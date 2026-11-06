/**
 * COH-OPS-ACQUISITION-DOCUMENT — acquisition DOCUMENTAIRE établie sans
 * Opération active ni historique « Achat » (lot 111S, ticket P1
 * « acquisition prouvée par facture → Opération ACQUISITION + Informations
 * + historique Achat » ; CDC cohérence §4.3 ; arbitrages C-Q1, C-Q2, C-Q7,
 * C-Q10, C-Q11). Ajouté EN FIN de registre.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE TROU COUVERT. Les contrôles existants partent d'une Opération qui
 * EXISTE : COH-OPS-ACQUISITION-DATE (acquisition sans date / date de la
 * fiche), COH-AGENDA-OPERATION-PROJECTION (événement calculable absent),
 * COH-OPERATION-RELATIONS (fournisseurs). Aucun ne voit une facture d'achat
 * dont l'acquisition n'a JAMAIS été matérialisée. Ce contrôle part du
 * DOCUMENT : la chaîne T1 → T3 → T4 d'une acquisition prouvée est-elle
 * complète, ou son abstention justifiée et tracée ?
 *
 * Objet : document vivant du compte portant (a) un candidat T1 ACTIF et
 * ÉTABLI de type ACQUISITION (hors devis, commande, acompte, avoir,
 * remboursement, preuve de paiement), ou (b) la preuve canonique ACTIVE et
 * CERTAINE de la date / du prix d'acquisition d'un bien ou d'un équipement
 * vivant (`field_evidence`, règles déterministes de la projection T1 :
 * justificatif d'achat de la cible elle-même).
 *
 * Diagnostic (lecture seule, sans IA, mode à blanc compris) — par candidat :
 *   · ACQUISITION_CANDIDATE_NOT_CONSOLIDATED  candidat établi resté « à
 *     consolider » au-delà du délai de la file T3 → REPAIRABLE (T3 ciblé) ;
 *   · ACQUISITION_CORROBORATED_NOT_CONSOLIDATED  abstention T3 « probable
 *     sans correspondance » alors que la preuve canonique du document
 *     corrobore désormais l'achat (règle commune `acquisition-corroboration`,
 *     même identité que T3) → REPAIRABLE (T3 ciblé) ;
 *   · ACQUISITION_OPERATION_INACTIVE / ACQUISITION_SOURCE_MISSING /
 *     ACQUISITION_OPERATION_UNLINKED  décision T3 « créée / rattachée » mais
 *     Opération invalidée, source du document inactive, ou aucun lien au bien
 *     ciblé → REPAIRABLE (reconsolidation T3 ciblée du document) ;
 *   · ACQUISITION_EVENT_MISSING / ACQUISITION_EVENT_OUT_OF_SYNC  Opération
 *     active, projection T4 SIMULÉE (`projectAccountOperations` dryRun :
 *     suppressions mémorisées, éléments touchés, rapprochements compris) qui
 *     créerait / lierait / mettrait à jour l'historique → REPAIRABLE (T4) ;
 *   · ACQUISITION_UNRESOLVED / ACQUISITION_ARBITRATION_PENDING /
 *     ACQUISITION_NOT_PROVEN  abstention T3 tracée (contradiction, examen M3,
 *     arbitrage « À traiter », preuve seulement probable) → AMBIGUOUS, aucune
 *     écriture : le mécanisme existant reste seul juge ;
 *   · ACQUISITION_OPERATION_REQUALIFIED  Opération du candidat d'un autre type
 *     ou non réalisée → AMBIGUOUS.
 * Sans candidat d'acquisition, document preuve canonique de l'achat d'une
 * cible qui n'a AUCUNE acquisition active :
 *   · ACQUISITION_CANDIDATE_ABSENT  document jamais doté de candidats (analysé
 *     avant le contrat Opérations) → REPAIRABLE : relance T1 ciblée du seul
 *     document par la file existante, budget commun des relances IA de la
 *     cohérence (COHERENCE_T1_RELAUNCH_DAILY_MAX), une seule fois ;
 *   · ACQUISITION_CANDIDATE_NOT_PRODUCED  T1 a produit des candidats (ou a été
 *     relancé) sans acquisition établie → FINDING (sortie T1, motifs
 *     d'exclusion tracés) — jamais une seconde relance sur les mêmes entrées.
 *
 * Réparations (mode correctif seulement), déléguées aux services existants :
 * `consolidateDocument` (T3, déterministe, sans M3), puis
 * `consolidateAssetData` des biens concernés (date canonique de la fiche,
 * lot 85E), puis `projectAccountOperations` des Opérations du document (T4) ;
 * ou `requeueDocumentForReread` (T1). Aucune écriture du contrôle lui-même,
 * aucun appel IA hors relance T1 budgétée ; recontrôle par le moteur.
 * Idempotent : à état stable, CONSISTENT et aucune écriture.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, idsOf, intArray, rows, type Row } from '../util';

export const ACQUISITION_DOCUMENT_CHECK_ID = 'COH-OPS-ACQUISITION-DOCUMENT';
/** Code de relance consigné sur la couverture du document (`document_extraction_coverage.last_retry_result`). */
export const ACQUISITION_T1_RELAUNCH_RESULT = 'REQUEUED_T1_ACQUISITION';
/** Délai laissé à la file T3 avant de constater un candidat « à consolider » (minutes). */
export const ACQUISITION_T3_GRACE_MINUTES = 60;

const ROLES_NON_ACQUISITION = ['QUOTE', 'ORDER', 'DEPOSIT_INVOICE', 'CREDIT_NOTE', 'REFUND_PROOF', 'PAYMENT_PROOF'];
const ROLES_SQL = ROLES_NON_ACQUISITION.map((r) => `'${r}'`).join(', ');

/** Candidat d'acquisition établi (alias c). */
const ACQ_CANDIDATE_SQL = `c.status = 'ACTIVE' AND c.established AND upper(COALESCE(c.type_hint, '')) = 'ACQUISITION'
  AND COALESCE(c.payload ->> 'sourceRoleHint', '') NOT IN (${ROLES_SQL})
  AND upper(COALESCE(c.status_hint, 'REALIZED')) = 'REALIZED'`;

/** Preuve canonique d'acquisition ACTIVE et CERTAINE (alias fe) — mêmes règles que `acquisition-corroboration`. */
const EVIDENCE_ROW_SQL = `fe.confidence = 'certain' AND fe.status IN ('active', 'conflict') AND COALESCE(to_jsonb(fe) ->> 'lifecycle_status', 'ACTIVE') = 'ACTIVE'
     AND COALESCE(to_jsonb(fe) ->> 'canonical_key', fe.field_key) IN ('acquisitionDate', 'acquisitionPrice')
     AND COALESCE(to_jsonb(fe) ->> 'projection_rule', '') NOT IN ('ACQUISITION_PRICE_BASKET_TOTAL', 'ACQUISITION_PRICE_LINE_COUNT_UNKNOWN')`;

/** Preuve canonique d'acquisition portée par le document f sur une cible vivante. */
const ACQ_EVIDENCE_SQL = `EXISTS (
  SELECT 1 FROM field_evidence fe JOIN assets a ON a.id = fe.asset_id AND a.account_id = f.account_id AND a.deleted_at IS NULL
   WHERE fe.source_type = 'document' AND fe.source_id = f.id AND fe.account_id = f.account_id AND ${EVIDENCE_ROW_SQL})`;

/** Périmètre du contrôle (alias f ; $1 compte). */
const SCOPE_SQL = `f.account_id = $1 AND f.deleted_at IS NULL AND (
  EXISTS (SELECT 1 FROM document_operation_candidates c WHERE c.file_id = f.id AND c.account_id = f.account_id AND ${ACQ_CANDIDATE_SQL})
  OR ${ACQ_EVIDENCE_SQL})`;

// ── Diagnostic (pur) ───────────────────────────────────────────────────────

type ProjectionState = 'OK' | 'MISSING' | 'OUT_OF_SYNC' | 'NOT_PROJECTED';

export interface AcquisitionOperationFacts {
  id: number;
  active: boolean;
  typeCode: string | null;
  status: string;
  /** Source DOCUMENT active de CE document sur l'Opération. */
  documentSource: boolean;
  /** Lien actif à un bien vivant. */
  assetLinked: boolean;
  projection: ProjectionState;
  /** Événements liés (non annulés). */
  events: number;
}

export interface AcquisitionCandidateFacts {
  id: number;
  confidence: string;
  pending: boolean;
  /** Candidat « à consolider » depuis plus longtemps que le délai de la file T3. */
  pendingStale: boolean;
  outcome: string | null;
  reason: string | null;
  /** Corroboré par la preuve canonique du document (même identité que T3). */
  corroborated: boolean;
  /** Le candidat vise un bien vivant (cible T1 certaine ou bien du document). */
  targetsLiveAsset: boolean;
  operation: AcquisitionOperationFacts | null;
}

export interface AcquisitionDocumentFacts {
  fileId: number;
  analyzing: boolean;
  candidatesEver: number;
  /** Candidats actifs non retenus comme acquisition (trace d'une abstention T1). */
  otherCandidates: Array<{ type: string | null; established: boolean; exclusion: string | null }>;
  /** Cibles dont le document est la preuve canonique d'acquisition (`ASSET:12`, `EQUIPMENT:7`). */
  evidenceTargets: string[];
  /** Une de ces cibles porte déjà une acquisition active (autre source). */
  targetHasAcquisition: boolean;
  /** Relance T1 « acquisition » déjà demandée pour ce document. */
  t1Relaunched: boolean;
  acquisitions: AcquisitionCandidateFacts[];
}

const RANG: Record<string, number> = { REPAIRABLE: 0, AMBIGUOUS: 1, FINDING: 2, CONSISTENT: 3, GONE: 4 };

/** Verdict d'un document (pure). `budgetLeft` : relances T1 encore permises. */
export function acquisitionDocumentVerdict(d: AcquisitionDocumentFacts, budgetLeft: number): Inspection {
  const base = { fileId: d.fileId, evidenceTargets: d.evidenceTargets };
  if (d.analyzing) return { verdict: 'CONSISTENT', detail: { ...base, waiting: 'ANALYSIS_IN_PROGRESS' } };
  if (!d.acquisitions.length) {
    if (!d.evidenceTargets.length || d.targetHasAcquisition) return { verdict: 'CONSISTENT', detail: base };
    if (d.candidatesEver === 0 && !d.t1Relaunched) {
      const i: Inspection = {
        verdict: 'REPAIRABLE', anomaly: 'ACQUISITION_CANDIDATE_ABSENT', faultyLink: 'T1',
        expected: 'candidat Opération ACQUISITION établi par T1 pour le justificatif d’achat', observed: { candidates: 0 },
        detail: { ...base, repair: 'T1', repairChain: 'relance T1 ciblée du document (file existante), puis T3 et T4 à la fin de l’analyse' },
        inputHash: hashOf({ f: d.fileId, k: 'T1_ABSENT', t: d.evidenceTargets }),
      };
      return budgetLeft > 0 ? i : { ...i, verdict: 'FINDING', detail: { ...i.detail, relaunchBudgetReached: true } };
    }
    return {
      verdict: 'FINDING', anomaly: 'ACQUISITION_CANDIDATE_NOT_PRODUCED', faultyLink: 'T1',
      expected: 'candidat Opération ACQUISITION établi (ou exclusion motivée)', observed: { candidates: d.otherCandidates.slice(0, 5), relaunched: d.t1Relaunched },
      detail: base, inputHash: hashOf({ f: d.fileId, k: 'T1_NOT_PRODUCED', c: d.otherCandidates, r: d.t1Relaunched }),
    };
  }
  let pire: Inspection | null = null;
  for (const c of d.acquisitions) {
    const i = candidateVerdict(d, c);
    if (!pire || RANG[i.verdict] < RANG[pire.verdict]) pire = i;
  }
  return pire!;
}

function candidateVerdict(d: AcquisitionDocumentFacts, c: AcquisitionCandidateFacts): Inspection {
  const detail = { fileId: d.fileId, candidateId: c.id, outcome: c.outcome, reason: c.reason, operationId: c.operation?.id ?? null };
  const t3 = (anomaly: string, observed: unknown): Inspection => ({
    verdict: 'REPAIRABLE', anomaly, faultyLink: 'T3', expected: 'Opération ACQUISITION active, source documentaire, liée à sa cible', observed,
    detail: { ...detail, repair: 'T3', repairChain: 'reconsolidation T3 ciblée du document, réconciliation de la fiche (lot 85E), projection T4' },
    inputHash: hashOf({ f: d.fileId, c: c.id, a: anomaly, o: observed }),
  });
  const ambigu = (anomaly: string): Inspection => ({
    verdict: 'AMBIGUOUS', anomaly, faultyLink: 'T3', observed: { outcome: c.outcome, reason: c.reason, confidence: c.confidence },
    detail, inputHash: hashOf({ f: d.fileId, c: c.id, a: anomaly, r: c.reason }),
  });
  if (c.pending) return c.pendingStale ? t3('ACQUISITION_CANDIDATE_NOT_CONSOLIDATED', { pending: true }) : { verdict: 'CONSISTENT', detail: { ...detail, waiting: 'T3_QUEUE' } };
  if (c.outcome === 'HOLD_UNRESOLVED') {
    if (c.reason === 'PROBABLE_WITHOUT_MATCH') return c.corroborated ? t3('ACQUISITION_CORROBORATED_NOT_CONSOLIDATED', { outcome: c.outcome, reason: c.reason }) : ambigu('ACQUISITION_NOT_PROVEN');
    return ambigu('ACQUISITION_UNRESOLVED');
  }
  if (c.outcome === 'ARBITRATION_REQUIRED') return ambigu('ACQUISITION_ARBITRATION_PENDING');
  if (c.outcome !== 'CREATE_NEW' && c.outcome !== 'MATCH_AND_ENRICH') {
    // Jamais décidé (ancienne consolidation) : la consolidation T3 ciblée tranche.
    return t3('ACQUISITION_CANDIDATE_NOT_CONSOLIDATED', { outcome: c.outcome });
  }
  const op = c.operation;
  if (!op || !op.active) return t3('ACQUISITION_OPERATION_INACTIVE', { operationId: op?.id ?? null, active: false });
  if (!op.documentSource) return t3('ACQUISITION_SOURCE_MISSING', { operationId: op.id });
  if (op.typeCode !== 'ACQUISITION' || op.status !== 'REALIZED') {
    return { ...ambigu('ACQUISITION_OPERATION_REQUALIFIED'), observed: { operationId: op.id, typeCode: op.typeCode, status: op.status } };
  }
  if (!op.assetLinked && c.targetsLiveAsset) return t3('ACQUISITION_OPERATION_UNLINKED', { operationId: op.id, assetLinked: false });
  if (op.projection === 'MISSING' || op.projection === 'OUT_OF_SYNC') {
    const anomaly = op.projection === 'MISSING' ? 'ACQUISITION_EVENT_MISSING' : 'ACQUISITION_EVENT_OUT_OF_SYNC';
    return {
      verdict: 'REPAIRABLE', anomaly, faultyLink: 'PROJECTION', expected: 'historique « Achat » lié à l’Opération, daté de l’acquisition établie',
      observed: { operationId: op.id, events: op.events }, detail: { ...detail, repair: 'T4', repairChain: 'projection T4 de l’Opération (suppressions mémorisées et éléments touchés respectés)' },
      inputHash: hashOf({ f: d.fileId, op: op.id, a: anomaly, e: op.events }),
    };
  }
  return { verdict: 'CONSISTENT', detail: { ...detail, events: op.events } };
}

// ── Lecture des faits ──────────────────────────────────────────────────────

type Sql = Parameters<typeof rows>[0];

async function lireFaits(sql: Sql, accountId: number, ids: readonly number[], today: string): Promise<Map<number, AcquisitionDocumentFacts>> {
  const out = new Map<number, AcquisitionDocumentFacts>();
  const docs = await rows(sql, `
    SELECT f.id, COALESCE(f.asset_id, f.linked_asset_id) AS asset_id, f.analysis_state, f.amount_cents,
           (SELECT count(*)::int FROM document_operation_candidates c WHERE c.file_id = f.id AND c.account_id = f.account_id) AS ever,
           (SELECT cov.last_retry_result FROM document_extraction_coverage cov WHERE cov.file_id = f.id) AS retry
      FROM asset_files f WHERE ${SCOPE_SQL} AND f.id = ANY($2::int[])`, [accountId, intArray(ids)]);
  if (!docs.length) return out;
  const fileIds = idsOf(docs);
  const { acquisitionEvidenceIndex, acquisitionEvidenceSql } = await import('@/services/business-operations/consolidation/acquisition-corroboration');
  const cands = await rows(sql, `
    SELECT c.id, c.file_id, c.candidate_key, c.established, c.confidence, c.type_hint, c.status_hint, c.summary, c.payload,
           c.t3_pending, c.t3_outcome, c.t3_reason, c.t3_operation_id, (c.created_at < now() - make_interval(mins => $3)) AS stale,
           (${ACQ_CANDIDATE_SQL}) AS acq
      FROM document_operation_candidates c
     WHERE c.account_id = $1 AND c.file_id = ANY($2::int[]) AND c.status = 'ACTIVE' ORDER BY c.id`, [accountId, fileIds, ACQUISITION_T3_GRACE_MINUTES]);
  // Cibles : biens des documents, cibles T1 certaines, équipements (et leur bien).
  const assetIds = new Set<number>(docs.map((x) => Number(x.asset_id)).filter((x) => Number.isSafeInteger(x) && x > 0));
  const equipmentIds = new Set<number>();
  for (const c of cands) {
    for (const t of ((c.payload as { targetHints?: Array<{ type?: string; entityId?: unknown }> } | null)?.targetHints ?? [])) {
      const id = Number(t.entityId);
      if (!Number.isSafeInteger(id)) continue;
      if (t.type === 'ASSET') assetIds.add(id);
      if (t.type === 'EQUIPMENT') equipmentIds.add(id);
    }
  }
  const eqs = equipmentIds.size ? await rows(sql, `
    SELECT e.id, e.asset_id FROM equipments e JOIN assets a ON a.id = e.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
     WHERE e.id = ANY($2::int[]) AND e.archived_at IS NULL`, [accountId, [...equipmentIds]]) : [];
  const equipmentAssets = new Map(eqs.map((x) => [Number(x.id), Number(x.asset_id)]));
  for (const a of equipmentAssets.values()) assetIds.add(a);
  // Preuves canoniques des DOCUMENTS contrôlés (toutes cibles vivantes), puis index commun avec T3.
  const evid = await rows(sql, `
    SELECT DISTINCT COALESCE(to_jsonb(fe) ->> 'target_type', 'ASSET') AS target_type,
           COALESCE((to_jsonb(fe) ->> 'target_entity_id')::int, fe.asset_id) AS target_id, fe.source_id AS file_id, fe.asset_id
      FROM field_evidence fe JOIN assets a ON a.id = fe.asset_id AND a.account_id = fe.account_id AND a.deleted_at IS NULL
     WHERE fe.account_id = $1 AND fe.source_type = 'document' AND fe.source_id = ANY($2::int[]) AND ${EVIDENCE_ROW_SQL}`, [accountId, fileIds]);
  for (const e of evid) assetIds.add(Number(e.asset_id));
  const vivants = new Set(idsOf(await rows(sql, `SELECT id FROM assets WHERE account_id = $1 AND deleted_at IS NULL AND id = ANY($2::int[])`, [accountId, [...assetIds]])));
  const index = acquisitionEvidenceIndex(await rows(sql, acquisitionEvidenceSql(accountId, [...vivants], [...equipmentAssets.keys()])) as never);
  // Acquisitions actives des cibles prouvées (toute source : fiche, autre document, agenda).
  const cibleAcq = await rows(sql, `
    SELECT DISTINCT l.asset_id, NULL::int AS equipment_id FROM business_operation_asset_links l JOIN business_operations o ON o.id = l.operation_id
     WHERE o.account_id = $1 AND l.active AND o.type_code = 'ACQUISITION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL AND l.asset_id = ANY($2::int[])
    UNION
    SELECT DISTINCT NULL::int, el.equipment_id FROM business_operation_equipment_links el JOIN business_operations o ON o.id = el.operation_id
     WHERE o.account_id = $1 AND el.active AND o.type_code = 'ACQUISITION' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL AND el.equipment_id = ANY($3::int[])`,
  [accountId, [...vivants], [...equipmentAssets.keys()]]);
  const acquises = new Set(cibleAcq.map((x) => (x.asset_id != null ? `ASSET:${x.asset_id}` : `EQUIPMENT:${x.equipment_id}`)));

  // Opérations des candidats d'acquisition (fusions suivies jusqu'à la canonique).
  const opIds = intArray(cands.filter((c) => c.established && c.t3_operation_id != null).map((c) => Number(c.t3_operation_id)));
  const ops = opIds.length ? await rows(sql, `
    WITH RECURSIVE chaine AS (
      SELECT o.id AS origine, o.id, o.merged_into_operation_id, 0 AS n FROM business_operations o WHERE o.account_id = $1 AND o.id = ANY($2::bigint[])
      UNION ALL
      SELECT ch.origine, o.id, o.merged_into_operation_id, ch.n + 1 FROM chaine ch JOIN business_operations o ON o.id = ch.merged_into_operation_id AND o.account_id = $1 WHERE ch.n < 10
    )
    SELECT ch.origine, o.id, o.type_code, o.status, (o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS active,
           EXISTS (SELECT 1 FROM business_operation_asset_links l JOIN assets a ON a.id = l.asset_id AND a.account_id = $1 AND a.deleted_at IS NULL
                    WHERE l.operation_id = o.id AND l.active) AS linked,
           (SELECT array_agg(s.source_entity_key) FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT') AS docs,
           (SELECT count(*)::int FROM agenda_items ai WHERE ai.account_id = $1 AND ai.business_operation_id = o.id
              AND (ai.manual_status IS NULL OR ai.manual_status <> 'annule')) AS events
      FROM chaine ch JOIN business_operations o ON o.id = ch.id
     WHERE ch.merged_into_operation_id IS NULL OR ch.n = 10`, [accountId, opIds]) : [];
  const opDe = new Map(ops.map((o) => [Number(o.origine), o]));
  // Projection T4 SIMULÉE des Opérations actives d'acquisition (aucune écriture).
  const actives = intArray(ops.filter((o) => o.active && o.type_code === 'ACQUISITION' && o.status === 'REALIZED').map((o) => Number(o.id)));
  const plans = new Map<number, ProjectionState>();
  if (actives.length) {
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    const sim = await projectAccountOperations(accountId, { operationIds: actives, dryRun: true, today });
    for (const p of sim.plans ?? []) {
      const kinds = new Set(p.actions.map((a) => a.kind));
      plans.set(p.operationId, kinds.has('CREATE') || kinds.has('LINK') ? 'MISSING' : kinds.has('SYNC') ? 'OUT_OF_SYNC' : 'OK');
    }
  }
  const { buildCandidateIdentity } = await import('@/services/business-operations/consolidation/model');
  for (const doc of docs) {
    const fileId = Number(doc.id);
    const fileAsset = doc.asset_id == null ? null : Number(doc.asset_id);
    const leurs = cands.filter((c) => Number(c.file_id) === fileId);
    const etablis = leurs.filter((c) => c.established).map(record);
    const evidenceTargets = [...new Set(evid.filter((e) => Number(e.file_id) === fileId).map((e) => `${e.target_type === 'EQUIPMENT' ? 'EQUIPMENT' : 'ASSET'}:${e.target_id}`))].sort();
    const acquisitions: AcquisitionCandidateFacts[] = [];
    for (const c of leurs) {
      // Candidat d'acquisition, ou candidat établi sans type corroboré par la preuve (même règle que T3).
      const identity = buildCandidateIdentity(record(c), {
        fileAssetId: fileAsset, liveAssetIds: vivants, equipmentAssets, documentCandidates: etablis, documentTotalMinor: doc.amount_cents == null ? null : Number(doc.amount_cents), today,
        acquisitionEvidence: index,
      });
      if (!c.acq && identity.corroboration?.type !== 'ACQUISITION') continue;
      const o = c.t3_operation_id == null ? null : opDe.get(Number(c.t3_operation_id)) ?? null;
      acquisitions.push({
        id: Number(c.id), confidence: String(c.confidence), pending: c.t3_pending === true, pendingStale: c.stale === true,
        outcome: (c.t3_outcome as string | null) ?? null, reason: (c.t3_reason as string | null) ?? null,
        corroborated: !!identity.corroboration, targetsLiveAsset: identity.assetIds.length > 0,
        operation: o ? {
          id: Number(o.id), active: o.active === true, typeCode: (o.type_code as string | null) ?? null, status: String(o.status),
          documentSource: ((o.docs as string[] | null) ?? []).includes(String(fileId)), assetLinked: o.linked === true,
          projection: plans.get(Number(o.id)) ?? (o.active && o.type_code === 'ACQUISITION' && o.status === 'REALIZED' ? 'OK' : 'NOT_PROJECTED'), events: Number(o.events ?? 0),
        } : null,
      });
    }
    out.set(fileId, {
      fileId, analyzing: doc.analysis_state === 'ANALYZING' || doc.analysis_state === 'UPLOADED', candidatesEver: Number(doc.ever ?? 0),
      otherCandidates: leurs.filter((c) => !c.acq).map((c) => ({
        type: (c.type_hint as string | null) ?? null, established: c.established === true,
        exclusion: ((c.payload as { exclusionReason?: string | null } | null)?.exclusionReason) ?? null,
      })),
      evidenceTargets, targetHasAcquisition: evidenceTargets.some((t) => acquises.has(t)),
      t1Relaunched: doc.retry === ACQUISITION_T1_RELAUNCH_RESULT, acquisitions,
    });
  }
  return out;
}

function record(c: Row) {
  return {
    id: Number(c.id), accountId: 0, fileId: Number(c.file_id), candidateKey: String(c.candidate_key), established: c.established === true,
    confidence: c.confidence as never, typeHint: (c.type_hint as string | null) ?? null, statusHint: (c.status_hint as string | null) ?? null,
    summary: String(c.summary ?? ''), payload: (c.payload ?? {}) as never,
  };
}

async function budget(ctx: Parameters<NonNullable<CoherenceCheck['inspect']>>[0]): Promise<number> {
  const { t1RelaunchBudgetLeft } = await import('./extract-chain');
  return t1RelaunchBudgetLeft(ctx);
}

// ── Contrôle ───────────────────────────────────────────────────────────────

export const operationsAcquisitionDocumentCheck: CoherenceCheck = {
  id: ACQUISITION_DOCUMENT_CHECK_ID,
  version: 1,
  status: 'ACTIVE',
  title: 'Opérations : acquisition prouvée par un document matérialisée (Opération active, liens, historique « Achat »)',
  domain: 'operations',
  level: 'N3',
  objectType: 'document',
  scope: 'documents vivants portant un candidat T1 ACQUISITION établi (hors devis, commande, acompte, avoir, paiement) ou la preuve canonique certaine de la date / du prix d’acquisition d’un bien ou d’un équipement vivant',
  sources: ['asset_files', 'document_operation_candidates', 'field_evidence', 'business_operations', 'business_operation_sources',
    'business_operation_asset_links', 'business_operation_equipment_links', 'business_operation_projection_suppressions', 'agenda_items', 'document_extraction_coverage'],
  applicability: 'compte éligible (actif et modifiable) ; Standard comme Premium (Informations et Agenda) ; relance T1 dans le budget commun des relances IA de la cohérence (COHERENCE_T1_RELAUNCH_DAILY_MAX)',
  invariant: 'toute acquisition documentaire établie aboutit à une Opération ACQUISITION active, sourcée par le document, liée à sa cible, et à son historique « Achat » (sauf suppression mémorisée ou élément touché par l’utilisateur), ou à une abstention justifiée et tracée',
  anomalies: ['ACQUISITION_CANDIDATE_NOT_CONSOLIDATED', 'ACQUISITION_CORROBORATED_NOT_CONSOLIDATED', 'ACQUISITION_OPERATION_INACTIVE', 'ACQUISITION_SOURCE_MISSING',
    'ACQUISITION_OPERATION_UNLINKED', 'ACQUISITION_EVENT_MISSING', 'ACQUISITION_EVENT_OUT_OF_SYNC', 'ACQUISITION_UNRESOLVED', 'ACQUISITION_ARBITRATION_PENDING',
    'ACQUISITION_NOT_PROVEN', 'ACQUISITION_OPERATION_REQUALIFIED', 'ACQUISITION_CANDIDATE_ABSENT', 'ACQUISITION_CANDIDATE_NOT_PRODUCED'],
  autoRepairWhen: 'preuves persistées suffisantes (candidat établi, ou corroboré par la preuve canonique du document) : reconsolidation T3 ciblée du document, réconciliation de la fiche, projection T4 ; document jamais doté de candidats : une relance T1 ciblée budgétée',
  forbiddenRepairs: ['créer une Opération hors de la consolidation T3', 'requalifier un achat d’accessoire, de travaux ou d’équipement en acquisition du bien parent',
    'remplacer une valeur saisie ou corrigée par l’utilisateur', 'recréer un événement supprimé par l’utilisateur', 'réécrire un événement modifié par l’utilisateur',
    'créer un second événement Achat ou une seconde Opération', 'appeler l’IA hors de la relance T1 budgétée', 'relancer T1 sur des entrées inchangées', 'trancher un arbitrage'],
  services: ['business-operations/consolidation/consolidator#consolidateDocument', 'business-operations/consolidation/asset-data-consolidator#consolidateAssetData',
    'business-operations/agenda-projection/service#projectAccountOperations', 'ai/source-analysis/source-units/jobs#requeueDocumentForReread'],
  chain: ['T1', 'T3', 'PERSISTENCE', 'LINK', 'PROJECTION'],
  triggers: ['SOURCE_ANALYZED', 'DOCUMENT_UPDATED', 'DOCUMENT_UPLOADED', 'ASSET_CREATED', 'ASSET_UPDATED', 'BUSINESS_OPERATION_CHANGED'],
  frequency: 'campagne exhaustive quotidienne des comptes éligibles + contrôle ciblé à chaque analyse, modification de document ou de bien, écriture d’Opération',
  criticality: 'HIGH',
  semanticReevaluation: [],
  tests: ['L111S-U-VERDICT', 'L111S-U-CORROBORATION', 'L111S-E2E-01', 'L111S-E2E-11', 'L111S-E2E-12'],

  async listObjects(ctx, accountId, afterId, limit) {
    return idsOf(await rows(ctx.sql, `SELECT f.id FROM asset_files f WHERE ${SCOPE_SQL} AND f.id > $2 ORDER BY f.id LIMIT $3`, [accountId, afterId, limit]));
  },

  async objectsForEvent(ctx, accountId, e) {
    if (e.entityId == null) return [];
    if (e.type === 'ASSET_UPDATED' || e.type === 'ASSET_CREATED') {
      return idsOf(await rows(ctx.sql, `
        SELECT f.id FROM asset_files f WHERE ${SCOPE_SQL} AND (COALESCE(f.asset_id, f.linked_asset_id) = $2
           OR EXISTS (SELECT 1 FROM field_evidence fe WHERE fe.source_type = 'document' AND fe.source_id = f.id AND fe.asset_id = $2))
         ORDER BY f.id`, [accountId, e.entityId]));
    }
    if (e.type === 'BUSINESS_OPERATION_CHANGED') {
      return idsOf(await rows(ctx.sql, `
        SELECT f.id FROM asset_files f WHERE ${SCOPE_SQL} AND (
          EXISTS (SELECT 1 FROM document_operation_candidates c WHERE c.file_id = f.id AND c.status = 'ACTIVE' AND c.t3_operation_id = $2)
          OR EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = $2 AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = f.id::text))
         ORDER BY f.id`, [accountId, e.entityId]));
    }
    return idsOf(await rows(ctx.sql, `SELECT f.id FROM asset_files f WHERE ${SCOPE_SQL} AND f.id = $2`, [accountId, e.entityId]));
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const faits = await lireFaits(ctx.sql, accountId, ids, ctx.today);
    let reste = -1;
    for (const id of ids) {
      const d = faits.get(id);
      if (!d) { out.set(id, { verdict: 'GONE' }); continue; }
      // Budget lu seulement si une relance T1 est envisagée (et décompté dans le lot).
      const relance = !d.acquisitions.length && d.candidatesEver === 0 && !d.t1Relaunched && d.evidenceTargets.length > 0 && !d.targetHasAcquisition && !d.analyzing;
      if (relance && reste < 0) reste = await budget(ctx);
      const i = acquisitionDocumentVerdict(d, relance ? reste : 0);
      if (relance && i.verdict === 'REPAIRABLE') reste--;
      out.set(id, i);
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    // Diagnostic relu au moment de réparer (jamais sur un état périmé).
    const faits = await lireFaits(ctx.sql, accountId, items.map((i) => i.id), ctx.today);
    for (const { id, inspection } of items) {
      const d = faits.get(id);
      const repair = (inspection.detail as { repair?: string } | undefined)?.repair;
      if (!d) { out.set(id, { called: false, service: 'none', result: { skipped: 'DOCUMENT_GONE' } }); continue; }
      if (repair === 'T1') {
        const [cov] = await rows(ctx.sql, `SELECT retry_attempts FROM document_extraction_coverage WHERE file_id = $1`, [id]);
        const jobs = await import('@/services/ai/source-analysis/source-units/jobs');
        const ok = await jobs.requeueDocumentForReread({
          fileId: id, accountId, attempt: Number(cov?.retry_attempts ?? 0) + 1, origin: 'coherence-control', result: ACQUISITION_T1_RELAUNCH_RESULT,
        });
        if (!ok) throw new Error('relance T1 refusée par la file');
        out.set(id, {
          called: true, service: 'requeueDocumentForReread', pending: true, aiCalls: 0,
          result: { queued: true, origin: 'coherence-control', diagnostic: inspection.anomaly, propagation: 'T3 puis T4 à la fin de l’analyse (abonnés existants)' },
          rollbackRef: `document_extraction_coverage:file=${id}:last_retry_result=${ACQUISITION_T1_RELAUNCH_RESULT}`,
        });
        continue;
      }
      const opsAvant = d.acquisitions.map((c) => c.operation?.id).filter((x): x is number => typeof x === 'number');
      let t3: { changes: number; operations: number[]; outcomes: Record<string, number | undefined>; error?: string } | null = null;
      if (repair === 'T3') {
        const { consolidateDocument } = await import('@/services/business-operations/consolidation/consolidator');
        t3 = await consolidateDocument(accountId, id, { today: ctx.today, correlationId: ctx.correlationId, syncCards: true });
        if (t3.error) throw new Error(`consolidation T3 du document ${id} : ${t3.error}`);
      } else if (repair !== 'T4') {
        out.set(id, { called: false, service: 'none', result: { skipped: 'NO_REPAIR_FOR_DIAGNOSTIC', anomaly: inspection.anomaly ?? null } });
        continue;
      }
      // Opérations ACQUISITION du document après T3 (décision tracée sur le candidat), puis fiche (85E) et projection T4.
      const apres = await rows(ctx.sql, `
        SELECT DISTINCT o.id, l.asset_id FROM document_operation_candidates c
          JOIN business_operations o ON o.id = c.t3_operation_id AND o.account_id = c.account_id
          LEFT JOIN business_operation_asset_links l ON l.operation_id = o.id AND l.active
         WHERE c.account_id = $1 AND c.file_id = $2 AND c.status = 'ACTIVE' AND o.type_code = 'ACQUISITION'
           AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL`, [accountId, id]);
      const opIds = intArray([...opsAvant, ...idsOf(apres)]);
      const biens = intArray(apres.map((x) => Number(x.asset_id)));
      let fiche = 0;
      if (repair === 'T3') {
        const { consolidateAssetData } = await import('@/services/business-operations/consolidation/asset-data-consolidator');
        for (const b of biens) {
          const r = await consolidateAssetData(accountId, b, { today: ctx.today, correlationId: ctx.correlationId });
          if (r.error) throw new Error(`réconciliation du bien ${b} : ${r.error}`);
          fiche += r.changes;
        }
      }
      const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
      const t4 = opIds.length ? await projectAccountOperations(accountId, { operationIds: opIds, correlationId: ctx.correlationId, today: ctx.today }) : null;
      out.set(id, {
        called: true, service: repair === 'T3' ? 'consolidateDocument+consolidateAssetData+projectAccountOperations' : 'projectAccountOperations', aiCalls: 0,
        reevaluation: 'TECHNICAL_REBUILD',
        result: {
          anomaly: inspection.anomaly ?? null, t3Changes: t3?.changes ?? null, t3Outcomes: t3?.outcomes ?? null, operations: opIds, assetDataChanges: fiche,
          t4Created: t4?.created ?? 0, t4Updated: t4?.updated ?? 0, t4Linked: t4?.linked ?? 0, t4Suppressed: t4?.suppressed ?? 0,
        },
        rollbackRef: `business_operation_history:correlation_id=${ctx.correlationId}`,
      });
    }
    return out;
  },
};
