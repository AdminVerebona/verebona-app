/**
 * Reprise des documents « à valider » (lot 71B — décision PO du 19/10 :
 * « Il ne doit pas y avoir de système de validation sur les fiches. Soit il y
 * a besoin d'une carte À traiter, soit la donnée est ajoutée. »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MÉCANISME RETIRÉ
 *
 * Jusqu'au lot 71A, deux moteurs mettaient un document dans l'état
 * `VALIDATION_REQUIRED` : la fin d'analyse T1 (`computeFinalState` : document
 * multi-biens avec propositions) et l'abstention de T3 DOCUMENT_ASSET (en plus
 * de sa carte LINK-ASSET). Le tiroir du document affichait alors « Automatique
 * — Validation suggérée » et un bouton « Appliquer » : l'utilisateur passait en
 * édition et « Sauvegarder = valider » (`POST /api/documents/[id]/commit`)
 * marquait les propositions « conservées » et transformait les données
 * documentaires du pont « À traiter » en VALEURS UTILISATEUR.
 *
 * Depuis le lot 71B, plus aucun moteur ne pose cet état : les écritures
 * fiables sont faites directement par les moteurs (métadonnées T1, preuves et
 * T3 pour la fiche du bien, pont « À traiter » pour les données documentaires,
 * service document ↔ équipement), une valeur incertaine ou en conflit devient
 * une carte « À traiter » (décision centrale AUTO_RESOLVED / NO_ACTION / DEFER
 * / CREATE_ACTION du lot 61), une valeur saisie par l'utilisateur n'est jamais
 * écrasée (préséances existantes).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE FAIT LA REPRISE (un document à la fois, idempotent)
 *
 *   1. état `VALIDATION_REQUIRED` → `ANALYZED`, CONDITIONNEL (une analyse ou
 *      une reprise concurrente l'a déjà changé → document ignoré) ;
 *   2. données documentaires : `syncDocumentRulesFromState` (déclencheur
 *      BACKFILL) — la décision centrale du pont consulte la connaissance
 *      persistée : valeur fiable et sans conflit → écrite (AUTO_RESOLVED,
 *      tracée, valeur automatique) ; incertaine ou contradictoire → carte
 *      « À traiter » (CREATE_ACTION, unique par donnée) ; valeur utilisateur
 *      → jamais touchée ; rattachement à un bien : carte LINK-ASSET existante
 *      conservée, sinon T3 DOCUMENT_ASSET (balayage) reste maître ;
 *   3. équipements : `syncDocumentEquipmentLinks` (données structurées, SANS
 *      IA) — désignation certaine → lien ; ambiguïté → carte LINK-ELT ; choix
 *      de l'utilisateur → jamais contredit ;
 *   4. trace : `document_validation_reprise` (0495), une ligne par document.
 *
 * Les propositions de l'analyse (`document_analysis_proposals`) gardent leur
 * statut : `pending` n'est plus une attente de l'utilisateur mais la trace de
 * ce que T1 a lu (`kept` signifierait « validé par l'utilisateur » et
 * alimenterait à tort le rattrapage des liens `document-asset-links`).
 *
 * Simulation : lecture seule (documents, propositions, cartes ouvertes,
 * rattachements aux équipements qui seraient posés).
 *
 * Isolation : chaque lecture et écriture porte le compte du document ; le
 * filtre « compte » du BO limite la sélection.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import { randomUUID } from 'node:crypto';
import { pgClient } from '@/db';

/** Ancien état « à valider » — plus jamais écrit depuis le lot 71B. */
export const LEGACY_VALIDATION_STATE = 'VALIDATION_REQUIRED';

export type RepriseOrigin = 'SCHEDULED' | 'BO';

export interface ValidationRepriseReport {
  mode: 'simulate' | 'apply';
  runId: string;
  origin: RepriseOrigin;
  /** Documents « à valider » trouvés (dans la limite du passage). */
  scanned: number;
  /** Documents repris (état remis à « analysé », moteurs rejoués). */
  processed: number;
  /** Documents dont l'état a changé entre la lecture et la reprise. */
  skipped: number;
  /** Propositions de l'analyse encore « en attente » sur ces documents. */
  pendingProposals: number;
  /** Bilan du pont « À traiter » (application). */
  rules: { written: number; created: number; updated: number; closed: number; errors: number };
  /** Rattachements aux équipements (simulation : qui seraient posés). */
  equipment: { linksCreated: number; cards: number; ambiguous: number };
  /** Cartes « À traiter » ouvertes sur ces documents (avant reprise). */
  openCards: number;
  failed: Array<{ fileId: number; accountId: number; error: string }>;
  samples: string[];
  /** Il reste des documents (limite ou délai atteint). */
  more: boolean;
}

export interface ValidationRepriseOptions {
  apply: boolean;
  origin: RepriseOrigin;
  accountId?: number | null;
  reason?: string | null;
  /** Documents lus par lot (défaut 100). */
  batchSize?: number;
  /** Plafond de documents par exécution (défaut 2 000). */
  maxDocuments?: number;
  /** Instant au-delà duquel la boucle rend la main (tâche planifiée). */
  deadline?: number;
  log?: (message: string) => void;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0) || 0;

/** Documents encore dans l'ancien état, par identifiant croissant. */
async function selectLegacyDocuments(accountId: number | null, afterId: number, limit: number): Promise<Array<{ id: number; accountId: number }>> {
  const rows = (await pgClient.unsafe(
    `SELECT f.id, f.account_id FROM asset_files f
      WHERE f.analysis_state = $1 AND f.id > $2 AND ($3::int IS NULL OR f.account_id = $3::int)
        -- Lot 82A (C-Q10, §3.3) : comptes éligibles seulement (repris après réactivation).
        AND ${processingEligibleSql('f.account_id')}
      ORDER BY f.id LIMIT $4`,
    [LEGACY_VALIDATION_STATE, afterId, accountId, limit] as never[],
  )) as unknown as Row[];
  return rows.map((r) => ({ id: num(r.id), accountId: num(r.account_id) }));
}

/** Propositions « en attente » du run de référence et cartes ouvertes du document. */
async function documentFacts(accountId: number, fileId: number): Promise<{ pending: number; openCards: number }> {
  const [r] = (await pgClient.unsafe(
    `SELECT
        (SELECT count(*) FROM document_analysis_proposals p
           JOIN document_analysis_runs run ON run.id = p.run_id AND run.is_current_reference = true AND run.account_id = $1
          WHERE p.asset_file_id = $2 AND p.account_id = $1 AND p.status = 'pending') AS pending,
        (SELECT count(*) FROM to_process_actions a
          WHERE a.account_id = $1 AND a.target_type = 'DOCUMENT' AND a.target_id = $2 AND a.resolved_at IS NULL) AS open_cards`,
    [accountId, fileId] as never[],
  )) as unknown as Row[];
  return { pending: num(r?.pending), openCards: num(r?.open_cards) };
}

/** Transition conditionnelle de l'ancien état vers « analysé » (rend vrai si appliquée). */
async function leaveLegacyState(accountId: number, fileId: number): Promise<boolean> {
  const rows = (await pgClient.unsafe(
    `UPDATE asset_files SET analysis_state = 'ANALYZED', updated_at = now()
      WHERE id = $1 AND account_id = $2 AND analysis_state = $3 RETURNING id`,
    [fileId, accountId, LEGACY_VALIDATION_STATE] as never[],
  )) as unknown as Row[];
  if (rows.length === 0) return false;
  try {
    const { broadcast } = await import('@/services/ai/source-analysis/stream/broadcast');
    broadcast(fileId, { type: 'state_update', analysisState: 'ANALYZED' });
  } catch { /* tiroir fermé : rien à diffuser */ }
  return true;
}

async function trace(p: {
  fileId: number; accountId: number; runId: string; origin: RepriseOrigin; reason: string | null;
  pending: number; rules: Record<string, unknown>; equipment: Record<string, unknown>;
}): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO document_validation_reprise
       (file_id, account_id, run_id, origin, reason, before_state, after_state, pending_proposals, rules, equipment)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, 'ANALYZED', $7, $8::jsonb, $9::jsonb)
     ON CONFLICT (file_id) DO UPDATE SET
       run_id = EXCLUDED.run_id, origin = EXCLUDED.origin, reason = EXCLUDED.reason,
       pending_proposals = EXCLUDED.pending_proposals, rules = EXCLUDED.rules, equipment = EXCLUDED.equipment,
       passes = document_validation_reprise.passes + 1, updated_at = now()`,
    [p.fileId, p.accountId, p.runId, p.origin, p.reason, LEGACY_VALIDATION_STATE, p.pending,
      JSON.stringify(p.rules), JSON.stringify(p.equipment)] as never[],
  );
}

/**
 * Reprise des documents « à valider ». Ne lève pas pour un document : son
 * échec est rapporté (`failed`) et le document sera repris au passage suivant
 * s'il n'a pas quitté l'ancien état.
 */
export async function runValidationReprise(o: ValidationRepriseOptions): Promise<ValidationRepriseReport> {
  const report: ValidationRepriseReport = {
    mode: o.apply ? 'apply' : 'simulate', runId: randomUUID(), origin: o.origin,
    scanned: 0, processed: 0, skipped: 0, pendingProposals: 0,
    rules: { written: 0, created: 0, updated: 0, closed: 0, errors: 0 },
    equipment: { linksCreated: 0, cards: 0, ambiguous: 0 },
    openCards: 0, failed: [], samples: [], more: false,
  };
  const log = o.log ?? (() => undefined);
  const batch = Math.max(1, Math.min(o.batchSize ?? 100, 500));
  const max = Math.max(1, o.maxDocuments ?? 2_000);
  const accountId = o.accountId ?? null;
  const reason = o.reason ?? (o.origin === 'SCHEDULED' ? 'Tâche planifiée « document-validation-reprise » (lot 71B)' : null);
  const { syncDocumentRulesFromState } = await import('@/services/to-process/document-rule-bridge');
  const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');

  let curseur = 0;
  for (;;) {
    if (o.deadline && Date.now() > o.deadline) { report.more = true; break; }
    const restant = max - report.scanned;
    if (restant <= 0) { report.more = (await selectLegacyDocuments(accountId, curseur, 1)).length > 0; break; }
    const docs = await selectLegacyDocuments(accountId, curseur, Math.min(batch, restant));
    if (docs.length === 0) break;
    for (const d of docs) {
      curseur = d.id;
      if (o.deadline && Date.now() > o.deadline) { report.more = true; break; }
      report.scanned += 1;
      try {
        const faits = await documentFacts(d.accountId, d.id);
        report.pendingProposals += faits.pending;
        report.openCards += faits.openCards;
        if (!o.apply) {
          const eq = await syncDocumentEquipmentLinks({ accountId: d.accountId, fileId: d.id, allowAi: false, dryRun: true });
          report.equipment.linksCreated += eq.created;
          if (eq.status === 'AMBIGUOUS') report.equipment.ambiguous += 1;
          if (report.samples.length < 20) {
            report.samples.push(`document ${d.id} · compte ${d.accountId} : ${faits.pending} proposition(s) en attente, ${faits.openCards} carte(s) ouverte(s), équipements ${eq.status}`);
          }
          continue;
        }
        if (!(await leaveLegacyState(d.accountId, d.id))) { report.skipped += 1; continue; }
        const regles = await syncDocumentRulesFromState(d.accountId, d.id, {
          reason: 'OBSOLETE', create: true, trigger: 'BACKFILL', runRef: `l71b-reprise:${report.runId}`,
        });
        const eq = await syncDocumentEquipmentLinks({ accountId: d.accountId, fileId: d.id, allowAi: false });
        report.processed += 1;
        report.rules.written += regles.written;
        report.rules.created += regles.created;
        report.rules.updated += regles.updated;
        report.rules.closed += regles.closed;
        report.rules.errors += Object.keys(regles.errors).length;
        report.equipment.linksCreated += eq.created;
        if (eq.cardProposed) report.equipment.cards += 1;
        if (eq.status === 'AMBIGUOUS') report.equipment.ambiguous += 1;
        await trace({
          fileId: d.id, accountId: d.accountId, runId: report.runId, origin: o.origin, reason, pending: faits.pending,
          rules: { written: regles.written, created: regles.created, updated: regles.updated, closed: regles.closed, outcomes: regles.outcomes, errors: regles.errors },
          equipment: { status: eq.status, linked: eq.linked, created: eq.created, cardProposed: eq.cardProposed },
        });
        if (report.samples.length < 20) {
          report.samples.push(`document ${d.id} · compte ${d.accountId} : ${regles.written} donnée(s) écrite(s), ${regles.created} carte(s) créée(s), équipements ${eq.status}`);
        }
      } catch (e) {
        report.failed.push({ fileId: d.id, accountId: d.accountId, error: String((e as Error).message ?? e).slice(0, 300) });
      }
    }
    if (report.more) break;
    log(`${report.scanned} document(s) examiné(s), ${report.processed} repris`);
    if (docs.length < Math.min(batch, restant)) break;
  }
  return report;
}

/** Synthèse d'une ligne (tâche planifiée, journal). */
export function formatValidationReprise(r: ValidationRepriseReport): string {
  const sim = r.mode === 'simulate';
  return `${r.scanned} document(s) « à valider » ${sim ? 'à reprendre' : 'examiné(s)'}, ${r.processed} repris, `
    + `${r.pendingProposals} proposition(s) en attente, ${r.rules.written} donnée(s) écrite(s), `
    + `${r.rules.created} carte(s) « À traiter » créée(s), ${r.equipment.linksCreated} lien(s) équipement ${sim ? 'à poser' : 'posé(s)'}, `
    + `${r.failed.length} échec(s)${r.more ? ', reste à traiter' : ''}`;
}
