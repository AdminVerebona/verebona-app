/**
 * T3 — rattrapage des TITRES de documents (lot 33C, ticket « T1/T3 :
 * garantir le renommage métier des documents »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CONTRÔLE INDÉPENDANT DES AUTRES TRAITEMENTS
 *
 * Un document dont l'analyse, le classement, le rattachement et l'agenda sont
 * terminés reste éligible : seuls comptent son état d'analyse ABOUTI, un
 * titre NON conforme (`isValidBusinessTitle`) et une source SYSTEM. Aucune
 * autre action T3 (DOCUMENT_ASSET, réconciliation) n'est requise ni lue.
 *
 * Même mécanique que le rattrapage DOCUMENT_ASSET (lots 31B / 32C) :
 *   · sorte de travail `document_title_sweep` (cible `document_title_sweep`,
 *     sans compte) au contrat de file 31C (`payloadVersion: 1`) ;
 *   · page 0 ouverte par la racine du balayage planifié T3
 *     (`registerT3SweepStarter('document_title', …)`, même cycle, même
 *     déclencheur) — pas de nouveau cycle tant qu'une page vit encore ;
 *   · chaque page traite au plus `titleSweepPageSize()` documents (curseur =
 *     identifiant), puis met en file UNE continuation (clé unique
 *     « cycle:page », `onlyIfNeverQueued`) : bornée, reprenable (une page
 *     rejouée est idempotente), multi-instances (prélèvement atomique de la
 *     file + écriture en compare-and-set).
 *
 * Le titre est reconstruit depuis les données PERSISTÉES par le service
 * commun `DocumentTitleService` — jamais d'OCR, d'extraction, d'appel T1 ni
 * de classification. Un titre utilisateur n'est jamais repris.
 *
 * Lot 34E (moteur de titre v2) : la sélection ne se limite plus aux titres
 * techniques. Sont repris tous les titres SYSTEM d'un document analysé et
 * actif dont :
 *   · la version des règles est antérieure (`title_rule_version` <
 *     `DOCUMENT_TITLE_RULE_VERSION`) — rattrapage AUTOMATIQUE de tout
 *     l'existant, y compris les titres jusque-là jugés valides ;
 *   · ou le CONTEXTE du titre a pu changer depuis le dernier contrôle : nouvelle
 *     analyse, rattachement / détachement (lien), bien / équipement lié
 *     modifié (nom…), nouvelle représentation documentaire.
 * Le service recalcule alors l'empreinte du contexte : identique → aucune
 * écriture ; modifiée → titre réévalué (renommé seulement s'il est
 * réellement meilleur). Pas de boucle horaire : un document contrôlé n'est
 * plus sélectionné tant que rien ne change. Le préfiltre technique
 * (`technicalTitleSqlPredicate`) reste une optimisation de tri, plus un
 * critère d'éligibilité.
 *
 * LOT 87D (C-Q9, ticket P1 « titres des factures périodiques ») : le CYCLE
 * HORAIRE paginé est RETIRÉ (plus de démarreur sur la racine du balayage T3,
 * plus de continuation) — la reprise du stock et la convergence passent par
 * le contrôle de cohérence COH-DOC-TITLES (`coherence/registry/checks/
 * document-titles.ts`), qui délègue au même service de nommage : une seule
 * chaîne de réparation. Une page `document_title_sweep` déjà en file au
 * déploiement est close sans effet (`RETIRED`). Restent : `repairTitles` /
 * `sweepDocumentTitles`, contrôle CIBLÉ d'un compte après une connaissance T3
 * nouvelle (connaissance ouverte), propagation et non réparation de stock.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { processingEligibleSql } from '@/services/account/processing-eligibility';
import type { QueuedJob } from '../queue/job-queue.repository';
import type { ExecutionGuard } from '../queue/execution-control';
import { PermanentJobError, type JobBusinessResult } from '../queue/queue-policy';
import { envNumber } from '@/lib/env-number';
import { DOCUMENT_TITLE_RULE_VERSION } from '@/lib/documents/document-title-rules';
import { registerT3JobKind } from './t3-job-contract';
import { T1_SETTLED_STATES } from './document-asset/question-gate';
import type { TitleOutcome } from '@/services/documents/document-title.service';

const T3_TARGET_DOCUMENT_TITLE_SWEEP = 'document_title_sweep';
export const DOCUMENT_TITLE_SWEEP_KIND = 'document_title_sweep';

/** Documents examinés par contrôle ciblé (`T3_TITLE_SWEEP_PAGE_SIZE`, 100 par défaut, 1 à 500). */
function titleSweepPageSize(): number {
  return Math.min(500, Math.floor(envNumber('T3_TITLE_SWEEP_PAGE_SIZE', 100, { min: 1 })));
}

interface DocumentTitleSweepPayload {
  kind: typeof DOCUMENT_TITLE_SWEEP_KIND;
  cycleId: string;
  page: number;
  afterFileId: number;
  requestedAt: string | null;
}

/**
 * Documents à contrôler (SQL pur, borné, curseur par identifiant) :
 *   · analyse T1 aboutie (état abouti, analyse datée ou représentation durable) ;
 *   · visible (ni supprimé, ni regroupé, ni brouillon, ni ignoré), pas un lien web ;
 *   · titre SYSTÈME (`title_source = 'SYSTEM'`) ;
 *   · règles de titre antérieures, OU contexte du titre potentiellement
 *     obsolète depuis le dernier contrôle (`title_checked_at`).
 * AUCUNE condition sur le classement, l'agenda ou une autre action T3.
 */
export const TITLE_SWEEP_SQL = `
  SELECT f.id, f.account_id
    FROM asset_files f
   WHERE ($3::int IS NULL OR f.account_id = $3::int)
     -- Lot 82A (C-Q10) : documents des seuls comptes éligibles.
     AND ${processingEligibleSql('f.account_id')}
     AND f.id > $1::int
     AND f.deleted_at IS NULL AND f.grouped_into_file_id IS NULL
     AND COALESCE(f.is_draft, false) = false AND COALESCE(f.is_ignored, false) = false
     AND COALESCE(f.is_web_link, false) = false
     AND f.title_source = 'SYSTEM'
     AND f.analysis_state IN ('${T1_SETTLED_STATES.join("', '")}')
     AND (f.last_analysis_at IS NOT NULL OR EXISTS (SELECT 1 FROM document_extractions e WHERE e.file_id = f.id))
     AND (
          f.title_rule_version IS DISTINCT FROM $4::int
       OR f.title_context_fingerprint IS NULL
       OR f.title_checked_at IS NULL
       OR (f.last_analysis_at IS NOT NULL AND f.title_checked_at < f.last_analysis_at)
       OR EXISTS (SELECT 1 FROM document_extractions e WHERE e.file_id = f.id AND e.extracted_at > f.title_checked_at)
       OR EXISTS (SELECT 1 FROM document_asset_links l WHERE l.file_id = f.id AND l.updated_at > f.title_checked_at)
       OR EXISTS (SELECT 1 FROM document_asset_links l JOIN assets a ON a.id = l.asset_id
                   WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND a.updated_at > f.title_checked_at)
       OR EXISTS (SELECT 1 FROM document_asset_links l JOIN equipments x ON x.id = l.equipment_id
                   WHERE l.file_id = f.id AND l.status = 'ACTIVE' AND x.updated_at > f.title_checked_at)
       OR EXISTS (SELECT 1 FROM assets a WHERE a.id = COALESCE(f.asset_id, f.linked_asset_id) AND a.updated_at > f.title_checked_at))
   ORDER BY f.id
   LIMIT $2`;

async function listDocumentsWithNonCompliantTitle(q: { afterFileId?: number; limit: number; accountId?: number | null }): Promise<Array<{ fileId: number; accountId: number }>> {
  const { pgClient } = await import('@/db');
  const rows = (await pgClient.unsafe(TITLE_SWEEP_SQL, [q.afterFileId ?? 0, q.limit, q.accountId ?? null, DOCUMENT_TITLE_RULE_VERSION] as never[])) as unknown as Array<{ id: number; account_id: number }>;
  return rows.map((r) => ({ fileId: Number(r.id), accountId: Number(r.account_id) }));
}

type Compteurs = Record<TitleOutcome, number>;
const compteursVides = (): Compteurs => ({ UPDATED: 0, NO_CHANGE: 0, SKIP_USER_TITLE: 0, INSUFFICIENT_DATA: 0, FAILED: 0 });

/** Contrôle (et corrige) une liste de documents par le service commun, origine T3. */
export async function repairTitles(rows: ReadonlyArray<{ fileId: number; accountId: number }>, guard?: ExecutionGuard): Promise<Compteurs> {
  const { ensureBusinessTitle } = await import('@/services/documents/document-title.service');
  const c = compteursVides();
  for (const r of rows) {
    await guard?.assertActive('T3 titre des documents');
    const res = await ensureBusinessTitle({ fileId: r.fileId, accountId: r.accountId, origin: 'T3', mode: 'repair', guard });
    c[res.outcome]++;
    // Sélectionné pour un changement SANS effet sur le titre (contexte
    // identique) : la date de contrôle avance, sans autre écriture — il
    // n'est plus repris au passage suivant.
    if (res.outcome === 'NO_CHANGE' && res.reason === null) await markTitleChecked(r.fileId, r.accountId);
  }
  return c;
}

/** Date de contrôle seule (jamais `updated_at`). */
async function markTitleChecked(fileId: number, accountId: number): Promise<void> {
  const { pgClient } = await import('@/db');
  await pgClient.unsafe(`UPDATE asset_files SET title_checked_at = now() WHERE id = $1 AND account_id = $2`, [fileId, accountId] as never[]);
}

/**
 * Page du rattrapage planifié des titres — RETIRÉ au lot 87D : une page encore
 * en file (déploiement) est close SANS contrôle ni continuation. La reprise
 * du stock appartient au contrôle de cohérence COH-DOC-TITLES.
 */
export async function runDocumentTitleSweepPage(
  _job: QueuedJob, p: DocumentTitleSweepPayload, _guard: ExecutionGuard,
): Promise<JobBusinessResult> {
  return { result: 'NO_CHANGE', detail: { cycleId: p.cycleId, page: p.page, retired: 'RETIRED', replacedBy: 'COH-DOC-TITLES' } };
}

const entier = (job: Pick<QueuedJob, 'id'>, raw: Record<string, unknown>, key: string): number => {
  const v = raw[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new PermanentJobError(`T3 job ${job.id} : ${key} invalide`);
  return v;
};

let enregistre = false;

/** Enregistre la sorte de travail. Idempotent (démarrage, chargement du module). */
export function registerDocumentTitleT3(): void {
  if (enregistre) return;
  enregistre = true;
  registerT3JobKind<DocumentTitleSweepPayload>({
    kind: DOCUMENT_TITLE_SWEEP_KIND,
    targetTypes: [T3_TARGET_DOCUMENT_TITLE_SWEEP],
    account: 'forbidden',
    versions: [1],
    parse(raw, job) {
      const cycleId = raw.cycleId;
      if (typeof cycleId !== 'string' || !cycleId) throw new PermanentJobError(`T3 job ${job.id} : page de rattrapage des titres sans cycle`);
      const requestedAt = raw.requestedAt;
      if (requestedAt !== undefined && requestedAt !== null
        && (typeof requestedAt !== 'string' || Number.isNaN(new Date(requestedAt).getTime()))) {
        throw new PermanentJobError(`T3 job ${job.id} : requestedAt invalide`);
      }
      return {
        kind: DOCUMENT_TITLE_SWEEP_KIND, cycleId,
        page: entier(job, raw, 'page'), afterFileId: entier(job, raw, 'afterFileId'),
        requestedAt: (requestedAt as string | null | undefined) ?? null,
      };
    },
    run: ({ job, payload, guard }) => runDocumentTitleSweepPage(job, payload, guard),
  });
}

/**
 * Contrôle CIBLÉ (connaissance T3 nouvelle d'un compte, tests) : au plus
 * `limit` documents d'un compte dont le contexte du titre a pu changer. La
 * reprise du stock passe par le contrôle de cohérence COH-DOC-TITLES.
 */
export async function sweepDocumentTitles(opts: { accountId?: number | null; limit?: number; guard?: ExecutionGuard } = {}): Promise<Compteurs> {
  const rows = await listDocumentsWithNonCompliantTitle({ limit: opts.limit ?? titleSweepPageSize(), accountId: opts.accountId ?? null });
  return repairTitles(rows, opts.guard);
}

registerDocumentTitleT3();
