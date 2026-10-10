/**
 * Contexte d'évaluation des relations T3 réévaluables autres que
 * DOCUMENT_ASSET (lot 34E, migration 0292 — `t3_reconciliation_states`).
 *
 * Pour chaque résolution réévaluable : version du moteur, révision de
 * connaissance évaluée, empreinte du contexte, date, résultat, raison. Même
 * contrat que `document_asset_resolutions` (qui garde ses colonnes propres) :
 * une décision n'est rejouée que si la connaissance du compte a évolué ET que
 * son contexte pertinent a changé. Écrire ici ne journalise rien (aucune
 * boucle d'invalidation).
 */
import { pgClient } from '@/db';

export interface ReconciliationState {
  relation: string;
  subjectType: string;
  subjectId: number;
  accountId: number;
  engineVersion: number;
  knowledgeRevision: number | null;
  contextFingerprint: string | null;
  result: string;
  reason: string | null;
  detail: Record<string, unknown>;
  runs: number;
  evaluatedAt: string;
}

export async function getReconciliationState(relation: string, subjectType: string, subjectId: number): Promise<ReconciliationState | null> {
  const rows = (await pgClient.unsafe(
    `SELECT relation, subject_type, subject_id, account_id, engine_version, knowledge_revision, context_fingerprint,
            result, reason, detail, runs, evaluated_at
       FROM t3_reconciliation_states WHERE relation = $1 AND subject_type = $2 AND subject_id = $3`,
    [relation, subjectType, subjectId] as never[],
  )) as unknown as Array<Record<string, unknown>>;
  const r = rows[0];
  if (!r) return null;
  const detail = typeof r.detail === 'string' ? JSON.parse(r.detail) as Record<string, unknown> : (r.detail as Record<string, unknown>) ?? {};
  return {
    relation: String(r.relation), subjectType: String(r.subject_type), subjectId: Number(r.subject_id),
    accountId: Number(r.account_id), engineVersion: Number(r.engine_version),
    knowledgeRevision: r.knowledge_revision == null ? null : Number(r.knowledge_revision),
    contextFingerprint: (r.context_fingerprint as string | null) ?? null,
    result: String(r.result), reason: (r.reason as string | null) ?? null, detail,
    runs: Number(r.runs ?? 0), evaluatedAt: new Date(String(r.evaluated_at)).toISOString(),
  };
}

export async function recordReconciliationState(s: Omit<ReconciliationState, 'runs' | 'evaluatedAt'>): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO t3_reconciliation_states (relation, subject_type, subject_id, account_id, engine_version, knowledge_revision,
                                           context_fingerprint, result, reason, detail, runs, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10::jsonb, 1, now())
     ON CONFLICT (relation, subject_type, subject_id) DO UPDATE SET
       account_id = $4, engine_version = $5, knowledge_revision = $6::bigint, context_fingerprint = $7,
       result = $8, reason = $9, detail = $10::jsonb, runs = t3_reconciliation_states.runs + 1, evaluated_at = now()`,
    [s.relation, s.subjectType, s.subjectId, s.accountId, s.engineVersion, s.knowledgeRevision, s.contextFingerprint,
     s.result, s.reason, JSON.stringify(s.detail ?? {})] as never[],
  );
}
