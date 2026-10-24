/**
 * Lot 85F — mémoire des interprétations T3 de la connaissance T1
 * (`t3_knowledge_queries`, migration 0720) et budget d'appels.
 *
 * Tolérant : table absente → aucune mémoire ni budget lus (le service
 * n'appelle alors PAS le modèle : pas de mémoire = risque de boucle, état
 * « interprétation en attente » prudent).
 */
import { pgClient } from '@/db';
import { envNumber } from '@/lib/env-number';
import type { EffectiveOutcome, Rejection, ValidatedFinding } from './validate';

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, params: unknown[]): Promise<T[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as T[];

/** Appels au plus par compte sur 24 h glissantes (`T3_KNOWLEDGE_QUERY_DAILY_MAX`, 100 ; 0 = aucun appel). */
export const knowledgeQueryDailyMax = (): number => Math.floor(envNumber('T3_KNOWLEDGE_QUERY_DAILY_MAX', 100, { min: 0 }));
/** Tentatives au plus après une panne IA, pour une même entrée. */
export const KNOWLEDGE_QUERY_MAX_ATTEMPTS = 3;
/** Délai avant une nouvelle tentative après une panne IA. */
export const KNOWLEDGE_QUERY_RETRY_MINUTES = 60;

let etatTable: { ok: boolean; at: number } | null = null;
/** Table 0720 présente ? (revérifiée toutes les 5 min tant qu'absente). Ne lève jamais. */
export async function knowledgeQueriesReady(): Promise<boolean> {
  if (etatTable && (etatTable.ok || Date.now() - etatTable.at < 300_000)) return etatTable.ok;
  let ok = false;
  try {
    const [r] = await q<{ ok: boolean }>(`SELECT to_regclass('t3_knowledge_queries') IS NOT NULL AS ok`, []);
    ok = r?.ok === true;
  } catch { ok = false; }
  etatTable = { ok, at: Date.now() };
  return ok;
}

export interface KnowledgeEntryKey {
  accountId: number; fileId: number; fieldKey: string; questionFp: string; contextFp: string; promptVersion: string;
}

export interface StoredKnowledgeQuery {
  id: number;
  status: 'ANSWERED' | 'AI_FAILED';
  outcome: EffectiveOutcome | 'INCOMPLETE' | null;
  findings: ValidatedFinding[];
  rejected: Rejection[];
  calls: number;
  attempts: number;
  traceIds: string[];
  retryAt: string | null;
  pagesTotal: number;
  pagesExamined: number;
}

const json = <T>(v: unknown, def: T): T => {
  if (v === null || v === undefined) return def;
  if (typeof v === 'string') { try { return JSON.parse(v) as T; } catch { return def; } }
  return v as T;
};

/** Interprétation mémorisée pour cette entrée, ou null. Lève sur une lecture en échec. */
export async function findKnowledgeQuery(k: KnowledgeEntryKey): Promise<StoredKnowledgeQuery | null> {
  const [r] = await q<Row>(
    `SELECT id, status, outcome, findings, rejected, calls, attempts, ai_trace_ids, retry_at, pages_total, pages_examined
       FROM t3_knowledge_queries
      WHERE account_id = $1 AND file_id = $2 AND field_key = $3 AND question_fp = $4 AND context_fp = $5 AND prompt_version = $6`,
    [k.accountId, k.fileId, k.fieldKey, k.questionFp, k.contextFp, k.promptVersion],
  );
  if (!r) return null;
  return {
    id: Number(r.id), status: r.status as StoredKnowledgeQuery['status'], outcome: (r.outcome as StoredKnowledgeQuery['outcome']) ?? null,
    findings: json<ValidatedFinding[]>(r.findings, []), rejected: json<Rejection[]>(r.rejected, []),
    calls: Number(r.calls ?? 0), attempts: Number(r.attempts ?? 0), traceIds: (r.ai_trace_ids as string[] | null) ?? [],
    retryAt: r.retry_at ? new Date(r.retry_at as string).toISOString() : null,
    pagesTotal: Number(r.pages_total ?? 0), pagesExamined: Number(r.pages_examined ?? 0),
  };
}

/** Appels d'interprétation du compte sur 24 h glissantes. Lève sur une lecture en échec. */
export async function knowledgeCallsLastDay(accountId: number, now: Date = new Date()): Promise<number> {
  const [r] = await q<{ n: number | string | null }>(
    `SELECT COALESCE(sum(calls), 0)::int AS n FROM t3_knowledge_queries WHERE account_id = $1 AND updated_at > $2::timestamptz - interval '24 hours'`,
    [accountId, now.toISOString()],
  );
  return Number(r?.n ?? 0);
}

export interface KnowledgeQueryRecord extends KnowledgeEntryKey {
  ruleCode: string;
  status: 'ANSWERED' | 'AI_FAILED';
  outcome: EffectiveOutcome | 'INCOMPLETE' | null;
  pagesTotal: number;
  pagesExamined: number;
  calls: number;
  traceIds: string[];
  findings: ValidatedFinding[];
  rejected: Rejection[];
  contextSummary: Record<string, unknown>;
  error?: string | null;
  retryAt?: string | null;
  trigger: string;
  runRef?: string | null;
}

/** Mémorise une interprétation (entrée unique : mise à jour, appels et tentatives cumulés). Rend l'identifiant. */
export async function saveKnowledgeQuery(r: KnowledgeQueryRecord): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO t3_knowledge_queries (account_id, file_id, field_key, rule_code, question_fp, context_fp, prompt_version, status, outcome,
                                       pages_total, pages_examined, calls, attempts, ai_trace_ids, findings, rejected, context_summary, error,
                                       retry_at, trigger_code, run_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13::text[], $14::jsonb, $15::jsonb, $16::jsonb, $17, $18::timestamptz, $19, $20)
     ON CONFLICT (account_id, file_id, field_key, question_fp, context_fp, prompt_version) DO UPDATE SET
       status = EXCLUDED.status, outcome = EXCLUDED.outcome, pages_total = EXCLUDED.pages_total, pages_examined = EXCLUDED.pages_examined,
       calls = t3_knowledge_queries.calls + EXCLUDED.calls, attempts = t3_knowledge_queries.attempts + 1,
       ai_trace_ids = (t3_knowledge_queries.ai_trace_ids || EXCLUDED.ai_trace_ids)[1:20],
       findings = EXCLUDED.findings, rejected = EXCLUDED.rejected, context_summary = EXCLUDED.context_summary, error = EXCLUDED.error,
       retry_at = EXCLUDED.retry_at, trigger_code = EXCLUDED.trigger_code, run_ref = COALESCE(EXCLUDED.run_ref, t3_knowledge_queries.run_ref), updated_at = now()
     RETURNING id`,
    [
      r.accountId, r.fileId, r.fieldKey, r.ruleCode, r.questionFp, r.contextFp, r.promptVersion, r.status, r.outcome,
      r.pagesTotal, r.pagesExamined, r.calls, r.traceIds.slice(0, 20), JSON.stringify(r.findings.slice(0, 30)), JSON.stringify(r.rejected.slice(0, 30)),
      JSON.stringify(r.contextSummary), r.error ? String(r.error).slice(0, 500) : null, r.retryAt ?? null, r.trigger, r.runRef ?? null,
    ],
  );
  return Number(row.id);
}

/** Dernière interprétation d'une donnée d'un document (contrôle de cohérence). Ne lève pas : null. */
export async function latestKnowledgeQuery(accountId: number, fileId: number, fieldKey: string): Promise<(StoredKnowledgeQuery & { contextFp: string; promptVersion: string; updatedAt: string }) | null> {
  try {
    const [r] = await q<Row>(
      `SELECT id, status, outcome, findings, rejected, calls, attempts, ai_trace_ids, retry_at, pages_total, pages_examined, context_fp, prompt_version, updated_at
         FROM t3_knowledge_queries WHERE account_id = $1 AND file_id = $2 AND field_key = $3 ORDER BY updated_at DESC, id DESC LIMIT 1`,
      [accountId, fileId, fieldKey],
    );
    if (!r) return null;
    return {
      id: Number(r.id), status: r.status as StoredKnowledgeQuery['status'], outcome: (r.outcome as StoredKnowledgeQuery['outcome']) ?? null,
      findings: json<ValidatedFinding[]>(r.findings, []), rejected: json<Rejection[]>(r.rejected, []),
      calls: Number(r.calls ?? 0), attempts: Number(r.attempts ?? 0), traceIds: (r.ai_trace_ids as string[] | null) ?? [],
      retryAt: r.retry_at ? new Date(r.retry_at as string).toISOString() : null, pagesTotal: Number(r.pages_total ?? 0), pagesExamined: Number(r.pages_examined ?? 0),
      contextFp: String(r.context_fp), promptVersion: String(r.prompt_version), updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  } catch { return null; }
}
