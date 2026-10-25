/**
 * Lot 87B (CODE-09, CODE-11) — journal `operation_semantic_reevaluations`
 * (migration 0752) : mémoire anti-rappel, budget, trace des décisions et
 * mutations. Lecture / écriture SQL seulement (aucune règle métier).
 */
import type postgres from 'postgres';
import type { RefusedMutation, RepresentationMutation, SemanticScope, SemanticStatus, SemanticTrigger } from './contract';

/** Rôle décidé par T4 pour un élément (miroir de `T4RepresentationRole`, projection). */
export type DecidedRole = 'PRINCIPAL' | 'STEP' | 'INDEPENDENT' | 'DUPLICATE';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;

let pret: { ready: boolean; at: number } | null = null;

/** Journal 0752 présent ? (cache 5 min ; ne lève jamais). Absent : aucune demande (jamais sans trace). */
export async function semanticJournalReady(sql: Sql): Promise<boolean> {
  if (pret && (pret.ready || Date.now() - pret.at < 5 * 60_000)) return pret.ready;
  let ready = false;
  try {
    const [r] = await sql.unsafe<Row[]>(`SELECT to_regclass('operation_semantic_reevaluations') IS NOT NULL AS ok`);
    ready = r?.ok === true;
  } catch { ready = false; }
  pret = { ready, at: Date.now() };
  return ready;
}

/** Réservé aux tests. */
export function __resetSemanticJournalForTests(): void { pret = null; }

/** Statuts qui CLÔTURENT une demande pour un contexte donné (aucun nouvel appel sur ce contexte). */
export const SETTLED_STATUSES: readonly SemanticStatus[] = ['APPLIED', 'PARTIAL', 'NO_CHANGE', 'REJECTED', 'ABSTAINED'];
/** Délai avant un nouvel essai après un échec IA ou technique. */
export const SEMANTIC_RETRY_HOURS = 6;

export interface StoredReevaluation {
  id: number;
  status: SemanticStatus;
  contextFingerprint: string | null;
  resultingFingerprint: string | null;
  createdAt: string;
  reason: string | null;
}

const toStored = (x: Row): StoredReevaluation => ({
  id: Number(x.id), status: String(x.status) as SemanticStatus, contextFingerprint: (x.context_fingerprint as string | null) ?? null,
  resultingFingerprint: (x.resulting_fingerprint as string | null) ?? null, createdAt: String(x.created_at), reason: (x.reason as string | null) ?? null,
});

/**
 * Dernière demande qui couvre ce contexte (même empreinte d'entrée, ou état
 * PRODUIT par une décision appliquée) pour la même version de contrat et de
 * décideur — décision close, ou échec récent (nouvel essai après le délai).
 */
export async function findCovering(sql: Sql, p: {
  accountId: number; scope: SemanticScope; operationId: number; fingerprint: string; contractVersion: string; deciderVersion: string; now: Date;
}): Promise<StoredReevaluation | null> {
  const r = await sql.unsafe<Row[]>(`
    SELECT id, status, context_fingerprint, resulting_fingerprint, created_at::text AS created_at, reason
      FROM operation_semantic_reevaluations
     WHERE account_id = $1 AND scope = $2 AND operation_id = $3 AND contract_version = $5 AND decider_version = $6
       AND (context_fingerprint = $4 OR resulting_fingerprint = $4)
       AND (status = ANY($7::text[])
            OR (status IN ('AI_FAILED', 'FAILED') AND created_at > $8::timestamptz - make_interval(hours => ${SEMANTIC_RETRY_HOURS})))
     ORDER BY id DESC LIMIT 1`,
  [p.accountId, p.scope, p.operationId, p.fingerprint, p.contractVersion, p.deciderVersion, `{${SETTLED_STATUSES.join(',')}}`, p.now.toISOString()] as never[]);
  return r[0] ? toStored(r[0]) : null;
}

/** Dernière ligne d'un statut « d'attente » identique (évite de journaliser le même constat chaque jour). */
export async function findSameWaiting(sql: Sql, p: {
  accountId: number; scope: SemanticScope; operationId: number; fingerprint: string | null; status: SemanticStatus; reason: string; deciderVersion: string;
}): Promise<StoredReevaluation | null> {
  const r = await sql.unsafe<Row[]>(`
    SELECT id, status, context_fingerprint, resulting_fingerprint, created_at::text AS created_at, reason
      FROM operation_semantic_reevaluations
     WHERE account_id = $1 AND scope = $2 AND operation_id = $3 AND status = $4 AND COALESCE(reason, '') = $5
       AND context_fingerprint IS NOT DISTINCT FROM $6 AND decider_version = $7
     ORDER BY id DESC LIMIT 1`,
  [p.accountId, p.scope, p.operationId, p.status, p.reason, p.fingerprint, p.deciderVersion] as never[]);
  return r[0] ? toStored(r[0]) : null;
}

/** Appels IA du compte sur 24 h pour une portée (budget). */
export async function semanticCallsLastDay(sql: Sql, accountId: number, scope: SemanticScope, now: Date): Promise<number> {
  const [r] = await sql.unsafe<Row[]>(`
    SELECT COALESCE(sum(ai_calls), 0)::int AS n FROM operation_semantic_reevaluations
     WHERE account_id = $1 AND scope = $2 AND created_at > $3::timestamptz - interval '24 hours'`, [accountId, scope, now.toISOString()] as never[]);
  return Number(r?.n ?? 0);
}

export interface ReevaluationRecord {
  accountId: number;
  scope: SemanticScope;
  operationId: number;
  operationIds?: number[];
  triggerKind: SemanticTrigger;
  triggerRef?: string | null;
  correlationId?: string | null;
  status: SemanticStatus;
  reason?: string | null;
  contractVersion: string;
  deciderVersion: string;
  contextFingerprint?: string | null;
  resultingFingerprint?: string | null;
  contextSummary?: Record<string, unknown>;
  aiOutput?: unknown;
  validation?: Record<string, unknown>;
  /** Rôles décidés (décisions certaines) : identifiant d'élément → rôle (mémoire lue par la projection). */
  decidedItems?: Record<number, DecidedRole>;
  applied?: ReadonlyArray<RepresentationMutation | Record<string, unknown>>;
  refused?: readonly RefusedMutation[];
  beforeState?: unknown;
  afterState?: unknown;
  aiCalls?: number;
  aiTraceId?: string | null;
  error?: string | null;
  decided?: boolean;
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export async function recordReevaluation(sql: Sql, r: ReevaluationRecord): Promise<number> {
  const [x] = await sql.unsafe<Row[]>(`
    INSERT INTO operation_semantic_reevaluations
      (account_id, scope, operation_id, operation_ids, trigger_kind, trigger_ref, correlation_id, status, reason, contract_version, decider_version,
       context_fingerprint, resulting_fingerprint, context_summary, ai_output, validation, mutations_applied, mutations_refused,
       before_state, after_state, ai_calls, ai_trace_id, error, decided_at, decided_items)
    VALUES ($1, $2, $3, $4::bigint[], $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::text::jsonb, '{}'::jsonb), $15::text::jsonb,
            COALESCE($16::text::jsonb, '{}'::jsonb), COALESCE($17::text::jsonb, '[]'::jsonb), COALESCE($18::text::jsonb, '[]'::jsonb),
            $19::text::jsonb, $20::text::jsonb, $21, $22, $23, CASE WHEN $24::boolean THEN now() END, COALESCE($25::text::jsonb, '{}'::jsonb))
    RETURNING id`,
  [r.accountId, r.scope, r.operationId, `{${[...new Set([r.operationId, ...(r.operationIds ?? [])])].join(',')}}`, r.triggerKind, r.triggerRef ?? null,
    r.correlationId ?? null, r.status, r.reason ? r.reason.slice(0, 300) : null, r.contractVersion, r.deciderVersion,
    r.contextFingerprint ?? null, r.resultingFingerprint ?? null, json(r.contextSummary), json(r.aiOutput), json(r.validation),
    json(r.applied ?? []), json(r.refused ?? []), json(r.beforeState), json(r.afterState), r.aiCalls ?? 0, r.aiTraceId ?? null,
    r.error ? r.error.slice(0, 500) : null, r.decided === true, json(r.decidedItems ?? {})] as never[]);
  return Number(x.id);
}

/** État final d'une décision appliquée (après la projection rejouée) : mémoire de convergence. */
export async function updateOutcome(sql: Sql, id: number, p: { afterState: unknown; resultingFingerprint: string }): Promise<void> {
  await sql.unsafe(`UPDATE operation_semantic_reevaluations SET after_state = $2::text::jsonb, resulting_fingerprint = $3 WHERE id = $1`,
    [id, json(p.afterState), p.resultingFingerprint] as never[]);
}

/** Clôt une demande T3 en attente (résultat de la consolidation T3). */
export async function settlePending(sql: Sql, p: { id: number; status: SemanticStatus; reason: string; afterState?: unknown }): Promise<void> {
  await sql.unsafe(`
    UPDATE operation_semantic_reevaluations SET status = $2, reason = $3, after_state = COALESCE($4::text::jsonb, after_state), decided_at = now()
     WHERE id = $1 AND status = 'PENDING'`, [p.id, p.status, p.reason.slice(0, 300), json(p.afterState)] as never[]);
}

/** Demande T3 encore ouverte pour l'Opération (aucune seconde demande en parallèle). */
export async function openT3Request(sql: Sql, accountId: number, operationId: number): Promise<StoredReevaluation | null> {
  const r = await sql.unsafe<Row[]>(`
    SELECT id, status, context_fingerprint, resulting_fingerprint, created_at::text AS created_at, reason
      FROM operation_semantic_reevaluations
     WHERE account_id = $1 AND scope = 'T3' AND operation_id = $2 AND status = 'PENDING' ORDER BY id DESC LIMIT 1`, [accountId, operationId] as never[]);
  return r[0] ? toStored(r[0]) : null;
}

/**
 * Lot 87B (CODE-03, CODE-11) : rôles donnés par la DERNIÈRE décision T4
 * appliquée (APPLIED, PARTIAL, NO_CHANGE) de chaque Opération — lus par la
 * projection : une étape, un événement indépendant ou un doublon protégé
 * décidés par T4 ne sont plus jamais candidats (aucune nouvelle demande,
 * aucune carte). Journal absent : aucune mémoire (comportement antérieur).
 */
export async function loadT4Roles(sql: Sql, accountId: number, operationIds: readonly number[]): Promise<Map<number, Map<number, DecidedRole>>> {
  const out = new Map<number, Map<number, DecidedRole>>();
  const ids = [...new Set(operationIds)].filter((x) => Number.isSafeInteger(x) && x > 0);
  if (!ids.length || !(await semanticJournalReady(sql))) return out;
  const r = await sql.unsafe<Row[]>(`
    SELECT DISTINCT ON (operation_id) operation_id, decided_items FROM operation_semantic_reevaluations
     WHERE account_id = $1 AND scope = 'T4' AND operation_id = ANY($2::bigint[]) AND status IN ('APPLIED', 'PARTIAL', 'NO_CHANGE')
     ORDER BY operation_id, id DESC`, [accountId, `{${ids.join(',')}}`] as never[]);
  for (const x of r) {
    const m = new Map<number, DecidedRole>();
    for (const [k, v] of Object.entries((x.decided_items ?? {}) as Record<string, unknown>)) {
      const id = Number(k);
      if (Number.isSafeInteger(id) && (v === 'PRINCIPAL' || v === 'STEP' || v === 'INDEPENDENT' || v === 'DUPLICATE')) m.set(id, v);
    }
    if (m.size) out.set(Number(x.operation_id), m);
  }
  return out;
}

/** Motif des absorptions posées par une décision T4 (lot 87B) : déjà décidées, jamais « historiques ». */
export const T4_CONSOLIDATION_REASON = 'T4_SEMANTIC_SAME_OCCURRENCE';

/**
 * Lot 87B (CODE-06, CODE-07) : condition SQL « l'Opération `alias` porte une
 * ancienne consolidation d'agenda (journal 0591, absorption non restaurée)
 * décidée par l'ancienne règle du code et qu'aucune décision T4 appliquée
 * n'a validée depuis ». `semantic` : journal 0752 présent.
 */
export function historicalConsolidationSql(alias: string, semantic: boolean): string {
  return `EXISTS (SELECT 1 FROM agenda_intervention_consolidations k
                   WHERE k.account_id = ${alias}.account_id AND k.operation_id = ${alias}.id AND k.kind = 'ABSORB' AND k.restored_at IS NULL
                     AND k.reason IS DISTINCT FROM '${T4_CONSOLIDATION_REASON}'
                     ${semantic ? `AND NOT EXISTS (SELECT 1 FROM operation_semantic_reevaluations r
                                     WHERE r.account_id = k.account_id AND r.scope = 'T4' AND r.operation_id = k.operation_id
                                       AND r.status IN ('APPLIED', 'PARTIAL', 'NO_CHANGE') AND r.created_at >= k.created_at)` : ''})`;
}
