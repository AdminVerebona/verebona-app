/**
 * BusinessOperationConsolidator — consolidation T3 DÉTERMINISTE des candidats
 * T1 en Opérations (lot 41, O3a ; CDC Opérations V1 ch. 8, B5, C4, C5, C6,
 * C8, C9, C9.1, C10, C12, C21, C24).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNITÉ DE TRAVAIL : UN DOCUMENT, UNE TRANSACTION
 *
 *   document « sale » ──► withBusinessOperationWrite(compte)  (verrou du compte)
 *     1. relire le document (supprimé ? type non métier ?), ses candidats
 *        ACTIFS et ses sources DOCUMENT déjà consolidées ;
 *     2. pour chaque candidat : identité (`model.ts`) puis décision C5 / C6 /
 *        C7 (`matching.ts`) sur les Opérations PLAUSIBLES du compte (requête
 *        bornée par compte, références, cibles, type : NFR-OP-010) ;
 *     3. CREATE_NEW : Opération + source dans la même transaction (NFR-OP-002)
 *        — MATCH_AND_ENRICH : source ajoutée (ou réutilisée) ;
 *     4. sources du document qu'aucun candidat ne revendique (réanalyse qui
 *        retire, document supprimé / non métier) : désactivées (C9) ;
 *     5. chaque Opération touchée est RECONSOLIDÉE depuis toutes ses sources
 *        actives : statut, dates, type, prestataire, cibles, références,
 *        composantes financières, détails, invalidation sans source (C8) ;
 *     6. trace de la décision sur le candidat (0321), marqueur T3 levé.
 *   Événements Opération publiés APRÈS commit (bus du lot 39).
 *
 * IDEMPOTENCE (NFR-OP-004, INV-039, INV-040) : une réanalyse identique, un
 * second passage, un balayage sans changement n'écrivent AUCUN historique —
 * chaque écriture du dépôt compare avant d'écrire ; seule la version
 * technique d'une source suit le candidat courant.
 *
 * Aucun appel IA DANS la transaction : le niveau M3 (lot 42, `m3.ts`) tourne
 * entre deux passages, hors verrou ; son verdict, enregistré sur le candidat
 * avec l'EMPREINTE du contexte, n'est appliqué (`applyM3Verdict`) que si le
 * contexte est inchangé. Aucun déclencheur n'est posé sur les tables
 * `business_operation*` (anti-boucle C16.2) ; la corrélation de la file est
 * transmise aux événements. Rien n'est visible pour l'utilisateur (P09), sauf
 * les questions « À traiter » d'une ambiguïté à impact (lot 42, ch. 20,
 * `to-process/operation-cards.ts`), posées APRÈS commit, en langage métier.
 *
 * LOT 42 (O3b) : fusion V1 (B8) quand une source prouve que plusieurs
 * Opérations sont la même réalité ; réactivation d'une Opération invalidée par
 * une preuve certaine de même identité (F-052) ; décisions utilisateur
 * durables (C6.3 : CONFIRMED / REJECTED, parent Sinistre, montant retenu).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { sql, type SQL } from 'drizzle-orm';
import { isBusinessOperationIntegrityError } from '../errors';
import type { DbTx } from '../lock';
import type { BusinessOperationStatus, BusinessOperationTypeCode, Confidence, OperationTypeInput, ReferenceKind } from '../model';
import type { BusinessOperationRepository } from '../repository';
import { withBusinessOperationWrite } from '../write';
import { NON_BUSINESS_DOCUMENT_TYPES } from '@/services/ai/source-analysis/operation-candidates/prepare';
import {
  buildCandidateIdentity, consolidateOperationState, normalizeProvider,
  type CandidateIdentity, type CandidateRecord, type SourceContribution,
} from './model';
import { applyM3Verdict, decideCandidate, rankPlausible, type CandidateDecision, type ExistingOperation, type MatchContext, type T3Outcome } from './matching';
import { advanceM3Progress, m3ProgressFor, m3SubjectFingerprint, selectM3Batch, type M3Progress } from './m3-progress';
import { applyCurrencyChoices, type AmountChoice, type CurrencyChoice, type SideAmount } from './model';
import { OPERATION_MATCH_MAX_CANDIDATES, type OperationMatchVerdict } from '@/services/ai/reconciliation/master/operation-match';
import { emptyCardNeeds, type OperationCardNeeds } from './card-needs';
import { operationMatchContext, type StoredM3 } from './m3-context';
import { applyStructuredAuthority, assetDataContribution, type AssetDataRow } from './asset-data';
import { agendaContribution, applyAgendaAuthority } from './agenda-source';
import { loadAgendaSourceItem } from './agenda-source-read';
import { applyAssetExclusions, exclusionsTableReady, loadActiveExclusions } from './asset-exclusions';

/**
 * Sources AGENDA actives dont l'élément n'existe plus dans le compte (lot
 * 47B) — même prédicat que `agenda-source-consolidator` (filet horaire).
 */
export const STALE_AGENDA_SOURCE_SQL = `
  s.active AND s.source_kind = 'AGENDA' AND s.locator ? 'agenda'
  AND NOT EXISTS (SELECT 1 FROM agenda_items ai WHERE ai.id::text = s.source_entity_key AND ai.account_id = s.account_id)`;

type Row = Record<string, unknown>;
const rows = async <T = Row>(tx: DbTx, q: SQL): Promise<T[]> => (await tx.execute(q)) as unknown as T[];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
/** Tableaux en littéral PostgreSQL (le gabarit Drizzle développerait un tableau JS en liste de paramètres). */
const intArray = (v: readonly number[]): string => `{${v.filter((x) => Number.isSafeInteger(x)).join(',')}}`;
const textArray = (v: readonly string[]): string => `{${v.map((x) => `"${x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;

/**
 * Version technique d'une contribution documentaire : candidat T1 courant,
 * bien du document, type documentaire. Une différence (document déplacé,
 * reclassé, réanalysé) rend la source « à reconsolider » pour le balayage.
 * MÊME expression pour l'écriture et la détection (aucune divergence TS/SQL).
 */
export const SOURCE_VERSION_SQL = `('c' || c.id || '|a' || COALESCE(f.asset_id, f.linked_asset_id, 0) || '|t' || COALESCE(f.document_type_code, ''))`;

/** Prédicat SQL des sources DOCUMENT gérées par T3 devenues obsolètes (alias s, f, c). */
export const STALE_DOCUMENT_SOURCE_SQL = `
  s.active AND s.source_kind = 'DOCUMENT' AND s.locator ? 'candidateKey'
  AND (f.id IS NULL OR f.deleted_at IS NOT NULL OR f.account_id <> s.account_id OR c.id IS NULL
       OR s.source_version IS DISTINCT FROM ${SOURCE_VERSION_SQL})`;

/** Jointures associées (fichier, candidat ACTIF de la même clé). */
export const STALE_DOCUMENT_SOURCE_JOINS = `
  LEFT JOIN asset_files f ON f.id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END)
  LEFT JOIN document_operation_candidates c
         ON c.file_id = f.id AND c.status = 'ACTIVE' AND c.candidate_key = s.locator->>'candidateKey'`;

// ── Résultats ───────────────────────────────────────────────────────────────

export interface FileConsolidationResult {
  fileId: number;
  outcomes: Partial<Record<T3Outcome, number>>;
  /** Écritures métier (historisées) effectuées. */
  changes: number;
  operations: number[];
  /** Questions « À traiter » à poser / fermer (synchronisées après commit). */
  cards?: OperationCardNeeds;
  error?: string;
}

export interface ConsolidationOptions {
  correlationId?: string;
  /** Date du jour (AAAA-MM-JJ) — décision PO Q13 ; défaut : date UTC courante. */
  today?: string;
  /** Avant chaque transaction (interruption d'exploitation). */
  beforeWrite?: (what: string) => Promise<void>;
  /** Synchroniser les cartes « À traiter » après commit (défaut : oui). */
  syncCards?: boolean;
  /** Tests : étape de fusion (injection d'erreur, F-168). */
  onMergeStep?: (step: string) => void | Promise<void>;
  /** Lot 54D (E01) : travail de file à l'origine du passage (trace de l'erreur technique). */
  jobId?: number | null;
}

// ── Lot 54D (E01, E05) : reprise automatique bornée ─────────────────────────

/** Tentatives T3 en erreur technique avant abandon (exposé au BO, reprise par « Reconsolider »). */
export const T3_TECHNICAL_RETRY_MAX = 6;
/** Backoff : 5 min × 2^(n−1), plafonné à 6 h. */
export function t3RetryDelayMinutes(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > T3_TECHNICAL_RETRY_MAX) return null;
  return Math.min(360, 5 * 2 ** (attempt - 1));
}

type FaultHook = (stage: 'document' | 'cards', ctx: { accountId: number; fileId?: number }) => void | Promise<void>;
let faultHook: FaultHook | null = null;
/** Tests seulement : injection d'une panne (intégrité T3, service de cartes). */
export function setT3FaultHookForTests(h: FaultHook | null): void { faultHook = h; }

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Compteur des écritures métier d'un passage. */
export class Changes {
  n = 0;
  track(b: boolean | number): void {
    if (b === true || (typeof b === 'number' && b > 0)) this.n++;
  }
}

// ── Lecture du contexte (sous verrou, dans la transaction) ─────────────────

interface FileRow { id: number; accountId: number; deleted: boolean; assetId: number | null; documentTypeCode: string | null }

async function loadFile(tx: DbTx, accountId: number, fileId: number): Promise<FileRow | null> {
  const [f] = await rows<{ id: number; account_id: number; deleted: boolean; asset_id: number | null; document_type_code: string | null }>(tx, sql`
    SELECT id, account_id, deleted_at IS NOT NULL AS deleted, COALESCE(asset_id, linked_asset_id) AS asset_id, document_type_code
      FROM asset_files WHERE id = ${fileId}`);
  if (!f || Number(f.account_id) !== accountId) return null;
  return { id: Number(f.id), accountId: Number(f.account_id), deleted: f.deleted, assetId: num(f.asset_id), documentTypeCode: f.document_type_code };
}

interface CandidateRow extends CandidateRecord {
  status: 'ACTIVE' | 'SUPERSEDED';
  t3Pending: boolean;
  t3Outcome: string | null;
  t3Reason: string | null;
  t3OperationId: number | null;
  t3Detail: Record<string, unknown> | null;
  version: string | null;
}

const CANDIDATE_COLUMNS = sql.raw(`c.id, c.account_id, c.file_id, c.candidate_key, c.established, c.confidence, c.type_hint, c.status_hint, c.summary,
           c.payload, c.status, c.t3_pending, c.t3_outcome, c.t3_reason, c.t3_operation_id, c.t3_detail,
           ${SOURCE_VERSION_SQL} AS version`);

async function loadCandidates(tx: DbTx, accountId: number, fileId: number): Promise<CandidateRow[]> {
  const r = await rows<Row>(tx, sql`
    SELECT ${CANDIDATE_COLUMNS}
      FROM document_operation_candidates c JOIN asset_files f ON f.id = c.file_id
     WHERE c.file_id = ${fileId} AND c.account_id = ${accountId} AND (c.status = 'ACTIVE' OR c.t3_pending)
     ORDER BY c.candidate_key, c.id
       FOR UPDATE OF c`);
  return r.map(toCandidateRow);
}

/**
 * Contexte M3 d'un candidat en attente (lot 42), relu dans une transaction
 * de LECTURE (aucun verrou d'écriture) : mêmes constructeurs que la
 * consolidation, donc même empreinte si rien n'a changé. `null` : candidat
 * disparu, remplacé ou document plus exploitable.
 */
export async function prepareOperationMatch(accountId: number, candidateId: number): Promise<{
  fileId: number; variables: Record<string, unknown>; fingerprint: string; operationIds: number[]; plausible: number[];
} | null> {
  const { db } = await import('@/db');
  return db.transaction(async (tx) => {
    const [x] = await rows<Row>(tx, sql`
      SELECT ${CANDIDATE_COLUMNS}
        FROM document_operation_candidates c JOIN asset_files f ON f.id = c.file_id
       WHERE c.id = ${candidateId} AND c.account_id = ${accountId} AND c.status = 'ACTIVE'`);
    if (!x) return null;
    const c = toCandidateRow(x);
    const file = await loadFile(tx, accountId, c.fileId);
    if (!file || file.deleted || (file.documentTypeCode && NON_BUSINESS_DOCUMENT_TYPES.has(file.documentTypeCode))) return null;
    const ids = targetIdsOf([c], file.assetId);
    const actx = await loadAssetContext(tx, accountId, ids.assets, ids.equipments);
    const identity = buildCandidateIdentity(c, { fileAssetId: file.assetId, liveAssetIds: actx.live, equipmentAssets: actx.equipments });
    // Lot 53 (D7) : le LOT courant de l'examen progressif (au plus 5 Opérations),
    // à défaut (trace antérieure au lot 53) les Opérations plausibles.
    const lot = (c.t3Detail?.m3Batch ?? c.t3Detail?.plausible) as unknown[] | undefined;
    const plausible = ((lot ?? []).map(Number)).filter((n) => Number.isSafeInteger(n));
    const m3 = await operationMatchContext(tx, accountId, identity, plausible);
    return { fileId: c.fileId, ...m3, plausible };
  });
}

function toCandidateRow(x: Row): CandidateRow {
  return ({
    id: Number(x.id), accountId: Number(x.account_id), fileId: Number(x.file_id), candidateKey: String(x.candidate_key),
    established: Boolean(x.established), confidence: x.confidence as Confidence, typeHint: (x.type_hint as string | null) ?? null,
    statusHint: (x.status_hint as string | null) ?? null, summary: String(x.summary ?? ''),
    payload: (x.payload ?? {}) as CandidateRecord['payload'], status: x.status as 'ACTIVE' | 'SUPERSEDED',
    t3Pending: Boolean(x.t3_pending), t3Outcome: (x.t3_outcome as string | null) ?? null, t3Reason: (x.t3_reason as string | null) ?? null,
    t3OperationId: num(x.t3_operation_id), t3Detail: (x.t3_detail as Record<string, unknown> | null) ?? null,
    version: (x.version as string | null) ?? null,
  });
}

interface DocSource { id: number; operationId: number; active: boolean; key: string; opInvalidated: boolean; opMerged: boolean }

/** Sources DOCUMENT gérées par T3 (locator.candidateKey) d'un document, actives ou non. */
async function loadDocumentSources(tx: DbTx, accountId: number, fileId: number): Promise<DocSource[]> {
  const r = await rows<Row>(tx, sql`
    SELECT s.id, s.operation_id, s.active, s.locator->>'candidateKey' AS key,
           o.invalidated_at IS NOT NULL AS inv, o.merged_into_operation_id IS NOT NULL AS merged
      FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id AND o.account_id = s.account_id
     WHERE s.account_id = ${accountId} AND s.source_kind = 'DOCUMENT' AND s.source_entity_key = ${String(fileId)}
       AND s.locator ? 'candidateKey'
     ORDER BY s.id`);
  return r.map((x) => ({
    id: Number(x.id), operationId: Number(x.operation_id), active: Boolean(x.active), key: String(x.key),
    opInvalidated: Boolean(x.inv), opMerged: Boolean(x.merged),
  }));
}

interface AssetContext { live: Set<number>; status: Map<number, string>; equipments: Map<number, number> }

export async function loadAssetContext(tx: DbTx, accountId: number, assetIds: number[], equipmentIds: number[]): Promise<AssetContext> {
  const ctx: AssetContext = { live: new Set(), status: new Map(), equipments: new Map() };
  if (equipmentIds.length) {
    const e = await rows<{ id: number; asset_id: number }>(tx, sql`
      SELECT e.id, e.asset_id FROM equipments e JOIN assets a ON a.id = e.asset_id
       WHERE e.id = ANY(${intArray(equipmentIds)}::int[]) AND a.account_id = ${accountId} AND a.deleted_at IS NULL AND e.archived_at IS NULL`);
    for (const x of e) {
      ctx.equipments.set(Number(x.id), Number(x.asset_id));
      assetIds.push(Number(x.asset_id));
    }
  }
  const ids = [...new Set(assetIds)];
  if (ids.length) {
    const a = await rows<{ id: number; status: string | null }>(tx, sql`
      SELECT id, status FROM assets WHERE id = ANY(${intArray(ids)}::int[]) AND account_id = ${accountId} AND deleted_at IS NULL`);
    for (const x of a) {
      ctx.live.add(Number(x.id));
      ctx.status.set(Number(x.id), x.status ?? 'EN_SERVICE');
    }
  }
  return ctx;
}

function targetIdsOf(cands: CandidateRecord[], fileAssetId: number | null): { assets: number[]; equipments: number[] } {
  const assets: number[] = fileAssetId !== null ? [fileAssetId] : [];
  const equipments: number[] = [];
  for (const c of cands) {
    for (const t of c.payload?.targetHints ?? []) {
      if (typeof t.entityId !== 'number') continue;
      if (t.type === 'ASSET') assets.push(t.entityId);
      if (t.type === 'EQUIPMENT') equipments.push(t.entityId);
    }
  }
  return { assets, equipments };
}

/** Borne des Opérations examinées par candidat (NFR-OP-010 : jamais de scan global). */
export const MATCHING_OPERATION_LIMIT = 300;

/**
 * Opérations du compte qui POURRAIENT représenter la réalité du candidat :
 * références communes, mêmes cibles (ou sans cible), même type (ou nul),
 * bornes de cycle de possession, décisions utilisateur, même source. Bornée
 * par compte et par index (références, liens biens, type).
 */
export async function loadMatchableOperations(
  tx: DbTx, accountId: number, c: CandidateIdentity, extraIds: number[],
): Promise<ExistingOperation[]> {
  const refs = c.refs.map((r) => `${r.kind}:${r.normalized}`);
  const cycle = c.type === 'ACQUISITION' || c.type === 'DISPOSAL';
  const r = await rows<Row>(tx, sql`
    WITH cand AS (
      SELECT o.id FROM business_operations o
       WHERE o.account_id = ${accountId} AND o.merged_into_operation_id IS NULL
         AND (o.id = ANY(${intArray(extraIds)}::bigint[])
              -- Référence exacte : y compris une Opération INVALIDÉE (réactivation, F-052).
              OR EXISTS (SELECT 1 FROM business_operation_references r
                          WHERE r.account_id = ${accountId} AND r.operation_id = o.id AND (r.active OR o.invalidated_at IS NOT NULL)
                            AND (r.reference_kind || ':' || r.normalized_value) = ANY(${textArray(refs)}::text[]))
              OR (o.invalidated_at IS NULL AND (
                   ((${c.type}::text IS NULL OR o.type_code IS NULL OR o.type_code = ${c.type}
                     OR (${cycle} AND o.type_code IN ('ACQUISITION', 'DISPOSAL')))
                    AND (cardinality(${intArray(c.assetIds)}::int[]) = 0
                         OR EXISTS (SELECT 1 FROM business_operation_asset_links l
                                     WHERE l.operation_id = o.id AND l.active AND l.asset_id = ANY(${intArray(c.assetIds)}::int[]))
                         OR NOT EXISTS (SELECT 1 FROM business_operation_asset_links l WHERE l.operation_id = o.id AND l.active))))))
       ORDER BY (o.invalidated_at IS NULL) DESC, o.id DESC
       LIMIT ${MATCHING_OPERATION_LIMIT}
    )
    SELECT o.id, o.type_code, o.status, o.provider, o.invalidated_at IS NOT NULL AS invalidated, o.technical_label,
           -- Lot 53 (D5) : montants actifs (cohérence des montants du faisceau).
           COALESCE((SELECT json_agg(json_build_object('kind', fc.kind, 'amountMinor', fc.amount_minor, 'currency', btrim(fc.currency)))
                       FROM business_operation_financial_components fc WHERE fc.operation_id = o.id AND fc.active), '[]') AS amounts,
           o.planned_date::text AS planned_date, o.start_date::text AS start_date,
           o.realized_date::text AS realized_date, o.end_date::text AS end_date,
           COALESCE((SELECT array_agg(l.asset_id ORDER BY l.asset_id) FROM business_operation_asset_links l
                      WHERE l.operation_id = o.id AND l.active), '{}') AS assets,
           COALESCE((SELECT json_agg(json_build_object('kind', r.reference_kind, 'normalized', r.normalized_value))
                       FROM business_operation_references r WHERE r.operation_id = o.id AND (r.active OR o.invalidated_at IS NOT NULL)), '[]') AS refs,
           -- Lot 47B : établie par l'agenda seul (toutes ses sources actives sont AGENDA).
           (EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'AGENDA')
            AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active AND s.source_kind <> 'AGENDA')) AS agenda_only
      FROM business_operations o JOIN cand ON cand.id = o.id`);
  // Lot 53 (Q17) : un bien retiré d'un sinistre par l'utilisateur reste un bien
  // que ce sinistre CONCERNE pour le rapprochement (un document qui le cite est
  // bien celui du sinistre — carte de décision —, jamais une contradiction).
  const exclus = new Map<number, number[]>();
  if (r.length && await exclusionsTableReady(tx)) {
    for (const e of await rows<{ operation_id: string; asset_id: number }>(tx, sql`
      SELECT operation_id, asset_id FROM business_operation_asset_exclusions
       WHERE account_id = ${accountId} AND active AND operation_id = ANY(${intArray(r.map((x) => Number(x.id)))}::bigint[])`)) {
      exclus.set(Number(e.operation_id), [...(exclus.get(Number(e.operation_id)) ?? []), Number(e.asset_id)]);
    }
  }
  return r.map((x) => ({
    id: Number(x.id),
    typeCode: (x.type_code as BusinessOperationTypeCode | null) ?? null,
    status: x.status as BusinessOperationStatus,
    providerKey: normalizeProvider(x.provider as string | null),
    assetIds: [...new Set([...((x.assets as number[] | null) ?? []).map(Number), ...(exclus.get(Number(x.id)) ?? [])])].sort((a, b) => a - b),
    refs: ((x.refs as Array<{ kind: ReferenceKind; normalized: string }> | null) ?? []),
    plannedDate: (x.planned_date as string | null) ?? null,
    startDate: (x.start_date as string | null) ?? null,
    realizedDate: (x.realized_date as string | null) ?? null,
    endDate: (x.end_date as string | null) ?? null,
    invalidated: Boolean(x.invalidated),
    ...(x.agenda_only === true ? { agendaOnly: true } : {}),
    label: (x.technical_label as string | null) ?? null,
    amounts: ((x.amounts as Array<{ kind: string; amountMinor: number | string; currency: string }> | null) ?? [])
      .map((a) => ({ kind: String(a.kind), amountMinor: Number(a.amountMinor), currency: String(a.currency) })),
  }));
}

/** Raison d'un rejet « c'est une autre réalité » (carte À traiter, lot 42) : autorise la création (C5). */
export const USER_DISTINCT_REASON = 'USER_DISTINCT_OPERATION';

async function loadDecisions(tx: DbTx, accountId: number, fileId: number, candidateKey: string): Promise<{ confirmed: Set<number>; rejected: Set<number>; userDistinct: boolean }> {
  // Décision sur une Opération fusionnée : suivie jusqu'à la canonique (C6 étape 12).
  const r = await rows<{ op: string; decision: string; reason_code: string }>(tx, sql`
    SELECT COALESCE(o.merged_into_operation_id, d.candidate_operation_id) AS op, d.decision, d.reason_code
      FROM business_operation_match_decisions d
      JOIN business_operations o ON o.id = d.candidate_operation_id AND o.account_id = d.account_id
     WHERE d.account_id = ${accountId} AND d.source_kind = 'DOCUMENT' AND d.source_entity_key = ${String(fileId)} AND d.active
       AND (d.source_version IS NULL OR d.source_version = ${candidateKey})`);
  const confirmed = new Set(r.filter((x) => x.decision === 'CONFIRMED').map((x) => Number(x.op)));
  return {
    confirmed,
    // Une décision CONFIRMED l'emporte sur un rejet de la même Opération (fusion de deux décisions).
    rejected: new Set(r.filter((x) => x.decision === 'REJECTED' && !confirmed.has(Number(x.op))).map((x) => Number(x.op))),
    userDistinct: r.some((x) => x.decision === 'REJECTED' && x.reason_code === USER_DISTINCT_REASON),
  };
}

/**
 * Couples d'Opérations qu'une décision utilisateur sépare (une même source
 * CONFIRMED sur l'une, REJECTED sur l'autre) : jamais fusionnés (F-046).
 */
async function loadNonMergeable(tx: DbTx, accountId: number, ids: readonly number[]): Promise<Set<string>> {
  if (ids.length < 2) return new Set();
  const r = await rows<{ a: string; b: string }>(tx, sql`
    SELECT d1.candidate_operation_id AS a, d2.candidate_operation_id AS b
      FROM business_operation_match_decisions d1
      JOIN business_operation_match_decisions d2
        ON d2.account_id = d1.account_id AND d2.source_kind = d1.source_kind AND d2.source_entity_key = d1.source_entity_key
       AND COALESCE(d2.source_version, '') = COALESCE(d1.source_version, '') AND d2.active AND d2.decision = 'REJECTED'
     WHERE d1.account_id = ${accountId} AND d1.active AND d1.decision = 'CONFIRMED'
       AND d1.candidate_operation_id = ANY(${intArray(ids)}::bigint[]) AND d2.candidate_operation_id = ANY(${intArray(ids)}::bigint[])`);
  return new Set(r.map((x) => {
    const [a, b] = [Number(x.a), Number(x.b)].sort((m, n) => m - n);
    return `${a}:${b}`;
  }));
}

// ── Reconsolidation d'une Opération (C8, C9.1, C10, C12, C13) ──────────────

interface OpSource {
  id: number; kind: string; entityKey: string; key: string | null;
  /** Lot 43 : nature d'une source ASSET_DATA (ACQUISITION, DISPOSAL, CONTRACT). */
  nature: string | null;
  managed: boolean; decision: Record<string, unknown> | null;
}

/** Contexte d'une contribution AGENDA (lot 47B) : Opération et autres preuves. */
interface AgendaContext { operationId: number; operationType: string | null; otherSupport: boolean; today: string }

/** Motif du retrait d'une source gérée devenue obsolète. */
const withdrawReason = (kind: string, agendaReason?: string): string =>
  kind === 'ASSET_DATA' ? 'ASSET_DATA_WITHDRAWN' : kind === 'AGENDA' ? `AGENDA_${agendaReason ?? 'WITHDRAWN'}` : 'T3_SOURCE_WITHDRAWN';

/**
 * Ligne du bien d'une source ASSET_DATA (lot 43), relue dans la transaction :
 * `row_to_json` porte `status_changed_at` (0322) sans le déclarer à Drizzle.
 */
export async function loadAssetDataRow(tx: DbTx, accountId: number, assetId: number): Promise<AssetDataRow | null> {
  const [r] = await rows<{ r: AssetDataRow | string }>(tx, sql`
    SELECT row_to_json(a.*) AS r FROM assets a WHERE a.id = ${assetId} AND a.account_id = ${accountId} AND a.deleted_at IS NULL`);
  if (!r) return null;
  return typeof r.r === 'string' ? JSON.parse(r.r) as AssetDataRow : r.r;
}

/**
 * Décision utilisateur rattachée à l'Opération (lot 42, B19 : « persistée
 * comme source explicite ») : source `USER_ARBITRATION` dont le `locator`
 * porte `decision` — `CLAIM_PARENT` (parent Sinistre choisi ou écarté) ou
 * `AMOUNT` (montant retenu pour un fait économique contradictoire). Elle
 * éclaire la consolidation mais ne prouve pas l'existence (C5).
 */
export const DECISION_SOURCE_KIND = 'USER_ARBITRATION';

export const typeInput = (t: BusinessOperationTypeCode | null): OperationTypeInput =>
  t === null ? null : t === 'OTHER'
    ? { code: 'OTHER', qualification: { confidence: 'certain', reason: 'T1_TYPE_HINT_OTHER_CERTAIN' } }
    : { code: t };

/**
 * Contribution d'une source gérée par T3 (null : obsolète) :
 *   · DOCUMENT : identité de son candidat ACTIF ;
 *   · ASSET_DATA (lot 43) : réalité que les données structurées du bien
 *     établissent ENCORE (valeur effacée, devenue automatique, statut quitté,
 *     bien supprimé → null, la source est retirée).
 */
async function contributionOf(tx: DbTx, accountId: number, s: OpSource, agenda?: AgendaContext): Promise<SourceContribution | { withdrawn: string } | null> {
  // Lot 47B : élément d'agenda saisi / corrigé par l'utilisateur (garde
  // anti-blanchiment et règles de contribution : `agenda-source.ts`).
  if (s.managed && s.kind === 'AGENDA' && agenda && /^[0-9]{1,9}$/.test(s.entityKey)) {
    const item = await loadAgendaSourceItem(tx, accountId, Number(s.entityKey));
    const d = agendaContribution(item, agenda);
    return d.kind === 'CONTRIBUTES' ? { sourceId: s.id, identity: d.identity } : { withdrawn: d.reason };
  }
  if (s.managed && s.kind === 'ASSET_DATA' && s.nature !== null && /^[0-9]{1,9}$/.test(s.entityKey)) {
    const row = await loadAssetDataRow(tx, accountId, Number(s.entityKey));
    return row ? assetDataContribution(s.id, row, s.nature) : null;
  }
  if (!s.managed || s.key === null || !/^[0-9]{1,9}$/.test(s.entityKey)) return null;
  const fileId = Number(s.entityKey);
  const file = await loadFile(tx, accountId, fileId);
  if (!file || file.deleted || (file.documentTypeCode && NON_BUSINESS_DOCUMENT_TYPES.has(file.documentTypeCode))) return null;
  const [c] = (await loadCandidates(tx, accountId, fileId)).filter((x) => x.status === 'ACTIVE' && x.candidateKey === s.key && x.established);
  if (!c || c.confidence === 'conflictual') return null;
  const ids = targetIdsOf([c], file.assetId);
  const actx = await loadAssetContext(tx, accountId, ids.assets, ids.equipments);
  return {
    sourceId: s.id,
    identity: buildCandidateIdentity(c, { fileAssetId: file.assetId, liveAssetIds: actx.live, equipmentAssets: actx.equipments }),
  };
}

/**
 * Recalcule l'état consolidé d'une Opération depuis ses sources ACTIVES et
 * applique les seuls écarts (historisés par le dépôt). Une source gérée dont
 * le candidat n'est plus actif est retirée ; sans source active, l'Opération
 * est invalidée (décision PO, C8) et ses composantes deviennent inactives.
 */
export async function reconsolidateOperation(
  repo: BusinessOperationRepository, tx: DbTx, operationId: number, today: string, changes: Changes = new Changes(),
  cards: OperationCardNeeds = emptyCardNeeds(),
): Promise<void> {
  const accountId = repo.accountId;
  const op = await repo.load(operationId, { allowInactive: true, allowMerged: true });
  if (!cards.reviewedOperations.includes(operationId)) cards.reviewedOperations.push(operationId);
  if (op.mergedIntoOperationId !== null) return;

  const srcRows = await rows<Row>(tx, sql`
    SELECT id, source_kind, source_entity_key, locator->>'candidateKey' AS key,
           CASE WHEN source_kind = 'ASSET_DATA' THEN locator->>'nature' END AS nature,
           CASE WHEN source_kind = 'AGENDA' THEN locator->>'agenda' END AS agenda,
           CASE WHEN source_kind = ${DECISION_SOURCE_KIND} AND locator ? 'decision' THEN locator END AS decision
      FROM business_operation_sources WHERE operation_id = ${operationId} AND account_id = ${accountId} AND active ORDER BY id`);
  const sources: OpSource[] = srcRows.map((x) => ({
    id: Number(x.id), kind: String(x.source_kind), entityKey: String(x.source_entity_key), key: (x.key as string | null) ?? null,
    nature: (x.nature as string | null) ?? null,
    // Lot 43 : une donnée structurée du bien (ASSET_DATA + nature) est gérée par T3 comme un candidat.
    // Lot 47B : un élément d'agenda de l'utilisateur (AGENDA + locator.agenda) aussi.
    managed: (x.source_kind === 'DOCUMENT' && x.key !== null) || (x.source_kind === 'ASSET_DATA' && x.nature !== null)
      || (x.source_kind === 'AGENDA' && x.agenda !== null),
    decision: (x.decision as Record<string, unknown> | null) ?? null,
  }));
  const decisions = sources.filter((x) => x.decision !== null);
  // Lot 47B (TRG-014, F-087) : une annulation d'agenda ne vaut que si rien d'autre ne prouve l'Opération.
  const agendaCtx: AgendaContext = {
    operationId, operationType: op.typeCode, today,
    otherSupport: sources.some((x) => x.kind !== 'AGENDA' && x.decision === null),
  };
  const contributions: SourceContribution[] = [];
  for (const s of sources.filter((x) => x.managed)) {
    const c = await contributionOf(tx, accountId, s, agendaCtx);
    if (c && 'identity' in c) contributions.push(c);
    else changes.track(await repo.deactivateSource(s.id, withdrawReason(s.kind, c && 'withdrawn' in c ? c.withdrawn : undefined)));
  }
  // Une décision utilisateur n'est ni une preuve gérée ni un soutien d'existence.
  const unmanaged = sources.filter((s) => !s.managed && s.decision === null).length;
  const activeIds = new Set(contributions.map((c) => c.sourceId));
  // Sources gérées (actives ou non) : provenance des liens / références / composantes que T3 maintient.
  const managedIds = new Set((await rows<{ id: string }>(tx, sql`
    SELECT id FROM business_operation_sources WHERE operation_id = ${operationId} AND account_id = ${accountId}
       AND ((source_kind = 'DOCUMENT' AND locator ? 'candidateKey') OR (source_kind = 'ASSET_DATA' AND locator ? 'nature')
            OR (source_kind = 'AGENDA' AND locator ? 'agenda'))`)).map((x) => Number(x.id)));

  if (contributions.length === 0) {
    // Plus aucune preuve documentaire : composantes qu'elles soutenaient inactives
    // (F-107, C9.1) ; sans autre source, Opération invalidée (F-064, décision PO C8).
    await syncComponents(repo, tx, operationId, managedIds, [], changes);
    if (unmanaged === 0) changes.track(await repo.invalidateIfUnsupported(operationId, 'T3_NO_ACTIVE_SOURCE'));
    return;
  }
  if (op.invalidatedAt !== null) changes.track(await repo.reactivate(operationId, 'T3_SOURCE_RESTORED'));

  // Montants retenus par l'utilisateur (carte « montant contradictoire ») : la plus récente par empreinte.
  const amountChoices = new Map<string, AmountChoice>();
  for (const d of decisions) {
    const v = d.decision as { decision?: unknown; fingerprint?: unknown; amountMinor?: unknown; currency?: unknown; known?: unknown };
    if (v.decision === 'AMOUNT' && typeof v.fingerprint === 'string' && typeof v.amountMinor === 'number' && typeof v.currency === 'string') {
      const known = Array.isArray(v.known) ? (v.known as Array<{ amountMinor: number; currency: string }>) : undefined;
      amountChoices.set(v.fingerprint, { amountMinor: v.amountMinor, currency: v.currency, ...(known ? { known } : {}) });
    }
  }
  // Lot 53D (D2) : devise confirmée par l'utilisateur pour un montant « XXX » (la plus récente par empreinte).
  const currencyChoices = new Map<string, CurrencyChoice>();
  for (const d of decisions) {
    const v = d.decision as { decision?: unknown; fingerprint?: unknown; currency?: unknown };
    if (v.decision === 'CURRENCY' && typeof v.fingerprint === 'string') {
      currencyChoices.set(v.fingerprint, { currency: typeof v.currency === 'string' ? v.currency : null });
    }
  }
  // Lot 43 : la donnée saisie sur la fiche prime pour le fait qu'elle porte
  // (date, prix d'achat, prix de vente) — jamais deux montants pour un même achat.
  // Lot 47B (C19) : la saisie Agenda de l'utilisateur prime pour les dates qu'elle porte.
  const state = applyAgendaAuthority(
    applyStructuredAuthority(consolidateOperationState(op.typeCode, contributions, today, amountChoices), contributions), contributions,
    agendaCtx.otherSupport);
  state.components = applyCurrencyChoices(state.components, currencyChoices);
  const fullyManaged = unmanaged === 0;

  // Type nul qualifié (F-054) ; lot 48 (C7.7, F-055) : OTHER requalifié vers un type connu, même identifiant.
  if ((op.typeCode === null || op.typeCode === 'OTHER') && state.type !== null && state.type !== op.typeCode) {
    changes.track(await repo.setType(operationId, typeInput(state.type), 'T3_TYPE_QUALIFIED'));
  }

  // Statut (C8, B7) : REALIZED → CANCELLED interdit (l'Opération reste réalisée) ;
  // REALIZED → ENVISAGED seulement après retrait de la preuve de réalisation.
  if (state.status !== op.status) {
    if (op.status === 'REALIZED' && state.status === 'ENVISAGED') {
      if (fullyManaged) changes.track(await repo.setStatus(operationId, 'ENVISAGED', { reasonCode: state.realizationProven ? 'T3_EFFECTIVE_DATE_FUTURE' : 'T3_REALIZATION_PROOF_WITHDRAWN', transition: 'REALIZATION_PROOF_WITHDRAWN' }));
    } else if (!(op.status === 'REALIZED' && state.status === 'CANCELLED')) {
      changes.track(await repo.setStatus(operationId, state.status, { reasonCode: 'T3_STATUS_PROVEN' }));
    }
  }

  // Dates (C11.1) : recalculées depuis les sources ; prestataire seulement s'il manque.
  const attrs: Parameters<BusinessOperationRepository['updateAttributes']>[1] = {};
  // Lot 47B (C19) : une date portée par une source AGENDA de l'utilisateur
  // s'applique même à côté de sources non gérées (correction explicite).
  const agendaDates = contributions.some((c) => c.identity.agenda);
  for (const k of ['plannedDate', 'startDate', 'realizedDate', 'endDate'] as const) {
    if (fullyManaged || op[k] === null) attrs[k] = state[k];
    else if (agendaDates && (k === 'plannedDate' || k === 'realizedDate') && state[k] !== null) attrs[k] = state[k];
  }
  if (op.provider === null && state.provider) attrs.provider = state.provider;
  changes.track(await repo.updateAttributes(operationId, attrs, 'T3_ATTRIBUTES_CONSOLIDATED'));

  // Lot 53 (retour PO Q17) : un bien retiré du sinistre par l'utilisateur n'est
  // jamais relié à nouveau automatiquement ; un document non arbitré qui le
  // cite → carte de décision (document à l'origine).
  let assetsVoulus = state.assets;
  if (op.typeCode === 'CLAIM') {
    const exclusions = await loadActiveExclusions(tx, accountId, operationId);
    if (exclusions.length) {
      const fichiers = new Map(sources.filter((x) => x.managed && x.kind === 'DOCUMENT').map((x) => [x.id, Number(x.entityKey)]));
      const citations = contributions.flatMap((c) => {
        const f = fichiers.get(c.sourceId);
        return f === undefined ? [] : c.identity.assetIds.map((assetId) => ({ assetId, fileId: f }));
      });
      const r = applyAssetExclusions(state.assets, citations, exclusions);
      assetsVoulus = r.assets;
      for (const k of r.conflicts) cards.exclusion.push({ operationId, assetId: k.assetId, fileIds: k.fileIds });
    }
  }
  await syncAssets(repo, tx, operationId, managedIds, assetsVoulus, changes);
  await syncEquipments(repo, tx, operationId, managedIds, state.equipments, changes);
  await syncReferences(repo, tx, operationId, managedIds, activeIds, state.references, changes);
  // Lot 44 (C19, Q4) : l'indemnité SAISIE d'un sinistre (formulaire ou ancien
  // formulaire migré) prime sur celle d'un document — jamais deux indemnités
  // pour un même sinistre.
  const userSaisie = op.typeCode === 'CLAIM' && sources.some((x) => x.kind === 'CLAIM_FORM' || x.kind === 'MIGRATION');
  const indemniteSaisie = userSaisie && (await rows(tx, sql`
    SELECT 1 FROM business_operation_financial_components c
     WHERE c.operation_id = ${operationId} AND c.active AND c.kind = 'INDEMNITY'
       AND NOT EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id
                        WHERE cs.component_id = c.id AND s.source_kind NOT IN ('CLAIM_FORM', 'MIGRATION')) LIMIT 1`)).length > 0;
  await syncComponents(repo, tx, operationId, managedIds, indemniteSaisie ? state.components.filter((c) => c.kind !== 'INDEMNITY') : state.components, changes);
  await syncDetails(repo, tx, operationId, state, changes, userSaisie);
  // Lot 53D (D9) : frais annexes et écarts document / saisie, conservés hors total.
  await syncSideAmounts(tx, repo.accountId, operationId, state.sideAmounts ?? []);


  // Lot 42 (B19, ch. 20) : montant contradictoire de même rôle entre preuves
  // de même autorité → question à l'utilisateur (la valeur de la plus ancienne
  // preuve reste retenue d'ici là : aucune donnée économique ambiguë modifiée).
  const fichierDe = new Map(sources.filter((x) => x.managed && x.kind === 'DOCUMENT').map((x) => [x.id, Number(x.entityKey)]));
  for (const c of state.amountConflicts.filter((x) => !x.resolvedByUser)) {
    const options = c.options.map((o) => ({
      amountMinor: o.amountMinor, currency: o.currency,
      fileIds: [...new Set(o.sourceIds.map((id) => fichierDe.get(id)).filter((f): f is number => f !== undefined))],
    }));
    const recent = Math.max(...c.options.flatMap((o) => o.sourceIds));
    const fileId = fichierDe.get(recent);
    if (fileId !== undefined) cards.amount.push({ operationId, fileId, fingerprint: c.fingerprint, kind: c.kind, options, retained: c.retained });
  }

  // Lot 53D (D2) : montant dont la devise n'est pas établie → question
  // « À traiter » (hors agrégats EUR d'ici là) ; « je ne sais pas » n'est
  // plus reproposé.
  for (const c of state.components.filter((x) => x.currency === 'XXX' && !currencyChoices.has(x.fingerprint))) {
    const fileId = c.sourceIds.map((id) => fichierDe.get(id)).find((f): f is number => f !== undefined);
    if (fileId !== undefined) {
      cards.currency.push({
        operationId, fileId, fingerprint: c.fingerprint, kind: c.kind, amountMinor: c.amountMinor,
        candidates: c.currencyCandidates?.length ? c.currencyCandidates : ['EUR'],
      });
    }
  }

  await consolidateClaimParent(repo, tx, operationId, state, decisions, sources, cards, changes);
}

/**
 * Parent Sinistre d'une INTERVENTION (C8.1 PARENT-005, B19, ch. 20, lot 42) :
 *   · décision utilisateur (`CLAIM_PARENT`) : appliquée si le Sinistre choisi
 *     est encore actif ; « aucun » n'est plus reproposé ;
 *   · sinon référence de sinistre EXACTE citée par une preuve de
 *     l'intervention : un seul Sinistre actif la porte → parent posé ; deux
 *     ou plus → question « À traiter » (ambiguïté à impact fort) ;
 *   · un parent déjà posé n'est jamais remplacé automatiquement.
 */
async function consolidateClaimParent(
  repo: BusinessOperationRepository, tx: DbTx, operationId: number, state: ReturnType<typeof consolidateOperationState>,
  decisions: OpSource[], sources: OpSource[], cards: OperationCardNeeds, changes: Changes,
): Promise<void> {
  const op = await repo.load(operationId, { allowInactive: true });
  if (op.typeCode !== 'INTERVENTION' || op.invalidatedAt !== null) return;
  if (op.parentOperationId !== null) {
    // Lot 53 (retour PO D11) : un parent déjà posé n'est jamais retiré
    // automatiquement ; s'il ne tient plus qu'à une facture retirée des
    // actions du sinistre, l'utilisateur est consulté.
    await reviewClaimParentJustification(tx, repo.accountId, operationId, op.parentOperationId, state, decisions, sources, cards);
    return;
  }
  const choix = [...decisions].reverse().find((d) => (d.decision as { decision?: unknown }).decision === 'CLAIM_PARENT');
  if (choix) {
    const parentId = (choix.decision as { parentOperationId?: unknown }).parentOperationId;
    if (typeof parentId === 'number') {
      const [p] = await rows<{ id: string }>(tx, sql`
        SELECT COALESCE(merged_into_operation_id, id) AS id FROM business_operations
         WHERE id = ${parentId} AND account_id = ${repo.accountId}`);
      const cible = p ? Number(p.id) : null;
      const [actif] = cible !== null ? await rows(tx, sql`
        SELECT 1 FROM business_operations WHERE id = ${cible} AND type_code = 'CLAIM' AND invalidated_at IS NULL`) : [];
      if (cible !== null && actif) changes.track(await repo.setParent(operationId, cible, 'USER_CLAIM_PARENT'));
    }
    return;
  }
  // Lot 44 (C14.2, F-152) : facture désignée par une action d'un sinistre —
  // désignation EXPLICITE de l'utilisateur, donc certaine : l'intervention
  // prouvée par cette facture devient enfant de ce sinistre (un seul).
  const factures = sources.filter((x) => x.managed && x.kind === 'DOCUMENT').map((x) => Number(x.entityKey)).filter((n) => Number.isSafeInteger(n));
  if (factures.length) {
    const parActions = (await rows<{ id: string }>(tx, sql`
      SELECT DISTINCT o.id FROM business_operation_claim_actions a
        JOIN business_operations o ON o.id = a.operation_id
       WHERE o.account_id = ${repo.accountId} AND o.type_code = 'CLAIM' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
         AND a.invoice_file_id = ANY(${intArray(factures)}::int[])
       ORDER BY o.id`)).map((x) => Number(x.id));
    if (parActions.length === 1) {
      changes.track(await repo.setParent(operationId, parActions[0], 'CLAIM_ACTION_INVOICE'));
      await tx.execute(sql`
        UPDATE business_operation_claim_actions SET child_operation_id = ${operationId}
         WHERE operation_id = ${parActions[0]} AND child_operation_id IS NULL AND invoice_file_id = ANY(${intArray(factures)}::int[])`);
      return;
    }
  }
  const refs = state.references.filter((r) => r.kind === 'CLAIM').map((r) => r.normalized);
  if (!refs.length) return;
  const claims = (await rows<{ id: string }>(tx, sql`
    SELECT DISTINCT o.id FROM business_operations o
      JOIN business_operation_references r ON r.operation_id = o.id AND r.active AND r.reference_kind = 'CLAIM'
     WHERE o.account_id = ${repo.accountId} AND o.type_code = 'CLAIM' AND o.invalidated_at IS NULL AND o.id <> ${operationId}
       AND r.normalized_value = ANY(${textArray(refs)}::text[])
     ORDER BY o.id DESC`)).map((x) => Number(x.id));
  if (claims.length === 1) {
    changes.track(await repo.setParent(operationId, claims[0], 'T3_PARENT_CLAIM_REFERENCE'));
    return;
  }
  if (claims.length > 1) {
    const porteuse = [...sources].reverse().find((x) => x.managed && x.kind === 'DOCUMENT' && state.references.some((r) => r.kind === 'CLAIM' && r.sourceId === x.id))
      ?? [...sources].reverse().find((x) => x.managed && x.kind === 'DOCUMENT');
    if (porteuse) cards.parent.push({ operationId, fileId: Number(porteuse.entityKey), claimIds: claims });
  }
}

/**
 * Lot 53 (retour PO D11) — le rattachement d'une intervention à son sinistre
 * est-il encore justifié ? Seuls les rattachements posés par la FACTURE d'une
 * action (`CLAIM_ACTION_INVOICE`) sont réexaminés. Justifié si l'un de ces
 * éléments subsiste : une action du sinistre désigne encore une facture de
 * l'intervention ; une référence de sinistre commune ; une décision
 * utilisateur qui confirme ce sinistre. Sinon : carte « À traiter » (garder /
 * dissocier) — jamais de dissociation automatique.
 */
async function reviewClaimParentJustification(
  tx: DbTx, accountId: number, operationId: number, parentId: number, state: ReturnType<typeof consolidateOperationState>,
  decisions: OpSource[], sources: OpSource[], cards: OperationCardNeeds,
): Promise<void> {
  const [parent] = await rows<{ type_code: string | null }>(tx, sql`
    SELECT type_code FROM business_operations WHERE id = ${parentId} AND account_id = ${accountId} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL`);
  if (parent?.type_code !== 'CLAIM') return;
  const [pose] = await rows<{ reason_code: string }>(tx, sql`
    SELECT reason_code FROM business_operation_history
     WHERE operation_id = ${operationId} AND account_id = ${accountId} AND event_type = 'PARENT_CHANGED'
       AND (after_json->>'parent_operation_id')::bigint = ${parentId}
     ORDER BY id DESC LIMIT 1`);
  if (pose?.reason_code !== 'CLAIM_ACTION_INVOICE') return;
  // Décision utilisateur confirmant ce sinistre (carte « garder » ou parent choisi).
  if (decisions.some((d) => (d.decision as { decision?: unknown; parentOperationId?: unknown }).decision === 'CLAIM_PARENT'
    && (d.decision as { parentOperationId?: unknown }).parentOperationId === parentId)) return;
  const factures = sources.filter((x) => x.managed && x.kind === 'DOCUMENT').map((x) => Number(x.entityKey)).filter((n) => Number.isSafeInteger(n));
  if (factures.length) {
    const [action] = await rows(tx, sql`
      SELECT 1 FROM business_operation_claim_actions WHERE operation_id = ${parentId} AND invoice_file_id = ANY(${intArray(factures)}::int[]) LIMIT 1`);
    if (action) return;
  }
  const refs = state.references.filter((r) => r.kind === 'CLAIM').map((r) => r.normalized);
  if (refs.length) {
    const [commune] = await rows(tx, sql`
      SELECT 1 FROM business_operation_references WHERE operation_id = ${parentId} AND active AND reference_kind = 'CLAIM'
         AND normalized_value = ANY(${textArray(refs)}::text[]) LIMIT 1`);
    if (commune) return;
  }
  const porteuse = factures.at(-1);
  if (porteuse !== undefined) cards.detach.push({ operationId, claimId: parentId, fileId: porteuse });
}

async function syncAssets(
  repo: BusinessOperationRepository, tx: DbTx, opId: number, managed: Set<number>,
  desired: ReturnType<typeof consolidateOperationState>['assets'], changes: Changes,
): Promise<void> {
  const cur = await rows<{ asset_id: number; link_role: string; src: string | null }>(tx, sql`
    SELECT asset_id, link_role, source_operation_source_id AS src FROM business_operation_asset_links WHERE operation_id = ${opId} AND active`);
  const voulus = new Set(desired.map((d) => d.assetId));
  // Cible corrigée (C10) : un lien posé par T3 qui n'est plus soutenu est retiré.
  for (const l of cur) {
    if (!voulus.has(Number(l.asset_id)) && l.src !== null && managed.has(Number(l.src))) {
      changes.track(await repo.detachAsset(opId, Number(l.asset_id), 'T3_TARGET_WITHDRAWN'));
    }
  }
  const role = desired.length === 1 ? 'PRIMARY' : 'CONCERNED';
  for (const d of desired) {
    changes.track(await repo.linkAsset(opId, { assetId: d.assetId, role, authority: d.authority, sourceId: d.sourceId }, 'T3_TARGET_LINKED'));
  }
}

async function syncEquipments(
  repo: BusinessOperationRepository, tx: DbTx, opId: number, managed: Set<number>,
  desired: ReturnType<typeof consolidateOperationState>['equipments'], changes: Changes,
): Promise<void> {
  const cur = await rows<{ equipment_id: number; src: string | null }>(tx, sql`
    SELECT equipment_id, source_operation_source_id AS src FROM business_operation_equipment_links WHERE operation_id = ${opId} AND active`);
  const voulus = new Set(desired.map((d) => d.equipmentId));
  for (const l of cur) {
    if (!voulus.has(Number(l.equipment_id)) && l.src !== null && managed.has(Number(l.src))) {
      changes.track(await repo.unlinkEquipment(opId, Number(l.equipment_id), 'T3_TARGET_WITHDRAWN'));
    }
  }
  for (const d of desired) {
    changes.track(await repo.linkEquipment(opId, { equipmentId: d.equipmentId, authority: 'DOCUMENT', sourceId: d.sourceId }, 'T3_TARGET_LINKED'));
  }
}

async function syncReferences(
  repo: BusinessOperationRepository, tx: DbTx, opId: number, managed: Set<number>, active: Set<number>,
  desired: ReturnType<typeof consolidateOperationState>['references'], changes: Changes,
): Promise<void> {
  const cur = await rows<{ id: string; reference_kind: string; normalized_value: string; active: boolean; source_id: string | null }>(tx, sql`
    SELECT id, reference_kind, normalized_value, active, source_id FROM business_operation_references WHERE operation_id = ${opId}`);
  const cle = (k: string, v: string) => `${k}:${v}`;
  const voulus = new Map(desired.map((d) => [cle(d.kind, d.normalized), d]));
  for (const r of cur) {
    const d = voulus.get(cle(r.reference_kind, r.normalized_value));
    if (!r.active || r.source_id === null || !managed.has(Number(r.source_id))) continue;
    if (!d) changes.track(await repo.deactivateReference(Number(r.id), 'T3_REFERENCE_WITHDRAWN'));
    else if (!active.has(Number(r.source_id))) await repo.repointReference(Number(r.id), d.sourceId);
  }
  for (const d of desired) {
    changes.track(await repo.addReference(opId, { kind: d.kind, value: d.value, sourceId: d.sourceId }, 'T3_REFERENCE_ADDED'));
  }
}

interface CurrentComponent {
  id: number; fingerprint: string | null; kind: string; amount_minor: number; currency: string; amount_eur_cents: number | null;
  economic_date: string | null; period_start: string | null; period_end: string | null;
  target_asset_id: number | null; target_equipment_id: number | null; label: string | null; sources: number[];
}

async function syncComponents(
  repo: BusinessOperationRepository, tx: DbTx, opId: number, managed: Set<number>,
  desired: ReturnType<typeof consolidateOperationState>['components'], changes: Changes,
): Promise<void> {
  const cur = (await rows<Row>(tx, sql`
    SELECT c.id, c.fingerprint, c.kind, c.amount_minor, c.currency, c.amount_eur_cents, c.economic_date::text AS economic_date,
           c.period_start::text AS period_start, c.period_end::text AS period_end, c.target_asset_id, c.target_equipment_id, c.label,
           COALESCE(array_agg(cs.operation_source_id) FILTER (WHERE cs.operation_source_id IS NOT NULL), '{}') AS sources
      FROM business_operation_financial_components c
      LEFT JOIN business_operation_financial_component_sources cs ON cs.component_id = c.id
     WHERE c.operation_id = ${opId} AND c.active
     GROUP BY c.id`)).map((x) => ({
    ...(x as unknown as CurrentComponent), id: Number(x.id), amount_minor: Number(x.amount_minor),
    sources: ((x.sources as Array<string | number>) ?? []).map(Number),
  }));
  // Composante gérée par T3 : empreinte, et toutes ses preuves sont des sources documentaires gérées.
  const geree = (c: CurrentComponent) => c.fingerprint !== null && c.sources.every((s) => managed.has(s));
  const parFp = new Map(cur.filter((c) => c.fingerprint !== null).map((c) => [c.fingerprint as string, c]));
  const voulues = new Set(desired.map((d) => d.fingerprint));

  for (const c of cur) {
    if (geree(c) && !voulues.has(c.fingerprint as string)) {
      changes.track(await repo.supersedeFinancialComponent(c.id, 'T3_COMPONENT_WITHDRAWN'));
    }
  }
  for (const d of desired) {
    const c = parFp.get(d.fingerprint);
    const memes = c && c.kind === d.kind && Number(c.amount_minor) === d.amountMinor && String(c.currency).trim() === d.currency
      && num(c.amount_eur_cents) === (d.amountEurCents ?? null) && c.economic_date === d.economicDate && c.period_start === d.periodStart
      && c.period_end === d.periodEnd && c.target_asset_id === null && c.target_equipment_id === null && c.label === d.label;
    if (c && memes) {
      for (const s of d.sourceIds) if (!c.sources.includes(s)) await repo.attachComponentSource(c.id, s);
      for (const s of c.sources) if (managed.has(s) && !d.sourceIds.includes(s)) await repo.detachComponentSource(c.id, s);
      continue;
    }
    // Nouvelle composante, ou même fait économique dont la valeur change :
    // l'ancienne est supersédée, jamais additionnée (C12.1, F-062).
    await repo.addFinancialComponent(opId, {
      kind: d.kind, amountMinor: d.amountMinor, currency: d.currency, amountEurCents: d.amountEurCents ?? null,
      economicDate: d.economicDate, periodStart: d.periodStart, periodEnd: d.periodEnd, label: d.label,
      fingerprint: d.fingerprint, sources: d.sourceIds.map((sourceId, i) => ({ sourceId, isPrimary: i === 0 })),
    }, 'T3_COMPONENT_CONSOLIDATED');
    changes.track(true);
  }
}

/**
 * Lot 53D (D9) : montants hors total de l'Opération (`business_operation_side_amounts`,
 * 0351) — remplacés par l'état consolidé, sans écriture quand rien ne change.
 * Table absente (migration non appliquée) : rien n'est écrit (code tolérant).
 */
async function syncSideAmounts(tx: DbTx, accountId: number, opId: number, desired: readonly SideAmount[]): Promise<void> {
  const [t] = await rows<{ ok: boolean }>(tx, sql`SELECT to_regclass('business_operation_side_amounts') IS NOT NULL AS ok`);
  if (!t?.ok) return;
  const cur = await rows<Row>(tx, sql`
    SELECT id, nature, fingerprint, kind, amount_minor, currency, amount_eur_cents, economic_date::text AS economic_date, source_ids
      FROM business_operation_side_amounts WHERE operation_id = ${opId} AND account_id = ${accountId}`);
  const cle = (n: string, f: string) => `${n}|${f}`;
  const voulus = new Map(desired.map((d) => [cle(d.nature, d.fingerprint), d]));
  for (const c of cur) {
    const d = voulus.get(cle(String(c.nature), String(c.fingerprint)));
    const memes = d && d.kind === c.kind && d.amountMinor === Number(c.amount_minor) && d.currency === String(c.currency).trim()
      && (d.amountEurCents ?? null) === num(c.amount_eur_cents) && (d.economicDate ?? null) === (c.economic_date ?? null)
      && [...d.sourceIds].sort((a, b) => a - b).join(',') === ((c.source_ids as Array<string | number>) ?? []).map(Number).sort((a, b) => a - b).join(',');
    if (memes) { voulus.delete(cle(d.nature, d.fingerprint)); continue; }
    await tx.execute(sql`DELETE FROM business_operation_side_amounts WHERE id = ${Number(c.id)} AND account_id = ${accountId}`);
  }
  for (const d of voulus.values()) {
    await tx.execute(sql`
      INSERT INTO business_operation_side_amounts
        (account_id, operation_id, nature, kind, fingerprint, amount_minor, currency, amount_eur_cents, economic_date, source_ids)
      VALUES (${accountId}, ${opId}, ${d.nature}, ${d.kind}, ${d.fingerprint}, ${d.amountMinor}, ${d.currency}, ${d.amountEurCents ?? null},
              ${d.economicDate ?? null}, ${intArray(d.sourceIds)}::bigint[])`);
  }
}

async function syncDetails(
  repo: BusinessOperationRepository, tx: DbTx, opId: number, state: ReturnType<typeof consolidateOperationState>, changes: Changes,
  /** Lot 44 : sinistre saisi (CLAIM_FORM / MIGRATION) — la saisie prime, un document ne fait que compléter. */
  userClaim = false,
): Promise<void> {
  const op = await repo.load(opId, { allowInactive: true });
  if (op.typeCode === 'CONTRACT' && state.contract) {
    const [d] = await rows<Row>(tx, sql`
      SELECT contract_reference, periodicity, effective_from::text AS effective_from, effective_to::text AS effective_to
        FROM business_operation_contract_details WHERE operation_id = ${opId}`);
    const v = {
      contractReference: state.contract.contractReference ?? (d?.contract_reference as string | null) ?? null,
      periodicity: (d?.periodicity as never) ?? null,
      effectiveFrom: state.contract.effectiveFrom ?? (d?.effective_from as string | null) ?? null,
      effectiveTo: state.contract.effectiveTo ?? (d?.effective_to as string | null) ?? null,
    };
    if (d || v.contractReference || v.effectiveFrom || v.effectiveTo) changes.track(await repo.upsertContractDetails(opId, v, 'T3_DETAILS_CONSOLIDATED'));
  }
  if (op.typeCode === 'FINANCING' && state.financing) {
    const [d] = await rows<Row>(tx, sql`
      SELECT financing_reference, lender, principal_amount_minor, principal_currency, effective_from::text AS effective_from, effective_to::text AS effective_to
        FROM business_operation_financing_details WHERE operation_id = ${opId}`);
    const v = {
      financingReference: state.financing.financingReference ?? (d?.financing_reference as string | null) ?? null,
      lender: (d?.lender as string | null) ?? state.financing.lender,
      // Lot 53D (Q16) : capital emprunté lu sur une source (jamais une dépense) ; à défaut, valeur en place.
      principalAmountMinor: state.financing.principalAmountMinor ?? num(d?.principal_amount_minor),
      principalCurrency: state.financing.principalAmountMinor != null
        ? state.financing.principalCurrency ?? null
        : (d?.principal_currency as string | null)?.trim() ?? null,
      effectiveFrom: state.financing.effectiveFrom ?? (d?.effective_from as string | null) ?? null,
      effectiveTo: state.financing.effectiveTo ?? (d?.effective_to as string | null) ?? null,
    };
    if (d || v.financingReference || v.lender || v.effectiveFrom || v.principalAmountMinor != null) changes.track(await repo.upsertFinancingDetails(opId, v, 'T3_DETAILS_CONSOLIDATED'));
  }
  if (op.typeCode === 'CLAIM' && state.claim) {
    const [d] = await rows<Row>(tx, sql`
      SELECT claim_type, declared_on::text AS declared_on, insurer_claim_ref, insurance_contract_operation_id, policy_reference_text,
             status, status_detail, circumstances, consequences, measures_summary, exchanges_summary, estimated_damage_minor
        FROM business_operation_claim_details WHERE operation_id = ${opId}`);
    const v = {
      claimType: (d?.claim_type as string | null) ?? null,
      declaredOn: (d?.declared_on as string | null) ?? null,
      insurerClaimRef: userClaim
        ? (d?.insurer_claim_ref as string | null) ?? state.claim.insurerClaimRef ?? null
        : state.claim.insurerClaimRef ?? (d?.insurer_claim_ref as string | null) ?? null,
      insuranceContractOperationId: num(d?.insurance_contract_operation_id),
      policyReferenceText: userClaim
        ? (d?.policy_reference_text as string | null) ?? state.claim.policyReferenceText ?? null
        : state.claim.policyReferenceText ?? (d?.policy_reference_text as string | null) ?? null,
      status: (d?.status as never) ?? null,
      statusDetail: (d?.status_detail as string | null) ?? null,
      circumstances: (d?.circumstances as string | null) ?? null,
      consequences: (d?.consequences as string | null) ?? null,
      measuresSummary: (d?.measures_summary as string | null) ?? null,
      exchangesSummary: (d?.exchanges_summary as string | null) ?? null,
      estimatedDamageMinor: num(d?.estimated_damage_minor),
    };
    if (d || v.insurerClaimRef || v.policyReferenceText) changes.track(await repo.upsertClaimDetails(opId, v, 'T3_DETAILS_CONSOLIDATED'));
  }
}

// ── Niveau M3 progressif (lot 53, retour PO D7) ────────────────────────────

/** Trace de l'examen M3 progressif d'un candidat (persistée dans `t3_detail`). */
export interface ProgressiveM3Trace {
  /** Empreinte du contexte du lot courant (null : plus rien à soumettre). */
  fingerprint: string | null;
  batch: number[];
  progress: M3Progress;
  selection: { examined: number[]; remaining: number[]; total: number };
}

/**
 * Décision « M3_REQUIRED » → lot courant de l'examen progressif et, si un
 * verdict enregistré porte l'empreinte de ce lot, son application (voir
 * `m3-progress.ts`). Au plus UN lot avance par consolidation : le lot
 * suivant est soumis au modèle au cycle suivant (reprise automatique).
 */
export async function resolveProgressiveM3(
  tx: DbTx, accountId: number, identity: CandidateIdentity, d: CandidateDecision,
  ctx: Pick<MatchContext, 'operations' | 'assetStatus' | 'userDistinct'>, t3Detail: Record<string, unknown> | null,
): Promise<{ decision: CandidateDecision; trace: ProgressiveM3Trace }> {
  const plausibles = ctx.operations.filter((o) => d.detail.plausible.includes(o.id));
  const ranked = rankPlausible(identity, plausibles);
  let progress = m3ProgressFor(t3Detail?.m3Progress, m3SubjectFingerprint(identity));
  const stored = (t3Detail?.m3 ?? null) as StoredM3 | null;
  for (let tour = 0; tour < 3; tour++) {
    const sel = selectM3Batch(ranked, progress, OPERATION_MATCH_MAX_CANDIDATES);
    const selection = { examined: sel.examined, remaining: sel.remaining, total: sel.total };
    if (!sel.batch.length) {
      // Toutes les Opérations plausibles ont été examinées et jugées distinctes.
      const verdict: OperationMatchVerdict = {
        decision: 'DISTINCT_OPERATION', matchedOperationId: null, confidence: 'certain',
        concordantSignals: [], contradictions: [], reason: 'ALL_CANDIDATES_EXAMINED_DISTINCT',
      };
      return { decision: applyM3Verdict(identity, d, verdict, ctx), trace: { fingerprint: null, batch: [], progress, selection } };
    }
    const m3 = await operationMatchContext(tx, accountId, identity, sel.batch);
    const trace: ProgressiveM3Trace = { fingerprint: m3.fingerprint, batch: sel.batch, progress, selection };
    if (stored?.status !== 'DONE' || stored.fingerprint !== m3.fingerprint || !stored.verdict) return { decision: d, trace };
    const v = stored.verdict as OperationMatchVerdict;
    if (v.decision === 'DISTINCT_OPERATION' && v.confidence === 'certain' && sel.remaining.length) {
      // Lot écarté avec certitude, d'autres Opérations restent : lot suivant (jamais de création ici).
      progress = advanceM3Progress(progress, sel.batch, stored.at);
      continue;
    }
    const applied = applyM3Verdict(identity, { ...d, detail: { ...d.detail, plausible: sel.batch } }, v, ctx);
    return { decision: { ...applied, detail: { ...applied.detail, plausible: d.detail.plausible } }, trace };
  }
  return { decision: d, trace: { fingerprint: null, batch: [], progress, selection: { examined: [], remaining: [], total: ranked.length } } };
}

// ── Un document (TRG-001 à TRG-007) ────────────────────────────────────────

/**
 * Consolide les candidats d'UN document, dans UNE transaction sous le verrou
 * du compte (voir l'en-tête). Une erreur d'intégrité (NFR-OP-008) annule la
 * transaction ; elle est journalisée et TRACÉE sur les candidats (HOLD
 * technique, jamais un « À traiter ») pour ne pas boucler à chaque passage.
 */
export async function consolidateDocument(accountId: number, fileId: number, opts: ConsolidationOptions = {}): Promise<FileConsolidationResult> {
  const today = opts.today ?? todayUtc();
  const result: FileConsolidationResult = { fileId, outcomes: {}, changes: 0, operations: [] };
  await opts.beforeWrite?.('consolidation des Opérations d\'un document');
  try {
    let cards = emptyCardNeeds();
    await withBusinessOperationWrite(accountId, async (repo, session) => {
      // Relance après conflit de transaction : besoins recalculés depuis zéro.
      cards = emptyCardNeeds();
      const changes = new Changes();
      const tx = session.tx;
      const file = await loadFile(tx, accountId, fileId);
      const valid = !!file && !file.deleted && !(file.documentTypeCode && NON_BUSINESS_DOCUMENT_TYPES.has(file.documentTypeCode));
      const cands = await loadCandidates(tx, accountId, fileId);
      await faultHook?.('document', { accountId, fileId });
      const actifs = cands.filter((c) => c.status === 'ACTIVE');
      const docSources = await loadDocumentSources(tx, accountId, fileId);
      const ids = targetIdsOf(actifs, file?.assetId ?? null);
      const actx = await loadAssetContext(tx, accountId, ids.assets, ids.equipments);

      const claimed = new Map<number, number>(); // sourceId -> operationId
      const createdHere = new Set<number>();
      const touched = new Set<number>(docSources.filter((s) => s.active && !s.opMerged).map((s) => s.operationId));
      const decisions = new Map<number, CandidateDecision>();
      const m3Fingerprints = new Map<number, string>();
      const m3Traces = new Map<number, ProgressiveM3Trace>();
      cards.reviewedFiles.push(fileId);

      for (const c of actifs) {
        const identity = buildCandidateIdentity(c, { fileAssetId: file?.assetId ?? null, liveAssetIds: actx.live, equipmentAssets: actx.equipments });
        let d: CandidateDecision;
        if (!valid) {
          d = { outcome: 'NO_OPERATION', operationId: null, matchMethod: null, reason: !file || file.deleted ? 'DOCUMENT_DELETED' : 'DOCUMENT_NOT_BUSINESS', detail: { certain: [], plausible: [], contradictions: [], excluded: [] } };
        } else {
          const memeSource = docSources.filter((s) => s.key === c.candidateKey && !s.opMerged && (s.active || s.opInvalidated));
          const dec = await loadDecisions(tx, accountId, fileId, c.candidateKey);
          const extra = [...new Set([...memeSource.map((s) => s.operationId), ...dec.confirmed])];
          const ops = (await loadMatchableOperations(tx, accountId, identity, extra))
            // Deux candidats d'un même document sont deux réalités distinctes (B8, F-027).
            .filter((o) => !createdHere.has(o.id))
            .map((o) => ({ ...o, sameSource: memeSource.some((s) => s.operationId === o.id) }));
          const ctx = {
            operations: ops, confirmed: dec.confirmed, rejected: dec.rejected, assetStatus: actx.status,
            userDistinct: dec.userDistinct, nonMergeable: await loadNonMergeable(tx, accountId, ops.map((o) => o.id)),
          };
          d = decideCandidate(identity, ctx);
          // Niveau M3 (C6.2) : verdict enregistré appliqué seulement si le contexte
          // est inchangé ; lot 53 (D7) : examen PROGRESSIF par lots de 5 au plus.
          if (d.reason === 'M3_REQUIRED') {
            const r = await resolveProgressiveM3(tx, accountId, identity, d, ctx, c.t3Detail);
            d = r.decision;
            m3Traces.set(c.id, r.trace);
            if (r.trace.fingerprint) m3Fingerprints.set(c.id, r.trace.fingerprint);
          }
        }
        decisions.set(c.id, d);
        result.outcomes[d.outcome] = (result.outcomes[d.outcome] ?? 0) + 1;
        if (d.outcome === 'ARBITRATION_REQUIRED' && d.arbitration) {
          cards.match.push({ fileId, candidateKey: c.candidateKey, basis: d.arbitration.basis, operationIds: d.arbitration.operationIds, typeHint: identity.type });
        }

        const source = {
          kind: 'DOCUMENT' as const, entityKey: fileId, version: c.version, role: identity.role,
          locator: { candidateKey: c.candidateKey }, authority: 'DOCUMENT' as const, confidence: identity.confidence,
        };
        if (d.outcome === 'CREATE_NEW') {
          // NFR-OP-002 : Opération + première source + cibles dans la transaction.
          const s = consolidateOperationState(identity.type, [{ sourceId: 0, identity }], today);
          const created = await repo.create({
            type: typeInput(s.type), status: s.status,
            plannedDate: s.plannedDate, startDate: s.startDate, realizedDate: s.realizedDate, endDate: s.endDate,
            provider: s.provider, technicalLabel: identity.summary.slice(0, 200) || null,
            source: { ...source, matchMethod: null, matchReason: d.reason },
            assets: s.assets.map((a) => ({ assetId: a.assetId, role: s.assets.length === 1 ? 'PRIMARY' : 'CONCERNED', authority: a.authority })),
            equipments: s.equipments.map((e) => ({ equipmentId: e.equipmentId, authority: 'DOCUMENT' as const })),
            reasonCode: 'T3_CREATE_NEW',
          });
          changes.track(true);
          d.operationId = created.id;
          createdHere.add(created.id);
          claimed.set(created.sourceId, created.id);
          touched.add(created.id);
        } else if (d.outcome === 'MATCH_AND_ENRICH' && d.operationId !== null) {
          const opId = d.operationId;
          // Fusion V1 (B8, F-049) : la source prouve que ces Opérations sont la même réalité.
          for (const absorbee of d.mergeIds ?? []) {
            if (await repo.mergeOperations(absorbee, opId, 'T3_MERGE_COMMON_REFERENCE', { onStep: opts.onMergeStep })) changes.track(true);
            touched.delete(absorbee);
            cards.reviewedOperations.push(absorbee);
          }
          const avant = await rows<{ id: string }>(tx, sql`
            SELECT id FROM business_operation_sources WHERE operation_id = ${opId} AND active`);
          const sourceId = await repo.addSource(opId, { ...source, matchMethod: d.matchMethod, matchReason: d.reason }, 'T3_MATCH_AND_ENRICH');
          if (!avant.some((x) => Number(x.id) === sourceId)) changes.track(true);
          await repo.refreshSourceVersion(sourceId, c.version);
          claimed.set(sourceId, opId);
          touched.add(opId);
        }
      }

      // C9 : contributions du document qu'aucun candidat ne revendique plus.
      for (const s of docSources) {
        if (s.active && !claimed.has(s.id)) {
          changes.track(await repo.deactivateSource(s.id, valid ? 'T3_SOURCE_WITHDRAWN' : !file || file.deleted ? 'DOCUMENT_DELETED' : 'DOCUMENT_RECLASSIFIED'));
          touched.add(s.operationId);
        }
      }
      for (const opId of [...touched].sort((a, b) => a - b)) {
        await reconsolidateOperation(repo, tx, opId, today, changes, cards);
      }

      // Trace de la décision, marqueur T3 levé (aucune écriture si rien ne change).
      for (const c of cands) {
        const d = decisions.get(c.id);
        if (!d) {
          if (c.t3Pending) await tx.execute(sql`UPDATE document_operation_candidates SET t3_pending = false, t3_processed_at = now() WHERE id = ${c.id}`);
          continue;
        }
        const fp = m3Fingerprints.get(c.id) ?? null;
        const ancien = c.t3Detail ?? {};
        const trace = m3Traces.get(c.id) ?? null;
        const memeArbitrage = JSON.stringify(ancien.arbitration ?? null) === JSON.stringify(d.arbitration ?? null);
        // Lot 53 (D7) : lot courant et progression de l'examen M3 (diagnostic BO, reprise).
        const m3Batch = trace && trace.batch.length ? trace.batch : null;
        const m3Progress = trace && (trace.progress.rounds > 0 || trace.selection.total > OPERATION_MATCH_MAX_CANDIDATES)
          ? { ...trace.progress, total: trace.selection.total, remaining: trace.selection.remaining.length }
          : null;
        const memeProgression = JSON.stringify(ancien.m3Batch ?? null) === JSON.stringify(m3Batch)
          && JSON.stringify(ancien.m3Progress ?? null) === JSON.stringify(m3Progress);
        if (!c.t3Pending && c.t3Outcome === d.outcome && c.t3Reason === d.reason && c.t3OperationId === d.operationId
          && (ancien.m3Fingerprint ?? null) === fp && memeArbitrage && memeProgression) continue;
        // La trace M3 (verdict, report…) survit aux passages suivants : elle n'est
        // remplacée que par la phase M3 elle-même.
        const detail = {
          matchMethod: d.matchMethod, ...d.detail,
          ...(d.mergeIds?.length ? { mergeIds: d.mergeIds } : {}),
          ...(d.arbitration ? { arbitration: d.arbitration } : {}),
          ...(fp ? { m3Fingerprint: fp } : {}),
          ...(m3Batch ? { m3Batch } : {}),
          ...(m3Progress ? { m3Progress } : {}),
          ...(ancien.m3 ? { m3: ancien.m3 } : {}),
        };
        await tx.execute(sql`
          UPDATE document_operation_candidates
             SET t3_pending = false, t3_processed_at = now(), t3_outcome = ${d.outcome}, t3_reason = ${d.reason},
                 t3_operation_id = ${d.operationId}, t3_detail = ${JSON.stringify(detail)}::jsonb
           WHERE id = ${c.id}`);
      }
      // Lot 54D (E01) : consolidation réussie — la reprise programmée est levée,
      // la cause reste lisible au BO (`resolvedAt`). Aucune écriture sinon.
      await tx.execute(sql`
        UPDATE document_operation_candidates
           SET t3_error_attempts = 0, t3_retry_at = NULL,
               t3_last_error = CASE WHEN t3_last_error IS NOT NULL AND NOT (t3_last_error ? 'resolvedAt')
                                    THEN t3_last_error || jsonb_build_object('resolvedAt', now()) ELSE t3_last_error END
         WHERE file_id = ${fileId} AND account_id = ${accountId} AND (t3_error_attempts > 0 OR t3_retry_at IS NOT NULL)`);
      result.changes = changes.n;
      result.operations = [...touched].sort((a, b) => a - b);
    }, { correlationId: opts.correlationId });
    result.cards = cards;
    if (opts.syncCards !== false) await syncCards(accountId, cards);
  } catch (e) {
    if (!isBusinessOperationIntegrityError(e)) throw e;
    // NFR-OP-008 : erreur technique journalisée. Lot 54D (E01) : distincte d'une
    // décision métier (motif `TECHNICAL_ERROR:<code>`), cause / candidat / compte /
    // job conservés, reprise AUTOMATIQUE programmée (backoff borné) — jamais un
    // succès silencieux, jamais une boucle (au plus T3_TECHNICAL_RETRY_MAX tentatives).
    console.error(`[t3-operations] document ${fileId} (compte ${accountId}) : ${e.message}`);
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `UPDATE document_operation_candidates
          SET t3_pending = false, t3_processed_at = now(), t3_outcome = CASE WHEN status = 'ACTIVE' THEN 'HOLD_UNRESOLVED' ELSE t3_outcome END,
              t3_reason = CASE WHEN status = 'ACTIVE' THEN $3 ELSE t3_reason END,
              t3_error_attempts = CASE WHEN status = 'ACTIVE' THEN t3_error_attempts + 1 ELSE t3_error_attempts END,
              t3_retry_at = CASE WHEN status = 'ACTIVE' AND t3_error_attempts + 1 <= $6
                                 THEN now() + make_interval(mins => LEAST(360, 5 * power(2, t3_error_attempts)::int)) ELSE NULL END,
              t3_last_error = jsonb_build_object('code', $4::text, 'message', left($5::text, 500), 'jobId', $7::bigint,
                                                 'correlationId', $8::text, 'at', now(), 'attempt', t3_error_attempts + 1)
        WHERE file_id = $1 AND account_id = $2 AND (status = 'ACTIVE' OR t3_pending)`,
      [fileId, accountId, `TECHNICAL_ERROR:${e.code}`, e.code, e.message, T3_TECHNICAL_RETRY_MAX, opts.jobId ?? null, opts.correlationId ?? null] as never[],
    );
    result.error = e.code;
  }
  return result;
}

/**
 * Cartes « À traiter » des ambiguïtés (lot 42) — APRÈS commit, jamais dans la
 * transaction des Opérations. Ne lève jamais : une carte manquée est reprise
 * au passage suivant (le candidat reste ARBITRATION_REQUIRED).
 */
export async function syncCards(accountId: number, cards: OperationCardNeeds): Promise<void> {
  if (!cards.reviewedFiles.length && !cards.reviewedOperations.length) return;
  let echec: string | null = null;
  try {
    await faultHook?.('cards', { accountId });
    const { syncOperationCards } = await import('@/services/to-process/operation-cards');
    const rep = await syncOperationCards(accountId, cards);
    echec = rep.error ?? null;
  } catch (e) {
    echec = (e as Error).message;
  }
  // Lot 54D (E05) : l'échec n'est plus seulement journalisé — les documents
  // concernés sont marqués (état durable) et repris par le passage T3 suivant
  // (balayage horaire), qui recalcule et resynchronise leurs cartes sans
  // doublon (clé de relation) ni intervention utilisateur. Succès : marque levée.
  try {
    const { pgClient } = await import('@/db');
    if (echec) {
      console.error(`[t3-operations] cartes « À traiter » du compte ${accountId} non synchronisées (reprise programmée) :`, echec);
      await pgClient.unsafe(
        `UPDATE document_operation_candidates SET t3_cards_pending = true
          WHERE account_id = $1 AND status = 'ACTIVE' AND NOT t3_cards_pending
            AND (file_id = ANY($2::int[]) OR t3_operation_id = ANY($3::bigint[]))`,
        [accountId, `{${cards.reviewedFiles.join(',')}}`, `{${cards.reviewedOperations.join(',')}}`] as never[],
      );
    } else if (cards.reviewedFiles.length) {
      await pgClient.unsafe(
        `UPDATE document_operation_candidates SET t3_cards_pending = false
          WHERE account_id = $1 AND t3_cards_pending AND file_id = ANY($2::int[])`,
        [accountId, `{${cards.reviewedFiles.join(',')}}`] as never[],
      );
    }
  } catch (e) {
    console.error(`[t3-operations] marque de reprise des cartes (compte ${accountId}) :`, (e as Error).message);
  }
}

/** Reconsolide des Opérations précises (contrats arrivés à leur date d'effet, Q13). */
export async function reconsolidateOperations(accountId: number, operationIds: number[], opts: ConsolidationOptions = {}): Promise<number> {
  if (operationIds.length === 0) return 0;
  await opts.beforeWrite?.('reconsolidation des Opérations');
  const cards = emptyCardNeeds();
  const n = await withBusinessOperationWrite(accountId, async (repo, session) => {
    const changes = new Changes();
    for (const id of operationIds) await reconsolidateOperation(repo, session.tx, id, opts.today ?? todayUtc(), changes, cards);
    return changes.n;
  }, { correlationId: opts.correlationId });
  if (opts.syncCards !== false) await syncCards(accountId, cards);
  return n;
}

// ── Compte (job T3) ─────────────────────────────────────────────────────────

/** Documents traités par passage ; au-delà, un passage consolidé suivant est demandé. */
export const DOCUMENTS_PER_RUN = 200;
/** Documents en attente de résolution (HOLD) réexaminés par passage. */
export const HOLD_REEVALUATION_LIMIT = 100;

export interface AccountConsolidationResult {
  documents: number;
  outcomes: Partial<Record<T3Outcome, number>>;
  changes: number;
  holdsReevaluated: number;
  contractsActivated: number;
  errors: number;
  /** Lot 54D (E01) : erreurs TECHNIQUES du passage (distinctes des attentes métier HOLD / arbitrage). */
  technicalErrors?: Array<{ fileId: number | null; code: string }>;
  /** D'autres documents attendent encore (passage suivant demandé). */
  remaining: boolean;
  /** Niveau M3 (lot 42) : appels modèle, reports (plafonds), prompt sans la branche, erreurs. */
  m3?: import('./m3').OperationMatchPhaseResult;
  /** Lot 43 : biens dont les données structurées ont été réconciliées. */
  assets?: number;
  /** Lot 47B : éléments d'agenda réconciliés (sources AGENDA). */
  agendaItems?: number;
  /** Lot 48 (O10) : Opérations actives recalculées par une reconsolidation complète (BO). */
  reconsolidated?: number;
}

type Sql = typeof import('@/db').pgClient;
const pg = async (): Promise<Sql> => (await import('@/db')).pgClient;

/**
 * Documents « sales » du compte (état, pas événements : rien n'est perdu si un
 * événement l'est) : candidats en attente T3 ; sources documentaires
 * obsolètes (document supprimé, déplacé, reclassé, candidat remplacé).
 */
export async function listDirtyDocuments(accountId: number, limit: number): Promise<number[]> {
  const r = (await (await pg()).unsafe(
    `SELECT file_id FROM (
       SELECT c.file_id FROM document_operation_candidates c WHERE c.account_id = $1 AND c.t3_pending
       UNION
       -- Lot 54D (E01) : reprise programmée d'une erreur technique, échue.
       SELECT c.file_id FROM document_operation_candidates c
        WHERE c.account_id = $1 AND c.status = 'ACTIVE' AND c.t3_retry_at IS NOT NULL AND c.t3_retry_at <= now()
       UNION
       -- Lot 54D (E05) : cartes « À traiter » à resynchroniser.
       SELECT c.file_id FROM document_operation_candidates c WHERE c.account_id = $1 AND c.t3_cards_pending
       UNION
       SELECT (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END) AS file_id
         FROM business_operation_sources s ${STALE_DOCUMENT_SOURCE_JOINS}
        WHERE s.account_id = $1 AND ${STALE_DOCUMENT_SOURCE_SQL}
     ) x WHERE file_id IS NOT NULL ORDER BY file_id LIMIT $2`,
    [accountId, limit] as never[],
  )) as unknown as Array<{ file_id: number }>;
  return r.map((x) => Number(x.file_id));
}

/** Prédicat SQL des contrats ENVISAGED arrivés à leur date d'effet avec une preuve certaine (Q13). */
export const DUE_CONTRACT_SQL = `
  o.type_code = 'CONTRACT' AND o.status = 'ENVISAGED' AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
  AND o.start_date IS NOT NULL AND o.start_date <= current_date
  AND EXISTS (
    SELECT 1 FROM business_operation_sources s
      JOIN document_operation_candidates c
        ON c.file_id = (CASE WHEN s.source_entity_key ~ '^[0-9]{1,9}$' THEN s.source_entity_key::int END)
       AND c.status = 'ACTIVE' AND c.candidate_key = s.locator->>'candidateKey'
     WHERE s.operation_id = o.id AND s.active AND s.source_kind = 'DOCUMENT'
       AND c.confidence = 'certain' AND c.status_hint = 'REALIZED'
       AND COALESCE(c.payload->>'sourceRoleHint', '') NOT IN ('QUOTE', 'ORDER'))`;

/**
 * Passage T3 Opérations d'un compte : documents sales (et ceux que les
 * événements désignent), puis réexamen borné des HOLD si une Opération a
 * changé ou si un bien ciblé a été modifié, puis contrats arrivés à date
 * d'effet. Sans rien de sale : aucune écriture (INV-040).
 */
export async function consolidateAccountOperations(
  accountId: number,
  opts: ConsolidationOptions & {
    fileIds?: number[]; reevaluateHolds?: boolean; limit?: number;
    /** Lot 43 : biens dont les données structurées ont changé (événements `asset_updated` / `asset_disposed`). */
    assetIds?: number[];
    /** Lot 47B : éléments d'agenda modifiés par l'utilisateur (événements `agenda_changed`). */
    agendaItemIds?: number[];
    /** Niveau M3 : `false` le coupe (correction utilisateur, tests) ; dépendances injectables. */
    operationMatch?: false | import('./m3').OperationMatchDeps;
  } = {},
): Promise<AccountConsolidationResult> {
  const limit = opts.limit ?? DOCUMENTS_PER_RUN;
  const res: AccountConsolidationResult = { documents: 0, outcomes: {}, changes: 0, holdsReevaluated: 0, contractsActivated: 0, errors: 0, remaining: false };
  // Lot 43 (TRG-008 à TRG-010) : données structurées des biens modifiés, AVANT
  // les documents — un document en attente se rapproche alors de l'Opération
  // établie par la fiche (jamais de doublon document + donnée structurée).
  const biens = [...new Set(opts.assetIds ?? [])].filter((a) => Number.isSafeInteger(a) && a > 0).sort((a, b) => a - b);
  if (biens.length) {
    const { consolidateAssetData } = await import('./asset-data-consolidator');
    for (const assetId of biens) {
      const r = await consolidateAssetData(accountId, assetId, opts);
      res.assets = (res.assets ?? 0) + 1;
      res.changes += r.changes;
      if (r.error) res.errors++;
    }
  }
  // Lot 47B (TRG-012 à TRG-014) : éléments d'agenda modifiés par l'utilisateur,
  // et filet de l'état (sources AGENDA d'éléments supprimés) — AVANT les
  // documents : un document en attente se rapproche alors de l'intervention
  // établie par l'agenda.
  {
    const { consolidateAgendaItems, listStaleAgendaSourceItems } = await import('./agenda-source-consolidator');
    const elements = [...new Set([...(opts.agendaItemIds ?? []), ...(await listStaleAgendaSourceItems(accountId))])];
    if (elements.length) {
      for (const r of await consolidateAgendaItems(accountId, elements, opts)) {
        res.agendaItems = (res.agendaItems ?? 0) + 1;
        res.changes += r.changes;
        if (r.error) res.errors++;
      }
    }
  }
  const sales = await listDirtyDocuments(accountId, limit + 1);
  res.remaining = sales.length > limit;
  const fichiers = [...new Set([...sales.slice(0, limit), ...(opts.fileIds ?? [])])].sort((a, b) => a - b);
  const traites = new Set<number>();
  const passer = async (fileId: number) => {
    const r = await consolidateDocument(accountId, fileId, opts);
    traites.add(fileId);
    res.documents++;
    res.changes += r.changes;
    if (r.error) { res.errors++; (res.technicalErrors ??= []).push({ fileId, code: r.error }); }
    for (const [k, v] of Object.entries(r.outcomes)) res.outcomes[k as T3Outcome] = (res.outcomes[k as T3Outcome] ?? 0) + (v ?? 0);
  };
  for (const f of fichiers) await passer(f);

  // Une Opération a changé (ou un bien ciblé) : les HOLD du compte peuvent se résoudre
  // (ex. la facture arrive après sa preuve de paiement). Un HOLD qui reste HOLD n'écrit rien.
  if (res.changes > 0 || opts.reevaluateHolds) {
    // Lot 42 : une ambiguïté soumise à l'utilisateur est aussi réexaminée — sa
    // carte se ferme d'elle-même si la situation s'est résolue.
    const holds = (await (await pg()).unsafe(
      `SELECT DISTINCT file_id FROM document_operation_candidates
        WHERE account_id = $1 AND status = 'ACTIVE' AND t3_outcome IN ('HOLD_UNRESOLVED', 'ARBITRATION_REQUIRED') AND NOT t3_pending
          -- Lot 54D (E01) : une erreur technique suit SA reprise bornée (t3_retry_at), pas le réexamen.
          AND (t3_reason IS NULL OR t3_reason NOT LIKE 'TECHNICAL_ERROR:%')
        ORDER BY file_id LIMIT $2`,
      [accountId, HOLD_REEVALUATION_LIMIT] as never[],
    )) as unknown as Array<{ file_id: number }>;
    for (const h of holds.map((x) => Number(x.file_id)).filter((f) => !traites.has(f))) {
      await passer(h);
      res.holdsReevaluated++;
    }
  }

  // Lot 42 : une Opération a changé — les questions « À traiter » ouvertes sur
  // d'AUTRES Opérations (parent Sinistre, montant) sont revérifiées, pour se
  // fermer d'elles-mêmes si la situation s'est résolue. Sans changement :
  // aucune écriture (recalcul idempotent).
  if (res.changes > 0) {
    const ouvertes = (await (await pg()).unsafe(
      `SELECT DISTINCT (trigger_context->>'operationId')::bigint AS id FROM to_process_actions
        WHERE account_id = $1 AND resolved_at IS NULL
          AND rule_code IN ('OPERATION-CLAIM-PARENT', 'OPERATION-AMOUNT', 'OPERATION-CLAIM-DETACH', 'OPERATION-CLAIM-ASSET', 'OPERATION-CURRENCY')
          AND trigger_context ? 'operationId'
        ORDER BY 1 LIMIT 50`,
      [accountId] as never[],
    )) as unknown as Array<{ id: number }>;
    if (ouvertes.length) {
      try {
        res.changes += await reconsolidateOperations(accountId, ouvertes.map((x) => Number(x.id)), opts);
      } catch (e) {
        if (!isBusinessOperationIntegrityError(e)) throw e;
        res.errors++;
        console.error(`[t3-operations] revérification des questions ouvertes (compte ${accountId}) : ${e.message}`);
      }
    }
  }

  // Niveau M3 (C6.1, C6.2) : hors verrou, borné, une fois par empreinte de
  // contexte ; chaque verdict obtenu est appliqué par une reconsolidation du
  // document (déterministe, dans sa transaction).
  if (opts.operationMatch !== false) {
    const { runOperationMatchPhase } = await import('./m3');
    res.m3 = await runOperationMatchPhase(accountId, { ...(opts.operationMatch ?? {}), beforeCall: opts.beforeWrite });
    for (const f of res.m3.files) {
      await passer(f);
    }
  }

  const dus = (await (await pg()).unsafe(
    `SELECT o.id FROM business_operations o WHERE o.account_id = $1 AND ${DUE_CONTRACT_SQL} ORDER BY o.id LIMIT 100`,
    [accountId] as never[],
  )) as unknown as Array<{ id: number }>;
  if (dus.length) {
    const n = await reconsolidateOperations(accountId, dus.map((x) => Number(x.id)), opts);
    res.changes += n;
    res.contractsActivated = n > 0 ? dus.length : 0;
  }
  return res;
}

/**
 * Comptes à examiner par le balayage horaire (curseur stable par compte) :
 * candidats en attente, sources documentaires obsolètes, contrats arrivés à
 * date d'effet, candidats dont le niveau M3 reste à évaluer (lot 42 :
 * contexte nouveau, report échu, prompt T3 modifié). Un compte sans rien de
 * tel n'est pas mis en file : le balayage ne recalcule rien (NFR-OP-005,
 * INV-040).
 */
export async function listAccountsToConsolidate(afterAccountId: number, limit: number, m3PromptVersion: string | null = null): Promise<number[]> {
  const { M3_PENDING_SQL } = await import('./m3');
  const r = (await (await pg()).unsafe(
    `SELECT account_id FROM (
       SELECT c.account_id FROM document_operation_candidates c WHERE c.t3_pending AND c.account_id > $1
       UNION
       -- Lot 54D (E01, E05) : reprises programmées échues, cartes à resynchroniser.
       SELECT c.account_id FROM document_operation_candidates c
        WHERE c.account_id > $1 AND c.status = 'ACTIVE' AND c.t3_retry_at IS NOT NULL AND c.t3_retry_at <= now()
       UNION
       SELECT c.account_id FROM document_operation_candidates c WHERE c.account_id > $1 AND c.t3_cards_pending
       UNION
       SELECT s.account_id FROM business_operation_sources s ${STALE_DOCUMENT_SOURCE_JOINS}
        WHERE s.account_id > $1 AND ${STALE_DOCUMENT_SOURCE_SQL}
       UNION
       SELECT o.account_id FROM business_operations o WHERE o.account_id > $1 AND ${DUE_CONTRACT_SQL}
       UNION
       SELECT c.account_id FROM document_operation_candidates c WHERE c.account_id > $1 AND ${M3_PENDING_SQL('$3')}
       UNION
       SELECT s.account_id FROM business_operation_sources s WHERE s.account_id > $1 AND ${STALE_AGENDA_SOURCE_SQL}
     ) x ORDER BY account_id LIMIT $2`,
    [afterAccountId, limit, m3PromptVersion] as never[],
  )) as unknown as Array<{ account_id: number }>;
  return r.map((x) => Number(x.account_id));
}
