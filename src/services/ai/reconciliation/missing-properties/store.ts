/**
 * Lot 88B — journal des analyses et décisions (`property_recovery_runs`,
 * `property_recovery_decisions`, migration 0770) et budget d'appels PARTAGÉ
 * avec la connaissance T1 (85F, `T3_KNOWLEDGE_QUERY_DAILY_MAX`).
 *
 * Tolérant : tables absentes → aucune mémoire lue, et le service n'appelle
 * PAS le modèle (sans mémoire, un rappel sans fin serait possible).
 */
import { pgClient } from '@/db';
import type { SubjectType } from './contract';

type Row = Record<string, unknown>;
const q = async <T = Row>(sql: string, params: unknown[]): Promise<T[]> =>
  (await pgClient.unsafe(sql, params as never[])) as unknown as T[];

let etat: { ok: boolean; at: number } | null = null;
/** Tables 0770 présentes ? (revérifié toutes les 5 min tant qu'absentes). Ne lève jamais. */
export async function propertyRecoveryReady(): Promise<boolean> {
  if (etat && (etat.ok || Date.now() - etat.at < 300_000)) return etat.ok;
  let ok = false;
  try {
    const [r] = await q<{ ok: boolean }>(
      `SELECT to_regclass('property_recovery_runs') IS NOT NULL AND to_regclass('property_recovery_decisions') IS NOT NULL AS ok`, []);
    ok = r?.ok === true;
  } catch { ok = false; }
  etat = { ok, at: Date.now() };
  return ok;
}

/** Réservé aux tests. */
export function __resetPropertyRecoveryReadyForTests(): void { etat = null; }

export interface ObjectKey { accountId: number; objectType: SubjectType; objectId: number }

export interface StoredDecision {
  id: number;
  runId: number;
  fieldKey: string;
  questionFp: string;
  decision: 'WRITTEN' | 'ABSTAINED';
  cause: string | null;
  valueAfter: unknown;
}

/**
 * Décisions déjà rendues pour ces propriétés dans CE contexte (empreinte du
 * contexte, version du prompt), indexées par clé. Lève sur une lecture en échec.
 */
export async function decisionsFor(k: ObjectKey, contextFp: string, promptVersion: string, keys: readonly string[]): Promise<Map<string, StoredDecision>> {
  if (!keys.length) return new Map();
  const r = await q<Row>(
    `SELECT DISTINCT ON (field_key) id, run_id, field_key, question_fp, decision, cause, value_after
       FROM property_recovery_decisions
      WHERE account_id = $1 AND object_type = $2 AND object_id = $3 AND context_fp = $4 AND prompt_version = $5 AND field_key = ANY($6::text[])
      ORDER BY field_key, id DESC`,
    [k.accountId, k.objectType, k.objectId, contextFp, promptVersion, keys],
  );
  return new Map(r.map((x) => [String(x.field_key), {
    id: Number(x.id), runId: Number(x.run_id), fieldKey: String(x.field_key), questionFp: String(x.question_fp),
    decision: x.decision as StoredDecision['decision'], cause: (x.cause as string | null) ?? null, valueAfter: x.value_after ?? null,
  }]));
}

export interface StoredRun { id: number; status: string; attempts: number; retryAt: string | null }

/** Dernière analyse en échec IA de ce contexte (tentatives, prochaine tentative). Lève sur une lecture en échec. */
export async function failedRunFor(k: ObjectKey, contextFp: string, promptVersion: string): Promise<StoredRun | null> {
  const [r] = await q<Row>(
    `SELECT id, status, attempts, retry_at FROM property_recovery_runs
      WHERE account_id = $1 AND object_type = $2 AND object_id = $3 AND context_fp = $4 AND prompt_version = $5 AND status = 'AI_FAILED'
      ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [k.accountId, k.objectType, k.objectId, contextFp, promptVersion],
  );
  return r ? { id: Number(r.id), status: String(r.status), attempts: Number(r.attempts ?? 0), retryAt: r.retry_at ? new Date(r.retry_at as string).toISOString() : null } : null;
}

/**
 * Appels T3 du compte sur 24 h glissantes, TOUS usages de la branche
 * KNOWLEDGE_QUERY confondus (85F et 88B) : un seul budget. Lève sur une lecture en échec.
 */
export async function sharedKnowledgeCallsLastDay(accountId: number, now: Date): Promise<number> {
  const [r] = await q<{ n: number | string | null }>(
    `SELECT (COALESCE((SELECT sum(calls) FROM property_recovery_runs WHERE account_id = $1 AND updated_at > $2::timestamptz - interval '24 hours'), 0)
           + CASE WHEN to_regclass('t3_knowledge_queries') IS NULL THEN 0 ELSE
               COALESCE((SELECT sum(calls) FROM t3_knowledge_queries WHERE account_id = $1 AND updated_at > $2::timestamptz - interval '24 hours'), 0) END)::int AS n`,
    [accountId, now.toISOString()],
  );
  return Number(r?.n ?? 0);
}

export interface RunRecord extends ObjectKey {
  assetId: number;
  contextFp: string;
  promptVersion: string;
  contractVersion: string;
  batchFp: string;
  properties: string[];
  status: 'ANSWERED' | 'NO_EVIDENCE' | 'AI_FAILED' | 'BUDGET_EXHAUSTED';
  pagesTotal: number;
  pagesExamined: number;
  calls: number;
  traceIds: string[];
  contextSummary: Record<string, unknown>;
  error?: string | null;
  retryAt?: string | null;
  trigger: string;
  runRef?: string | null;
}

/** Mémorise une analyse (entrée unique : mise à jour, appels et tentatives cumulés). Rend l'identifiant. */
export async function saveRun(r: RunRecord): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO property_recovery_runs (account_id, asset_id, object_type, object_id, context_fp, prompt_version, contract_version, batch_fp, properties,
                                         status, pages_total, pages_examined, calls, attempts, ai_trace_ids, context_summary, error, retry_at, trigger_code, run_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, 1, $14::text[], $15::jsonb, $16, $17::timestamptz, $18, $19)
     ON CONFLICT (account_id, object_type, object_id, context_fp, prompt_version, batch_fp) DO UPDATE SET
       status = EXCLUDED.status, pages_total = EXCLUDED.pages_total, pages_examined = EXCLUDED.pages_examined,
       calls = property_recovery_runs.calls + EXCLUDED.calls, attempts = property_recovery_runs.attempts + 1,
       ai_trace_ids = (property_recovery_runs.ai_trace_ids || EXCLUDED.ai_trace_ids)[1:20], context_summary = EXCLUDED.context_summary,
       error = EXCLUDED.error, retry_at = EXCLUDED.retry_at, trigger_code = EXCLUDED.trigger_code,
       run_ref = COALESCE(EXCLUDED.run_ref, property_recovery_runs.run_ref), updated_at = now()
     RETURNING id`,
    [
      r.accountId, r.assetId, r.objectType, r.objectId, r.contextFp, r.promptVersion, r.contractVersion, r.batchFp, r.properties,
      r.status, r.pagesTotal, r.pagesExamined, r.calls, r.traceIds.slice(0, 20), JSON.stringify(r.contextSummary),
      r.error ? String(r.error).slice(0, 500) : null, r.retryAt ?? null, r.trigger, r.runRef ?? null,
    ],
  );
  return Number(row.id);
}

export interface DecisionRecord extends ObjectKey {
  runId: number;
  assetId: number;
  fieldKey: string;
  questionFp: string;
  contextFp: string;
  promptVersion: string;
  decision: 'WRITTEN' | 'ABSTAINED';
  cause: string | null;
  valueBefore: unknown;
  valueAfter: unknown;
  proposedValue: unknown;
  findings: unknown[];
  rejected: unknown[];
  evidenceIds: number[];
  provenance: Record<string, unknown>;
  writeOutcome: string | null;
}

const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/** Décision d'une propriété (une par contexte : un rejeu ne crée pas de doublon). Rend l'identifiant. */
export async function saveDecision(d: DecisionRecord): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO property_recovery_decisions (run_id, account_id, asset_id, object_type, object_id, field_key, question_fp, context_fp, prompt_version,
                                              decision, cause, value_before, value_after, proposed_value, findings, rejected, evidence_ids, provenance, write_outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::int[], $18::jsonb, $19)
     ON CONFLICT (account_id, object_type, object_id, field_key, context_fp, prompt_version, question_fp) DO UPDATE SET
       run_id = EXCLUDED.run_id, decision = EXCLUDED.decision, cause = EXCLUDED.cause, value_before = EXCLUDED.value_before,
       value_after = EXCLUDED.value_after, proposed_value = EXCLUDED.proposed_value, findings = EXCLUDED.findings, rejected = EXCLUDED.rejected,
       evidence_ids = EXCLUDED.evidence_ids, provenance = EXCLUDED.provenance, write_outcome = EXCLUDED.write_outcome
     RETURNING id`,
    [
      d.runId, d.accountId, d.assetId, d.objectType, d.objectId, d.fieldKey, d.questionFp, d.contextFp, d.promptVersion,
      d.decision, d.cause, j(d.valueBefore), j(d.valueAfter), j(d.proposedValue), JSON.stringify(d.findings.slice(0, 20)),
      JSON.stringify(d.rejected.slice(0, 20)), d.evidenceIds.slice(0, 50), JSON.stringify(d.provenance), d.writeOutcome,
    ],
  );
  return Number(row.id);
}
