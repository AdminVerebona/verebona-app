/**
 * Lot 113W (Trello #724) — PÉRIODES MÉTIER : persistance, lecture et
 * correction (service UNIQUE ; règles pures dans `./model`).
 *
 *   · `refreshDocumentBusinessPeriods` : (re)qualifie les périodes d'un
 *     document depuis sa connaissance T1 PERSISTÉE — appelé après chaque
 *     analyse (pipeline T1, après le titre) et par le contrôle de cohérence
 *     COH-DOC-BUSINESS-PERIODS (reprise de l'historique). Idempotent (faits
 *     identiques conservés), transactionnel par document (une reprise
 *     interrompue reprend où elle s'est arrêtée), aucune IA, aucune relecture
 *     du fichier. Une nature corrigée par l'utilisateur n'est jamais réécrite ;
 *   · `readDocumentPeriods` : période principale (une seule ligne, ou
 *     « Plusieurs périodes concernées »), détail, et historique de couverture
 *     des événements de référence dont le document est membre ;
 *   · `readOperationCoverageHistory` : TOUTES les périodes de couverture
 *     établies d'un événement de référence, chronologiques, chacune reliée à
 *     son justificatif — LUES à travers l'appartenance des documents
 *     (`business_operation_documents`) : aucun second historique, aucune copie
 *     des périodes facturées (chaque dépense garde la sienne, TCO inchangé) ;
 *   · `correctDocumentPeriod` : correction de l'utilisateur, depuis le
 *     document OU l'événement de référence — c'est le MÊME fait qui change
 *     (synchronisation par construction), protégé des retraitements.
 * Bornées au compte : un document ou un événement d'un autre compte n'existe
 * pas (null). Aucune écriture `business_operation_*`.
 *
 * CARTE #766 (pré-MEP) — `correctDocumentPeriod` :
 *   · E04 — la « durée indéterminée établie » est CONSERVÉE quand la correction ne la modifie pas
 *     (début seul corrigé) ; elle se modifie explicitement (`openEnded`) ou en saisissant une fin ;
 *     l'état d'avant est tracé (`before_correction`) ;
 *   · E08 — FAIT PARTAGÉ : la correction d'une couverture datée s'applique aussi aux autres
 *     justificatifs du MÊME événement de référence qui portent exactement ce fait (mêmes bornes, même
 *     modalité de fin — le « même fait » de la résolution), dans la même transaction, avec la trace de
 *     son origine (`before_correction.sharedFrom`). Jamais à une autre nature, à d'autres bornes, à un
 *     autre événement de référence ni à une période facturée ;
 *   · E12 — création d'une nature sans fait existant : seulement si la connaissance T1 persistée la
 *     tient pour pertinente (fait dérivé) ou explicitement indéterminée (contrat v2) ; sinon refus.
 */
import type postgres from 'postgres';
import { documentTitleColumnsSql, documentTitleOf } from '@/lib/documents/document-title-source';
import {
  chronoKey, isBusinessPeriodKind, isPartialDate, orderedBounds, periodLine, principalLine, samePeriodBounds,
  type BusinessPeriodKind, type PartialDate, type PeriodBounds,
} from '@/lib/documents/business-periods';
import {
  deriveDocumentPeriods, planRefresh, principalKind, PERIOD_FACT_PREFIX,
  type DesiredPeriod, type PeriodCandidateInput, type PeriodEvidence, type PeriodFactInput, type PeriodInputs, type StoredPeriod,
} from './model';
import { parseRelevance } from './t1-v2';
import { resolvePeriods, type EntryResolution, type PeriodConflict, type ResolutionEntry, type UserPeriodDecision } from './resolution';
import { loadRelationStates, type RelationState } from './relation-review';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;
const MAX_MERGE_REDIRECTS = 10;
/** Lot 113AC : plafond d'une lecture groupée d'historiques de couverture (surfaces : 200). */
export const MAX_GROUPED_OPERATIONS = 200;

/** Table absente (migration 1560 non appliquée) : le code se tait. */
const tableMissing = (e: unknown) => (e as { code?: string })?.code === '42P01';

const json = (v: unknown) => JSON.stringify(v ?? null);
const asObj = (v: unknown): Record<string, unknown> => {
  if (typeof v === 'string') { try { return asObj(JSON.parse(v)); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
};

// ── Entrées (connaissance T1 persistée) ─────────────────────────────────────

/** Entrées du modèle pour un document (lecture seule, bornée). */
export async function loadPeriodInputs(sql: Sql | Tx, accountId: number, fileId: number): Promise<PeriodInputs> {
  const [cands, facts, run] = await Promise.all([
    sql.unsafe(
      `SELECT candidate_key, established, confidence, type_hint, payload FROM document_operation_candidates
        WHERE file_id = $1 AND account_id = $2 AND status = 'ACTIVE' ORDER BY id LIMIT 20`,
      [fileId, accountId] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
    sql.unsafe(
      `SELECT id, COALESCE(raw_key, fact_key) AS raw_key, normalized_value, raw_value, to_char(period_start, 'YYYY-MM-DD') AS period_start,
              to_char(period_end, 'YYYY-MM-DD') AS period_end, attribute, confidence, excerpt, location
         FROM document_facts
        WHERE file_id = $1 AND account_id = $2 AND status = 'active' AND COALESCE(raw_key, fact_key) LIKE $3 ORDER BY id LIMIT 60`,
      [fileId, accountId, `${PERIOD_FACT_PREFIX}%`] as never[],
    ).catch(() => []) as unknown as Promise<Row[]>,
    sql.unsafe(
      `SELECT raw_response_json AS raw FROM document_analysis_runs
        WHERE asset_file_id = $1 AND account_id = $2 AND status = 'completed' AND raw_response_json IS NOT NULL
          AND strpos(raw_response_json, '"billingPeriod"') > 0
        ORDER BY is_current_reference DESC, id DESC LIMIT 1`,
      [fileId, accountId] as never[],
    ).catch(() => []) as unknown as Promise<Array<{ raw: string }>>,
  ]);
  const candidates: PeriodCandidateInput[] = cands.map((c) => ({
    candidateKey: String(c.candidate_key), established: c.established === true, confidence: String(c.confidence),
    typeHint: (c.type_hint as string | null) ?? null, payload: asObj(c.payload),
  }));
  const periodFacts: PeriodFactInput[] = facts.map((f) => ({
    factId: Number(f.id), rawKey: (f.raw_key as string | null) ?? null,
    normalizedValue: f.normalized_value == null ? null : String(f.normalized_value),
    rawValue: f.raw_value == null ? null : String(f.raw_value),
    periodStart: (f.period_start as string | null) ?? null, periodEnd: (f.period_end as string | null) ?? null,
    attribute: (f.attribute as string | null) ?? null, confidence: (f.confidence as string | null) ?? null,
    excerpt: (f.excerpt as string | null) ?? null,
    page: typeof asObj(f.location).page === 'number' ? asObj(f.location).page as number : null,
  }));
  let resultat: unknown = null;
  try { resultat = run[0]?.raw ? JSON.parse(run[0].raw) : null; } catch { resultat = null; }
  // Règle de période facturée UNIQUE du nommage (lot 87D / 99C), réutilisée telle quelle.
  // Les périodes de faits génériques ne sont pas une période facturée (jamais devinée).
  const { DocumentTitleService } = await import('@/services/documents/document-title.service');
  const { periodFactsOf } = await import('@/services/ai/source-analysis/document-title');
  const basis = DocumentTitleService.billingBasisFrom({ candidatePayloads: candidates.map((c) => c.payload), factPeriods: [], analysisResult: resultat, issueDate: null });
  const pf = periodFactsOf(basis);
  const bloc = asObj(asObj(asObj(resultat).document).billingPeriod);
  return {
    candidates, facts: periodFacts,
    billing: { billedPeriod: basis.billedPeriod, statedMonth: pf.statedMonth, hasBillingBlock: Object.keys(bloc).length > 0 },
  };
}

// ── Lecture des faits persistés ─────────────────────────────────────────────

const PERIOD_COLUMNS = `p.id, p.file_id, p.period_kind, p.segment_index, p.start_on, p.end_on, p.principal_hint, p.origin, p.basis,
  p.evidence, p.user_locked, p.corrected_at::text AS corrected_at, p.end_open, p.before_correction`;

/** Carte #766 (E05, E08) : bornes du fait remplacé par une correction (`before_correction`) ; null : aucun fait antérieur. */
function boundsBefore(v: unknown): PeriodBounds | null {
  const o = asObj(v);
  if (!('start' in o) && !('end' in o)) return null;
  const borne = (x: unknown): PartialDate | null => (isPartialDate(x) ? x : null);
  return { start: borne(o.start), end: borne(o.end), ...(o.openEnded === true ? { openEnded: true } : {}) };
}

function toStored(r: Row): StoredPeriod & { fileId: number; correctedAt: string | null } {
  return {
    id: Number(r.id), fileId: Number(r.file_id), kind: r.period_kind as BusinessPeriodKind, segment: Number(r.segment_index),
    start: (r.start_on as string | null) ?? null, end: (r.end_on as string | null) ?? null,
    principalHint: r.principal_hint === true, origin: r.origin as StoredPeriod['origin'], basis: String(r.basis),
    evidence: asObj(r.evidence) as PeriodEvidence, userLocked: r.user_locked === true, correctedAt: (r.corrected_at as string | null) ?? null,
    ...(r.end_open === true ? { openEnded: true } : {}),
    ...(r.user_locked === true ? { lockedBefore: boundsBefore(r.before_correction) } : {}),
  };
}

async function activePeriods(sql: Sql | Tx, accountId: number, fileId: number): Promise<Array<ReturnType<typeof toStored>>> {
  const r = (await sql.unsafe(
    `SELECT ${PERIOD_COLUMNS} FROM document_business_periods p
      WHERE p.account_id = $1 AND p.file_id = $2 AND p.status = 'ACTIVE' ORDER BY p.period_kind, p.segment_index`,
    [accountId, fileId] as never[],
  )) as unknown as Row[];
  return r.map(toStored);
}

// ── (Re)qualification ───────────────────────────────────────────────────────

export interface RefreshResult {
  outcome: 'UPDATED' | 'UNCHANGED' | 'GONE' | 'UNAVAILABLE';
  kept: number;
  inserted: number;
  superseded: number;
  /** Natures corrigées par l'utilisateur, laissées telles quelles. */
  protectedKinds: BusinessPeriodKind[];
}

/** Écart entre les faits voulus et les faits enregistrés (lecture seule) — contrôle de cohérence. */
export async function previewDocumentBusinessPeriods(accountId: number, fileId: number, runner?: Sql): Promise<{
  gone: boolean; desired: DesiredPeriod[]; plan: ReturnType<typeof planRefresh> | null;
}> {
  const sql = runner ?? await sqlClient();
  const vivant = (await sql.unsafe(
    `SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [fileId, accountId] as never[],
  )) as unknown as Row[];
  if (!vivant.length) return { gone: true, desired: [], plan: null };
  const desired = deriveDocumentPeriods(await loadPeriodInputs(sql, accountId, fileId));
  const stored = await activePeriods(sql, accountId, fileId);
  return { gone: false, desired, plan: planRefresh(stored, desired) };
}

/** Lot 113AA : divergences de périodes des événements dont le document est membre, resynchronisées (ne lève jamais). */
async function afterPeriodsChanged(accountId: number, fileId: number, others: readonly number[] = []): Promise<void> {
  try {
    const { syncPeriodConflictCards } = await import('./conflict-cards');
    await syncPeriodConflictCards(accountId, { fileIds: [fileId, ...others] });
  } catch (e) {
    console.error(`[periodes-metier] divergences du document ${fileId} non resynchronisées :`, (e as Error).message);
  }
}

export async function refreshDocumentBusinessPeriods(accountId: number, fileId: number, opts: { correlationId?: string | null } = {}): Promise<RefreshResult> {
  const r = await refreshDocumentBusinessPeriodsOnce(accountId, fileId, opts);
  if (r.outcome === 'UPDATED') await afterPeriodsChanged(accountId, fileId);
  return r;
}

async function refreshDocumentBusinessPeriodsOnce(accountId: number, fileId: number, opts: { correlationId?: string | null } = {}): Promise<RefreshResult> {
  const sql = await sqlClient();
  const vide: RefreshResult = { outcome: 'UNCHANGED', kept: 0, inserted: 0, superseded: 0, protectedKinds: [] };
  try {
    return await sql.begin(async (tx) => {
      // Un seul rafraîchissement à la fois par document (analyse et reprise concurrentes).
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('document_business_periods'), $1)`, [fileId] as never[]);
      const vivant = (await tx.unsafe(
        `SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [fileId, accountId] as never[],
      )) as unknown as Row[];
      if (!vivant.length) return { ...vide, outcome: 'GONE' as const };
      const desired = deriveDocumentPeriods(await loadPeriodInputs(tx, accountId, fileId));
      const stored = await activePeriods(tx, accountId, fileId);
      const plan = planRefresh(stored, desired);
      const protectedKinds = [...new Set(stored.filter((s) => s.userLocked).map((s) => s.kind))];
      if (plan.supersede.length) {
        await tx.unsafe(
          `UPDATE document_business_periods SET status = 'SUPERSEDED', superseded_at = now(), updated_at = now()
            WHERE account_id = $1 AND id = ANY($2::bigint[]) AND status = 'ACTIVE' AND NOT user_locked`,
          [accountId, plan.supersede] as never[],
        );
      }
      for (const d of plan.insert) await insertPeriod(tx, accountId, fileId, d, 'T1', opts.correlationId ?? null);
      const changed = plan.supersede.length + plan.insert.length > 0;
      return { outcome: changed ? 'UPDATED' as const : 'UNCHANGED' as const, kept: plan.keep.length, inserted: plan.insert.length, superseded: plan.supersede.length, protectedKinds };
    });
  } catch (e) {
    if (tableMissing(e)) return { ...vide, outcome: 'UNAVAILABLE' };
    throw e;
  }
}

async function insertPeriod(tx: Tx, accountId: number, fileId: number, d: DesiredPeriod, origin: 'T1' | 'USER', correlationId: string | null, user?: {
  userId: number | null; before: unknown;
}): Promise<number> {
  const r = (await tx.unsafe(
    `INSERT INTO document_business_periods (account_id, file_id, period_kind, segment_index, start_on, end_on, principal_hint, origin, basis,
       evidence, user_locked, corrected_by_user_id, corrected_at, before_correction, correlation_id, end_open)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, CASE WHEN $11 THEN now() END, $13::jsonb, $14, $15) RETURNING id`,
    [accountId, fileId, d.kind, d.segment, d.start, d.end, d.principalHint, origin, d.basis, json(d.evidence),
      !!user, user?.userId ?? null, user ? json(user.before) : null, correlationId, d.openEnded === true && d.end === null] as never[],
  )) as unknown as Row[];
  return Number(r[0].id);
}

// ── Lectures ────────────────────────────────────────────────────────────────

export interface PeriodView {
  id: number;
  kind: BusinessPeriodKind;
  segment: number;
  start: PartialDate | null;
  end: PartialDate | null;
  line: string;
  /** Corrigée par l'utilisateur (protégée). */
  userCorrected: boolean;
  /** Lot 113AA : durée indéterminée établie (≠ fin inconnue). */
  openEnded?: boolean;
}

export interface CoverageEntry extends PeriodView {
  fileId: number;
  documentTitle: string;
  /**
   * Lot 113AA (D11) : résolution contextuelle de la période parmi celles de l'événement de référence
   * (absente : période établie, aucune autre ne la contredit). `note` : texte affiché (à valider par le PO).
   */
  resolution?: { status: 'REPLACED' | 'CONFLICT'; basis?: string; byFileId?: number; note: string; pendingQuestion?: boolean };
  /** Lot 113AA : autres justificatifs portant EXACTEMENT la même période (même fait, sources réunies). */
  otherSources?: Array<{ fileId: number; documentTitle: string }>;
}

/**
 * Lot 113AC — couverture telle qu'exposée aux écrans (routes) : `resolution.basis` est INTERNE (tableau
 * « à afficher / à exclure » de 113AA) et n'est jamais transmis ; le reste (statut, note, document
 * remplaçant, question en attente, autres justificatifs, durée indéterminée) est conservé. Pure.
 */
export function publicCoverage<T extends CoverageEntry>(c: T): T {
  if (!c.resolution) return c;
  const { basis: _interne, ...resolution } = c.resolution;
  return { ...c, resolution: resolution as CoverageEntry['resolution'] };
}

/** Lot 113AA — textes de la résolution (à valider par le PO). */
export const RESOLUTION_NOTES = {
  AMENDMENT: (t: string) => `Actualisée par l’avenant « ${t} »`,
  RECTIFICATION: (t: string) => `Remplacée par le rectificatif « ${t} »`,
  USER_DECISION: (t: string) => `Remplacée par « ${t} » (votre choix)`,
  // Lot 113AD : classement par le réexamen T3 d'une divergence non déclarée, preuve citée (à valider par le PO).
  AI_AMENDMENT: (t: string, x: string | null) => `Actualisée par « ${t} »${x ? ` (avenant reconnu : « ${x} »)` : ''}`,
  AI_RECTIFICATION: (t: string, x: string | null) => `Remplacée par « ${t} »${x ? ` (rectificatif reconnu : « ${x} »)` : ''}`,
  // Carte #766 (E08) : même fait, corrigé par l'utilisateur sur un autre justificatif (à valider par le PO).
  USER_CORRECTION: (t: string) => `Remplacée par votre correction sur « ${t} »`,
  CONFLICT: 'Les justificatifs indiquent des périodes différentes.',
  CONFLICT_QUESTION: 'Une question vous est posée dans « À traiter ».',
} as const;

export interface DocumentPeriodsView {
  documentId: number;
  principal: { kind: BusinessPeriodKind; line: string; segments: PeriodView[] } | null;
  /** Autres natures (détail, jamais écrites dans les notes). */
  secondary: PeriodView[];
  /** Historique de couverture des événements de référence dont le document est membre (≥ 1 autre justificatif). */
  coverageHistories: Array<{ operationId: number; coverages: CoverageEntry[] }>;
}

const toView = (s: StoredPeriod): PeriodView => ({
  id: s.id, kind: s.kind, segment: s.segment, start: s.start, end: s.end, line: periodLine(s.kind, s), userCorrected: s.userLocked,
  ...(s.openEnded ? { openEnded: true } : {}),
});

export async function readDocumentPeriods(accountId: number, fileId: number): Promise<DocumentPeriodsView | null> {
  const sql = await sqlClient();
  const doc = (await sql.unsafe(
    `SELECT id FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [fileId, accountId] as never[],
  )) as unknown as Row[];
  if (!doc.length) return null;
  let stored: Array<ReturnType<typeof toStored>> = [];
  try { stored = await activePeriods(sql, accountId, fileId); } catch (e) { if (!tableMissing(e)) throw e; }
  const kind = principalKind(stored);
  const segments = kind ? stored.filter((s) => s.kind === kind).sort((a, b) => a.segment - b.segment).map(toView) : [];
  const ops = (await sql.unsafe(
    `SELECT DISTINCT d.operation_id FROM business_operation_documents d
       JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND o.invalidated_at IS NULL
      WHERE d.account_id = $1 AND d.file_id = $2 AND d.active ORDER BY 1 LIMIT 10`,
    [accountId, fileId] as never[],
  ).catch(() => [])) as unknown as Row[];
  const coverageHistories: DocumentPeriodsView['coverageHistories'] = [];
  const resolus = await operationsPeriodResolution(sql, accountId, ops.map((o) => Number(o.operation_id)));
  for (const o of ops) {
    const coverages = resolus.get(Number(o.operation_id))?.coverages ?? [];
    if (coverages.some((c) => c.fileId !== fileId || (c.otherSources ?? []).some((o) => o.fileId !== fileId))) coverageHistories.push({ operationId: Number(o.operation_id), coverages: coverages.map(publicCoverage) });
  }
  return {
    documentId: fileId,
    principal: kind ? { kind, line: principalLine(kind, segments), segments } : null,
    secondary: stored.filter((s) => s.kind !== kind).sort((a, b) => a.kind.localeCompare(b.kind) || a.segment - b.segment).map(toView),
    coverageHistories,
  };
}

async function coverageOf(sql: Sql | Tx, accountId: number, operationId: number): Promise<CoverageEntry[]> {
  return (await operationPeriodResolution(sql, accountId, operationId)).coverages;
}

/** Décisions ACTIVES de l'utilisateur sur les divergences de plusieurs événements de référence (une requête ; migration 1590 absente : aucune). */
async function activeDecisionsOf(sql: Sql | Tx, accountId: number, operationIds: readonly number[]): Promise<Map<number, UserPeriodDecision[]>> {
  const out = new Map<number, UserPeriodDecision[]>();
  if (!operationIds.length) return out;
  try {
    const r = (await sql.unsafe(
      `SELECT operation_id, fingerprint, choice, retained_file_id FROM business_period_decisions
        WHERE account_id = $1 AND operation_id = ANY($2::bigint[]) AND status = 'ACTIVE' ORDER BY id`,
      [accountId, `{${operationIds.join(',')}}`] as never[],
    )) as unknown as Row[];
    for (const x of r) {
      const op = Number(x.operation_id);
      out.set(op, [...(out.get(op) ?? []), { fingerprint: String(x.fingerprint), choice: x.choice === 'BOTH' ? 'BOTH' : 'KEEP', retainedFileId: x.retained_file_id == null ? null : Number(x.retained_file_id) }]);
    }
  } catch (e) {
    if (!tableMissing(e)) throw e;
  }
  return out;
}

/** Périodes de couverture actives des documents membres d'un événement de référence (même borne : 200 par événement). */
const MAX_COVERAGE_ROWS_PER_OPERATION = 200;

/** Résolution D11 des couvertures d'un événement de référence. */
export interface OperationPeriodResolution {
  coverages: CoverageEntry[];
  conflicts: PeriodConflict[];
  /** Carte #766 (E06) : paires dont l'ordre n'est pas prouvé (aucune question ; réexamen T3 hors lecture). */
  uncertain: PeriodConflict[];
  titles: Map<number, string>;
  /**
   * Carte #766 (E02) : la lecture a atteint sa borne — la résolution ne porte que sur une PARTIE des
   * périodes de l'événement (jamais une base suffisante pour dire une couverture « établie » dans un export).
   */
  truncated?: true;
}

/**
 * Lot 113AA (D11, R13 / R14) — périodes de COUVERTURE de l'événement de référence RÉSOLUES
 * (`resolution.ts`, pure) : succession, même fait (sources réunies), avenant / rectificatif déclarés
 * par T1, décision de l'utilisateur, divergence. Lecture seule, sans IA — jamais une réanalyse.
 * Les périodes remplacées restent dans l'historique, avec leur justificatif et la raison.
 */
export async function operationPeriodResolution(sql: Sql | Tx, accountId: number, operationId: number): Promise<OperationPeriodResolution> {
  return (await operationsPeriodResolution(sql, accountId, [operationId])).get(operationId)!;
}

/**
 * Lot 113AC — MÊME résolution que `operationPeriodResolution`, pour plusieurs événements de référence en
 * DEUX requêtes (périodes, décisions) quel que soit leur nombre : listes, Assistant, dossiers sans N+1.
 * Chaque identifiant demandé est présent dans le résultat (vide s'il n'a aucune couverture).
 */
export async function operationsPeriodResolution(sql: Sql | Tx, accountId: number, operationIds: readonly number[]): Promise<Map<number, OperationPeriodResolution>> {
  const ids = [...new Set(operationIds.filter((x) => Number.isSafeInteger(x) && x > 0))];
  const out = new Map<number, OperationPeriodResolution>();
  if (!ids.length) return out;
  let r: Row[] = [];
  try {
    r = (await sql.unsafe(
      `SELECT x.* FROM (
         SELECT d.operation_id AS op_id, ${PERIOD_COLUMNS}, ${documentTitleColumnsSql('f')},
                row_number() OVER (PARTITION BY d.operation_id ORDER BY p.file_id, p.id) AS rang
           FROM business_operation_documents d
           JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
           JOIN document_business_periods p ON p.file_id = f.id AND p.account_id = d.account_id AND p.status = 'ACTIVE' AND p.period_kind = 'COVERAGE'
          WHERE d.account_id = $1 AND d.operation_id = ANY($2::bigint[]) AND d.active
       ) x WHERE x.rang <= ${MAX_COVERAGE_ROWS_PER_OPERATION} ORDER BY x.op_id, x.rang`,
      [accountId, `{${ids.join(',')}}`] as never[],
    )) as unknown as Row[];
  } catch (e) { if (!tableMissing(e)) throw e; }
  const parOp = new Map<number, Row[]>();
  for (const x of r) { const op = Number(x.op_id); parOp.set(op, [...(parOp.get(op) ?? []), x]); }
  const decisions = await activeDecisionsOf(sql, accountId, ids);
  // Lot 113AD : états du réexamen T3 des divergences de ces documents (une requête ; table absente : aucun).
  const examens = await loadRelationStates(sql, accountId, [...new Set(r.map((x) => Number(x.file_id)))]);
  for (const id of ids) {
    const lignes = parOp.get(id) ?? [];
    const res = resolveCoverageRows(lignes, decisions.get(id) ?? [], examens);
    out.set(id, lignes.length >= MAX_COVERAGE_ROWS_PER_OPERATION ? { ...res, truncated: true } : res);
  }
  return out;
}

/** Résolution D11 des lignes de couverture d'UN événement de référence (pure sur les lignes lues). */
function resolveCoverageRows(r: readonly Row[], decisions: readonly UserPeriodDecision[], examens: readonly RelationState[] = []): OperationPeriodResolution {
  const vues = r.map((x) => {
    const st = toStored(x);
    return { st, view: { ...toView(st), fileId: Number(x.file_id), documentTitle: documentTitleOf(x) } as CoverageEntry };
  });
  // Un même document membre par plusieurs appartenances : une seule ligne par fait.
  const uniques = [...new Map(vues.map((v) => [v.st.id, v])).values()];
  const titles = new Map(uniques.map((v) => [v.view.fileId, v.view.documentTitle]));
  const entrees: ResolutionEntry[] = uniques.map(({ st, view }) => ({
    id: st.id, fileId: view.fileId, kind: st.kind, start: st.start, end: st.end, userCorrected: st.userLocked,
    qualified: st.evidence?.qualified === true, relation: st.evidence?.relation ?? null,
    // Carte #766 : modalité de fin (E10) et valeur d'avant correction (E08, continuité du fait corrigé).
    ...(st.openEnded ? { openEnded: true } : {}), ...(st.userLocked ? { correctedFrom: st.lockedBefore ?? null } : {}),
  }));
  const res = resolvePeriods(entrees, decisions, examens);
  const citation = (fp: string | undefined) => {
    const x = fp ? examens.find((y) => y.fingerprint === fp) : undefined;
    const c = x && 'citation' in x ? x.citation : null;
    return c ? (c.excerpt.length > 120 ? `${c.excerpt.slice(0, 119)}…` : c.excerpt) : null;
  };
  const memes = new Map<number, Array<{ fileId: number; documentTitle: string }>>();
  const out: CoverageEntry[] = [];
  for (const { st, view } of uniques) {
    const e: EntryResolution = res.entries.get(st.id) ?? { status: 'ESTABLISHED' };
    if (e.status === 'SAME_AS') {
      // Même fait qu'un autre justificatif : réuni à la première ligne qui le porte.
      const prim = uniques.find((u) => u.view.fileId === e.byFileId && samePeriodBounds(u.st, st));
      if (prim) { memes.set(prim.st.id, [...(memes.get(prim.st.id) ?? []), { fileId: view.fileId, documentTitle: view.documentTitle }]); continue; }
    }
    if (e.status === 'REPLACED' && e.byFileId !== undefined) {
      const t = titles.get(e.byFileId) ?? 'Document';
      const note = e.basis === 'AMENDMENT' ? RESOLUTION_NOTES.AMENDMENT(t) : e.basis === 'RECTIFICATION' ? RESOLUTION_NOTES.RECTIFICATION(t)
        : e.basis === 'AI_AMENDMENT' ? RESOLUTION_NOTES.AI_AMENDMENT(t, citation(e.conflict)) : e.basis === 'AI_RECTIFICATION' ? RESOLUTION_NOTES.AI_RECTIFICATION(t, citation(e.conflict))
          : e.basis === 'CORRECTED_SAME_FACT' ? RESOLUTION_NOTES.USER_CORRECTION(t)
            : RESOLUTION_NOTES.USER_DECISION(t);
      out.push({ ...view, resolution: { status: 'REPLACED', basis: String(e.basis), byFileId: e.byFileId, note } });
      continue;
    }
    if (e.status === 'CONFLICT') {
      const question = res.conflicts.some((c) => c.needsUser && c.periodIds.includes(st.id));
      out.push({ ...view, resolution: { status: 'CONFLICT', basis: String(e.basis), note: question ? `${RESOLUTION_NOTES.CONFLICT} ${RESOLUTION_NOTES.CONFLICT_QUESTION}` : RESOLUTION_NOTES.CONFLICT, ...(question ? { pendingQuestion: true } : {}) } });
      continue;
    }
    out.push(view);
  }
  for (const v of out) { const m = memes.get(v.id); if (m) v.otherSources = m; }
  return {
    coverages: out.sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)) || a.fileId - b.fileId || a.segment - b.segment),
    conflicts: res.conflicts, uncertain: res.uncertain, titles,
  };
}

/** Événement de référence actif CANONIQUE (redirection des fusions), borné au compte ; null sinon. */
async function canonicalOperation(sql: Sql, accountId: number, operationId: number): Promise<number | null> {
  let id = operationId;
  for (let i = 0; i <= MAX_MERGE_REDIRECTS; i++) {
    const r = (await sql.unsafe(
      `SELECT id, invalidated_at IS NULL AS active, merged_into_operation_id FROM business_operations WHERE id = $1 AND account_id = $2`,
      [id, accountId] as never[],
    )) as unknown as Row[];
    if (!r.length) return null;
    if (r[0].active === true) return id;
    if (r[0].merged_into_operation_id == null) return null;
    id = Number(r[0].merged_into_operation_id);
  }
  return null;
}

export async function readOperationCoverageHistory(accountId: number, operationId: number): Promise<{ operationId: number; coverages: CoverageEntry[] } | null> {
  const sql = await sqlClient();
  const canon = await canonicalOperation(sql, accountId, operationId);
  if (canon === null) return null;
  return { operationId: canon, coverages: await coverageOf(sql, accountId, canon) };
}

/**
 * Lot 113AC — événements CANONIQUES de plusieurs identifiants (même règle que `canonicalOperation`),
 * par niveaux de redirection : une requête par niveau (au plus `MAX_MERGE_REDIRECTS` + 1), jamais une
 * par événement. Identifiant inconnu, d'un autre compte ou invalidé sans regroupement : absent.
 */
async function canonicalOperations(sql: Sql, accountId: number, operationIds: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  // origine → identifiant courant à relire
  let courants = new Map(operationIds.map((id) => [id, id]));
  for (let i = 0; i <= MAX_MERGE_REDIRECTS && courants.size; i++) {
    const r = (await sql.unsafe(
      `SELECT id, invalidated_at IS NULL AS active, merged_into_operation_id FROM business_operations WHERE id = ANY($1::bigint[]) AND account_id = $2`,
      [`{${[...new Set(courants.values())].join(',')}}`, accountId] as never[],
    )) as unknown as Row[];
    const lu = new Map(r.map((x) => [Number(x.id), x]));
    const suivants = new Map<number, number>();
    for (const [origine, id] of courants) {
      const x = lu.get(id);
      if (!x) continue;
      if (x.active === true) out.set(origine, id);
      else if (x.merged_into_operation_id != null) suivants.set(origine, Number(x.merged_into_operation_id));
    }
    courants = suivants;
  }
  return out;
}

/** Événement de référence d'un élément d'agenda (compte actif), sinon null. */
export async function operationOfAgendaItem(accountId: number, itemId: number): Promise<number | null | undefined> {
  const sql = await sqlClient();
  const r = (await sql.unsafe(
    `SELECT business_operation_id FROM agenda_items WHERE id = $1 AND account_id = $2`, [itemId, accountId] as never[],
  )) as unknown as Row[];
  if (!r.length) return undefined;
  return r[0].business_operation_id == null ? null : Number(r[0].business_operation_id);
}

// ── Correction de l'utilisateur ─────────────────────────────────────────────

export type CorrectionError = 'NOT_FOUND' | 'INVALID_DATES' | 'INVALID_KIND' | 'UNAVAILABLE' | 'NOT_RELEVANT';

export interface CorrectionInput {
  /** Fait corrigé (préféré) ; sinon nature sans fait existant (première saisie). */
  periodId?: number | null;
  kind?: BusinessPeriodKind | null;
  start: PartialDate | null;
  end: PartialDate | null;
  /**
   * Carte #766 (E04) — durée indéterminée ÉTABLIE (la fin n'existe pas). Absent / null : le statut du fait
   * corrigé est CONSERVÉ (sauf si une fin est saisie) ; `true` / `false` : modification explicite.
   */
  openEnded?: boolean | null;
}

interface SharedFactRow {
  id: number; fileId: number; segment: number; principalHint: boolean; origin: string; basis: string; evidence: PeriodEvidence;
  start: PartialDate | null; end: PartialDate | null; openEnded: boolean;
}

/**
 * Carte #766 (E08) — autres représentations du MÊME fait de couverture : périodes ACTIVES de même nature,
 * de mêmes bornes et de même modalité de fin, portées par d'autres justificatifs (non supprimés) d'un
 * événement de référence actif dont le document est membre. Seulement pour une couverture DATÉE (une
 * période « non renseignée » n'identifie aucun fait). Bornée au compte ; au plus 50.
 */
async function sharedFactSiblings(sql: Sql | Tx, accountId: number, fileId: number, periodId: number): Promise<SharedFactRow[]> {
  const r = (await sql.unsafe(
    `SELECT DISTINCT ON (p2.id) p2.id, p2.file_id, p2.segment_index, p2.principal_hint, p2.origin, p2.basis, p2.evidence, p2.start_on, p2.end_on, p2.end_open
       FROM document_business_periods p
       JOIN business_operation_documents d ON d.account_id = p.account_id AND d.file_id = p.file_id AND d.active
       JOIN business_operations o ON o.id = d.operation_id AND o.account_id = d.account_id AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL
       JOIN business_operation_documents d2 ON d2.account_id = d.account_id AND d2.operation_id = d.operation_id AND d2.active AND d2.file_id <> p.file_id
       JOIN asset_files f2 ON f2.id = d2.file_id AND f2.account_id = d2.account_id AND f2.deleted_at IS NULL
       JOIN document_business_periods p2 ON p2.account_id = p.account_id AND p2.file_id = d2.file_id AND p2.status = 'ACTIVE'
            AND p2.period_kind = p.period_kind AND p2.start_on IS NOT DISTINCT FROM p.start_on AND p2.end_on IS NOT DISTINCT FROM p.end_on
            AND p2.end_open = p.end_open
      WHERE p.account_id = $1 AND p.file_id = $2 AND p.id = $3 AND p.status = 'ACTIVE' AND p.period_kind = 'COVERAGE'
        AND (p.start_on IS NOT NULL OR p.end_on IS NOT NULL OR p.end_open)
      ORDER BY p2.id LIMIT 50`,
    [accountId, fileId, periodId] as never[],
  )) as unknown as Row[];
  return r.map((x) => ({
    id: Number(x.id), fileId: Number(x.file_id), segment: Number(x.segment_index), principalHint: x.principal_hint === true,
    origin: String(x.origin), basis: String(x.basis), evidence: asObj(x.evidence) as PeriodEvidence,
    start: (x.start_on as string | null) ?? null, end: (x.end_on as string | null) ?? null, openEnded: x.end_open === true,
  }));
}

/**
 * Carte #766 (E12) — la nature peut-elle être CRÉÉE sur ce document (aucun fait existant) ? Oui si la
 * connaissance T1 persistée la qualifie pertinente (un fait de cette nature en est dérivé : connue, ou
 * pertinente sans date), ou si T1 l'a rendue explicitement INDÉTERMINÉE (contrat v2 : l'utilisateur peut
 * l'établir). Non si T1 l'a dite non pertinente, ou si rien ne la qualifie (document non qualifié sous le
 * contrat v2 et aucune règle déterministe : aucun champ artificiel, achat ponctuel compris).
 */
export function creationAllowed(kind: BusinessPeriodKind, inputs: PeriodInputs): boolean {
  if (deriveDocumentPeriods(inputs).some((d) => d.kind === kind)) return true;
  return parseRelevance(inputs.facts)?.get(kind) === 'UNDETERMINED';
}

/**
 * Correction d'une période (même fait, quelle que soit la fiche d'où elle est
 * faite) : l'ancien fait passe en SUPERSEDED, le nouveau est USER et verrouillé
 * (`user_locked`), avec l'état d'avant. Les autres périodes (autres segments,
 * autres natures, périodes des dépenses) ne sont jamais touchées — sauf les
 * autres justificatifs du MÊME fait de couverture (carte #766, E08).
 */
export async function correctDocumentPeriod(accountId: number, userId: number | null, fileId: number, input: CorrectionInput, correlationId?: string | null):
  Promise<{ ok: true; period: PeriodView; propagatedFileIds: number[] } | { ok: false; error: CorrectionError }> {
  const { start, end } = input;
  if ((start !== null && !isPartialDate(start)) || (end !== null && !isPartialDate(end)) || !orderedBounds(start, end)) return { ok: false, error: 'INVALID_DATES' };
  // Carte #766 (E04) : une durée indéterminée n'a pas de date de fin (jamais les deux).
  if (input.openEnded === true && end !== null) return { ok: false, error: 'INVALID_DATES' };
  const sql = await sqlClient();
  try {
    // Carte #766 (E08) : documents du même fait, lus d'abord SANS verrou pour verrouiller dans un ordre stable.
    const pressentis = input.periodId != null ? await sharedFactSiblings(sql, accountId, fileId, input.periodId) : [];
    const verrous = [...new Set([fileId, ...pressentis.map((x) => x.fileId)])].sort((a, b) => a - b);
    const r = await sql.begin(async (tx) => {
      for (const f of verrous) await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('document_business_periods'), $1)`, [f] as never[]);
      const doc = (await tx.unsafe(
        `SELECT 1 FROM asset_files WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL`, [fileId, accountId] as never[],
      )) as unknown as Row[];
      if (!doc.length) return { ok: false as const, error: 'NOT_FOUND' as const };
      const stored = await activePeriods(tx, accountId, fileId);
      let cible: (typeof stored)[number] | undefined;
      let kind: BusinessPeriodKind;
      let segment: number;
      if (input.periodId != null) {
        cible = stored.find((s) => s.id === input.periodId);
        if (!cible) return { ok: false as const, error: 'NOT_FOUND' as const };
        kind = cible.kind;
        segment = cible.segment;
      } else {
        if (!isBusinessPeriodKind(input.kind)) return { ok: false as const, error: 'INVALID_KIND' as const };
        kind = input.kind;
        const memes = stored.filter((s) => s.kind === kind);
        if (memes.length) return { ok: false as const, error: 'NOT_FOUND' as const };
        // Carte #766 (E12) : contrôle de pertinence CÔTÉ SERVICE (une requête forgée ne crée pas une nature sans objet).
        if (!creationAllowed(kind, await loadPeriodInputs(tx, accountId, fileId))) return { ok: false as const, error: 'NOT_RELEVANT' as const };
        segment = 0;
      }
      // Carte #766 (E04) : statut conservé s'il n'est pas explicitement modifié ; une fin saisie le retire.
      const openEnded = end !== null ? false : input.openEnded == null ? cible?.openEnded === true : input.openEnded === true;
      // Carte #766 (E08) : relus SOUS verrou ; un justificatif apparu entre-temps (non verrouillé) n'est pas touché ici
      // (la résolution le rattache à la correction en lecture : `CORRECTED_SAME_FACT`).
      const fratrie = cible ? (await sharedFactSiblings(tx, accountId, fileId, cible.id)).filter((x) => verrous.includes(x.fileId)) : [];
      if (cible) {
        await tx.unsafe(
          `UPDATE document_business_periods SET status = 'SUPERSEDED', superseded_at = now(), updated_at = now() WHERE id = $1 AND account_id = $2`,
          [cible.id, accountId] as never[],
        );
      }
      const before = cible ? { start: cible.start, end: cible.end, origin: cible.origin, basis: cible.basis, ...(cible.openEnded ? { openEnded: true } : {}) } : null;
      const d: DesiredPeriod = {
        kind, segment, start, end, principalHint: cible?.principalHint ?? false, basis: 'USER', evidence: cible?.evidence ?? {},
        ...(openEnded ? { openEnded: true } : {}),
      };
      const id = await insertPeriod(tx, accountId, fileId, d, 'USER', correlationId ?? null, { userId, before });
      for (const f of fratrie) {
        await tx.unsafe(
          `UPDATE document_business_periods SET status = 'SUPERSEDED', superseded_at = now(), updated_at = now() WHERE id = $1 AND account_id = $2 AND status = 'ACTIVE'`,
          [f.id, accountId] as never[],
        );
        await insertPeriod(tx, accountId, f.fileId, {
          kind, segment: f.segment, start, end, principalHint: f.principalHint, basis: 'USER', evidence: f.evidence, ...(openEnded ? { openEnded: true } : {}),
        }, 'USER', correlationId ?? null, {
          userId,
          before: { start: f.start, end: f.end, origin: f.origin, basis: f.basis, ...(f.openEnded ? { openEnded: true } : {}), sharedFrom: { fileId, periodId: cible!.id } },
        });
      }
      return {
        ok: true as const,
        period: { id, kind, segment, start, end, line: periodLine(kind, { start, end, openEnded }), userCorrected: true, ...(openEnded ? { openEnded: true } : {}) },
        propagatedFileIds: fratrie.map((f) => f.fileId),
      };
    });
    // Lot 113AA : une correction peut faire disparaître (ou apparaître) une divergence — questions resynchronisées.
    if (r.ok) {
      await afterPeriodsChanged(accountId, fileId, r.propagatedFileIds);
      if (r.propagatedFileIds.length) {
        console.info(JSON.stringify({ event: 'business_period.shared_fact_corrected', accountId, fileId, periodId: r.period.id, propagated: r.propagatedFileIds.length }));
      }
    }
    return r;
  } catch (e) {
    if (tableMissing(e)) return { ok: false, error: 'UNAVAILABLE' };
    throw e;
  }
}

// ── Lot 113AA : lecture groupée (listes, recherche, exports — lecture publique) ─

/**
 * Période PRINCIPALE de plusieurs documents du compte (une ligne par document : la même règle que la
 * fiche — `principalKind` puis `principalLine`, jamais le titre). Documents sans période pertinente :
 * absents du résultat. Lecture seule, bornée (200 documents), sans IA ; table absente : vide.
 */
export async function readPrincipalPeriodLines(accountId: number, fileIds: readonly number[]): Promise<Map<number, { kind: BusinessPeriodKind; line: string }>> {
  const ids = [...new Set(fileIds.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, 200);
  const out = new Map<number, { kind: BusinessPeriodKind; line: string }>();
  if (!ids.length) return out;
  const sql = await sqlClient();
  let r: Row[] = [];
  try {
    r = (await sql.unsafe(
      `SELECT ${PERIOD_COLUMNS} FROM document_business_periods p
         JOIN asset_files f ON f.id = p.file_id AND f.account_id = p.account_id AND f.deleted_at IS NULL
        WHERE p.account_id = $1 AND p.file_id = ANY($2::int[]) AND p.status = 'ACTIVE' ORDER BY p.file_id, p.period_kind, p.segment_index`,
      [accountId, `{${ids.join(',')}}`] as never[],
    )) as unknown as Row[];
  } catch (e) { if (!tableMissing(e)) throw e; }
  const parDoc = new Map<number, Array<ReturnType<typeof toStored>>>();
  for (const x of r) { const s = toStored(x); parDoc.set(s.fileId, [...(parDoc.get(s.fileId) ?? []), s]); }
  for (const [fileId, stored] of parDoc) {
    const kind = principalKind(stored);
    if (!kind) continue;
    out.set(fileId, { kind, line: principalLine(kind, stored.filter((s) => s.kind === kind).sort((a, b) => a.segment - b.segment)) });
  }
  return out;
}

/**
 * Lot 113AA (demande 113AB) — historiques de couverture RÉSOLUS (D11) de plusieurs événements de
 * référence en un appel : même lecture que la fiche (`operationPeriodResolution` : statut REPLACED /
 * CONFLICT, note, document remplaçant, autres justificatifs du même fait). Événements canoniques
 * (redirection des fusions) bornés au compte ; un identifiant d'un autre compte est absent du résultat.
 * Lecture seule, sans IA, bornée (50 événements par défaut ; `max` jusqu'à `MAX_GROUPED_OPERATIONS`). Destinée à
 * l'Assistant (T2), aux dossiers et aux listes. Lot 113AC : groupée (nombre de requêtes indépendant du nombre d'événements).
 */
export async function readOperationsCoverageHistories(accountId: number, operationIds: readonly number[], opts: { max?: number } = {}): Promise<Map<number, { operationId: number; coverages: CoverageEntry[] }>> {
  const max = Math.min(Math.max(1, opts.max ?? 50), MAX_GROUPED_OPERATIONS);
  const sql = await sqlClient();
  const out = new Map<number, { operationId: number; coverages: CoverageEntry[] }>();
  const ids = [...new Set(operationIds.filter((x) => Number.isSafeInteger(x) && x > 0))].slice(0, max);
  if (!ids.length) return out;
  // Lot 113AC : lecture GROUPÉE (canoniques par niveau de redirection, puis une résolution pour tous) — même résultat
  // que l'appel par événement d'avant, sans N requêtes.
  const canon = await canonicalOperations(sql, accountId, ids);
  const resolus = await operationsPeriodResolution(sql, accountId, [...new Set(canon.values())]);
  for (const id of ids) {
    const c = canon.get(id);
    if (c === undefined) continue;
    out.set(id, { operationId: c, coverages: resolus.get(c)?.coverages ?? [] });
  }
  return out;
}
