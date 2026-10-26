/**
 * Persistance de la qualification par couple — lot 86A (CDC Pilotage IA V2
 * P5 ; migrations 0724, 0725, 0726). SQL brut (`pgClient.unsafe`, règle
 * mémoire du typecheck) ; lectures tolérantes à l'absence des tables (avant
 * migration : aucune preuve, jamais d'erreur d'écran).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LECTURE DES PREUVES PAR COUPLE — POINT D'ENTRÉE DU FICHIER GLOBAL (86B)
 *
 * `listQualificationEvidence(filter)` rend les preuves historisées, de la
 * plus récente à la plus ancienne, AVEC leur état courant calculé
 * (admissible / refusée / non concluante / obsolète) par rapport à la
 * configuration ACTIVE de l'environnement. Le chantier 86B l'intègre au
 * format d'export `verebona-ia-config-export` (VER-02/03 : « preuves de
 * qualification, origine et état »). Champs stables (voir
 * `QualificationEvidenceRecord`) ; aucun contenu de document, aucune donnée
 * de compte (seulement des empreintes). Une preuve d'un autre prompt ou
 * contrat est rendue « obsolète », jamais « active » (VER-03).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import type { Defect } from './defects';
import type { CoupleSignatureParts } from './signature';
import type { EvidenceRef, QualificationState } from './states';
import type { CaseObservation, CoupleMetrics, Reason, Verdict } from './verdict';

type Row = Record<string, unknown>;
const q = async (text: string, params: unknown[] = []): Promise<Row[]> => (await pgClient.unsafe(text, params as never[])) as unknown as Row[];
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const str = (v: unknown): string | null => (v == null ? null : String(v));
const iso = (v: unknown): string | null => (v == null ? null : new Date(String(v)).toISOString());
const absent = (e: unknown) => ['42P01', '42703'].includes(String((e as { code?: unknown })?.code ?? ''));

// ── Campagnes ───────────────────────────────────────────────────────────────

type CampaignKind = 'MANUAL' | 'AUTO';
export type CampaignStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'REFUSED' | 'INTERRUPTED' | 'FAILED';

interface CampaignRow {
  id: number; kind: CampaignKind; status: CampaignStatus; environment: string; trigger: string | null; reason: string | null;
  adminUserId: number | null; configVersionId: number | null; candidateVersionId: number | null;
  restorePointId: string | null; restorePointAt: string | null; thresholdsVersion: string;
  request: Record<string, unknown>; summary: Record<string, unknown>; refusal: string | null; error: string | null;
  createdAt: string; startedAt: string | null; heartbeatAt: string | null; finishedAt: string | null;
}

const toCampaign = (r: Row): CampaignRow => ({
  id: Number(r.id), kind: String(r.kind) as CampaignKind, status: String(r.status) as CampaignStatus, environment: String(r.environment),
  trigger: str(r.trigger), reason: str(r.reason), adminUserId: num(r.admin_user_id), configVersionId: num(r.config_version_id),
  candidateVersionId: num(r.candidate_version_id), restorePointId: str(r.restore_point_id), restorePointAt: iso(r.restore_point_at),
  thresholdsVersion: String(r.thresholds_version), request: (r.request ?? {}) as Record<string, unknown>, summary: (r.summary ?? {}) as Record<string, unknown>,
  refusal: str(r.refusal), error: str(r.error), createdAt: iso(r.created_at)!, startedAt: iso(r.started_at), heartbeatAt: iso(r.heartbeat_at), finishedAt: iso(r.finished_at),
});

export async function createCampaign(p: {
  kind: CampaignKind; environment: string; trigger: string | null; reason: string | null; adminUserId: number | null;
  configVersionId: number | null; candidateVersionId?: number | null; thresholdsVersion: string; request: Record<string, unknown>;
}): Promise<number> {
  const [r] = await q(
    `INSERT INTO ai_qualification_campaigns (kind, environment, trigger, reason, admin_user_id, config_version_id, candidate_version_id, thresholds_version, request)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id`,
    [p.kind, p.environment, p.trigger, p.reason, p.adminUserId, p.configVersionId, p.candidateVersionId ?? null, p.thresholdsVersion, JSON.stringify(p.request)],
  );
  return Number(r.id);
}

export async function updateCampaign(id: number, patch: Partial<{
  status: CampaignStatus; startedAt: Date; finishedAt: Date; restorePointId: string | null; restorePointAt: string | null;
  summary: Record<string, unknown>; refusal: string | null; error: string | null; candidateVersionId: number | null; request: Record<string, unknown>;
}>): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const set = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
  if (patch.status) set('status', patch.status);
  if (patch.startedAt) set('started_at', patch.startedAt.toISOString(), '::timestamptz');
  if (patch.finishedAt) set('finished_at', patch.finishedAt.toISOString(), '::timestamptz');
  if (patch.restorePointId !== undefined) set('restore_point_id', patch.restorePointId);
  if (patch.restorePointAt !== undefined) set('restore_point_at', patch.restorePointAt, '::timestamptz');
  if (patch.summary) set('summary', JSON.stringify(patch.summary), '::jsonb');
  if (patch.request) set('request', JSON.stringify(patch.request), '::jsonb');
  if (patch.refusal !== undefined) set('refusal', patch.refusal);
  if (patch.error !== undefined) set('error', patch.error);
  if (patch.candidateVersionId !== undefined) set('candidate_version_id', patch.candidateVersionId);
  if (!sets.length) return;
  await q(`UPDATE ai_qualification_campaigns SET ${sets.join(', ')}, heartbeat_at = now() WHERE id = $1`, vals);
}

export async function heartbeat(id: number): Promise<void> {
  await q(`UPDATE ai_qualification_campaigns SET heartbeat_at = now() WHERE id = $1 AND status = 'RUNNING'`, [id]).catch(() => undefined);
}

export async function getCampaignRow(id: number): Promise<CampaignRow | null> {
  const [r] = await q(`SELECT * FROM ai_qualification_campaigns WHERE id = $1`, [id]);
  return r ? toCampaign(r) : null;
}

export async function listCampaigns(limit = 30): Promise<CampaignRow[]> {
  try {
    return (await q(`SELECT * FROM ai_qualification_campaigns ORDER BY created_at DESC, id DESC LIMIT $1`, [limit])).map(toCampaign);
  } catch (e) {
    if (absent(e)) return [];
    throw e;
  }
}

/** Campagnes en cours (couples « en test »). */
export async function runningCampaigns(environment: string): Promise<CampaignRow[]> {
  try {
    return (await q(`SELECT * FROM ai_qualification_campaigns WHERE environment = $1 AND status IN ('PENDING', 'RUNNING')`, [environment])).map(toCampaign);
  } catch (e) {
    if (absent(e)) return [];
    throw e;
  }
}

/**
 * Campagnes sans signe de vie (processus arrêté au milieu — R13) :
 * INTERROMPUES, verrous libérés. Aucune donnée métier n'a été écrite par la
 * campagne (rejeu en lecture) ; les journaux et preuves déjà écrits restent.
 */
export async function interruptStaleCampaigns(staleMs: number, now: Date = new Date()): Promise<number[]> {
  try {
    const rows = await q(
      `UPDATE ai_qualification_campaigns
          SET status = 'INTERRUPTED', finished_at = $2::timestamptz,
              error = COALESCE(error, 'Campagne interrompue (aucun signe de vie) : preuves non concluantes, verrous libérés.')
        WHERE status IN ('PENDING', 'RUNNING') AND COALESCE(heartbeat_at, created_at) < $1::timestamptz
        RETURNING id`,
      [new Date(now.getTime() - staleMs).toISOString(), now.toISOString()],
    );
    const ids = rows.map((r) => Number(r.id));
    if (ids.length) await q(`UPDATE ai_qualification_campaign_accounts SET released_at = now() WHERE campaign_id = ANY($1::bigint[]) AND released_at IS NULL`, [ids]);
    return ids;
  } catch (e) {
    if (absent(e)) return [];
    throw e;
  }
}

// ── Verrou par compte ───────────────────────────────────────────────────────

/** Verrouille les comptes pour la campagne ; rend ceux déjà pris par une autre campagne ouverte. */
export async function lockAccounts(campaignId: number, accountIds: readonly number[]): Promise<{ locked: number[]; busy: number[] }> {
  const locked: number[] = [];
  const busy: number[] = [];
  for (const a of [...new Set(accountIds)]) {
    const r = await q(
      `INSERT INTO ai_qualification_campaign_accounts (campaign_id, account_id) VALUES ($1, $2)
       ON CONFLICT (account_id) WHERE released_at IS NULL DO NOTHING RETURNING account_id`, [campaignId, a]);
    (r.length ? locked : busy).push(a);
  }
  return { locked, busy };
}

export async function releaseAccounts(campaignId: number): Promise<void> {
  await q(`UPDATE ai_qualification_campaign_accounts SET released_at = now() WHERE campaign_id = $1 AND released_at IS NULL`, [campaignId]);
}

export async function openLocks(campaignId: number): Promise<number[]> {
  return (await q(`SELECT account_id FROM ai_qualification_campaign_accounts WHERE campaign_id = $1 AND released_at IS NULL ORDER BY account_id`, [campaignId]))
    .map((r) => Number(r.account_id));
}

// ── Preuves ─────────────────────────────────────────────────────────────────

interface EvidenceInput {
  campaignId: number | null;
  environment: string;
  treatment: string;
  operationCode: string;
  model: string;
  servedModel: string | null;
  servedModelVersion: string | null;
  rank: number;
  configVersionId: number | null;
  configRevisionId: number | null;
  role: 'CANDIDATE' | 'REFERENCE';
  profile: Record<string, unknown>;
  signature: string;
  parts: CoupleSignatureParts;
  verdict: Verdict;
  reasons: Reason[];
  metrics: CoupleMetrics & Record<string, unknown>;
  referenceEvidenceId?: number | null;
}

export async function recordEvidence(e: EvidenceInput, observations: readonly (CaseObservation & { advisory?: boolean })[]): Promise<number> {
  return pgClient.begin(async (tx) => {
    const t = tx as unknown as { unsafe: (s: string, p?: never[]) => Promise<Row[]> };
    const [r] = await t.unsafe(
      `INSERT INTO ai_qualification_evidence
         (campaign_id, environment, treatment, operation_code, model, served_model, served_model_version, rank, config_version_id, config_revision_id,
          role, profile, signature, prompt_fingerprint, contract_fingerprint, corpus_fingerprint, evaluator_fingerprint, capabilities_sha256,
          thresholds_version, verdict, reasons, metrics, reference_evidence_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb,$23) RETURNING id`,
      [e.campaignId, e.environment, e.treatment, e.operationCode, e.model, e.servedModel, e.servedModelVersion, e.rank, e.configVersionId, e.configRevisionId,
       e.role, JSON.stringify(e.profile), e.signature, e.parts.promptFingerprint, e.parts.contractFingerprint, e.parts.corpusFingerprint,
       e.parts.evaluatorFingerprint, e.parts.capabilitiesSha256, e.parts.thresholdsVersion, e.verdict, JSON.stringify(e.reasons),
       JSON.stringify(e.metrics), e.referenceEvidenceId ?? null] as never[],
    );
    const id = Number(r.id);
    for (const o of observations) {
      await t.unsafe(
        `INSERT INTO ai_qualification_cases
           (evidence_id, case_id, source, expected_source, observation, account_id, capture_id, mandatory, outcome, defects, inconclusive_reason,
            historical_sha256, observed_sha256, matches_historical, duration_ms, timeout_ms, cost_micros, served_model, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [id, o.caseId, o.source, o.advisory ? `${o.expectedSource}:ADVISORY` : o.expectedSource, o.observation, o.accountId ?? null, o.captureId ?? null,
         o.mandatory, o.outcome, JSON.stringify(o.defects satisfies Defect[]), o.inconclusiveReason, o.historicalSha256 ?? null, o.observedSha256 ?? null,
         o.matchesHistorical ?? null, o.durationMs, o.timeoutMs, o.costMicros, o.servedModel, o.traceId] as never[],
      );
    }
    return id;
  }) as Promise<number>;
}

/** Preuves (références légères) des couples demandés, pour le calcul de l'état. */
export async function evidenceRefsFor(environment: string, couples: ReadonlyArray<{ operationCode: string; model: string; rank: number }>): Promise<Map<string, EvidenceRef[]>> {
  const out = new Map<string, EvidenceRef[]>();
  if (!couples.length) return out;
  try {
    const rows = await q(
      `SELECT id, operation_code, model, rank, verdict, signature, profile, prompt_fingerprint, contract_fingerprint, corpus_fingerprint,
              evaluator_fingerprint, capabilities_sha256, thresholds_version, created_at
         FROM ai_qualification_evidence
        WHERE environment = $1 AND operation_code = ANY($2::text[]) AND model = ANY($3::text[])
        ORDER BY created_at DESC, id DESC`,
      [environment, [...new Set(couples.map((c) => c.operationCode))], [...new Set(couples.map((c) => c.model))]],
    );
    for (const r of rows) {
      const key = coupleKey(String(r.operation_code), String(r.model), Number(r.rank));
      const list = out.get(key) ?? [];
      list.push({
        id: Number(r.id), verdict: String(r.verdict) as Verdict, signature: String(r.signature), createdAt: iso(r.created_at)!,
        parts: {
          operationCode: String(r.operation_code), model: String(r.model), rank: Number(r.rank), profile: (r.profile ?? {}) as Record<string, unknown>,
          promptFingerprint: str(r.prompt_fingerprint), contractFingerprint: str(r.contract_fingerprint), corpusFingerprint: str(r.corpus_fingerprint),
          evaluatorFingerprint: str(r.evaluator_fingerprint), capabilitiesSha256: str(r.capabilities_sha256), thresholdsVersion: String(r.thresholds_version),
        },
      });
      out.set(key, list);
    }
  } catch (e) {
    if (!absent(e)) throw e;
  }
  return out;
}

export const coupleKey = (operationCode: string, model: string, rank: number): string => `${operationCode}|${model}|${rank}`;

/** Preuve complète (BO, export). */
export interface QualificationEvidenceRecord {
  id: number;
  campaignId: number | null;
  environment: string;
  treatment: string;
  operationCode: string;
  model: string;
  servedModel: string | null;
  servedModelVersion: string | null;
  rank: number;
  role: 'CANDIDATE' | 'REFERENCE';
  configVersionId: number | null;
  configRevisionId: number | null;
  profile: Record<string, unknown>;
  signature: string;
  fingerprints: { prompt: string | null; contract: string | null; corpus: string | null; evaluator: string | null; capabilities: string | null };
  thresholdsVersion: string;
  verdict: Verdict;
  reasons: Reason[];
  metrics: Record<string, unknown>;
  referenceEvidenceId: number | null;
  createdAt: string;
  /** État courant (calculé : signature courante de la configuration active). */
  currentState?: QualificationState;
  currentStateChanged?: string[];
}

const toRecord = (r: Row): QualificationEvidenceRecord => ({
  id: Number(r.id), campaignId: num(r.campaign_id), environment: String(r.environment), treatment: String(r.treatment), operationCode: String(r.operation_code),
  model: String(r.model), servedModel: str(r.served_model), servedModelVersion: str(r.served_model_version), rank: Number(r.rank),
  role: String(r.role) as 'CANDIDATE' | 'REFERENCE', configVersionId: num(r.config_version_id), configRevisionId: num(r.config_revision_id),
  profile: (r.profile ?? {}) as Record<string, unknown>, signature: String(r.signature),
  fingerprints: { prompt: str(r.prompt_fingerprint), contract: str(r.contract_fingerprint), corpus: str(r.corpus_fingerprint), evaluator: str(r.evaluator_fingerprint), capabilities: str(r.capabilities_sha256) },
  thresholdsVersion: String(r.thresholds_version), verdict: String(r.verdict) as Verdict, reasons: (r.reasons ?? []) as Reason[],
  metrics: (r.metrics ?? {}) as Record<string, unknown>, referenceEvidenceId: num(r.reference_evidence_id), createdAt: iso(r.created_at)!,
});

export interface EvidenceFilter {
  environment?: string;
  operationCode?: string;
  model?: string;
  rank?: number;
  campaignId?: number;
  verdict?: Verdict;
  /** Ne garder que la dernière preuve de chaque couple (opération, modèle, rang). */
  latestPerCouple?: boolean;
  limit?: number;
}

/** Lecture brute des preuves (sans état courant) — voir `listQualificationEvidence` (service). */
export async function readEvidence(f: EvidenceFilter = {}): Promise<QualificationEvidenceRecord[]> {
  const cond: string[] = [];
  const vals: unknown[] = [];
  const add = (sql: string, v: unknown) => { vals.push(v); cond.push(sql.replace('?', `$${vals.length}`)); };
  if (f.environment) add('environment = ?', f.environment);
  if (f.operationCode) add('operation_code = ?', f.operationCode);
  if (f.model) add('model = ?', f.model);
  if (f.rank != null) add('rank = ?', f.rank);
  if (f.campaignId != null) add('campaign_id = ?', f.campaignId);
  if (f.verdict) add('verdict = ?', f.verdict);
  vals.push(Math.min(Math.max(1, f.limit ?? 500), 5000));
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const sql = f.latestPerCouple
    ? `SELECT * FROM (SELECT DISTINCT ON (environment, operation_code, model, rank) * FROM ai_qualification_evidence ${where}
         ORDER BY environment, operation_code, model, rank, created_at DESC, id DESC) d ORDER BY created_at DESC, id DESC LIMIT $${vals.length}`
    : `SELECT * FROM ai_qualification_evidence ${where} ORDER BY created_at DESC, id DESC LIMIT $${vals.length}`;
  try {
    return (await q(sql, vals)).map(toRecord);
  } catch (e) {
    if (absent(e)) return [];
    throw e;
  }
}

interface CaseRecord {
  caseId: string; source: string; expectedSource: string; advisory: boolean; observation: number; accountId: number | null; captureId: number | null;
  mandatory: boolean; outcome: string; defects: Defect[]; inconclusiveReason: string | null; historicalSha256: string | null; observedSha256: string | null;
  matchesHistorical: boolean | null; durationMs: number | null; timeoutMs: number | null; costMicros: number | null; servedModel: string | null; traceId: string | null;
}

export async function readCases(evidenceId: number): Promise<CaseRecord[]> {
  return (await q(`SELECT * FROM ai_qualification_cases WHERE evidence_id = $1 ORDER BY case_id, observation, id`, [evidenceId])).map((r) => {
    const es = String(r.expected_source);
    return {
      caseId: String(r.case_id), source: String(r.source), expectedSource: es.replace(/:ADVISORY$/, ''), advisory: es.endsWith(':ADVISORY'),
      observation: Number(r.observation), accountId: num(r.account_id), captureId: num(r.capture_id), mandatory: Boolean(r.mandatory), outcome: String(r.outcome),
      defects: (r.defects ?? []) as Defect[], inconclusiveReason: str(r.inconclusive_reason), historicalSha256: str(r.historical_sha256),
      observedSha256: str(r.observed_sha256), matchesHistorical: r.matches_historical == null ? null : Boolean(r.matches_historical),
      durationMs: num(r.duration_ms), timeoutMs: num(r.timeout_ms), costMicros: num(r.cost_micros), servedModel: str(r.served_model), traceId: str(r.trace_id),
    };
  });
}

// ── Rejeux : entrées capturées des données existantes ──────────────────────

/**
 * Entrées modèle capturées (82C) des traitements applicables sur les comptes
 * EXISTANTS éligibles (C-Q10), hors appels de qualification eux-mêmes, au
 * plus `perAccount` par compte et `max` au total (les plus récentes).
 */
export async function loadReplayCaptures(p: { operationCode: string; accountIds: readonly number[]; perAccount: number; max: number }): Promise<import('./cases').CaptureRow[]> {
  if (!p.accountIds.length || p.max <= 0) return [];
  try {
    const rows = await q(
      `SELECT * FROM (
         SELECT c.id, c.account_id, c.operation_code, c.prompt_text, c.prompt_status, c.response_status, c.variables, c.attachments, c.masking, c.parsed_output,
                ROW_NUMBER() OVER (PARTITION BY c.account_id ORDER BY c.id DESC) AS rn
           FROM ai_call_captures c
           LEFT JOIN ai_usage_event u ON u.id = c.usage_event_id
          WHERE c.operation_code = $1 AND c.account_id = ANY($2::int[]) AND c.call_kind = 'analysis' AND c.capture_status = 'CAPTURED'
            AND COALESCE(u.metadata->>'trigger', '') <> 'qualification'
            AND COALESCE(u.status, 'success') = 'success'
       ) x WHERE rn <= $3 ORDER BY id DESC LIMIT $4`,
      [p.operationCode, [...p.accountIds], p.perAccount, p.max],
    );
    return rows.map((r) => ({
      id: Number(r.id), accountId: Number(r.account_id), operationCode: String(r.operation_code), promptText: str(r.prompt_text),
      promptStatus: String(r.prompt_status), responseStatus: String(r.response_status), variables: (r.variables ?? null) as Record<string, unknown> | null,
      attachments: (r.attachments ?? null) as unknown[] | null, masking: r.masking ?? null, parsedOutput: r.parsed_output ?? null,
    }));
  } catch (e) {
    if (absent(e)) return [];
    throw e;
  }
}

/** Comptes existants éligibles au traitement (C-Q10), hors compte technique de mesure. */
export async function eligibleAccountIds(technicalAccountId: number | null): Promise<number[]> {
  const { processingEligibleSql } = await import('@/services/account/processing-eligibility');
  const rows = await q(`SELECT a.id FROM accounts a WHERE ${processingEligibleSql('a.id')} ORDER BY a.id`);
  return rows.map((r) => Number(r.id)).filter((id) => id !== technicalAccountId);
}

/** Modèle servi (version déclarée par le fournisseur) d'une trace, si connue. */
export async function servedModelVersionOf(traceId: string | null): Promise<string | null> {
  if (!traceId) return null;
  try {
    const [r] = await q(
      `SELECT metadata->'providerMeta'->>'modelVersion' AS v FROM ai_usage_event WHERE metadata->>'traceId' = $1 ORDER BY id DESC LIMIT 1`, [traceId]);
    return str(r?.v);
  } catch {
    return null;
  }
}
