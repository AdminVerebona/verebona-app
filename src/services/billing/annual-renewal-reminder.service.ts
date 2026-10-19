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
 */
import { pgClient } from '@/db';
import { addDaysToDateStr, parisNow } from '@/lib/notifications/time-paris';
import { planLabelOf } from '@/lib/notifications/subscription-messages';
import {
  ANNUAL_RENEWAL_REMINDER, MANAGE_SUBSCRIPTION_PATH, REMINDER_WINDOW,
  amountLabelOf, annualRenewalDedupeKey, evaluateStripeEligibility, formatRenewalDate, parisDateOf,
  reminderTiming, renewalAmountFromPreview, renewalDelayLabel,
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
/** Annulations définitives : jamais relancées (décision BO, échéance passée). */
export const FINAL_CANCEL_REASONS = ['CHANNEL_DISABLED', 'TOO_LATE'] as const;

/** Relit l'abonnement (échéancier et prix des phases développés). */
async function readSubscription(stripe: ReminderStripe, id: string): Promise<{ sub: ReminderSubscription; schedule: ReminderSchedule | null }> {
  const sub = await stripe.subscriptions.retrieve(id, { expand: ['schedule.phases.items.price'] }) as ReminderSubscription;
  const schedule = sub.schedule && typeof sub.schedule === 'object' ? sub.schedule as ReminderSchedule : null;
  return { sub, schedule };
}

// ── Début de couverture (bascule Stripe → Verebona) ──────────────────────────

/** Date de la première exécution du traitement (posée une fois, jamais déplacée). */
export async function ensureCoverageFrom(today: string): Promise<string> {
  const [row] = await pgClient.unsafe<{ coverage_from: string }[]>(
    `INSERT INTO annual_renewal_reminder_state (id, coverage_from, updated_at) VALUES (1, $1::date, now())
     ON CONFLICT (id) DO UPDATE SET coverage_from = COALESCE(annual_renewal_reminder_state.coverage_from, EXCLUDED.coverage_from)
     RETURNING coverage_from::text AS coverage_from`,
    [today] as never[],
  );
  return row.coverage_from;
}

async function readCoverageFrom(): Promise<string | null> {
  const [row] = await pgClient.unsafe<{ coverage_from: string | null }[]>(
    `SELECT coverage_from::text AS coverage_from FROM annual_renewal_reminder_state WHERE id = 1`,
  );
  return row?.coverage_from ?? null;
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
  result.coverageFrom = await ensureCoverageFrom(today);

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
                           AND k.checked_on = $2::date)
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
  for (const c of candidates) {
    if (Date.now() >= deadline) break;
    const localKey = annualRenewalDedupeKey(c.stripe_subscription_id, c.renewal_date);
    let outcome: string;
    let reason: string | null = null;
    let jobId: number | null = null;
    let stripeRenewal: string | null = null;
    try {
      const { sub, schedule } = await readSubscription(stripe, c.stripe_subscription_id);
      const elig = evaluateStripeEligibility(sub, { schedule });
      if (!elig.ok) {
        outcome = 'EXCLUDED'; reason = elig.reason;
      } else {
        stripeRenewal = parisDateOf(elig.renewalAt);
        const timing = reminderTiming(now, elig.renewalAt, result.coverageFrom);
        if (!timing.send) {
          outcome = timing.reason === 'TOO_EARLY' ? 'WAITING' : 'EXCLUDED'; reason = timing.reason;
        } else {
          const r = await enqueueReminder({ accountId: c.account_id, ownerUserId: c.owner_user_id, subscriptionId: c.stripe_subscription_id, renewalAt: elig.renewalAt, catchUp: timing.catchUp, now });
          outcome = r.outcome; jobId = r.jobId; reason = r.reason ?? null;
          if (r.outcome === 'ENQUEUED') result.enqueued += 1;
          if (r.outcome === 'REVIVED') result.revived += 1;
        }
      }
    } catch (e) {
      // Panne Stripe : rien n'est consigné pour aujourd'hui → repris au passage suivant.
      result.stripeErrors += 1;
      console.error(`[annual-renewal] vérification Stripe impossible (${c.stripe_subscription_id}) :`, (e as Error)?.message ?? e);
      continue;
    }
    if (outcome === 'EXCLUDED' || outcome === 'WAITING') exclude(reason ?? outcome);
    await recordCheck({ key: localKey, accountId: c.account_id, subscriptionId: c.stripe_subscription_id, renewalDate: stripeRenewal ?? c.renewal_date, today, outcome, reason, jobId });
  }
  return result;
}

async function recordCheck(r: { key: string; accountId: number; subscriptionId: string; renewalDate: string; today: string; outcome: string; reason: string | null; jobId: number | null }): Promise<void> {
  await pgClient.unsafe(
    `INSERT INTO annual_renewal_reminder_checks
       (candidate_key, account_id, stripe_subscription_id, renewal_date, checked_on, outcome, reason, job_id, checks, created_at, updated_at)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, 1, now(), now())
     ON CONFLICT (candidate_key) DO UPDATE
        SET renewal_date = EXCLUDED.renewal_date, checked_on = EXCLUDED.checked_on, outcome = EXCLUDED.outcome,
            reason = EXCLUDED.reason, job_id = COALESCE(EXCLUDED.job_id, annual_renewal_reminder_checks.job_id),
            checks = annual_renewal_reminder_checks.checks + 1, updated_at = now()`,
    [r.key, r.accountId, r.subscriptionId, r.renewalDate, r.today, r.outcome, r.reason, r.jobId] as never[],
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

/**
 * Revalide l'abonnement chez Stripe et construit les variables du gabarit.
 * Une erreur Stripe LÈVE (échec temporaire, reprise par la file).
 */
export async function buildAnnualRenewalReminder(
  job: { user_id: number | null; context: Record<string, unknown> },
  now: Date,
  stripe?: ReminderStripe,
): Promise<ReminderBuild> {
  const ctx = job.context ?? {};
  const accountId = Number(ctx.accountId);
  const subscriptionId = typeof ctx.subscriptionId === 'string' ? ctx.subscriptionId : '';
  const renewalDate = typeof ctx.renewalDate === 'string' ? ctx.renewalDate : '';
  if (!Number.isFinite(accountId) || !subscriptionId || !renewalDate) return { ok: false, reason: 'INVALID_REQUEST' };

  const [acc] = await pgClient.unsafe<{
    owner_user_id: number; stripe_customer_id: string | null; account_sub: string | null; row_sub: string | null; plan_code: string | null;
    duo_owner: number | null; email: string | null; first_name: string | null; user_status: string | null;
  }[]>(
    `SELECT a.owner_user_id, COALESCE(s.stripe_customer_id, a.stripe_customer_id) AS stripe_customer_id,
            a.stripe_subscription_id AS account_sub, s.stripe_subscription_id AS row_sub, s.plan_code,
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

  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? acc.stripe_customer_id ?? undefined;
  const preview = await client.invoices.createPreview(
    elig.scheduleId ? { customer, schedule: elig.scheduleId } : { customer, subscription: subscriptionId },
  ) as ReminderInvoicePreview;
  const amount = renewalAmountFromPreview(preview, elig.renewalTs);
  // Jamais de montant inventé : reporté (reprises), puis échec journalisé.
  if (!amount) return { ok: false, reason: 'AMOUNT_UNAVAILABLE', temporary: true };

  const base = appBaseUrl();
  return {
    ok: true,
    to: acc.email,
    recipientUserId: Number(acc.owner_user_id),
    variables: {
      firstName: escapeHtml((acc.first_name ?? '').trim()),
      planLabel: escapeHtml(planLabelOf({ planCode: acc.plan_code ?? 'premium' }) ?? 'Premium'),
      renewalDate: formatRenewalDate(elig.renewalAt),
      renewalDelayLabel: renewalDelayLabel(timing.days),
      amountLabel: amountLabelOf(amount.cents, amount.currency),
      manageSubscriptionUrl: `${base}${MANAGE_SUBSCRIPTION_PATH}`,
      accountUrl: `${base}/mon-compte`,
    },
  };
}

// ── BO : état du traitement ──────────────────────────────────────────────────

export interface AnnualRenewalOverview {
  coverageFrom: string | null;
  /** Demandes par statut sur les 30 derniers jours. */
  jobs: Record<string, number>;
  /** Décisions du jour (motifs d'exclusion compris). */
  checksToday: Array<{ outcome: string; reason: string | null; count: number }>;
}

export async function getAnnualRenewalOverview(now: Date = new Date()): Promise<AnnualRenewalOverview> {
  const today = parisNow(now).dateStr;
  const [jobs, checks, coverageFrom] = await Promise.all([
    pgClient.unsafe<{ status: string; n: number }[]>(
      `SELECT status, count(*)::int AS n FROM transactional_email_jobs
        WHERE kind = $1 AND created_at > $2::timestamptz - interval '30 days' GROUP BY status`,
      [ANNUAL_RENEWAL_REMINDER, iso(now)] as never[],
    ),
    pgClient.unsafe<{ outcome: string; reason: string | null; n: number }[]>(
      `SELECT outcome, reason, count(*)::int AS n FROM annual_renewal_reminder_checks WHERE checked_on = $1::date GROUP BY outcome, reason ORDER BY n DESC`,
      [today] as never[],
    ),
    readCoverageFrom(),
  ]);
  return {
    coverageFrom,
    jobs: Object.fromEntries(jobs.map((j) => [j.status, Number(j.n)])),
    checksToday: checks.map((c) => ({ outcome: c.outcome, reason: c.reason, count: Number(c.n) })),
  };
}

/** Prochain J−7 (pour les tests et l'aide BO). */
export function reminderDateFor(renewalAt: Date): string {
  return addDaysToDateStr(parisDateOf(renewalAt), -7);
}
