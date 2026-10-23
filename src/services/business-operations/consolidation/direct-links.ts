/**
 * Lot 84E — CDC v5 O-6, §9.4, §9.5, P19, AC48–AC50, E29 : liens DIRECTS
 * Document ↔ Équipement des documents d'une Opération (`recomputeDirectLinks`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE
 *
 * Quand une Opération est liée à un ou plusieurs équipements, CHAQUE document
 * membre est réévalué individuellement : un lien direct n'est posé que pour
 * l'équipement que CE document désigne avec certitude. L'appartenance commune
 * à l'Opération n'est jamais une preuve (garde anti-cartésienne
 * `guardDocumentEquipmentLinks`, 82D) : aucun produit Documents × Équipements.
 *
 * PREUVES DÉTERMINISTES (M04 étendu — aucun nouveau moteur : le service
 * commun `syncDocumentEquipmentLinks` et ses règles `document-equipment-
 * matching` ; mêmes écritures, mêmes protections utilisateur) :
 *   · faits T1 du document ciblant l'équipement (cible vérifiée) ;
 *   · n° de série, modèle (marque compatible), désignation lus dans le
 *     document ;
 *   · contrat T1 ACTUEL des candidats Opération du document (O-5) : cible
 *     ÉQUIPEMENT certaine vérifiée, et DÉSIGNATION BRUTE (`rawLabel`) d'un
 *     équipement qui n'existait pas encore à l'analyse (cas Homiris : la
 *     facture désigne « l'alarme », l'équipement « Alarme » est créé
 *     ensuite) — mêmes règles de désignation que M04.
 * Le rapprochement reste calculé parmi TOUS les équipements des biens du
 * document ; seuls les équipements de l'Opération peuvent être liés, et une
 * concurrence n'est jamais levée par l'Opération.
 *
 * IA (M3 de l'arbitrage existant) seulement pour une AMBIGUÏTÉ sémantique
 * résiduelle entre équipements de l'Opération que le document désigne
 * (groupe ≥ 2), par l'arbitrage existant (`reconcileLinks`, prompt et
 * contrat inchangés), si l'appelant l'autorise, borné par le plafond M3 par
 * passage (`T3_OPERATION_MATCH_MAX_CALLS_PER_PASS`, inchangé). Un document qui
 * ne désigne aucun équipement n'est JAMAIS soumis à l'IA : la relation
 * document par document attend le contrat T3 demandé
 * (`82D-t3-document-equipement`) — constat `EQUIPMENT_ASSOCIATION_UNPROVEN`
 * du contrôle COH-DOC-LINKS, jamais un lien inventé.
 *
 * Décisions utilisateur : un équipement retiré ou refusé par l'utilisateur
 * pour un document n'est jamais relié (service commun) ; un choix explicite
 * de l'équipement du document n'est jamais modifié. Idempotent : rejoué, rien
 * de plus. Compte non éligible (C-Q10) : rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { DocumentFactProfile } from '@/services/equipment/document-equipment-matching';
import type { DocumentArbitrate } from '@/services/equipment/document-equipment-link.service';
import { guardDocumentEquipmentLinks, type CartesianRejection, type DocumentEquipmentEvidence } from '../grouping/model';

type Sql = typeof import('@/db').pgClient;
type Row = Record<string, unknown>;

/** Documents membres examinés par Opération (borne de lecture ; le reste au passage suivant). */
export const DIRECT_LINKS_DOCUMENT_LIMIT = 500;

export interface DirectLinksOptions {
  /** Simulation : liens qui seraient posés, aucune écriture, aucune IA. */
  dryRun?: boolean;
  /** Arbitrage IA d'une ambiguïté résiduelle (défaut : non). */
  allowAi?: boolean;
  /** Plafond d'appels IA partagé par l'appelant (défaut : plafond M3 par passage). */
  aiBudget?: { remaining: number };
  arbitrate?: DocumentArbitrate;
  /** Documents examinés seulement (défaut : tous les membres). */
  fileIds?: readonly number[];
  guard?: { assertActive(what: string): Promise<void> };
  sql?: Sql;
}

export interface DirectLinksResult {
  operationId: number;
  examined: number;
  /** Liens directs créés (0 au second passage). */
  created: number;
  /** Liens qui SERAIENT créés (simulation, ou avant écriture). */
  proposed: Array<{ fileId: number; equipmentId: number; method: string }>;
  /** Documents membres sans aucune preuve propre vers un équipement de l'Opération. */
  unproven: number[];
  /** Documents encore en concurrence entre équipements de l'Opération. */
  ambiguous: number[];
  rejected: Array<{ fileId: number; equipmentId: number; reason: CartesianRejection }>;
  aiCalls: number;
  skipped?: 'ACCOUNT_INELIGIBLE' | 'OPERATION_INACTIVE' | 'NO_EQUIPMENT' | 'NO_DOCUMENT';
}

/**
 * Faits du contrat T1 ACTUEL du document (candidats Opération actifs) qui
 * désignent un équipement : cible certaine vérifiée → fait ciblé ;
 * désignation brute (identifiant absent) → fait de désignation. Lecture
 * déterministe ; rien n'est déduit d'un intitulé.
 */
export async function t1EquipmentFacts(accountId: number, fileId: number, sql?: Sql): Promise<DocumentFactProfile[]> {
  const pg = sql ?? (await import('@/db')).pgClient;
  const r = (await pg.unsafe(
    `SELECT t.value AS t FROM document_operation_candidates c
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'targetHints') = 'array' THEN c.payload->'targetHints' ELSE '[]'::jsonb END) t
      WHERE c.account_id = $1 AND c.file_id = $2 AND c.status = 'ACTIVE' AND c.established
        AND t.value->>'type' = 'EQUIPMENT' AND t.value->>'confidence' = 'certain'
      ORDER BY c.id`,
    [accountId, fileId] as never[],
  )) as unknown as Array<{ t: { entityId?: number | null; rawLabel?: string | null } }>;
  return equipmentFactsOfTargets(r.map((x) => x.t));
}

/** Pure : cibles ÉQUIPEMENT certaines des candidats → faits du profil documentaire (dédoublonnés). */
export function equipmentFactsOfTargets(targets: ReadonlyArray<{ entityId?: number | null; rawLabel?: string | null }>): DocumentFactProfile[] {
  const out: DocumentFactProfile[] = [];
  const vus = new Set<string>();
  for (const t of targets) {
    const label = typeof t.rawLabel === 'string' && t.rawLabel.trim() ? t.rawLabel.trim().slice(0, 200) : null;
    if (typeof t.entityId === 'number' && Number.isSafeInteger(t.entityId) && t.entityId > 0) {
      const k = `id:${t.entityId}`;
      if (vus.has(k)) continue;
      vus.add(k);
      out.push({ key: 'operationEquipmentTarget', value: label ?? `équipement ${t.entityId}`, label: 'Équipement concerné (T1)', targetType: 'EQUIPMENT', targetId: t.entityId, targetLabel: label, excerpt: null, provenance: 'FACT' });
    } else if (label) {
      const k = `label:${label.toLowerCase()}`;
      if (vus.has(k)) continue;
      vus.add(k);
      // Désignation brute : libellé « équipement » (règle de désignation M04).
      out.push({ key: 'operationEquipmentDesignation', value: label, label: 'Équipement désigné (T1)', targetType: null, targetId: null, targetLabel: null, excerpt: null, provenance: 'FACT' });
    }
  }
  return out;
}

const preuve = (fileId: number, method: string): DocumentEquipmentEvidence => ({
  kind: method === 'VERIFIED_TARGET' ? 'T1_TARGET' : method === 'T3' ? 'AI_DECISION' : 'IDENTIFIER',
  fileId, ref: `${fileId}:${method}`,
});

/**
 * Réévalue CHAQUE document membre de l'Opération vers ses équipements
 * (voir l'en-tête). N'écrit que par le service commun ; jamais de lien sans
 * preuve propre au document.
 */
export async function recomputeDirectLinks(accountId: number, operationId: number, opts: DirectLinksOptions = {}): Promise<DirectLinksResult> {
  const pg = opts.sql ?? (await import('@/db')).pgClient;
  const out: DirectLinksResult = { operationId, examined: 0, created: 0, proposed: [], unproven: [], ambiguous: [], rejected: [], aiCalls: 0 };
  const { isAccountProcessingEligible } = await import('@/services/account/processing-eligibility');
  if (!(await isAccountProcessingEligible(accountId))) return { ...out, skipped: 'ACCOUNT_INELIGIBLE' };
  const [op] = (await pg.unsafe(
    `SELECT id FROM business_operations WHERE id = $1 AND account_id = $2 AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`,
    [operationId, accountId] as never[],
  )) as unknown as Row[];
  if (!op) return { ...out, skipped: 'OPERATION_INACTIVE' };
  const equips = ((await pg.unsafe(
    `SELECT el.equipment_id FROM business_operation_equipment_links el
       JOIN equipments e ON e.id = el.equipment_id AND e.archived_at IS NULL
       JOIN assets a ON a.id = e.asset_id AND a.account_id = $2 AND a.deleted_at IS NULL
      WHERE el.operation_id = $1 AND el.account_id = $2 AND el.active ORDER BY 1`,
    [operationId, accountId] as never[],
  )) as unknown as Row[]).map((x) => Number(x.equipment_id));
  if (!equips.length) return { ...out, skipped: 'NO_EQUIPMENT' };
  const membres = ((await pg.unsafe(
    `SELECT d.file_id FROM business_operation_documents d
       JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
      WHERE d.operation_id = $1 AND d.account_id = $2 AND d.active ORDER BY 1 LIMIT ${DIRECT_LINKS_DOCUMENT_LIMIT}`,
    [operationId, accountId] as never[],
  )) as unknown as Row[]).map((x) => Number(x.file_id));
  if (!membres.length) return { ...out, skipped: 'NO_DOCUMENT' };
  const cibles = new Set(equips);
  const filtre = opts.fileIds ? new Set(opts.fileIds) : null;
  const { syncDocumentEquipmentLinks, defaultDocumentArbitrate } = await import('@/services/equipment/document-equipment-link.service');
  const { operationMatchCallsPerPass } = await import('./m3');
  const budget = opts.aiBudget ?? { remaining: operationMatchCallsPerPass() };
  const arbitrage: DocumentArbitrate = async (p) => {
    if (budget.remaining <= 0) return { equipmentId: null, score: 0, reason: 'plafond M3 atteint (repris au passage suivant)', abstained: true };
    budget.remaining--;
    out.aiCalls++;
    return (opts.arbitrate ?? defaultDocumentArbitrate)(p);
  };

  for (const fileId of membres) {
    if (filtre && !filtre.has(fileId)) continue;
    await opts.guard?.assertActive(`liens directs du document ${fileId}`);
    out.examined++;
    const extraFacts = await t1EquipmentFacts(accountId, fileId, pg);
    const deja = new Set(((await pg.unsafe(
      `SELECT DISTINCT equipment_id FROM document_asset_links WHERE account_id = $1 AND file_id = $2 AND status = 'ACTIVE' AND equipment_id IS NOT NULL
       UNION SELECT equipment_id FROM asset_files WHERE id = $2 AND account_id = $1 AND equipment_id IS NOT NULL`,
      [accountId, fileId] as never[],
    )) as unknown as Row[]).map((x) => Number(x.equipment_id)));
    // 1. Décision déterministe (simulation), parmi tous les équipements des biens du document.
    const d = await syncDocumentEquipmentLinks({ accountId, fileId, extraFacts, restrictTo: cibles, allowAi: false, proposeCard: false, dryRun: true, sql: pg });
    const methode = (id: number) => d.methods[d.linked.indexOf(id)] ?? 'DESIGNATION';
    const propositions = d.linked.filter((id) => cibles.has(id) && !deja.has(id))
      .map((equipmentId) => ({ fileId, equipmentId, evidence: preuve(fileId, methode(equipmentId)) }));
    // 2. Garde anti-cartésienne (82D) : preuve propre au document, équipement de l'Opération, document membre.
    const g = guardDocumentEquipmentLinks(propositions, { memberFileIds: membres, equipmentIds: equips });
    out.rejected.push(...g.rejected.map((r) => ({ fileId: r.fileId, equipmentId: r.equipmentId, reason: r.reason })));
    out.proposed.push(...g.accepted.map((p) => ({ fileId, equipmentId: p.equipmentId, method: methode(p.equipmentId) })));
    const lie = d.linked.some((id) => cibles.has(id)) || [...deja].some((id) => cibles.has(id));
    if (!opts.dryRun && g.accepted.length) {
      const w = await syncDocumentEquipmentLinks({
        accountId, fileId, extraFacts, restrictTo: new Set(g.accepted.map((p) => p.equipmentId)), allowAi: false, proposeCard: false, sql: pg,
      });
      out.created += w.created;
    }
    // 3. Ambiguïté sémantique résiduelle entre équipements de l'Opération : arbitrage existant, borné.
    if (!lie && d.groups.length) {
      if (!opts.dryRun && opts.allowAi && budget.remaining > 0) {
        const w = await syncDocumentEquipmentLinks({ accountId, fileId, extraFacts, restrictTo: cibles, allowAi: true, arbitrate: arbitrage, proposeCard: false, sql: pg });
        out.created += w.created;
        if (w.linked.some((id) => cibles.has(id))) {
          out.proposed.push(...w.linked.filter((id) => cibles.has(id)).map((equipmentId) => ({ fileId, equipmentId, method: 'T3' })));
          continue;
        }
      }
      out.ambiguous.push(fileId);
      continue;
    }
    if (!lie) out.unproven.push(fileId);
  }
  return out;
}
