/**
 * Lot 99B — persistance de la mise en conformité automatique des prompts
 * (migration 0860). SQL brut ; lectures tolérantes à l'absence des tables
 * (avant migration : aucune incompatibilité affichée, jamais d'erreur d'écran).
 */
import { pgClient } from '@/db';

export type IssueStatus = 'DETECTED' | 'CORRECTING' | 'TESTING' | 'BLOCKED' | 'ACTIVATED' | 'FAILED' | 'ROLLED_BACK' | 'RESOLVED';
export type Defect = 'ABSENT' | 'OBSOLETE' | 'INCOMPLETE' | 'INCOMPATIBLE' | 'NONE';
export type FaultKind = 'PROMPT' | 'CODE' | 'DATA' | 'NONE';

export interface IssueRow {
  id: number;
  environment: string;
  contractId: string;
  treatment: string;
  masterPromptCode: string;
  status: IssueStatus;
  defect: Defect;
  faultKind: FaultKind;
  cause: string;
  impact: string;
  occurrences: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  lastTrigger: string | null;
  activePromptVersionId: number | null;
  activePromptSha256: string | null;
  contextFingerprint: string | null;
  candidatePromptVersionId: number | null;
  candidateConfigVersionId: number | null;
  previousConfigVersionId: number | null;
  campaignId: number | null;
  correction: Record<string, unknown>;
  qualification: Record<string, unknown>;
  catchup: Record<string, unknown>;
  postCheck: Record<string, unknown>;
  refusalReasons: string[];
  decision: string | null;
  activatedAt: string | null;
  watchUntil: string | null;
  rolledBackAt: string | null;
  resolvedAt: string | null;
  retryRequestedBy: number | null;
  retryRequestedAt: string | null;
  updatedAt: string;
}

export interface EventRow {
  id: number; issueId: number; contractId: string; kind: string; statusBefore: string | null; statusAfter: string | null;
  message: string; payload: Record<string, unknown>; createdAt: string;
}

type Row = Record<string, unknown>;
type Sql = { unsafe: (query: string, params?: never[]) => Promise<unknown> };
const db = (): Sql => pgClient as unknown as Sql;
const q = async (text: string, params: unknown[] = [], sql: Sql = db()): Promise<Row[]> => (await sql.unsafe(text, params as never[])) as Row[];
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const absent = (e: unknown) => ['42P01', '42703'].includes(String((e as { code?: unknown })?.code ?? ''));

const toIssue = (r: Row): IssueRow => ({
  id: Number(r.id), environment: String(r.environment), contractId: String(r.contract_id), treatment: String(r.treatment),
  masterPromptCode: String(r.master_prompt_code), status: String(r.status) as IssueStatus, defect: String(r.defect) as Defect,
  faultKind: String(r.fault_kind) as FaultKind, cause: String(r.cause), impact: String(r.impact), occurrences: Number(r.occurrences),
  firstDetectedAt: iso(r.first_detected_at)!, lastDetectedAt: iso(r.last_detected_at)!, lastTrigger: str(r.last_trigger),
  activePromptVersionId: num(r.active_prompt_version_id), activePromptSha256: str(r.active_prompt_sha256), contextFingerprint: str(r.context_fingerprint),
  candidatePromptVersionId: num(r.candidate_prompt_version_id), candidateConfigVersionId: num(r.candidate_config_version_id),
  previousConfigVersionId: num(r.previous_config_version_id), campaignId: num(r.campaign_id),
  correction: obj(r.correction), qualification: obj(r.qualification), catchup: obj(r.catchup), postCheck: obj(r.post_check),
  refusalReasons: Array.isArray(r.refusal_reasons) ? (r.refusal_reasons as unknown[]).map(String) : [],
  decision: str(r.decision), activatedAt: iso(r.activated_at), watchUntil: iso(r.watch_until), rolledBackAt: iso(r.rolled_back_at),
  resolvedAt: iso(r.resolved_at), retryRequestedBy: num(r.retry_requested_by), retryRequestedAt: iso(r.retry_requested_at), updatedAt: iso(r.updated_at)!,
});

const toEvent = (r: Row): EventRow => ({
  id: Number(r.id), issueId: Number(r.issue_id), contractId: String(r.contract_id), kind: String(r.kind),
  statusBefore: str(r.status_before), statusAfter: str(r.status_after), message: String(r.message), payload: obj(r.payload), createdAt: iso(r.created_at)!,
});

export async function conformityTablesReady(): Promise<boolean> {
  try {
    const r = await q(`SELECT to_regclass('ai_prompt_conformity_issues') IS NOT NULL AND to_regclass('ai_prompt_conformity_events') IS NOT NULL AS ok`);
    return Boolean(r[0]?.ok);
  } catch {
    return false;
  }
}

export async function listIssues(environment: string): Promise<IssueRow[]> {
  try {
    return (await q(`SELECT * FROM ai_prompt_conformity_issues WHERE environment = $1 ORDER BY (status = 'RESOLVED'), updated_at DESC, id DESC`, [environment])).map(toIssue);
  } catch (e) {
    if (absent(e)) return [];
    throw e;
  }
}

export async function getIssue(id: number): Promise<IssueRow | null> {
  const [r] = await q(`SELECT * FROM ai_prompt_conformity_issues WHERE id = $1`, [id]);
  return r ? toIssue(r) : null;
}

export async function getIssueByContract(environment: string, contractId: string): Promise<IssueRow | null> {
  const [r] = await q(`SELECT * FROM ai_prompt_conformity_issues WHERE environment = $1 AND contract_id = $2`, [environment, contractId]);
  return r ? toIssue(r) : null;
}

export async function listEvents(issueId: number, limit = 50): Promise<EventRow[]> {
  try {
    return (await q(`SELECT * FROM ai_prompt_conformity_events WHERE issue_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [issueId, limit])).map(toEvent);
  } catch (e) {
    if (absent(e)) return [];
    throw e;
  }
}

/**
 * Détection : une ligne par (environnement, contrat). Occurrence identique
 * regroupée (compteur, dernière détection) ; une incompatibilité RÉSOLUE qui
 * réapparaît est rouverte (DETECTED). Rend la ligne et si elle est nouvelle.
 */
export async function upsertDetection(p: {
  environment: string; contractId: string; treatment: string; masterPromptCode: string; defect: Defect; faultKind: FaultKind;
  cause: string; impact: string; trigger: string; activePromptVersionId: number | null; activePromptSha256: string | null; now: Date;
}): Promise<{ issue: IssueRow; created: boolean; reopened: boolean }> {
  const avant = await getIssueByContract(p.environment, p.contractId);
  const [r] = await q(
    `INSERT INTO ai_prompt_conformity_issues
       (environment, contract_id, treatment, master_prompt_code, status, defect, fault_kind, cause, impact, last_trigger,
        active_prompt_version_id, active_prompt_sha256, first_detected_at, last_detected_at, updated_at)
     VALUES ($1, $2, $3, $4, 'DETECTED', $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, $12::timestamptz, $12::timestamptz)
     ON CONFLICT (environment, contract_id) DO UPDATE SET
       occurrences = ai_prompt_conformity_issues.occurrences + 1,
       last_detected_at = EXCLUDED.last_detected_at, last_trigger = EXCLUDED.last_trigger,
       defect = EXCLUDED.defect, fault_kind = EXCLUDED.fault_kind, cause = EXCLUDED.cause, impact = EXCLUDED.impact,
       active_prompt_version_id = EXCLUDED.active_prompt_version_id, active_prompt_sha256 = EXCLUDED.active_prompt_sha256,
       status = CASE WHEN ai_prompt_conformity_issues.status = 'RESOLVED' THEN 'DETECTED' ELSE ai_prompt_conformity_issues.status END,
       resolved_at = CASE WHEN ai_prompt_conformity_issues.status = 'RESOLVED' THEN NULL ELSE ai_prompt_conformity_issues.resolved_at END,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [p.environment, p.contractId, p.treatment, p.masterPromptCode, p.defect, p.faultKind, p.cause.slice(0, 2000), p.impact.slice(0, 1000),
      p.trigger.slice(0, 120), p.activePromptVersionId, p.activePromptSha256, p.now.toISOString()],
  );
  const issue = toIssue(r);
  return { issue, created: !avant, reopened: avant?.status === 'RESOLVED' };
}

type Patch = Partial<{
  status: IssueStatus; defect: Defect; faultKind: FaultKind; cause: string; contextFingerprint: string | null;
  activePromptVersionId: number | null; activePromptSha256: string | null;
  candidatePromptVersionId: number | null; candidateConfigVersionId: number | null; previousConfigVersionId: number | null; campaignId: number | null;
  correction: Record<string, unknown>; qualification: Record<string, unknown>; catchup: Record<string, unknown>; postCheck: Record<string, unknown>;
  refusalReasons: string[]; decision: string | null; activatedAt: Date | null; watchUntil: Date | null; rolledBackAt: Date | null; resolvedAt: Date | null;
  retryRequestedBy: number | null; retryRequestedAt: Date | null;
}>;

const COLS: Record<keyof Patch, [string, string]> = {
  status: ['status', ''], defect: ['defect', ''], faultKind: ['fault_kind', ''], cause: ['cause', ''], contextFingerprint: ['context_fingerprint', ''],
  activePromptVersionId: ['active_prompt_version_id', ''], activePromptSha256: ['active_prompt_sha256', ''],
  candidatePromptVersionId: ['candidate_prompt_version_id', ''], candidateConfigVersionId: ['candidate_config_version_id', ''],
  previousConfigVersionId: ['previous_config_version_id', ''], campaignId: ['campaign_id', ''],
  correction: ['correction', '::jsonb'], qualification: ['qualification', '::jsonb'], catchup: ['catchup', '::jsonb'], postCheck: ['post_check', '::jsonb'],
  refusalReasons: ['refusal_reasons', '::jsonb'], decision: ['decision', ''], activatedAt: ['activated_at', '::timestamptz'],
  watchUntil: ['watch_until', '::timestamptz'], rolledBackAt: ['rolled_back_at', '::timestamptz'], resolvedAt: ['resolved_at', '::timestamptz'],
  retryRequestedBy: ['retry_requested_by', ''], retryRequestedAt: ['retry_requested_at', '::timestamptz'],
};

export async function updateIssue(id: number, patch: Patch): Promise<IssueRow> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(patch) as Array<[keyof Patch, unknown]>) {
    if (v === undefined) continue;
    const [col, cast] = COLS[k];
    const val = v instanceof Date ? v.toISOString() : cast === '::jsonb' ? JSON.stringify(v) : v;
    vals.push(val);
    sets.push(`${col} = $${vals.length}${cast}`);
  }
  const [r] = await q(`UPDATE ai_prompt_conformity_issues SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $1 RETURNING *`, vals);
  return toIssue(r);
}

/** Journal append-only (aucun secret : textes de prompt, empreintes, identifiants de version). */
export async function addEvent(issue: Pick<IssueRow, 'id' | 'environment' | 'contractId'>, e: {
  kind: string; message: string; statusBefore?: string | null; statusAfter?: string | null; payload?: Record<string, unknown>;
}): Promise<void> {
  await q(
    `INSERT INTO ai_prompt_conformity_events (issue_id, environment, contract_id, kind, status_before, status_after, message, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [issue.id, issue.environment, issue.contractId, e.kind, e.statusBefore ?? null, e.statusAfter ?? null, e.message.slice(0, 2000), JSON.stringify(e.payload ?? {})],
  );
}

/** Changement de statut journalisé (une ligne d'événement par transition). */
export async function transition(issue: IssueRow, status: IssueStatus, e: { kind: string; message: string; payload?: Record<string, unknown> }, patch: Patch = {}): Promise<IssueRow> {
  const next = await updateIssue(issue.id, { ...patch, status });
  await addEvent(issue, { ...e, statusBefore: issue.status, statusAfter: status });
  return next;
}
