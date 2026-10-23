/**
 * Cycle de vie des traitements d'un compte — lot 82A, décision PO C-Q10 et
 * §3.3 (23/10/2026).
 *
 * La règle d'éligibilité est dans `processing-eligibility.ts` ; elle est
 * vérifiée à la MISE EN FILE et à l'EXÉCUTION de chaque producteur de
 * travaux. Ce module traite les TRANSITIONS :
 *
 *   · éligible → non éligible (fin d'essai, suspension, lecture seule,
 *     impayé, rétractation, neutralisation) : `neutralizeAccountWork` —
 *     travaux de la file IA en attente ou en cours ANNULÉS proprement
 *     (CANCELLED, jeton révoqué : une exécution en cours ne peut plus rien
 *     écrire), marqués `payload.accountIneligible` pour réexamen. Les autres
 *     files (pré-génération mascotte, impacts de cohérence, migrations par
 *     repère, campagnes) ne sélectionnent tout simplement plus le compte :
 *     leurs demandes restent en place, sans doublon, et repartent d'elles-
 *     mêmes à la reprise ;
 *
 *   · non éligible → éligible : `onAccountReactivated` — POINT D'ENTRÉE
 *     UNIQUE de la reprise. Étapes enregistrées, dans l'ordre :
 *       1. `reexamine-neutralized-jobs` : chaque travail neutralisé encore
 *          pertinent est remis en file UNE fois (dernier par clé de
 *          déduplication, déduplication de la file : aucun doublon) ;
 *       2. `mascot-pregeneration` : situation de l'accueil réévaluée ;
 *       3. `catchup-control` : contrôle de rattrapage exhaustif du compte
 *          (aujourd'hui : rationalisation T3 COMPLÈTE du compte). Le contrôle
 *          de cohérence global (chantier 82B) remplace / complète cette étape
 *          par `registerAccountReactivationStep('catchup-control', …)`.
 *
 * Détection : `syncAccountEligibility(accountId)` compare l'éligibilité
 * courante au dernier état observé (`account_processing_states`, 0641) sous
 * verrou de ligne — une transition n'est traitée qu'UNE fois, même depuis
 * plusieurs instances. Appelée par les transitions connues (suspension et
 * réactivation BO, fin d'essai, synchronisation d'abonnement) et par la
 * tâche planifiée `account-eligibility-sync` (filet : essai échu par la seule
 * date, changement d'offre par un autre chemin).
 */
import {
  getAccountProcessingEligibility, invalidateProcessingEligibility, processingEligibleSql,
  INELIGIBILITY_LABELS, neutralizedMessage, type IneligibilityReason, type ProcessingEligibility,
} from './processing-eligibility';

type Raw = Record<string, unknown>;

async function q(text: string, params: unknown[] = []): Promise<Raw[]> {
  const { pgClient } = await import('@/db');
  return (await pgClient.unsafe(text, params as never[])) as unknown as Raw[];
}

let tableReady: boolean | null = null;
/** Table 0641 présente ? (mise en cache ; `null` = à relire). */
export async function processingStatesReady(): Promise<boolean> {
  if (tableReady !== null) return tableReady;
  try {
    const [r] = await q(`SELECT to_regclass('account_processing_states') IS NOT NULL AS ok`);
    tableReady = r?.ok === true;
  } catch {
    return false;
  }
  return tableReady;
}

/** Réservé aux tests : `null` = relire la base ; `false` = table absente (aucune requête). */
export function __setProcessingStatesReadyForTests(v: boolean | null): void { tableReady = v; }

// ── Neutralisation ──────────────────────────────────────────────────────────

export interface NeutralizationResult {
  aiJobsPending: number;
  aiJobsRunning: number;
}

/**
 * Neutralise les travaux de la file IA durable d'un compte devenu non
 * éligible : en attente ET en cours → CANCELLED (tentative non comptée,
 * jeton révoqué, exécutions locales interrompues), motif lisible au BO
 * (« Compte non éligible : … »), marqueur de réexamen. Idempotente.
 */
export async function neutralizeAccountWork(accountId: number, reason: IneligibilityReason, now: Date = new Date()): Promise<NeutralizationResult> {
  const rows = await q(
    `WITH cibles AS (
       SELECT id, status FROM ai_job_queue
        WHERE account_id = $1 AND status IN ('PENDING', 'RUNNING')
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ai_job_queue j
        SET status = 'CANCELLED', finished_at = NOW(), last_error = $2,
            attempts = CASE WHEN c.status = 'RUNNING' THEN GREATEST(j.attempts - 1, 0) ELSE j.attempts END,
            execution_id = NULL, worker_id = NULL, lease_expires_at = NULL,
            payload = COALESCE(j.payload, '{}'::jsonb) || jsonb_build_object('accountIneligible',
              jsonb_build_object('reason', $3::text, 'at', $4::text, 'previousStatus', c.status))
       FROM cibles c
      WHERE j.id = c.id
      RETURNING j.id, c.status AS before`,
    [accountId, neutralizedMessage(reason), reason, now.toISOString()],
  );
  const running = rows.filter((r) => r.before === 'RUNNING').map((r) => Number(r.id));
  if (running.length > 0) {
    const { abortLocalExecutions } = await import('@/services/ai/queue/execution-control');
    abortLocalExecutions(running, `compte non éligible (${INELIGIBILITY_LABELS[reason]})`);
  }
  const out = { aiJobsPending: rows.length - running.length, aiJobsRunning: running.length };
  if (rows.length > 0) {
    console.info(JSON.stringify({ event: 'account.processing_neutralized', accountId, reason, ...out }));
  }
  return out;
}


// ── Reprise ─────────────────────────────────────────────────────────────────

export interface ReactivationContext {
  accountId: number;
  /** Origine de la réactivation (`admin_reactivate`, `subscription_sync`, `eligibility_sync`…). */
  source: string;
  now: Date;
}

/** Une étape de reprise. Rend un résumé journalisable (jamais de donnée personnelle). */
export type AccountReactivationStep = (ctx: ReactivationContext) => Promise<Record<string, unknown> | void>;

const steps = new Map<string, AccountReactivationStep>();

/**
 * Enregistre (ou REMPLACE, même nom) une étape de reprise. Ordre
 * d'enregistrement conservé ; un remplacement garde la position d'origine.
 * Le contrôle de cohérence global (82B) branche ici son rattrapage :
 * `registerAccountReactivationStep('catchup-control', …)`.
 */
export function registerAccountReactivationStep(name: string, step: AccountReactivationStep): void {
  steps.set(name, step);
}

/** Étapes enregistrées (BO, tests). */
export function listAccountReactivationSteps(): string[] {
  return [...steps.keys()];
}

export interface ReactivationResult {
  accountId: number;
  source: string;
  steps: Record<string, { ok: boolean; detail?: Record<string, unknown>; error?: string }>;
}

/**
 * POINT D'ENTRÉE UNIQUE de la reprise d'un compte redevenu éligible
 * (C-Q10 : « à la réactivation, réévaluer les travaux encore pertinents,
 * prévenir les doublons et lancer un contrôle global exhaustif de
 * rattrapage »).
 *
 * Vérifie d'abord l'éligibilité (un appel pour un compte toujours non
 * éligible ne relance rien). Chaque étape est isolée : l'échec de l'une
 * n'empêche pas les suivantes, il est consigné (`last_catchup_result`) et
 * journalisé. Idempotente : les travaux déjà réexaminés ne sont pas remis en
 * file deux fois, les mises en file passent par la déduplication.
 */
export async function onAccountReactivated(
  accountId: number,
  opts: { source: string; now?: Date } = { source: 'manual' },
): Promise<ReactivationResult> {
  const now = opts.now ?? new Date();
  const out: ReactivationResult = { accountId, source: opts.source, steps: {} };
  invalidateProcessingEligibility(accountId);
  const e = await getAccountProcessingEligibility(accountId, now);
  if (!e.eligible) {
    out.steps.eligibility = { ok: false, error: `compte toujours non éligible : ${INELIGIBILITY_LABELS[e.reason ?? 'READ_ONLY']}` };
    return out;
  }
  for (const [name, step] of steps) {
    try {
      const detail = await step({ accountId, source: opts.source, now });
      out.steps[name] = { ok: true, ...(detail ? { detail } : {}) };
    } catch (err) {
      out.steps[name] = { ok: false, error: String((err as Error)?.message ?? err).slice(0, 300) };
      console.error(`[eligibilite] reprise du compte ${accountId}, étape « ${name} » en échec :`, (err as Error)?.message ?? err);
    }
  }
  if (await processingStatesReady()) {
    await q(
      `UPDATE account_processing_states
          SET last_reactivated_at = $2, last_reactivation_source = $3, last_catchup_requested_at = $2, last_catchup_result = $4::jsonb
        WHERE account_id = $1`,
      [accountId, now.toISOString(), opts.source.slice(0, 60), JSON.stringify(out.steps)],
    ).catch((err) => console.error('[eligibilite] trace de reprise non écrite :', (err as Error).message));
  }
  console.info(JSON.stringify({ event: 'account.processing_reactivated', accountId, source: opts.source, steps: Object.fromEntries(Object.entries(out.steps).map(([k, v]) => [k, v.ok])) }));
  return out;
}

/**
 * Étape 1 — réexamen des travaux neutralisés : le DERNIER travail de chaque
 * clé de déduplication est remis en file (mise en file automatique :
 * absorbée par un travail vivant équivalent, jamais doublée) ; tous les
 * travaux neutralisés du compte sont marqués réexaminés. Le contrôle de
 * périmètre et d'éligibilité de la file s'applique comme à toute mise en
 * file ; un travail devenu sans objet (fichier supprimé…) est écarté par son
 * exécutant comme d'habitude.
 */
export async function reexamineNeutralizedJobs(ctx: ReactivationContext): Promise<{ examined: number; requeued: number; absorbed: number; refused: number }> {
  const jobs = await q(
    `SELECT DISTINCT ON (dedupe_key) id, dedupe_key, treatment, target_type, target_id, trigger_code, payload
       FROM ai_job_queue
      WHERE account_id = $1 AND status = 'CANCELLED' AND payload ? 'accountIneligible'
        AND NOT (payload -> 'accountIneligible') ? 'reexaminedAt'
      ORDER BY dedupe_key, id DESC`,
    [ctx.accountId],
  );
  const res = { examined: jobs.length, requeued: 0, absorbed: 0, refused: 0 };
  if (jobs.length === 0) return res;
  const { enqueue } = await import('@/services/ai/queue/job-queue.repository');
  for (const j of jobs) {
    const payload = { ...((j.payload ?? {}) as Record<string, unknown>) };
    delete payload.accountIneligible;
    delete payload.deferrals;
    const r = await enqueue({
      treatment: String(j.treatment) as never,
      scope: { accountId: ctx.accountId, targetType: (j.target_type as string | null) ?? null, targetId: (j.target_id as string | null) ?? null },
      origin: 'automatic',
      triggerCode: (j.trigger_code as string | null) ?? 'account_reactivated',
      payload,
    });
    if (r.decision === 'create') res.requeued += 1;
    else if (r.jobId != null) res.absorbed += 1;
    else res.refused += 1;
    await q(
      `UPDATE ai_job_queue
          SET payload = jsonb_set(payload, '{accountIneligible}', (payload -> 'accountIneligible')
                || jsonb_build_object('reexaminedAt', $3::text, 'requeuedAs', $4::int, 'reactivationSource', $5::text))
        WHERE account_id = $1 AND dedupe_key = $2 AND status = 'CANCELLED' AND payload ? 'accountIneligible'
          AND NOT (payload -> 'accountIneligible') ? 'reexaminedAt'`,
      [ctx.accountId, String(j.dedupe_key), ctx.now.toISOString(), r.jobId, ctx.source.slice(0, 60)],
    );
  }
  return res;
}

/** Déclencheur porté par les travaux du contrôle de rattrapage. */
export const CATCHUP_TRIGGER = 'account_reactivated';

/**
 * Étape 3 (par défaut) — contrôle de rattrapage : rationalisation T3
 * COMPLÈTE du compte, dans la file durable (déduplication : un contrôle déjà
 * en attente absorbe la demande). Le chantier 82B la remplace par sa campagne
 * de cohérence ciblée sur le compte.
 */
export async function requestCatchupControl(ctx: ReactivationContext): Promise<{ t3JobId: number | null; decision: string }> {
  const [{ enqueue }, { buildT3Payload }] = await Promise.all([
    import('@/services/ai/queue/job-queue.repository'),
    import('@/services/ai/reconciliation/t3-job-contract'),
  ]);
  const r = await enqueue({
    treatment: 'T3',
    scope: { accountId: ctx.accountId },
    origin: 'automatic',
    triggerCode: CATCHUP_TRIGGER,
    payload: buildT3Payload('account', { scope: 'full', reactivationSource: ctx.source }, ctx.now),
  });
  return { t3JobId: r.jobId, decision: r.reasonCode ?? r.decision };
}

registerAccountReactivationStep('reexamine-neutralized-jobs', reexamineNeutralizedJobs);
registerAccountReactivationStep('mascot-pregeneration', async (ctx) => {
  const { requestMascotPregeneration } = await import('@/services/home/mascot/pregen-queue');
  await requestMascotPregeneration(ctx.accountId, CATCHUP_TRIGGER);
  return { requested: true };
});
/**
 * Étape 3 effective (intégration 82A × 82B, arbitrage C-Q10) : campagne de
 * rattrapage de cohérence EXHAUSTIVE du compte (tous les contrôles du
 * registre). Repli sur la T3 complète tant que les tables de cohérence ne
 * sont pas migrées. Import dynamique : aucun cycle account ↔ coherence.
 */
export async function coherenceCatchupControl(ctx: ReactivationContext): Promise<Record<string, unknown>> {
  const { coherenceCatchupReactivationStep } = await import('@/services/coherence/orchestrator');
  const r = await coherenceCatchupReactivationStep(ctx);
  if (r.coherenceCatchupCampaignId != null) return r;
  return { ...r, fallback: await requestCatchupControl(ctx) };
}

registerAccountReactivationStep('catchup-control', coherenceCatchupControl);

// ── Détection des transitions ───────────────────────────────────────────────

export type TransitionKind = 'none' | 'first_seen' | 'became_ineligible' | 'reactivated';

export interface SyncResult {
  accountId: number;
  eligibility: ProcessingEligibility;
  transition: TransitionKind;
  neutralized?: NeutralizationResult;
  reactivation?: ReactivationResult;
}

/**
 * Compare l'éligibilité COURANTE du compte au dernier état observé et traite
 * la transition (une seule fois : verrou de ligne). Compte supprimé : rien
 * (ses travaux disparaissent avec lui). Sans table 0641 : neutralisation
 * seulement (si non éligible), aucune détection de reprise.
 */
export async function syncAccountEligibility(accountId: number, opts: { source: string; now?: Date }): Promise<SyncResult> {
  const now = opts.now ?? new Date();
  invalidateProcessingEligibility(accountId);
  const eligibility = await getAccountProcessingEligibility(accountId, now);
  const result: SyncResult = { accountId, eligibility, transition: 'none' };
  if (eligibility.reason === 'ACCOUNT_NOT_FOUND') return result;

  let previous: boolean | null = null;
  if (await processingStatesReady()) {
    const { pgClient } = await import('@/db');
    previous = await pgClient.begin(async (tx) => {
      const [p] = (await tx.unsafe(
        `SELECT eligible FROM account_processing_states WHERE account_id = $1 FOR UPDATE`, [accountId] as never[],
      )) as unknown as Raw[];
      await tx.unsafe(
        `INSERT INTO account_processing_states (account_id, eligible, reason, observed_at, changed_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (account_id) DO UPDATE
           SET eligible = EXCLUDED.eligible, reason = EXCLUDED.reason, observed_at = EXCLUDED.observed_at,
               changed_at = CASE WHEN account_processing_states.eligible IS DISTINCT FROM EXCLUDED.eligible
                                 THEN EXCLUDED.changed_at ELSE account_processing_states.changed_at END`,
        [accountId, eligibility.eligible, eligibility.reason, now.toISOString()] as never[],
      );
      return p ? Boolean(p.eligible) : null;
    }) as boolean | null;
  }

  if (!eligibility.eligible && previous !== false) {
    result.transition = previous === null ? 'first_seen' : 'became_ineligible';
    result.neutralized = await neutralizeAccountWork(accountId, eligibility.reason ?? 'READ_ONLY', now);
    if (await processingStatesReady()) {
      await q(`UPDATE account_processing_states SET last_neutralized_at = $2, last_neutralized = $3::jsonb WHERE account_id = $1`,
        [accountId, now.toISOString(), JSON.stringify({ ...result.neutralized, source: opts.source })]);
    }
  } else if (eligibility.eligible && previous === false) {
    result.transition = 'reactivated';
    result.reactivation = await onAccountReactivated(accountId, { source: opts.source, now });
  } else if (previous === null) {
    result.transition = 'first_seen';
  }
  return result;
}

/** `syncAccountEligibility` qui ne lève jamais (appel depuis une transition métier). */
export async function syncAccountEligibilitySafe(accountId: number, source: string): Promise<SyncResult | null> {
  try {
    return await syncAccountEligibility(accountId, { source });
  } catch (e) {
    console.error(`[eligibilite] synchronisation du compte ${accountId} (${source}) impossible — reprise par la tâche account-eligibility-sync :`, (e as Error).message);
    return null;
  }
}

export interface EligibilitySweepResult {
  examined: number;
  firstSeen: number;
  becameIneligible: number;
  reactivated: number;
  errors: number;
  more: boolean;
  disabled?: boolean;
}

/**
 * Tâche planifiée `account-eligibility-sync` — comptes dont l'éligibilité
 * calculée (règle SQL) diffère du dernier état observé, ou jamais observés :
 * transition traitée compte par compte (`syncAccountEligibility`). Bornée
 * (`limit`, `deadline`) ; le passage suivant poursuit.
 */
export async function runAccountEligibilitySync(opts: { now?: Date; deadline?: number; limit?: number; onlyAccountIds?: number[] } = {}): Promise<EligibilitySweepResult> {
  const out: EligibilitySweepResult = { examined: 0, firstSeen: 0, becameIneligible: 0, reactivated: 0, errors: 0, more: false };
  if (!(await processingStatesReady())) return { ...out, disabled: true };
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 500;
  const rows = await q(
    `SELECT a.id FROM accounts a
       LEFT JOIN account_processing_states st ON st.account_id = a.id
      WHERE (st.account_id IS NULL OR st.eligible IS DISTINCT FROM ${processingEligibleSql('a.id', '$1::timestamptz')})
        AND ($3::int[] IS NULL OR a.id = ANY($3::int[]))
      ORDER BY a.id LIMIT $2`,
    [now.toISOString(), limit + 1, opts.onlyAccountIds ?? null],
  );
  out.more = rows.length > limit;
  for (const r of rows.slice(0, limit)) {
    if (opts.deadline && Date.now() >= opts.deadline) { out.more = true; break; }
    out.examined += 1;
    try {
      const s = await syncAccountEligibility(Number(r.id), { source: 'eligibility_sync', now });
      if (s.transition === 'first_seen') out.firstSeen += 1;
      else if (s.transition === 'became_ineligible') out.becameIneligible += 1;
      else if (s.transition === 'reactivated') out.reactivated += 1;
    } catch (e) {
      out.errors += 1;
      console.error(`[eligibilite] compte ${String(r.id)} :`, (e as Error).message);
    }
  }
  return out;
}
