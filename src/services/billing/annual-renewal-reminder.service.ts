/**
 * Rappel J−7 avant le renouvellement d'un abonnement ANNUEL — lot 68C, ticket
 * P1 « Abonnements annuels — e-mail automatique à J−7 avant renouvellement ».
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX TEMPS, UNE SEULE FILE
 *
 * 1. Tâche planifiée interne `subscription-annual-renewal-reminders` (toutes
 *    les heures de 8 h 30 à 20 h, Paris) — `runAnnualRenewalReminders` :
 *      · pré-filtre LOCAL (données synchronisées par les webhooks) : abonnement
 *        actif, annuel, sans résiliation programmée ni passage programmé au
 *        mensuel, échéance dans les 8 jours, pas déjà traité aujourd'hui ni
 *        déjà en file — aucun appel Stripe pour les autres abonnements ;
 *      · vérification STRIPE des seuls candidats (`rules.ts`) ; J−7 calendaire
 *        de Paris, rattrapage avant l'échéance (jamais après, jamais pour une
 *        échéance antérieure à l'activation du traitement) ;
 *      · demande enregistrée dans la file DURABLE des e-mails transactionnels
 *        (`transactional_email_jobs`, lot 57A) avec la clé d'idempotence
 *        `annual-renewal-reminder:<abonnement Stripe>:<date d'échéance>`
 *        (verrou consultatif + relecture verrouillée ; index unique 0459) ;
 *      · chaque décision est journalisée (`annual_renewal_reminder_checks`).
 * 2. Envoi par la tâche `transactional-emails-retry` (chaque minute) :
 *    `buildAnnualRenewalReminder` REVALIDE juste avant l'envoi (abonnement,
 *    périodicité, résiliation, date réelle, montant de l'aperçu de facture
 *    Stripe, titulaire payeur). Une modification rendant le rappel obsolète
 *    annule l'envoi (motif dans la demande) ; un montant indisponible ou une
 *    panne Stripe est un échec TEMPORAIRE (reprises 1, 5, 15, 60, 180 min,
 *    puis reprise quotidienne jusqu'à la veille de l'échéance).
 *
 * Statuts visibles dans le BO : préparé (`pending`), accepté par Resend
 * (`accepted`, `email_logs.status = sent`), livré (`delivery_status`
 * webhook Resend), échoué (`failed`), annulé avec motif (`cancelled`). Un
 * e-mail désactivé dans le BO (CHANNEL_DISABLED) n'est jamais compté envoyé.
 *
 * Destinataire : le TITULAIRE PAYEUR du compte porteur de l'abonnement
 * (`accounts.owner_user_id`) — jamais l'invité d'un Premium Duo.
 * Le bouton pointe vers une route Verebona permanente
 * (`/mon-compte/abonnement/gerer`) : la session Stripe est créée au clic,
 * jamais au moment de l'envoi.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * LOT 72F — FIABILISATION
 *   · lien CONTEXTUALISÉ : `/mon-compte/abonnement/gerer/<compte facturé>`
 *     (contrôle serveur du titulaire de CE compte, jamais de bascule) ;
 *   · libellé d'offre = offre du PROCHAIN renouvellement chez Stripe (prix de
 *     la ligne de renouvellement de l'aperçu, à défaut phase d'échéancier),
 *     jamais `plan_code` local ; non identifiable → échec temporaire ;
 *   · bascule DÉCLARÉE dans le BO (instant de désactivation des rappels
 *     Stripe) : sans elle rien n'est préparé ni envoyé ; couverture à partir
 *     du lendemain ; J−7 antérieurs ou du jour même → « couverture
 *     incertaine » signalée (décision BO), jamais présumés rappelés ;
 *   · suspension respectée À L'ENVOI (`annualRemindersSendBlock`) ;
 *   · retour arrière (BO) : demandes en attente neutralisées avant la
 *     réactivation des rappels Stripe ;
 *   · journal PAR VÉRIFICATION (étape, résultat, motif, prochaine
 *     vérification, historique borné), erreurs Stripe comprises ;
 *   · réconciliation planifiée avec Stripe : `annual-renewal-reconcile.service.ts`.
 */
import { pgClient } from '@/db';
import { addDaysToDateStr, parisNow } from '@/lib/notifications/time-paris';
import { planLabelOf } from '@/lib/notifications/subscription-messages';
import {
  ANNUAL_RENEWAL_REMINDER, ANNUAL_RENEWAL_TASK_CODE, MANAGE_SUBSCRIPTION_PATH, REMINDER_DAYS_BEFORE, REMINDER_WINDOW,
  amountLabelOf, annualRenewalDedupeKey, coverageFromSwitch, daysBetween, evaluateStripeEligibility, formatRenewalDate, parisDateOf,
  redactSecrets, reminderTiming, renewalAmountFromPreview, renewalDelayLabel, renewalPriceIdsFromPreview, renewalPriceIdsFromSubscription,
  type ReminderInvoicePreview, type ReminderSchedule, type ReminderSubscription,
} from './annual-renewal-reminder.rules';
import type { CustomerPortalConfigStripe } from './customer-portal-configuration.service';

/** Sous-ensemble du client Stripe utilisé (injectable dans les tests). */
export interface ReminderStripe {
  subscriptions: { retrieve(id: string, params?: { expand?: string[] }): Promise<unknown> };
  invoices: { createPreview(params: { customer?: string; subscription?: string; schedule?: string }): Promise<unknown> };
  /** Lot 70B : configurations du portail (recherche, création, relecture de la configuration Verebona). */
  billingPortal: { configurations: CustomerPortalConfigStripe['billingPortal']['configurations'] };
}

async function defaultStripe(): Promise<ReminderStripe> {
  const { getStripeServer } = await import('@/lib/stripe');
  return getStripeServer() as unknown as ReminderStripe;
}

const appBaseUrl = () => (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const iso = (d: Date) => d.toISOString();
const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CLOSED_USER_STATUSES = new Set(['SUSPENDED', 'PENDING_DELETION', 'DELETED']);
/** Annulations définitives : jamais relancées (décision BO, échéance passée, retour arrière). */
export const FINAL_CANCEL_REASONS = ['CHANNEL_DISABLED', 'TOO_LATE', 'ROLLBACK_NEUTRALIZED', 'ADMIN_ABANDONED'] as const;
/** Lot 72F : tâche de réconciliation planifiée avec Stripe. */
export const ANNUAL_RENEWAL_RECONCILE_TASK_CODE = 'subscription-annual-renewal-reconcile' as const;
/** Lot 72F : nouvelle vérification après une erreur Stripe (passage horaire suivant). */
const STRIPE_RETRY_MS = 55 * 60_000;
/** Lot 72F : historique borné par vérification. */
const HISTORY_MAX = 20;

/** Relit l'abonnement (échéancier et prix des phases développés). */
async function readSubscription(stripe: ReminderStripe, id: string): Promise<{ sub: ReminderSubscription; schedule: ReminderSchedule | null }> {
  const sub = await stripe.subscriptions.retrieve(id, { expand: ['schedule.phases.items.price'] }) as ReminderSubscription;
  const schedule = sub.schedule && typeof sub.schedule === 'object' ? sub.schedule as ReminderSchedule : null;
  return { sub, schedule };
}

// ── Bascule Stripe → Verebona (lot 72F : déclarée, jamais déduite) ─────────

export interface SwitchState {
  /** Premier J−7 couvert par Verebona (lendemain de la désactivation Stripe). */
  coverageFrom: string | null;
  stripeRemindersDisabledAt: Date | null;
  switchDeclaredAt: Date | null;
  switchDeclaredBy: number | null;
  rollbackAt: Date | null;
  lastReconcileAt: Date | null;
  lastReconcileNote: string | null;
}

const dateOrNull = (v: unknown): Date | null => (v == null ? null : new Date(v as string));

export async function readSwitchState(): Promise<SwitchState> {
  const [r] = await pgClient.unsafe<Record<string, unknown>[]>(
    `SELECT coverage_from::text AS coverage_from, stripe_reminders_disabled_at, switch_declared_at, switch_declared_by, rollback_at,
            last_reconcile_at, last_reconcile_note
       FROM annual_renewal_reminder_state WHERE id = 1`,
  );
  return {
    coverageFrom: (r?.coverage_from as string | null) ?? null,
    stripeRemindersDisabledAt: dateOrNull(r?.stripe_reminders_disabled_at),
    switchDeclaredAt: dateOrNull(r?.switch_declared_at),
    switchDeclaredBy: r?.switch_declared_by == null ? null : Number(r.switch_declared_by),
    rollbackAt: dateOrNull(r?.rollback_at),
    lastReconcileAt: dateOrNull(r?.last_reconcile_at),
    lastReconcileNote: (r?.last_reconcile_note as string | null) ?? null,
  };
}

/** État réel d'une tâche planifiée (suspension BO, variable d'arrêt, dernier passage). */
export interface SchedulerState {
  code: string;
  suspended: boolean;
  /** Arrêtée par variable d'environnement (SCHEDULED_TASK_…=off ou arrêt global). */
  stoppedByEnv: boolean;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastSuccessAt: string | null;
  lastNote: string | null;
  lastError: string | null;
  nextRunAt: string | null;
}

export async function readSchedulerState(code: string): Promise<SchedulerState> {
  const { isTaskEnabled } = await import('@/services/scheduling/scheduled-tasks.catalog');
  const [r] = await pgClient.unsafe<Record<string, unknown>[]>(
    `SELECT COALESCE((to_jsonb(t) ->> 'admin_disabled')::boolean, false) AS suspended,
            last_started_at, last_finished_at, last_status, last_success_at, to_jsonb(t) ->> 'last_note' AS last_note, last_error, next_run_at
       FROM scheduled_task_state t WHERE code = $1`,
    [code as never],
  );
  const isoOf = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    code,
    suspended: r?.suspended === true,
    stoppedByEnv: !isTaskEnabled(code),
    lastStartedAt: isoOf(r?.last_started_at), lastFinishedAt: isoOf(r?.last_finished_at),
    lastStatus: (r?.last_status as string | null) ?? null, lastSuccessAt: isoOf(r?.last_success_at),
    lastNote: r?.last_note ? redactSecrets(String(r.last_note)).slice(0, 500) : null,
    lastError: r?.last_error ? redactSecrets(String(r.last_error)).slice(0, 500) : null,
    nextRunAt: isoOf(r?.next_run_at),
  };
}

/**
 * Lot 72F — un rappel annuel peut-il partir MAINTENANT ? Non si la tâche est
 * suspendue (BO) ou arrêtée (variable), ou si la bascule n'est pas déclarée
 * (retour arrière compris). Lu à chaque envoi : demandes en attente comprises.
 */
export async function annualRemindersSendBlock(): Promise<'TASK_SUSPENDED' | 'SWITCH_NOT_DECLARED' | null> {
  const { isTaskEnabled } = await import('@/services/scheduling/scheduled-tasks.catalog');
  if (!isTaskEnabled(ANNUAL_RENEWAL_TASK_CODE)) return 'TASK_SUSPENDED';
  const [r] = await pgClient.unsafe<{ suspended: boolean; declared: boolean }[]>(
    `SELECT COALESCE((SELECT COALESCE((to_jsonb(t) ->> 'admin_disabled')::boolean, false) FROM scheduled_task_state t WHERE code = $1), false) AS suspended,
            COALESCE((SELECT stripe_reminders_disabled_at IS NOT NULL FROM annual_renewal_reminder_state WHERE id = 1), false) AS declared`,
    [ANNUAL_RENEWAL_TASK_CODE as never],
  );
  if (r?.suspended) return 'TASK_SUSPENDED';
  if (!r?.declared) return 'SWITCH_NOT_DECLARED';
  return null;
}

/**
 * Lot 72F — bascule : l'administrateur DÉCLARE l'instant où il a désactivé
 * « e-mails concernant les renouvellements à venir » dans Stripe. Couverture
 * Verebona à partir du lendemain (Paris) ; les J−7 antérieurs ou du jour même
 * seront signalés « couverture incertaine ». Refusée si déjà déclarée (retour
 * arrière d'abord) ou si l'instant est dans le futur.
 */
export async function declareStripeRemindersDisabled(p: { adminId: number; disabledAt: Date; now?: Date }): Promise<{ ok: true; coverageFrom: string } | { ok: false; code: 'ALREADY_DECLARED' | 'IN_FUTURE' | 'INVALID_DATE' }> {
  const now = p.now ?? new Date();
  if (Number.isNaN(p.disabledAt.getTime())) return { ok: false, code: 'INVALID_DATE' };
  if (p.disabledAt.getTime() > now.getTime() + 60_000) return { ok: false, code: 'IN_FUTURE' };
  const coverageFrom = coverageFromSwitch(p.disabledAt);
  const rows = await pgClient.unsafe<{ id: number }[]>(
    `INSERT INTO annual_renewal_reminder_state (id, coverage_from, stripe_reminders_disabled_at, switch_declared_at, switch_declared_by, updated_at)
     VALUES (1, $1::date, $2::timestamptz, $3::timestamptz, $4, $3::timestamptz)
     ON CONFLICT (id) DO UPDATE
        SET coverage_from = EXCLUDED.coverage_from, stripe_reminders_disabled_at = EXCLUDED.stripe_reminders_disabled_at,
            switch_declared_at = EXCLUDED.switch_declared_at, switch_declared_by = EXCLUDED.switch_declared_by, updated_at = EXCLUDED.updated_at
      WHERE annual_renewal_reminder_state.stripe_reminders_disabled_at IS NULL
     RETURNING id`,
    [coverageFrom, iso(p.disabledAt), iso(now), p.adminId] as never[],
  );
  if (rows.length === 0) return { ok: false, code: 'ALREADY_DECLARED' };
  return { ok: true, coverageFrom };
}

export interface RollbackResult {
  /** Demandes en attente (préparées, échecs temporaires) neutralisées. */
  neutralized: number;
  /** Parmi elles, échéances dont le J−7 est passé : Stripe ne les rappellera pas. */
  notCoveredByStripe: number;
  /** Demandes en cours d'envoi au moment du retour arrière (à vérifier). */
  inFlight: number;
  /** Acceptations incertaines non résolues (à vérifier dans le BO). */
  uncertain: number;
}

/**
 * Lot 72F — retour aux rappels Stripe. Exige la tâche SUSPENDUE ; neutralise
 * les demandes Verebona en attente (motif définitif) et retire la déclaration
 * de bascule (plus aucun envoi, même si la tâche était réactivée par erreur).
 * L'administrateur réactive ENSUITE les rappels dans Stripe.
 */
export async function rollbackToStripeReminders(p: { adminId: number; now?: Date }): Promise<{ ok: true; result: RollbackResult } | { ok: false; code: 'TASK_ACTIVE' }> {
  const now = p.now ?? new Date();
  const sched = await readSchedulerState(ANNUAL_RENEWAL_TASK_CODE);
  if (!sched.suspended && !sched.stoppedByEnv) return { ok: false, code: 'TASK_ACTIVE' };
  const today = parisNow(now).dateStr;
  const result = await pgClient.begin(async (tx) => {
    const cancelled = await tx.unsafe<{ dedupe_key: string | null; renewal_date: string | null }[]>(
      `UPDATE transactional_email_jobs
          SET status = 'cancelled', last_error = 'ROLLBACK_NEUTRALIZED', locked_until = NULL, updated_at = $2::timestamptz
        WHERE kind = $1 AND status IN ('pending', 'failed')
        RETURNING dedupe_key, context ->> 'renewalDate' AS renewal_date`,
      [ANNUAL_RENEWAL_REMINDER, iso(now)] as never[],
    );
    const keys = cancelled.map((c) => c.dedupe_key).filter((k): k is string => !!k);
    if (keys.length) {
      await tx.unsafe(
        `UPDATE annual_renewal_reminder_checks
            SET outcome = 'EXCLUDED', reason = 'ROLLBACK_NEUTRALIZED', step = 'ROLLBACK', last_checked_at = $2::timestamptz, updated_at = $2::timestamptz,
                history = ${historyAppendSql('$2', "'ROLLBACK'", "'EXCLUDED'", "'ROLLBACK_NEUTRALIZED'")}
          WHERE candidate_key = ANY($1::text[])`,
        [keys, iso(now)] as never[],
      );
    }
    const [c] = await tx.unsafe<{ in_flight: number; uncertain: number }[]>(
      `SELECT count(*) FILTER (WHERE status = 'sending')::int AS in_flight,
              count(*) FILTER (WHERE status = 'uncertain' OR (provider_outcome = 'uncertain' AND status = 'pending'))::int AS uncertain
         FROM transactional_email_jobs WHERE kind = $1`,
      [ANNUAL_RENEWAL_REMINDER as never],
    );
    await tx.unsafe(
      `UPDATE annual_renewal_reminder_state SET stripe_reminders_disabled_at = NULL, rollback_at = $1::timestamptz, rollback_by = $2, updated_at = $1::timestamptz WHERE id = 1`,
      [iso(now), p.adminId] as never[],
    );
    return {
      neutralized: cancelled.length,
      notCoveredByStripe: cancelled.filter((x) => x.renewal_date && addDaysToDateStr(x.renewal_date, -REMINDER_DAYS_BEFORE) <= today).length,
      inFlight: Number(c?.in_flight ?? 0),
      uncertain: Number(c?.uncertain ?? 0),
    };
  });
  return { ok: true, result };
}

// ── Portail Stripe : la désactivation du renouvellement est-elle offerte ? ───

let portalCheck: { day: string; allowed: true; configurationId: string } | null = null;

/**
 * Lot 70B : contrôle de la configuration VEREBONA du portail — celle que
 * le bouton de l'e-mail ouvre réellement (`/mon-compte/abonnement/gerer`) —
 * et non plus de la configuration par défaut du compte Stripe : trouvée ou
 * créée, relue, annulation activée en fin de période. Au plus une fois par
 * jour et par instance quand elle est conforme ; un échec n'est PAS mémorisé
 * (nouvel essai au passage horaire suivant) et bloque les rappels (garde-fou :
 * l'e-mail promettrait une désactivation impossible ; anomalie BO signalée
 * par le service, tâche planifiée en échec).
 */
async function checkPortal(stripe: ReminderStripe, today: string): Promise<{ allowed: boolean; configurationId: string | null }> {
  if (portalCheck?.day === today) return { allowed: true, configurationId: portalCheck.configurationId };
  try {
    const { ensureCustomerPortalConfiguration } = await import('./customer-portal-configuration.service');
    const r = await ensureCustomerPortalConfiguration({ stripe, force: true });
    portalCheck = { day: today, allowed: true, configurationId: r.configurationId };
    return { allowed: true, configurationId: r.configurationId };
  } catch (e) {
    console.warn('[annual-renewal] configuration Verebona du portail indisponible :', (e as Error)?.message ?? e);
    return { allowed: false, configurationId: null };
  }
}

/** Tests : oublie le contrôle mémorisé du portail. */
export function resetPortalCheckCache(): void { portalCheck = null; }

// ── Tâche planifiée ──────────────────────────────────────────────────────────

export interface AnnualRenewalRunResult {
  /** Passage ignoré (hors fenêtre 8 h 30 – 20 h, portail inadapté). */
  skipped?: string;
  candidates: number;
  enqueued: number;
  revived: number;
  excluded: Record<string, number>;
  stripeErrors: number;
  coverageFrom: string | null;
  portalAllowsDisable: boolean | null;
  /** Lot 70B : configuration Verebona du portail vérifiée pour ce passage. */
  portalConfigurationId?: string | null;
  /** Lot 72F : échéances à couverture incertaine (bascule) signalées pendant ce passage. */
  coverageUncertain?: number;
}

interface Candidate {
  account_id: number;
  owner_user_id: number;
  stripe_subscription_id: string;
  renewal_date: string;
}

const minutes = ([h, m]: readonly [number, number]) => h * 60 + m;

/**
 * Un passage du traitement. Idempotent : rejoué (relance manuelle, deux
 * instances, redémarrage), il ne crée jamais de seconde demande.
 */
export async function runAnnualRenewalReminders(opts: { now?: Date; stripe?: ReminderStripe; deadline?: number; limit?: number } = {}): Promise<AnnualRenewalRunResult> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Date.now() + 8 * 60_000;
  const p = parisNow(now);
  const today = p.dateStr;
  const result: AnnualRenewalRunResult = { candidates: 0, enqueued: 0, revived: 0, excluded: {}, stripeErrors: 0, coverageFrom: null, portalAllowsDisable: null };
  const m = p.hour * 60 + p.minute;
  // Relance manuelle hors fenêtre : rien (« à partir de 8 h 30 »).
  if (m < minutes(REMINDER_WINDOW.from) || m >= minutes(REMINDER_WINDOW.to)) {
    return { ...result, skipped: 'hors de la fenêtre d’envoi (8 h 30 – 20 h, Paris)' };
  }
  // Lot 72F : bascule DÉCLARÉE obligatoire (sinon double rappel avec Stripe possible).
  const sw = await readSwitchState();
  if (!sw.stripeRemindersDisabledAt) return { ...result, skipped: 'SWITCH_NOT_DECLARED' };
  result.coverageFrom = sw.coverageFrom ?? coverageFromSwitch(sw.stripeRemindersDisabledAt);

  // Reprise quotidienne des demandes échouées (échec temporaire), avant échéance.
  const revived = await pgClient.unsafe<{ id: number }[]>(
    `UPDATE transactional_email_jobs
        SET status = 'pending', attempts = 0, locked_until = NULL, next_attempt_at = $2::timestamptz, updated_at = $2::timestamptz,
            context = COALESCE(context, '{}'::jsonb) || jsonb_build_object('revivedOn', $3::text)
      WHERE kind = $1 AND status = 'failed'
        AND (context ->> 'revivedOn') IS DISTINCT FROM $3::text
        AND (context ->> 'renewalAt')::timestamptz > $2::timestamptz + interval '12 hours'
      RETURNING id`,
    [ANNUAL_RENEWAL_REMINDER, iso(now), today] as never[],
  );
  result.revived += revived.length;

  const candidates = await pgClient.unsafe<Candidate[]>(
    `WITH c AS (
       SELECT s.account_id, a.owner_user_id, s.stripe_subscription_id,
              to_char(s.current_period_end_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS renewal_date
         FROM account_subscriptions s
         JOIN accounts a ON a.id = s.account_id
        WHERE s.stripe_subscription_id IS NOT NULL
          AND s.status = 'active' AND s.billing_period = 'yearly'
          AND s.cancel_at_period_end = false
          AND (s.scheduled_billing_period IS NULL OR s.scheduled_billing_period <> 'monthly')
          AND s.current_period_end_at > $1::timestamptz
          AND s.current_period_end_at <= $1::timestamptz + interval '8 days')
     SELECT c.* FROM c
      WHERE NOT EXISTS (SELECT 1 FROM annual_renewal_reminder_checks k
                         WHERE k.candidate_key = 'annual-renewal-reminder:' || c.stripe_subscription_id || ':' || c.renewal_date
                           AND (k.next_check_at > $1::timestamptz OR (k.next_check_at IS NULL AND k.checked_on = $2::date)))
        AND NOT EXISTS (SELECT 1 FROM transactional_email_jobs j
                         WHERE j.dedupe_key = 'annual-renewal-reminder:' || c.stripe_subscription_id || ':' || c.renewal_date
                           AND (j.status <> 'cancelled' OR j.last_error = ANY($3::text[])))
      ORDER BY c.renewal_date, c.account_id
      LIMIT $4`,
    [iso(now), today, FINAL_CANCEL_REASONS as unknown as string[], opts.limit ?? 200] as never[],
  );
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  const stripe = opts.stripe ?? await defaultStripe();
  const portal = await checkPortal(stripe, today);
  result.portalAllowsDisable = portal.allowed;
  result.portalConfigurationId = portal.configurationId;
  if (result.portalAllowsDisable === false) {
    // L'e-mail promettrait une désactivation impossible : rien n'est préparé.
    return { ...result, skipped: 'PORTAL_CANCEL_DISABLED' };
  }

  const exclude = (reason: string) => { result.excluded[reason] = (result.excluded[reason] ?? 0) + 1; };
  const tomorrow = await startOfNextParisDay(today);
  for (const c of candidates) {
    if (Date.now() >= deadline) break;
    const localKey = annualRenewalDedupeKey(c.stripe_subscription_id, c.renewal_date);
    let outcome: string;
    let reason: string | null = null;
    let jobId: number | null = null;
    let stripeRenewal: string | null = null;
    let next: Date | null = tomorrow;
    try {
      const { sub, schedule } = await readSubscription(stripe, c.stripe_subscription_id);
      const elig = evaluateStripeEligibility(sub, { schedule });
      if (!elig.ok) {
        outcome = 'EXCLUDED'; reason = elig.reason;
      } else {
        stripeRenewal = parisDateOf(elig.renewalAt);
        const timing = reminderTiming(now, elig.renewalAt, result.coverageFrom);
        if (!timing.send) {
          outcome = timing.reason === 'TOO_EARLY' ? 'WAITING' : timing.reason === 'COVERAGE_UNCERTAIN' ? 'COVERAGE_UNCERTAIN' : 'EXCLUDED';
          reason = timing.reason;
          // Couverture incertaine : décision BO, plus de vérification automatique pour cette échéance.
          if (timing.reason === 'COVERAGE_UNCERTAIN') { next = elig.renewalAt; result.coverageUncertain = (result.coverageUncertain ?? 0) + 1; }
        } else {
          const r = await enqueueReminder({ accountId: c.account_id, ownerUserId: c.owner_user_id, subscriptionId: c.stripe_subscription_id, renewalAt: elig.renewalAt, catchUp: timing.catchUp, now });
          outcome = r.outcome; jobId = r.jobId; reason = r.reason ?? null;
          if (r.outcome === 'ENQUEUED') result.enqueued += 1;
          if (r.outcome === 'REVIVED') result.revived += 1;
        }
      }
    } catch (e) {
      // Lot 72F : panne Stripe JOURNALISÉE (étape, motif sans secret, prochaine tentative au passage suivant).
      result.stripeErrors += 1;
      const why = stripeErrorReason(e);
      console.error(`[annual-renewal] vérification Stripe impossible (${c.stripe_subscription_id}) : ${why}`);
      await recordCheck({ key: localKey, accountId: c.account_id, subscriptionId: c.stripe_subscription_id, renewalDate: c.renewal_date, today, outcome: 'STRIPE_ERROR', reason: why, jobId: null, step: 'STRIPE_CHECK', now, next: new Date(now.getTime() + STRIPE_RETRY_MS) });
      continue;
    }
    if (outcome === 'EXCLUDED' || outcome === 'WAITING' || outcome === 'COVERAGE_UNCERTAIN') exclude(reason ?? outcome);
    if (jobId != null) next = null;
    await recordCheck({ key: localKey, accountId: c.account_id, subscriptionId: c.stripe_subscription_id, renewalDate: stripeRenewal ?? c.renewal_date, today, outcome, reason, jobId, step: jobId != null ? 'ENQUEUE' : 'STRIPE_CHECK', now, next });
  }
  return result;
}

/** Lot 72F : motif d'une erreur Stripe, journalisable (type / code, message sans secret). */
export function stripeErrorReason(e: unknown): string {
  const err = e as { type?: string; code?: string; statusCode?: number; message?: string } | null;
  const head = [err?.type, err?.code, err?.statusCode].filter(Boolean).join(' ');
  return redactSecrets(`${head ? `${head} — ` : ''}${err?.message ?? String(e)}`).slice(0, 300);
}

async function startOfNextParisDay(today: string): Promise<Date> {
  const { parisWallTimeToDate } = await import('@/services/scheduling/task-calendar');
  return parisWallTimeToDate(addDaysToDateStr(today, 1), [0, 0]);
}

/** Lot 72F : ajout borné à l'historique d'une vérification (SQL : $at, étape, résultat, motif). */
function historyAppendSql(at: string, step: string, outcome: string, reason: string, current = 'history'): string {
  return `(SELECT COALESCE(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM (
             SELECT e, n FROM jsonb_array_elements(
               jsonb_build_array(jsonb_build_object('at', ${at}::timestamptz, 'step', ${step}::text, 'outcome', ${outcome}::text, 'reason', ${reason}::text))
               || COALESCE(${current}, '[]'::jsonb)) WITH ORDINALITY AS h(e, n)
             ORDER BY n LIMIT ${HISTORY_MAX}) x)`;
}

export interface CheckRecord {
  key: string; accountId: number | null; subscriptionId: string; renewalDate: string; today: string;
  outcome: string; reason: string | null; jobId: number | null;
  /** Étape : STRIPE_CHECK, ENQUEUE, RECONCILE, BO_DECISION, ROLLBACK. */
  step: string;
  now: Date;
  /** Prochaine vérification automatique (null : aucune). */
  next: Date | null;
}

/** Journal persistant par vérification (une ligne par abonnement × échéance, historique borné). */
export async function recordCheck(r: CheckRecord): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO annual_renewal_reminder_checks
       (candidate_key, account_id, stripe_subscription_id, renewal_date, checked_on, outcome, reason, job_id, checks, created_at, updated_at,
        step, last_checked_at, next_check_at, history)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, 1, $10::timestamptz, $10::timestamptz, $9, $10::timestamptz, $11::timestamptz,
             ${historyAppendSql('$10', '$9', '$6', '$7', "'[]'::jsonb")})
     ON CONFLICT (candidate_key) DO UPDATE
        SET renewal_date = EXCLUDED.renewal_date, checked_on = EXCLUDED.checked_on, outcome = EXCLUDED.outcome,
            reason = EXCLUDED.reason, job_id = COALESCE(EXCLUDED.job_id, annual_renewal_reminder_checks.job_id),
            account_id = COALESCE(EXCLUDED.account_id, annual_renewal_reminder_checks.account_id),
            checks = annual_renewal_reminder_checks.checks + 1, updated_at = EXCLUDED.updated_at,
            step = EXCLUDED.step, last_checked_at = EXCLUDED.last_checked_at, next_check_at = EXCLUDED.next_check_at,
            history = ${historyAppendSql('$10', '$9', '$6', '$7', 'annual_renewal_reminder_checks.history')}`,
    [r.key, r.accountId, r.subscriptionId, r.renewalDate, r.today, r.outcome, r.reason, r.jobId, r.step, iso(r.now), r.next ? iso(r.next) : null] as never[],
  );
}

/**
 * Enregistre la demande (ou relance une demande annulée devenue de nouveau
 * pertinente : renouvellement réactivé…). Jamais deux demandes par clé.
 */
export async function enqueueReminder(p: { accountId: number; ownerUserId: number; subscriptionId: string; renewalAt: Date; catchUp: boolean; now: Date }): Promise<{ outcome: 'ENQUEUED' | 'REVIVED' | 'DUPLICATE' | 'NO_RECIPIENT'; jobId: number | null; reason?: string }> {
  const renewalDate = parisDateOf(p.renewalAt);
  const key = annualRenewalDedupeKey(p.subscriptionId, renewalDate);
  const context = { accountId: p.accountId, subscriptionId: p.subscriptionId, renewalDate, renewalAt: iso(p.renewalAt), catchUp: p.catchUp };
  return pgClient.begin(async (tx) => {
    await tx.unsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`email-job:${ANNUAL_RENEWAL_REMINDER}:${key}`]);
    const [owner] = await tx.unsafe<{ email: string | null }[]>(`SELECT email FROM users WHERE id = $1`, [p.ownerUserId as never]);
    if (!owner?.email) return { outcome: 'NO_RECIPIENT' as const, jobId: null, reason: 'RECIPIENT_MISMATCH' };
    const [existing] = await tx.unsafe<{ id: number; status: string; last_error: string | null }[]>(
      `SELECT id, status, last_error FROM transactional_email_jobs WHERE dedupe_key = $1 FOR UPDATE`, [key],
    );
    if (existing) {
      const revivable = existing.status === 'cancelled' && !(FINAL_CANCEL_REASONS as readonly string[]).includes(existing.last_error ?? '');
      if (!revivable) return { outcome: 'DUPLICATE' as const, jobId: existing.id };
      await tx.unsafe(
        `UPDATE transactional_email_jobs
            SET status = 'pending', attempts = 0, locked_until = NULL, last_error = NULL, recipient_email = $2,
                user_id = $3, context = $4::jsonb, next_attempt_at = $5::timestamptz, updated_at = $5::timestamptz
          WHERE id = $1`,
        [existing.id, owner.email, p.ownerUserId, JSON.stringify(context), iso(p.now)] as never[],
      );
      return { outcome: 'REVIVED' as const, jobId: existing.id };
    }
    const [row] = await tx.unsafe<{ id: number }[]>(
      `INSERT INTO transactional_email_jobs
         (kind, user_id, duo_id, triggered_by_user_id, recipient_email, context, dedupe_key, status, attempts, max_attempts,
          next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, NULL, NULL, $3, $4::jsonb, $5, 'pending', 0, 6, $6::timestamptz, $6::timestamptz, $6::timestamptz)
       RETURNING id`,
      [ANNUAL_RENEWAL_REMINDER, p.ownerUserId, owner.email, JSON.stringify(context), key, iso(p.now)] as never[],
    );
    return { outcome: 'ENQUEUED' as const, jobId: row.id };
  });
}

// ── Construction de l'e-mail (revalidation juste avant l'envoi) ──────────────

export type ReminderBuild =
  | { ok: true; to: string; recipientUserId: number; variables: Record<string, string> }
  | { ok: false; reason: string; temporary?: boolean };

/** Lot 72F : lien permanent CONTEXTUALISÉ au compte facturé. */
export function manageSubscriptionUrlFor(accountId: number, base: string = appBaseUrl()): string {
  return `${base}${MANAGE_SUBSCRIPTION_PATH}/${accountId}`;
}

/**
 * Lot 72F — offre du PROCHAIN renouvellement : prix de la ligne de
 * renouvellement de l'aperçu Stripe (changement programmé compris), à défaut
 * phase d'échéancier ou prix courant ; reconnu par le registre des prix
 * (`price-history.service`) et ANNUEL. Une seule offre, sinon `null`.
 */
async function renewalPlanLabel(priceIds: string[]): Promise<string | null | 'UNAVAILABLE'> {
  if (priceIds.length === 0) return null;
  const { resolveHistoricalPrice } = await import('./price-history.service');
  const plans = new Set<string>();
  for (const id of priceIds) {
    const r = await resolveHistoricalPrice(id, { source: 'annual-renewal-reminder' });
    if (r.status === 'unavailable') return 'UNAVAILABLE';
    if (r.status !== 'recognized') continue; // prix hors offre (taxe, option) : ignoré
    if (r.billingPeriod !== 'yearly') return null;
    plans.add(r.planCode);
  }
  if (plans.size !== 1) return null;
  return planLabelOf({ planCode: [...plans][0] });
}

/**
 * Revalide l'abonnement chez Stripe et construit les variables du gabarit.
 * Une erreur Stripe LÈVE (échec temporaire, reprise par la file).
 * Lot 72F : `contentAt` fige le contenu dépendant de l'heure (« dans N jours »)
 * lors de la réémission d'un appel incertain (même clé Resend, même contenu) ;
 * l'éligibilité est toujours jugée à `now`.
 */
export async function buildAnnualRenewalReminder(
  job: { user_id: number | null; context: Record<string, unknown> },
  now: Date,
  stripe?: ReminderStripe,
  contentAt: Date = now,
): Promise<ReminderBuild> {
  const ctx = job.context ?? {};
  const accountId = Number(ctx.accountId);
  const subscriptionId = typeof ctx.subscriptionId === 'string' ? ctx.subscriptionId : '';
  const renewalDate = typeof ctx.renewalDate === 'string' ? ctx.renewalDate : '';
  if (!Number.isFinite(accountId) || !subscriptionId || !renewalDate) return { ok: false, reason: 'INVALID_REQUEST' };

  const [acc] = await pgClient.unsafe<{
    owner_user_id: number; account_customer: string | null; row_customer: string | null; account_sub: string | null; row_sub: string | null;
    duo_owner: number | null; email: string | null; first_name: string | null; user_status: string | null;
  }[]>(
    `SELECT a.owner_user_id, a.stripe_customer_id AS account_customer, s.stripe_customer_id AS row_customer,
            a.stripe_subscription_id AS account_sub, s.stripe_subscription_id AS row_sub,
            d.billing_owner_user_id AS duo_owner, u.email, u.first_name, u.status AS user_status
       FROM accounts a
       LEFT JOIN account_subscriptions s ON s.account_id = a.id
       LEFT JOIN duo_accounts d ON d.id = a.duo_account_id AND d.stripe_subscription_id = $2
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.id = $1`,
    [accountId, subscriptionId] as never[],
  );
  if (!acc || !acc.email) return { ok: false, reason: 'RECIPIENT_MISMATCH' };
  if ((acc.row_sub ?? acc.account_sub) !== subscriptionId) return { ok: false, reason: 'SUBSCRIPTION_REPLACED' };
  // Destinataire = titulaire payeur ; Premium Duo : le payeur du Duo doit être ce titulaire.
  if (job.user_id != null && Number(job.user_id) !== Number(acc.owner_user_id)) return { ok: false, reason: 'RECIPIENT_MISMATCH' };
  if (acc.duo_owner != null && Number(acc.duo_owner) !== Number(acc.owner_user_id)) return { ok: false, reason: 'RECIPIENT_MISMATCH' };
  if (CLOSED_USER_STATUSES.has(String(acc.user_status ?? '').toUpperCase())) return { ok: false, reason: 'ACCOUNT_CLOSED' };

  const client = stripe ?? await defaultStripe();
  const { sub, schedule } = await readSubscription(client, subscriptionId);
  const elig = evaluateStripeEligibility(sub, { schedule });
  if (!elig.ok) return { ok: false, reason: elig.reason };
  if (parisDateOf(elig.renewalAt) !== renewalDate) return { ok: false, reason: 'RENEWAL_DATE_CHANGED' };
  const timing = reminderTiming(now, elig.renewalAt, null);
  if (!timing.send) return { ok: false, reason: timing.reason };

  // Lot 72F : cohérence compte / abonnement / client Stripe (le lien ouvre le portail de CE client).
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null;
  const localCustomers = [acc.account_customer, acc.row_customer].filter((c): c is string => !!c);
  if (!customer || localCustomers.some((c) => c !== customer)) return { ok: false, reason: 'BILLING_MISMATCH' };

  const preview = await client.invoices.createPreview(
    elig.scheduleId ? { customer, schedule: elig.scheduleId } : { customer, subscription: subscriptionId },
  ) as ReminderInvoicePreview;
  const amount = renewalAmountFromPreview(preview, elig.renewalTs);
  // Jamais de montant inventé : reporté (reprises), puis échec journalisé.
  if (!amount) return { ok: false, reason: 'AMOUNT_UNAVAILABLE', temporary: true };

  // Lot 72F : libellé = offre réellement facturée au renouvellement (jamais plan_code local).
  const fromPreview = renewalPriceIdsFromPreview(preview, elig.renewalTs);
  const plan = await renewalPlanLabel(fromPreview.length ? fromPreview : renewalPriceIdsFromSubscription(sub, schedule, elig.renewalTs));
  if (plan === 'UNAVAILABLE' || !plan) return { ok: false, reason: 'PLAN_UNAVAILABLE', temporary: true };

  const contentDays = Math.max(1, daysBetween(parisDateOf(contentAt), renewalDate));
  return {
    ok: true,
    to: acc.email,
    recipientUserId: Number(acc.owner_user_id),
    variables: {
      firstName: escapeHtml((acc.first_name ?? '').trim()),
      planLabel: escapeHtml(plan),
      renewalDate: formatRenewalDate(elig.renewalAt),
      renewalDelayLabel: renewalDelayLabel(contentAt === now ? timing.days : contentDays),
      amountLabel: amountLabelOf(amount.cents, amount.currency),
      manageSubscriptionUrl: manageSubscriptionUrlFor(accountId),
      accountUrl: `${appBaseUrl()}/mon-compte`,
    },
  };
}

// ── Lot 72F : décisions BO sur une couverture incertaine (bascule) ───────────

export type CoverageDecision = 'SEND_VEREBONA' | 'STRIPE_CONFIRMED';

/**
 * Échéance « couverture incertaine » : l'administrateur a vérifié le rappel
 * Stripe (constaté → clos) ou demande le rappel Verebona (revalidé chez
 * Stripe, préparé comme un rattrapage, avant l'échéance seulement).
 */
export async function resolveCoverageUncertain(p: { key: string; decision: CoverageDecision; adminId: number; now?: Date; stripe?: ReminderStripe }): Promise<{ ok: true; outcome: string; jobId?: number | null } | { ok: false; code: 'NOT_FOUND' | 'NOT_UNCERTAIN' | 'NOT_ELIGIBLE'; reason?: string }> {
  const now = p.now ?? new Date();
  const today = parisNow(now).dateStr;
  const [row] = await pgClient.unsafe<{ account_id: number | null; stripe_subscription_id: string; renewal_date: string; outcome: string; owner_user_id: number | null }[]>(
    `SELECT k.account_id, k.stripe_subscription_id, k.renewal_date::text AS renewal_date, k.outcome, a.owner_user_id
       FROM annual_renewal_reminder_checks k LEFT JOIN accounts a ON a.id = k.account_id
      WHERE k.candidate_key = $1`,
    [p.key as never],
  );
  if (!row) return { ok: false, code: 'NOT_FOUND' };
  if (row.outcome !== 'COVERAGE_UNCERTAIN' || row.account_id == null || row.owner_user_id == null) return { ok: false, code: 'NOT_UNCERTAIN' };
  const base = { key: p.key, accountId: row.account_id, subscriptionId: row.stripe_subscription_id, renewalDate: row.renewal_date, today, step: 'BO_DECISION', now };
  if (p.decision === 'STRIPE_CONFIRMED') {
    await recordCheck({ ...base, outcome: 'EXCLUDED', reason: 'STRIPE_REMINDER_CONFIRMED', jobId: null, next: null });
    return { ok: true, outcome: 'EXCLUDED' };
  }
  const stripe = p.stripe ?? await defaultStripe();
  const { sub, schedule } = await readSubscription(stripe, row.stripe_subscription_id);
  const elig = evaluateStripeEligibility(sub, { schedule });
  if (!elig.ok) {
    await recordCheck({ ...base, outcome: 'EXCLUDED', reason: elig.reason, jobId: null, next: null });
    return { ok: false, code: 'NOT_ELIGIBLE', reason: elig.reason };
  }
  const timing = reminderTiming(now, elig.renewalAt, null);
  if (!timing.send) return { ok: false, code: 'NOT_ELIGIBLE', reason: timing.reason };
  const r = await enqueueReminder({ accountId: row.account_id, ownerUserId: row.owner_user_id, subscriptionId: row.stripe_subscription_id, renewalAt: elig.renewalAt, catchUp: true, now });
  await recordCheck({ ...base, renewalDate: parisDateOf(elig.renewalAt), outcome: r.outcome, reason: 'BO_DECISION', jobId: r.jobId, next: null });
  return { ok: true, outcome: r.outcome, jobId: r.jobId };
}

// ── BO : état du traitement ──────────────────────────────────────────────────

/**
 * Lot 72F — état consolidé d'une échéance (journal + demande + livraison) :
 * jamais « livré » sans confirmation du prestataire, jamais « accepté » pour
 * un e-mail désactivé, bloqué ou incertain.
 */
export type ReminderState =
  | 'WAITING' | 'EXCLUDED' | 'NO_RECIPIENT' | 'STRIPE_ERROR' | 'COVERAGE_UNCERTAIN' | 'DESYNC_RESYNCED' | 'DESYNC_UNRESOLVED' | 'STRIPE_ONLY'
  | 'PREPARED' | 'HELD' | 'SENDING' | 'ACCEPTED' | 'DELIVERED' | 'DELIVERY_PROBLEM' | 'TEMPORARY_FAILURE' | 'FINAL_FAILURE' | 'UNCERTAIN' | 'CANCELLED';

export const REMINDER_STATE_LABELS: Readonly<Record<ReminderState, string>> = {
  WAITING: 'En attente du J−7', EXCLUDED: 'Exclu', NO_RECIPIENT: 'Sans destinataire', STRIPE_ERROR: 'Vérification Stripe en échec',
  COVERAGE_UNCERTAIN: 'Couverture incertaine (bascule)', DESYNC_RESYNCED: 'Resynchronisé depuis Stripe', DESYNC_UNRESOLVED: 'Désynchronisé (non résolu)',
  STRIPE_ONLY: 'Absent localement', PREPARED: 'Préparé', HELD: 'Retenu (suspension)', SENDING: 'En cours d’envoi', ACCEPTED: 'Accepté par Resend',
  DELIVERED: 'Livré', DELIVERY_PROBLEM: 'Problème de livraison', TEMPORARY_FAILURE: 'Échec temporaire', FINAL_FAILURE: 'Échec définitif',
  UNCERTAIN: 'Acceptation incertaine', CANCELLED: 'Annulé',
};

const PROBLEM_DELIVERY = new Set(['bounced', 'complained', 'failed', 'suppressed']);

/** État consolidé (pur). */
export function reminderStateOf(r: { outcome: string; job_status: string | null; job_attempts: number | null; job_last_error: string | null; provider_outcome: string | null; delivery_status: string | null }): ReminderState {
  if (!r.job_status) {
    const o = r.outcome as ReminderState;
    if (['WAITING', 'NO_RECIPIENT', 'STRIPE_ERROR', 'COVERAGE_UNCERTAIN', 'DESYNC_RESYNCED', 'DESYNC_UNRESOLVED', 'STRIPE_ONLY'].includes(o)) return o;
    return 'EXCLUDED';
  }
  switch (r.job_status) {
    case 'pending':
      if (r.provider_outcome === 'uncertain') return 'UNCERTAIN';
      if (r.job_last_error === 'TASK_SUSPENDED' || r.job_last_error === 'SWITCH_NOT_DECLARED' || r.job_last_error === 'SEND_STATE_UNREADABLE') return 'HELD';
      return r.job_last_error && Number(r.job_attempts ?? 0) > 0 ? 'TEMPORARY_FAILURE' : 'PREPARED';
    case 'sending': return 'SENDING';
    case 'uncertain': return 'UNCERTAIN';
    case 'failed': return 'FINAL_FAILURE';
    case 'cancelled': return 'CANCELLED';
    case 'accepted':
      if (r.delivery_status === 'delivered') return 'DELIVERED';
      if (r.delivery_status && PROBLEM_DELIVERY.has(r.delivery_status)) return 'DELIVERY_PROBLEM';
      return 'ACCEPTED';
    default: return 'EXCLUDED';
  }
}

export interface AnnualRenewalRecentRow {
  key: string;
  accountId: number | null;
  /** Abonnement Stripe (identifiant seul, jamais de client ni de lien). */
  subscriptionId: string;
  renewalDate: string;
  state: ReminderState;
  step: string | null;
  reason: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  jobId: number | null;
  attempts: number | null;
  nextAttemptAt: string | null;
}

export interface AnnualRenewalAnomaly {
  state: 'STRIPE_ERROR' | 'COVERAGE_UNCERTAIN' | 'DESYNC_UNRESOLVED' | 'STRIPE_ONLY' | 'UNCERTAIN' | 'FINAL_FAILURE' | 'OVERDUE' | 'HELD';
  key: string | null;
  jobId: number | null;
  accountId: number | null;
  renewalDate: string | null;
  reason: string | null;
  since: string | null;
}

export interface AnnualRenewalOverview {
  coverageFrom: string | null;
  /** Demandes par statut sur les 30 derniers jours. */
  jobs: Record<string, number>;
  /** Décisions du jour (motifs d'exclusion compris). */
  checksToday: Array<{ outcome: string; reason: string | null; count: number }>;
  /** Lot 72F : état réel des tâches planifiées. */
  scheduler: SchedulerState;
  reconcileScheduler: SchedulerState;
  /** Lot 72F : bascule Stripe → Verebona. */
  switch: { declared: boolean; stripeRemindersDisabledAt: string | null; declaredAt: string | null; rollbackAt: string | null };
  lastReconcileAt: string | null;
  lastReconcileNote: string | null;
  /** Lot 72F : échéances récentes et à venir, état consolidé. */
  recent: AnnualRenewalRecentRow[];
  /** Lot 72F : erreurs, demandes non traitées, états incertains. */
  anomalies: AnnualRenewalAnomaly[];
}

export async function getAnnualRenewalOverview(now: Date = new Date()): Promise<AnnualRenewalOverview> {
  const today = parisNow(now).dateStr;
  const isoOf = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  const [jobs, checks, sw, scheduler, reconcileScheduler, recentRows, overdue] = await Promise.all([
    pgClient.unsafe<{ status: string; n: number }[]>(
      `SELECT status, count(*)::int AS n FROM transactional_email_jobs
        WHERE kind = $1 AND created_at > $2::timestamptz - interval '30 days' GROUP BY status`,
      [ANNUAL_RENEWAL_REMINDER, iso(now)] as never[],
    ),
    pgClient.unsafe<{ outcome: string; reason: string | null; n: number }[]>(
      `SELECT outcome, reason, count(*)::int AS n FROM annual_renewal_reminder_checks WHERE checked_on = $1::date GROUP BY outcome, reason ORDER BY n DESC`,
      [today] as never[],
    ),
    readSwitchState(),
    readSchedulerState(ANNUAL_RENEWAL_TASK_CODE),
    readSchedulerState(ANNUAL_RENEWAL_RECONCILE_TASK_CODE),
    pgClient.unsafe<Record<string, unknown>[]>(
      `SELECT k.candidate_key, k.account_id, k.stripe_subscription_id, k.renewal_date::text AS renewal_date, k.outcome, k.reason, k.step,
              k.last_checked_at, k.next_check_at, k.updated_at,
              j.id AS job_id, j.status AS job_status, j.attempts AS job_attempts, j.last_error AS job_last_error, j.next_attempt_at,
              j.provider_outcome, j.uncertain_since, l.delivery_status
         FROM annual_renewal_reminder_checks k
         LEFT JOIN transactional_email_jobs j ON j.dedupe_key = k.candidate_key
         LEFT JOIN email_logs l ON l.id = j.last_email_log_id AND j.status = 'accepted'
        WHERE k.renewal_date >= $1::date - 7
        ORDER BY k.updated_at DESC LIMIT 200`,
      [today] as never[],
    ),
    // Demandes dues depuis plus de 30 min et non traitées (file arrêtée ?).
    pgClient.unsafe<{ id: number; dedupe_key: string | null; next_attempt_at: string; account_id: string | null; renewal_date: string | null; last_error: string | null }[]>(
      `SELECT id, dedupe_key, next_attempt_at, context ->> 'accountId' AS account_id, context ->> 'renewalDate' AS renewal_date, last_error
         FROM transactional_email_jobs
        WHERE kind = $1 AND status IN ('pending', 'sending') AND next_attempt_at < $2::timestamptz - interval '30 minutes'
        ORDER BY next_attempt_at LIMIT 50`,
      [ANNUAL_RENEWAL_REMINDER, iso(now)] as never[],
    ),
  ]);
  const recent: AnnualRenewalRecentRow[] = recentRows.map((r) => ({
    key: String(r.candidate_key),
    accountId: r.account_id == null ? null : Number(r.account_id),
    subscriptionId: String(r.stripe_subscription_id),
    renewalDate: String(r.renewal_date),
    state: reminderStateOf({
      outcome: String(r.outcome), job_status: (r.job_status as string | null) ?? null, job_attempts: r.job_attempts == null ? null : Number(r.job_attempts),
      job_last_error: (r.job_last_error as string | null) ?? null, provider_outcome: (r.provider_outcome as string | null) ?? null, delivery_status: (r.delivery_status as string | null) ?? null,
    }),
    step: (r.step as string | null) ?? null,
    reason: r.job_status ? ((r.job_last_error as string | null) ?? (r.reason as string | null) ?? null) : ((r.reason as string | null) ?? null),
    lastCheckedAt: isoOf(r.last_checked_at ?? r.updated_at),
    nextCheckAt: isoOf(r.next_check_at),
    jobId: r.job_id == null ? null : Number(r.job_id),
    attempts: r.job_attempts == null ? null : Number(r.job_attempts),
    nextAttemptAt: isoOf(r.next_attempt_at),
  }));
  const anomalies: AnnualRenewalAnomaly[] = [];
  const ANOMALOUS = new Set(['STRIPE_ERROR', 'COVERAGE_UNCERTAIN', 'DESYNC_UNRESOLVED', 'STRIPE_ONLY', 'UNCERTAIN', 'FINAL_FAILURE', 'HELD']);
  for (const r of recent) {
    if (!ANOMALOUS.has(r.state)) continue;
    anomalies.push({ state: r.state as AnnualRenewalAnomaly['state'], key: r.key, jobId: r.jobId, accountId: r.accountId, renewalDate: r.renewalDate, reason: r.reason, since: r.lastCheckedAt });
  }
  // Acceptations incertaines hors fenêtre du journal (demande plus ancienne).
  const seen = new Set(anomalies.map((a) => a.jobId).filter((v) => v != null));
  const uncertain = await pgClient.unsafe<{ id: number; dedupe_key: string | null; account_id: string | null; renewal_date: string | null; provider_detail: string | null; uncertain_since: string | null }[]>(
    `SELECT id, dedupe_key, context ->> 'accountId' AS account_id, context ->> 'renewalDate' AS renewal_date, provider_detail, uncertain_since
       FROM transactional_email_jobs WHERE kind = $1 AND status = 'uncertain' ORDER BY uncertain_since NULLS LAST LIMIT 50`,
    [ANNUAL_RENEWAL_REMINDER as never],
  );
  for (const u of uncertain) {
    if (seen.has(u.id)) continue;
    anomalies.push({ state: 'UNCERTAIN', key: u.dedupe_key, jobId: u.id, accountId: u.account_id ? Number(u.account_id) : null, renewalDate: u.renewal_date, reason: u.provider_detail, since: isoOf(u.uncertain_since) });
    seen.add(u.id);
  }
  for (const o of overdue) {
    if (seen.has(o.id)) continue;
    anomalies.push({ state: 'OVERDUE', key: o.dedupe_key, jobId: o.id, accountId: o.account_id ? Number(o.account_id) : null, renewalDate: o.renewal_date, reason: o.last_error, since: isoOf(o.next_attempt_at) });
  }
  return {
    coverageFrom: sw.coverageFrom,
    jobs: Object.fromEntries(jobs.map((j) => [j.status, Number(j.n)])),
    checksToday: checks.map((c) => ({ outcome: c.outcome, reason: c.reason, count: Number(c.n) })),
    scheduler,
    reconcileScheduler,
    switch: {
      declared: !!sw.stripeRemindersDisabledAt,
      stripeRemindersDisabledAt: isoOf(sw.stripeRemindersDisabledAt),
      declaredAt: isoOf(sw.switchDeclaredAt),
      rollbackAt: isoOf(sw.rollbackAt),
    },
    lastReconcileAt: isoOf(sw.lastReconcileAt),
    lastReconcileNote: sw.lastReconcileNote,
    recent,
    anomalies,
  };
}

/** Prochain J−7 (pour les tests et l'aide BO). */
export function reminderDateFor(renewalAt: Date): string {
  return addDaysToDateStr(parisDateOf(renewalAt), -7);
}
