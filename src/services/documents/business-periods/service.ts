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
 */
import type postgres from 'postgres';
import { documentTitleColumnsSql, documentTitleOf } from '@/lib/documents/document-title-source';
import {
  chronoKey, isBusinessPeriodKind, isPartialDate, orderedBounds, periodLine, principalLine,
  type BusinessPeriodKind, type PartialDate,
} from '@/lib/documents/business-periods';
import {
  deriveDocumentPeriods, planRefresh, principalKind, PERIOD_FACT_PREFIX,
  type DesiredPeriod, type PeriodCandidateInput, type PeriodEvidence, type PeriodFactInput, type PeriodInputs, type StoredPeriod,
} from './model';

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;
const sqlClient = async (): Promise<Sql> => (await import('@/db')).pgClient;
const MAX_MERGE_REDIRECTS = 10;

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
  p.evidence, p.user_locked, p.corrected_at::text AS corrected_at`;

function toStored(r: Row): StoredPeriod & { fileId: number; correctedAt: string | null } {
  return {
    id: Number(r.id), fileId: Number(r.file_id), kind: r.period_kind as BusinessPeriodKind, segment: Number(r.segment_index),
    start: (r.start_on as string | null) ?? null, end: (r.end_on as string | null) ?? null,
    principalHint: r.principal_hint === true, origin: r.origin as StoredPeriod['origin'], basis: String(r.basis),
    evidence: asObj(r.evidence) as PeriodEvidence, userLocked: r.user_locked === true, correctedAt: (r.corrected_at as string | null) ?? null,
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

export async function refreshDocumentBusinessPeriods(accountId: number, fileId: number, opts: { correlationId?: string | null } = {}): Promise<RefreshResult> {
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
       evidence, user_locked, corrected_by_user_id, corrected_at, before_correction, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, CASE WHEN $11 THEN now() END, $13::jsonb, $14) RETURNING id`,
    [accountId, fileId, d.kind, d.segment, d.start, d.end, d.principalHint, origin, d.basis, json(d.evidence),
      !!user, user?.userId ?? null, user ? json(user.before) : null, correlationId] as never[],
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
}

export interface CoverageEntry extends PeriodView {
  fileId: number;
  documentTitle: string;
}

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
  for (const o of ops) {
    const coverages = await coverageOf(sql, accountId, Number(o.operation_id));
    if (coverages.some((c) => c.fileId !== fileId)) coverageHistories.push({ operationId: Number(o.operation_id), coverages });
  }
  return {
    documentId: fileId,
    principal: kind ? { kind, line: principalLine(kind, segments), segments } : null,
    secondary: stored.filter((s) => s.kind !== kind).sort((a, b) => a.kind.localeCompare(b.kind) || a.segment - b.segment).map(toView),
    coverageHistories,
  };
}

async function coverageOf(sql: Sql, accountId: number, operationId: number): Promise<CoverageEntry[]> {
  let r: Row[] = [];
  try {
    r = (await sql.unsafe(
      `SELECT ${PERIOD_COLUMNS}, ${documentTitleColumnsSql('f')}
         FROM business_operation_documents d
         JOIN asset_files f ON f.id = d.file_id AND f.account_id = d.account_id AND f.deleted_at IS NULL
         JOIN document_business_periods p ON p.file_id = f.id AND p.account_id = d.account_id AND p.status = 'ACTIVE' AND p.period_kind = 'COVERAGE'
        WHERE d.account_id = $1 AND d.operation_id = $2 AND d.active
        LIMIT 200`,
      [accountId, operationId] as never[],
    )) as unknown as Row[];
  } catch (e) { if (!tableMissing(e)) throw e; }
  return r.map((x) => ({ ...toView(toStored(x)), fileId: Number(x.file_id), documentTitle: documentTitleOf(x) }))
    .sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)) || a.fileId - b.fileId || a.segment - b.segment);
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

export type CorrectionError = 'NOT_FOUND' | 'INVALID_DATES' | 'INVALID_KIND' | 'UNAVAILABLE';

export interface CorrectionInput {
  /** Fait corrigé (préféré) ; sinon nature sans fait existant (première saisie). */
  periodId?: number | null;
  kind?: BusinessPeriodKind | null;
  start: PartialDate | null;
  end: PartialDate | null;
}

/**
 * Correction d'une période (même fait, quelle que soit la fiche d'où elle est
 * faite) : l'ancien fait passe en SUPERSEDED, le nouveau est USER et verrouillé
 * (`user_locked`), avec l'état d'avant. Les autres périodes (autres segments,
 * autres natures, périodes des dépenses) ne sont jamais touchées.
 */
export async function correctDocumentPeriod(accountId: number, userId: number | null, fileId: number, input: CorrectionInput, correlationId?: string | null):
  Promise<{ ok: true; period: PeriodView } | { ok: false; error: CorrectionError }> {
  const { start, end } = input;
  if ((start !== null && !isPartialDate(start)) || (end !== null && !isPartialDate(end)) || !orderedBounds(start, end)) return { ok: false, error: 'INVALID_DATES' };
  const sql = await sqlClient();
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext('document_business_periods'), $1)`, [fileId] as never[]);
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
        segment = 0;
      }
      if (cible) {
        await tx.unsafe(
          `UPDATE document_business_periods SET status = 'SUPERSEDED', superseded_at = now(), updated_at = now() WHERE id = $1 AND account_id = $2`,
          [cible.id, accountId] as never[],
        );
      }
      const before = cible ? { start: cible.start, end: cible.end, origin: cible.origin, basis: cible.basis } : null;
      const d: DesiredPeriod = {
        kind, segment, start, end, principalHint: cible?.principalHint ?? false, basis: 'USER', evidence: cible?.evidence ?? {},
      };
      const id = await insertPeriod(tx, accountId, fileId, d, 'USER', correlationId ?? null, { userId, before });
      return { ok: true as const, period: { id, kind, segment, start, end, line: periodLine(kind, { start, end }), userCorrected: true } };
    });
  } catch (e) {
    if (tableMissing(e)) return { ok: false, error: 'UNAVAILABLE' };
    throw e;
  }
}
