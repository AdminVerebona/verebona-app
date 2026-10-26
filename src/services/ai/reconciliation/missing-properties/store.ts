/**
 * Lot 88B — journal des analyses et décisions (`property_recovery_runs`,
 * `property_recovery_decisions`, migration 0770) et budget d'appels PARTAGÉ
 * avec la connaissance T1 (85F, `T3_KNOWLEDGE_QUERY_DAILY_MAX`).
 *
 * Tolérant : tables absentes → aucune mémoire lue, et le service n'appelle
 * PAS le modèle (sans mémoire, un rappel sans fin serait possible).
 *
 * Lot 91B — TOUTE issue est persistée : en plus des analyses T3, une ligne
 * « d'issue » (empreinte de lot `gate:…`) consigne ce qui a empêché l'appel
 * (contrat T3 absent, nouvelle tentative pas encore due, pannes répétées,
 * campagne à blanc, anti-boucle, objet jamais sélectionné) avec sa cause,
 * l'état du contrat, la campagne et le déclencheur (colonnes 0790). Une
 * ligne d'issue ne remplace jamais une analyse (tentatives, appels). Si le
 * journal lui-même est inutilisable, une anomalie de Supervision est
 * ouverte (`MEMORY_UNAVAILABLE`), résolue à la première écriture réussie.
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

interface ObjectKey { accountId: number; objectType: SubjectType; objectId: number }

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

/** Préfixe de l'empreinte de lot des lignes d'ISSUE (lot 91B) : jamais une analyse T3. */
export const GATE_BATCH_PREFIX = 'gate:';

/** Dernière analyse en échec IA de ce contexte (tentatives, prochaine tentative). Lève sur une lecture en échec. */
export async function failedRunFor(k: ObjectKey, contextFp: string, promptVersion: string): Promise<StoredRun | null> {
  const [r] = await q<Row>(
    `SELECT id, status, attempts, retry_at FROM property_recovery_runs
      WHERE account_id = $1 AND object_type = $2 AND object_id = $3 AND context_fp = $4 AND prompt_version = $5 AND status = 'AI_FAILED'
        AND batch_fp NOT LIKE '${GATE_BATCH_PREFIX}%'
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

/** Statuts d'une ANALYSE (0770). */
type AnalysisStatus = 'ANSWERED' | 'NO_EVIDENCE' | 'AI_FAILED' | 'BUDGET_EXHAUSTED';
/**
 * Lot 91B — issues persistées AVANT tout appel T3 (0790) :
 *   CONTRACT_PENDING   le prompt T3 actif ne porte pas le contrat d'entrée ;
 *   RETRY_SCHEDULED    panne IA récente : nouvelle tentative pas encore due ;
 *   AI_FAILED          (ligne d'issue) tentatives épuisées sur ce contexte ;
 *   DRY_RUN            campagne à blanc : réparation prévue, aucun appel ;
 *   REPAIR_SUPPRESSED  anti-boucle du moteur : mêmes entrées déjà tentées ;
 *   NOT_SELECTED       objet porteur de sources jamais contrôlé (rattrapage) ;
 *   NOT_EXECUTED       autre cause d'orchestration (motif dans `cause`) ;
 *   MEMORY_UNAVAILABLE journal partiellement indisponible (lecture en échec).
 */
export type GateStatus =
  | 'CONTRACT_PENDING' | 'RETRY_SCHEDULED' | 'AI_FAILED' | 'DRY_RUN' | 'REPAIR_SUPPRESSED' | 'NOT_SELECTED' | 'NOT_EXECUTED' | 'MEMORY_UNAVAILABLE';
const ANALYSIS_STATUSES: ReadonlySet<string> = new Set(['ANSWERED', 'NO_EVIDENCE', 'AI_FAILED', 'BUDGET_EXHAUSTED']);

/** Champs de traçabilité du lot 91B (colonnes 0790), facultatifs. */
interface Traceability {
  cause?: string | null;
  contractState?: string | null;
  campaignId?: number | null;
}

interface RunRecord extends ObjectKey, Traceability {
  assetId: number;
  contextFp: string;
  promptVersion: string;
  contractVersion: string;
  batchFp: string;
  properties: string[];
  status: AnalysisStatus;
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

let colonnes0790: { ok: boolean; at: number } | null = null;
/** Colonnes de traçabilité 0790 présentes ? (revérifié toutes les 5 min tant qu'absentes). Ne lève jamais. */
export async function propertyRecoveryOutcomesReady(): Promise<boolean> {
  if (colonnes0790 && (colonnes0790.ok || Date.now() - colonnes0790.at < 300_000)) return colonnes0790.ok;
  let ok = false;
  try {
    const [r] = await q<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
                         AND table_name = 'property_recovery_runs' AND column_name = 'contract_state') AS ok`, []);
    ok = r?.ok === true;
  } catch { ok = false; }
  colonnes0790 = { ok, at: Date.now() };
  return ok;
}

/** Réservé aux tests : oublie les détections de schéma. */
export function __resetRecoveryStoreCacheForTests(): void { etat = null; colonnes0790 = null; }

const borne = (v: string | null | undefined, n = 500) => (v ? String(v).slice(0, n) : null);

/** Mémorise une analyse (entrée unique : mise à jour, appels et tentatives cumulés). Rend l'identifiant. */
export async function saveRun(r: RunRecord): Promise<number> {
  if (!ANALYSIS_STATUSES.has(r.status)) throw new Error(`statut d'analyse inconnu : ${r.status}`);
  if (await propertyRecoveryOutcomesReady()) {
    const [row] = await q<{ id: number }>(
      `INSERT INTO property_recovery_runs (account_id, asset_id, object_type, object_id, context_fp, prompt_version, contract_version, batch_fp, properties,
                                           status, pages_total, pages_examined, calls, attempts, ai_trace_ids, context_summary, error, retry_at, trigger_code, run_ref,
                                           cause, contract_state, campaign_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, 1, $14::text[], $15::jsonb, $16, $17::timestamptz, $18, $19, $20, $21, $22)
       ON CONFLICT (account_id, object_type, object_id, context_fp, prompt_version, batch_fp) DO UPDATE SET
         status = EXCLUDED.status, pages_total = EXCLUDED.pages_total, pages_examined = EXCLUDED.pages_examined,
         calls = property_recovery_runs.calls + EXCLUDED.calls, attempts = property_recovery_runs.attempts + 1,
         ai_trace_ids = (property_recovery_runs.ai_trace_ids || EXCLUDED.ai_trace_ids)[1:20], context_summary = EXCLUDED.context_summary,
         error = EXCLUDED.error, retry_at = EXCLUDED.retry_at, trigger_code = EXCLUDED.trigger_code,
         run_ref = COALESCE(EXCLUDED.run_ref, property_recovery_runs.run_ref), cause = EXCLUDED.cause, contract_state = EXCLUDED.contract_state,
         campaign_id = COALESCE(EXCLUDED.campaign_id, property_recovery_runs.campaign_id), updated_at = now()
       RETURNING id`,
      [
        r.accountId, r.assetId, r.objectType, r.objectId, r.contextFp, r.promptVersion, r.contractVersion, r.batchFp, r.properties,
        r.status, r.pagesTotal, r.pagesExamined, r.calls, r.traceIds.slice(0, 20), JSON.stringify(r.contextSummary),
        borne(r.error), r.retryAt ?? null, r.trigger, r.runRef ?? null, borne(r.cause), r.contractState ?? null, r.campaignId ?? null,
      ],
    );
    return Number(row.id);
  }
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

interface DecisionRecord extends ObjectKey {
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

interface OutcomeRecord extends ObjectKey, Traceability {
  assetId: number;
  /** Empreinte du contexte courant (`''` quand l'objet n'a pas pu être lu : non sélectionné). */
  contextFp: string;
  promptVersion: string;
  contractVersion: string;
  /** Empreinte des propriétés concernées (préfixée `gate:` à l'écriture). */
  batchFp: string;
  properties: string[];
  status: GateStatus;
  cause: string;
  contextSummary?: Record<string, unknown>;
  retryAt?: string | null;
  trigger: string;
  runRef?: string | null;
}

/**
 * Lot 91B — consigne une ISSUE sans appel T3 (une ligne par objet, contexte,
 * version du prompt et lot de propriétés : un rejeu met à jour la même ligne,
 * date, déclencheur et nombre d'observations — `attempts`). Lève si le
 * journal est inutilisable (tables 0770 ou colonnes 0790 absentes, écriture
 * refusée) : l'appelant le signale (`reportRecoveryStorageUnavailable`).
 */
export async function saveOutcome(o: OutcomeRecord): Promise<number> {
  if (!(await propertyRecoveryReady())) throw new Error('journal 88B absent (migration 0770)');
  if (!(await propertyRecoveryOutcomesReady())) throw new Error('journal 88B sans colonnes de traçabilité (migration 0790)');
  const [row] = await q<{ id: number }>(
    `INSERT INTO property_recovery_runs (account_id, asset_id, object_type, object_id, context_fp, prompt_version, contract_version, batch_fp, properties,
                                         status, pages_total, pages_examined, calls, attempts, ai_trace_ids, context_summary, error, retry_at, trigger_code, run_ref,
                                         cause, contract_state, campaign_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, 0, 0, 0, 1, '{}', $11::jsonb, NULL, $12::timestamptz, $13, $14, $15, $16, $17)
     ON CONFLICT (account_id, object_type, object_id, context_fp, prompt_version, batch_fp) DO UPDATE SET
       status = EXCLUDED.status, properties = EXCLUDED.properties, attempts = property_recovery_runs.attempts + 1,
       context_summary = EXCLUDED.context_summary, retry_at = EXCLUDED.retry_at, trigger_code = EXCLUDED.trigger_code,
       run_ref = COALESCE(EXCLUDED.run_ref, property_recovery_runs.run_ref), cause = EXCLUDED.cause, contract_state = EXCLUDED.contract_state,
       campaign_id = EXCLUDED.campaign_id, updated_at = now()
     RETURNING id`,
    [
      o.accountId, o.assetId, o.objectType, o.objectId, o.contextFp, o.promptVersion, o.contractVersion, `${GATE_BATCH_PREFIX}${o.batchFp}`,
      o.properties, o.status, JSON.stringify(o.contextSummary ?? {}), o.retryAt ?? null, o.trigger, o.runRef ?? null, borne(o.cause),
      o.contractState ?? null, o.campaignId ?? null,
    ],
  );
  await clearRecoveryStorageAnomaly();
  return Number(row.id);
}

/** Dernière issue persistée d'un objet (analyse ou issue sans appel), tous contextes. */
export interface LatestOutcome {
  id: number;
  status: string;
  cause: string | null;
  gate: boolean;
  contextFp: string;
  promptVersion: string;
  properties: string[];
  calls: number;
  attempts: number;
  trigger: string | null;
  campaignId: number | null;
  retryAt: string | null;
  updatedAt: string;
}

/** Dernière issue de l'objet (null : aucune). Lève sur une lecture en échec. */
export async function latestOutcomeFor(k: ObjectKey): Promise<LatestOutcome | null> {
  const [r] = await q<Row>(
    `SELECT r.id, r.status, to_jsonb(r) ->> 'cause' AS cause, r.batch_fp, r.context_fp, r.prompt_version, r.properties, r.calls, r.attempts,
            r.trigger_code, (to_jsonb(r) ->> 'campaign_id')::bigint AS campaign_id, r.retry_at, r.updated_at
       FROM property_recovery_runs r
      WHERE r.account_id = $1 AND r.object_type = $2 AND r.object_id = $3
      ORDER BY r.updated_at DESC, r.id DESC LIMIT 1`,
    [k.accountId, k.objectType, k.objectId],
  );
  if (!r) return null;
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    id: Number(r.id), status: String(r.status), cause: (r.cause as string | null) ?? null, gate: String(r.batch_fp).startsWith(GATE_BATCH_PREFIX),
    contextFp: String(r.context_fp), promptVersion: String(r.prompt_version ?? ''), properties: (r.properties as string[] | null) ?? [],
    calls: Number(r.calls ?? 0), attempts: Number(r.attempts ?? 0), trigger: (r.trigger_code as string | null) ?? null,
    campaignId: r.campaign_id == null ? null : Number(r.campaign_id), retryAt: iso(r.retry_at), updatedAt: iso(r.updated_at)!,
  };
}

// ── Supervision : journal 88B inutilisable ──────────────────────────────────

/** Empreinte de l'anomalie « journal des propriétés manquantes inutilisable » (domaine « Autres traitements techniques »). */
export const RECOVERY_STORAGE_ANOMALY = 'other:missing-properties:memory_unavailable';
let signale = false;

/**
 * Lot 91B — le journal 88B ne peut pas être écrit (tables / colonnes
 * absentes, écriture refusée) : anomalie de Supervision consolidée (une par
 * nature, compte et objet dans le détail). Ne lève jamais.
 */
export async function reportRecoveryStorageUnavailable(p: { accountId: number; objectType: SubjectType; objectId: number; status: string; error: string }): Promise<void> {
  try {
    const { reportAnomaly } = await import('@/services/admin/anomaly.service');
    await reportAnomaly({
      domain: 'other', fingerprint: RECOVERY_STORAGE_ANOMALY,
      title: 'Propriétés manquantes (88B) : journal property_recovery_* inutilisable — issue non persistée',
      accountId: p.accountId,
      detail: {
        objectType: p.objectType, objectId: p.objectId, status: p.status, error: p.error.slice(0, 300),
        procedure: 'docs/exploitation/coherence-recette.md (§ 88B, issues persistées) — vérifier les migrations 0770 et 0790',
      },
    });
    signale = true;
  } catch (e) {
    console.error('[88B] signalement impossible :', (e as Error).message);
  }
}

/** Écriture du journal de nouveau possible : anomalie résolue automatiquement (une fois par processus). Ne lève jamais. */
async function clearRecoveryStorageAnomaly(): Promise<void> {
  if (!signale) return;
  signale = false;
  try {
    const { autoResolveAnomaly } = await import('@/services/admin/anomaly.service');
    await autoResolveAnomaly(RECOVERY_STORAGE_ANOMALY, { origin: 'property_recovery_write', cause: 'Journal 88B de nouveau inscriptible' });
  } catch { /* jamais bloquant */ }
}
