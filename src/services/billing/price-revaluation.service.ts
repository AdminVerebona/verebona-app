/**
 * Revalorisation des abonnements EXISTANTS à leur prochain renouvellement —
 * CDC lookup_key V4 §1.3, §24.2, §25.3, LK-106 à LK-113, EX-016 à EX-029,
 * TC-85 à TC-90, RX-06 à RX-15, RX-20, RX-22.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN TRANSFERT DE CLÉ NE CHANGE AUCUN ABONNEMENT
 *
 * La publication d'une nouvelle grille ne touche que les NOUVELLES ventes.
 * Les abonnés existants gardent le prix qu'ils paient (Stripe renouvelle sur
 * le Price porté par l'item) jusqu'à ce que CETTE campagne, distincte, ait :
 *
 *   1. inventorié CHEZ STRIPE (pagination, pas seulement la base locale)
 *      chaque abonnement dont l'item porte un ancien prix de la même offre et
 *      de la même périodicité (EX-016, EX-017) ;
 *   2. classé chaque abonnement (EX-023) :
 *        canceled / incomplete_expired / rétracté → exclu, jamais recréé ;
 *        cancel_at_period_end                     → différé tant que la
 *                                                   résiliation tient ;
 *        past_due, unpaid, paused, incomplete     → différé (politique
 *                                                   d'impayé prioritaire) ;
 *        trialing (aucun essai Stripe chez Verebona) → différé, exception ;
 *        plusieurs items / quantité ≠ 1           → bloqué, exception ;
 *        changement programmé par l'utilisateur   → différé : son intention
 *                                                   et son prix acceptés sont
 *                                                   préservés (EX-025) ;
 *        échéancier étranger                      → bloqué (EX-021) ;
 *   3. obtenu la PREUVE de l'information préalable (EX-029) : envoi réel
 *      tracé, ou preuve externe saisie dans le BO — le code n'invente
 *      jamais une notification ; l'ancien prix reste applicable sinon (LK-108) ;
 *   4. planifié, après le délai de préavis et pas trop près de l'échéance
 *      (EX-019), un ÉCHÉANCIER Stripe : phase courante strictement
 *      identique (prix, quantité, remises par identifiant, taxes, dates),
 *      puis phase au nouveau prix, `proration_behavior = none`, libéré
 *      ensuite (EX-020) — ni facture immédiate, ni prorata, ni ancre déplacée ;
 *   5. constaté la bascule au renouvellement (webhook ou passage suivant) et
 *      compté séparément planned / completed / deferred / failed / canceled
 *      (EX-028).
 * Toute relance est idempotente (index unique campagne × item, clés
 * d'idempotence Stripe, TC-83, RX-22). Un échec laisse l'ancien prix et
 * apparaît dans le diagnostic (EX-027).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { pgClient } from '@/db';
import { envNumber } from '@/lib/env-number';
import { getStripeServer, getStripeCatalogContext } from '@/lib/stripe-client';
import { CATALOG_COUPLES, coupleKey, formatEuroCents, PLAN_LABELS, type BillingPeriod, type PlanCode } from '@/lib/billing/plan-catalog';
import type { CatalogSnapshot, ResolvedPrice } from './catalog-types';
import { resolveHistoricalPrice } from './price-history.service';

type Row = Record<string, unknown>;
async function q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pgClient.unsafe(text, params as never[])) as unknown as T[];
}

const toDate = (unix: number | null | undefined): Date | null => (typeof unix === 'number' && unix > 0 ? new Date(unix * 1000) : null);
const idOf = (v: string | { id: string } | null | undefined): string | null => (!v ? null : typeof v === 'string' ? v : v.id);

/** Préavis minimal entre l'information et la date d'effet (jours). */
export function noticeDays(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber('BILLING_REVALUATION_NOTICE_DAYS', 30, { min: 1 }, env);
}
/** Marge de sécurité avant une échéance (EX-019) : en deçà, échéance suivante. */
export const RENEWAL_SAFETY_MS = 48 * 60 * 60_000;

export type Eligibility =
  | { status: 'eligible' }
  | { status: 'deferred'; reason: string }
  | { status: 'excluded'; reason: string; migration: 'canceled' | 'blocked' };

/** Classement d'un abonnement (pur, EX-023, LK-110). */
export function evaluateEligibility(
  sub: Pick<Stripe.Subscription, 'status' | 'cancel_at_period_end' | 'schedule' | 'items'>,
  ctx: { withdrawn: boolean; userScheduledChange: boolean; scheduleIsOwnRevaluation?: boolean },
): Eligibility {
  if (['canceled', 'incomplete_expired'].includes(sub.status)) return { status: 'excluded', reason: 'CANCELED', migration: 'canceled' };
  if (ctx.withdrawn) return { status: 'excluded', reason: 'WITHDRAWN', migration: 'canceled' };
  if (sub.items.data.length !== 1) return { status: 'excluded', reason: 'MULTIPLE_ITEMS', migration: 'blocked' };
  if ((sub.items.data[0].quantity ?? 1) !== 1) return { status: 'excluded', reason: 'QUANTITY_NOT_ONE', migration: 'blocked' };
  if (sub.cancel_at_period_end) return { status: 'deferred', reason: 'CANCEL_AT_PERIOD_END' };
  if (['past_due', 'unpaid', 'paused', 'incomplete'].includes(sub.status)) return { status: 'deferred', reason: `STATUS_${sub.status.toUpperCase()}` };
  if (sub.status === 'trialing') return { status: 'deferred', reason: 'TRIALING' };
  if (ctx.userScheduledChange) return { status: 'deferred', reason: 'USER_SCHEDULED_CHANGE' };
  if (sub.schedule && !ctx.scheduleIsOwnRevaluation) return { status: 'excluded', reason: 'FOREIGN_SCHEDULE', migration: 'blocked' };
  return { status: 'eligible' };
}

/**
 * Date d'effet : prochaine échéance NON ENCORE FACTURÉE, postérieure au
 * préavis, et pas trop proche (EX-019). Pure.
 */
export function revaluationTiming(renewalAt: Date | null, noticeDeadline: Date | null, now: Date): { ready: boolean; reason: string } {
  if (!renewalAt) return { ready: false, reason: 'NO_RENEWAL_DATE' };
  if (!noticeDeadline) return { ready: false, reason: 'NOTICE_NOT_PROVEN' };
  if (renewalAt.getTime() < noticeDeadline.getTime()) return { ready: false, reason: 'NOTICE_PERIOD_RUNNING' };
  if (renewalAt.getTime() - now.getTime() < RENEWAL_SAFETY_MS) return { ready: false, reason: 'RENEWAL_TOO_CLOSE' };
  return { ready: true, reason: 'OK' };
}

/**
 * Phases de l'échéancier de revalorisation (pur, EX-020, EX-021, TC-53).
 * Phase courante recopiée À L'IDENTIQUE ; remises reportées par IDENTIFIANT
 * de remise (`discount`) pour ne pas relancer la durée d'un coupon (EX-026).
 */
export function buildRevaluationPhases(
  current: Stripe.SubscriptionSchedule.Phase,
  targetPriceId: string,
  period: BillingPeriod,
  metadata: Record<string, string>,
): Stripe.SubscriptionScheduleUpdateParams.Phase[] {
  const discounts = (current.discounts ?? []).map((dsc) => {
    const discountId = idOf(dsc.discount as string | { id: string } | null);
    if (discountId) return { discount: discountId };
    const coupon = idOf(dsc.coupon as string | { id: string } | null);
    const promotion = idOf(dsc.promotion_code as string | { id: string } | null);
    return coupon ? { coupon } : promotion ? { promotion_code: promotion } : null;
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  const items = current.items.map((it) => ({
    price: idOf(it.price as string | { id: string })!,
    quantity: it.quantity ?? 1,
    ...(it.tax_rates?.length ? { tax_rates: it.tax_rates.map((t) => idOf(t as string | { id: string })!) } : {}),
  }));
  const defaultTaxRates = (current.default_tax_rates ?? []).map((t) => idOf(t as string | { id: string })!).filter(Boolean);
  return [
    {
      items,
      start_date: current.start_date,
      end_date: current.end_date,
      ...(discounts.length ? { discounts } : {}),
      ...(defaultTaxRates.length ? { default_tax_rates: defaultTaxRates } : {}),
      ...(current.metadata && Object.keys(current.metadata).length ? { metadata: current.metadata } : {}),
      proration_behavior: 'none',
    },
    {
      items: [{ price: targetPriceId, quantity: items[0]?.quantity ?? 1, ...(items[0]?.tax_rates ? { tax_rates: items[0].tax_rates } : {}) }],
      duration: { interval: period === 'yearly' ? 'year' : 'month', interval_count: 1 },
      ...(discounts.length ? { discounts } : {}),
      ...(defaultTaxRates.length ? { default_tax_rates: defaultTaxRates } : {}),
      proration_behavior: 'none',
      metadata,
    },
  ];
}

// ─── Campagne ───────────────────────────────────────────────────────────────

export interface CampaignCounts { inventoried: number; planned: number; deferred: number; excluded: number; skippedSamePrice: number }

/** Couples dont le MONTANT change entre deux révisions (seuls concernés). */
export function changedCouples(previous: CatalogSnapshot | null, next: CatalogSnapshot): Map<string, ResolvedPrice> {
  const out = new Map<string, ResolvedPrice>();
  for (const c of CATALOG_COUPLES) {
    const key = coupleKey(c.planCode, c.billingPeriod);
    const n = next.entries[key];
    const p = previous?.entries[key];
    if (n && p && n.unitAmountCents !== p.unitAmountCents) out.set(key, n);
  }
  return out;
}

async function* listAllSubscriptions(stripe: Stripe): AsyncGenerator<Stripe.Subscription> {
  for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) yield s;
}

async function localContext(subscriptionId: string): Promise<{ accountId: number | null; withdrawn: boolean; userScheduledChange: boolean }> {
  const [row] = await q<{ account_id: number; scheduled_plan_code: string | null }>(
    `SELECT account_id, scheduled_plan_code FROM account_subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`, [subscriptionId],
  ).catch(() => []);
  const [w] = await q(`SELECT 1 FROM withdrawal_requests WHERE stripe_subscription_id = $1 AND status <> 'rejected' LIMIT 1`, [subscriptionId]).catch(() => []);
  return { accountId: row?.account_id ?? null, withdrawn: Boolean(w), userScheduledChange: Boolean(row?.scheduled_plan_code) };
}

/**
 * Crée la campagne d'une révision activée (EX-016). Idempotente : une ligne
 * par (campagne, item) — une relance n'ajoute rien (TC-83).
 */
export async function createRevaluationCampaign(input: { revisionId: string; previous: CatalogSnapshot | null; next: CatalogSnapshot; stripe?: Stripe }): Promise<CampaignCounts> {
  const counts: CampaignCounts = { inventoried: 0, planned: 0, deferred: 0, excluded: 0, skippedSamePrice: 0 };
  const targets = changedCouples(input.previous, input.next);
  if (targets.size === 0) return counts;
  const ctx = getStripeCatalogContext();
  const stripe = input.stripe ?? getStripeServer();
  for await (const sub of listAllSubscriptions(stripe)) {
    if (['canceled', 'incomplete_expired'].includes(sub.status)) continue;
    for (const item of sub.items.data) {
      const recognized = await resolveHistoricalPrice(item.price.id, { source: 'revaluation', price: item.price });
      if (recognized.status !== 'recognized') continue;
      const target = targets.get(coupleKey(recognized.planCode, recognized.billingPeriod));
      if (!target) continue;
      counts.inventoried++;
      if (item.price.id === target.priceId) { counts.skippedSamePrice++; continue; }
      const local = await localContext(sub.id);
      const scheduleIsOwnRevaluation = false;
      const verdict = evaluateEligibility(sub, { ...local, scheduleIsOwnRevaluation });
      const migrationStatus = verdict.status === 'eligible' ? 'planned' : verdict.status === 'deferred' ? 'deferred' : verdict.migration;
      const inserted = await q(
        `INSERT INTO stripe_price_migrations
           (catalog_context, revision_id, account_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
            plan_code, billing_period, subscription_status, old_price_id, old_amount_cents, target_price_id, target_amount_cents,
            renewal_at, has_discount, has_schedule, eligibility_status, eligibility_reason, migration_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15,$16,$17,$18,$19)
         ON CONFLICT (revision_id, stripe_subscription_item_id) DO NOTHING
         RETURNING id`,
        [ctx.catalogContext, input.revisionId, local.accountId, idOf(sub.customer as string | { id: string }), sub.id, item.id,
          recognized.planCode, recognized.billingPeriod, sub.status, item.price.id, item.price.unit_amount ?? null,
          target.priceId, target.unitAmountCents, toDate(item.current_period_end)?.toISOString() ?? null,
          Boolean(sub.discounts?.length), Boolean(sub.schedule),
          verdict.status, verdict.status === 'eligible' ? null : verdict.reason, migrationStatus],
      );
      if (!inserted.length) continue;
      if (migrationStatus === 'planned') counts.planned++;
      else if (migrationStatus === 'deferred') counts.deferred++;
      else counts.excluded++;
    }
  }
  console.info(JSON.stringify({ evt: 'billing.revaluation.campaign_created', revisionId: input.revisionId, ...counts }));
  return counts;
}

export interface CampaignRow {
  id: number; revisionId: string; accountId: number | null; stripeSubscriptionId: string; planCode: PlanCode; billingPeriod: BillingPeriod;
  subscriptionStatus: string | null; oldPriceId: string; oldAmountCents: number | null; targetPriceId: string; targetAmountCents: number;
  renewalAt: string | null; hasDiscount: boolean; hasSchedule: boolean; eligibilityStatus: string; eligibilityReason: string | null;
  notificationStatus: string; noticeDeadline: string | null; migrationStatus: string; scheduleId: string | null; attempts: number; lastError: string | null;
  plannedAction: string;
}

function plannedAction(r: Row): string {
  const status = String(r.migration_status);
  if (status === 'planned') return r.notification_status === 'proven' ? 'Échéancier Stripe à la prochaine échéance (sans prorata)' : 'En attente de la preuve d’information préalable';
  if (status === 'scheduled') return 'Échéancier posé : bascule au renouvellement';
  if (status === 'deferred') return `Différé (${r.eligibility_reason ?? '—'}) : ancien tarif maintenu`;
  if (status === 'blocked') return `Exception (${r.eligibility_reason ?? r.last_error ?? '—'}) : ancien tarif maintenu`;
  if (status === 'retryable') return 'Nouvelle tentative automatique';
  return '—';
}

/** Simulation NOMINATIVE interne (LK-112) : lecture seule. */
export async function listCampaign(revisionId?: string | null, limit = 500): Promise<{ revisionId: string | null; counts: Record<string, number>; rows: CampaignRow[] }> {
  const ctx = getStripeCatalogContext().catalogContext;
  const [latest] = revisionId ? [{ revision_id: revisionId }] : await q<{ revision_id: string }>(
    `SELECT revision_id FROM stripe_price_migrations WHERE catalog_context = $1 ORDER BY created_at DESC LIMIT 1`, [ctx],
  ).catch(() => []);
  if (!latest) return { revisionId: null, counts: {}, rows: [] };
  const rows = await q(`SELECT * FROM stripe_price_migrations WHERE catalog_context = $1 AND revision_id = $2 ORDER BY renewal_at NULLS LAST, id LIMIT $3`, [ctx, latest.revision_id, limit]);
  const countRows = await q<{ migration_status: string; n: number }>(
    `SELECT migration_status, count(*)::int AS n FROM stripe_price_migrations WHERE catalog_context = $1 AND revision_id = $2 GROUP BY migration_status`, [ctx, latest.revision_id],
  );
  return {
    revisionId: latest.revision_id,
    counts: Object.fromEntries(countRows.map((r) => [r.migration_status, Number(r.n)])),
    rows: rows.map((r) => ({
      id: Number(r.id), revisionId: String(r.revision_id), accountId: (r.account_id as number) ?? null, stripeSubscriptionId: String(r.stripe_subscription_id),
      planCode: r.plan_code as PlanCode, billingPeriod: r.billing_period as BillingPeriod, subscriptionStatus: (r.subscription_status as string) ?? null,
      oldPriceId: String(r.old_price_id), oldAmountCents: r.old_amount_cents == null ? null : Number(r.old_amount_cents),
      targetPriceId: String(r.target_price_id), targetAmountCents: Number(r.target_amount_cents),
      renewalAt: r.renewal_at ? new Date(r.renewal_at as string).toISOString() : null, hasDiscount: Boolean(r.has_discount), hasSchedule: Boolean(r.has_schedule),
      eligibilityStatus: String(r.eligibility_status), eligibilityReason: (r.eligibility_reason as string) ?? null,
      notificationStatus: String(r.notification_status), noticeDeadline: r.notice_deadline ? new Date(r.notice_deadline as string).toISOString() : null,
      migrationStatus: String(r.migration_status), scheduleId: (r.schedule_id as string) ?? null, attempts: Number(r.attempts ?? 0), lastError: (r.last_error as string) ?? null,
      plannedAction: plannedAction(r),
    })),
  };
}

// ─── Information préalable (EX-029) ─────────────────────────────────────────

export interface NotificationInput {
  revisionId: string;
  /** `email` : envoi du gabarit PRICE_CHANGE_NOTICE ; `external` : preuve d'une information faite hors application. */
  channel: 'email' | 'external';
  /** Référence de validation juridique du texte (obligatoire). */
  legalReference: string;
  actor: string;
  /** Référence de la preuve externe (campagne d'envoi, courrier…). */
  externalReference?: string | null;
}

/**
 * Enregistre l'information préalable des abonnés concernés. N'est jamais
 * déclenchée automatiquement : action BO explicite, référence juridique
 * exigée. Un envoi en échec n'est PAS une preuve (`failed`).
 */
export async function recordCampaignNotification(input: NotificationInput, now: Date = new Date()): Promise<{ proven: number; failed: number }> {
  if (!input.legalReference?.trim()) throw new Error('Référence de validation juridique obligatoire');
  if (input.channel === 'external' && !input.externalReference?.trim()) throw new Error('Référence de la preuve externe obligatoire');
  const ctx = getStripeCatalogContext().catalogContext;
  const rows = await q(
    `SELECT m.*, a.owner_user_id FROM stripe_price_migrations m LEFT JOIN accounts a ON a.id = m.account_id
      WHERE m.catalog_context = $1 AND m.revision_id = $2 AND m.notification_status IN ('pending', 'failed')
        AND m.migration_status IN ('planned', 'deferred', 'retryable')`,
    [ctx, input.revisionId],
  );
  const deadline = new Date(now.getTime() + noticeDays() * 86_400_000);
  let proven = 0;
  let failed = 0;
  for (const r of rows) {
    let proof: Record<string, unknown>;
    let ok = false;
    if (input.channel === 'external') {
      proof = { channel: 'external', reference: input.externalReference, legalReference: input.legalReference, actor: input.actor, at: now.toISOString() };
      ok = true;
    } else {
      const res = await sendNotice(r, deadline).catch((e: Error) => ({ success: false, error: e.message }));
      proof = { channel: 'email', template: 'PRICE_CHANGE_NOTICE', legalReference: input.legalReference, actor: input.actor, at: now.toISOString(), result: res };
      ok = Boolean((res as { success?: boolean }).success);
    }
    await q(
      `UPDATE stripe_price_migrations SET notification_status = $2, notification_proof = $3::jsonb,
         notified_at = CASE WHEN $4::boolean THEN $5::timestamptz ELSE notified_at END,
         notice_deadline = CASE WHEN $4::boolean THEN $6::timestamptz ELSE notice_deadline END, updated_at = now()
       WHERE id = $1`,
      [r.id, ok ? 'proven' : 'failed', JSON.stringify(proof), ok, now.toISOString(), deadline.toISOString()],
    );
    if (ok) proven++; else failed++;
  }
  return { proven, failed };
}

async function sendNotice(r: Row, effectiveFrom: Date): Promise<{ success: boolean; error?: string }> {
  if (!r.owner_user_id) return { success: false, error: 'NO_OWNER' };
  const [user] = await q<{ email: string; first_name: string | null }>(`SELECT email, first_name FROM users WHERE id = $1`, [r.owner_user_id]);
  if (!user?.email) return { success: false, error: 'NO_EMAIL' };
  const { emailService } = await import('@/lib/email/email-service');
  const period = r.billing_period === 'yearly' ? 'par an' : 'par mois';
  const res = await emailService.send({
    templateCode: 'PRICE_CHANGE_NOTICE',
    to: user.email,
    userId: Number(r.owner_user_id),
    variables: {
      firstName: user.first_name ?? '',
      planLabel: PLAN_LABELS[r.plan_code as PlanCode] ?? String(r.plan_code),
      oldAmount: r.old_amount_cents == null ? '—' : `${formatEuroCents(Number(r.old_amount_cents))} TTC ${period}`,
      newAmount: `${formatEuroCents(Number(r.target_amount_cents))} TTC ${period}`,
      effectiveFrom: effectiveFrom.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' }),
    },
  });
  return { success: Boolean((res as { success?: boolean })?.success), error: (res as { error?: string })?.error };
}

// ─── Application (tâche planifiée) ──────────────────────────────────────────

export interface TickResult { scheduled: number; completed: number; deferred: number; failed: number; waiting: number; canceled: number }

/**
 * Passage idempotent : planifie les lignes prêtes, constate les bascules.
 * Bornée par `deadline`.
 */
export async function runRevaluationTick(opts: { deadline?: number; stripe?: Stripe; now?: Date } = {}): Promise<TickResult> {
  const out: TickResult = { scheduled: 0, completed: 0, deferred: 0, failed: 0, waiting: 0, canceled: 0 };
  const ctx = getStripeCatalogContext();
  if (!ctx.mode) return out;
  const stripe = opts.stripe ?? getStripeServer();
  const now = opts.now ?? new Date();
  const rows = await q(
    `SELECT * FROM stripe_price_migrations WHERE catalog_context = $1 AND migration_status IN ('planned', 'retryable', 'deferred', 'scheduled')
      ORDER BY renewal_at NULLS LAST, id LIMIT 200`,
    [ctx.catalogContext],
  ).catch(() => []);
  for (const r of rows) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    try {
      const outcome = await processRow(stripe, r, now);
      out[outcome]++;
    } catch (e) {
      const attempts = Number(r.attempts ?? 0) + 1;
      const status = attempts >= 5 ? 'failed' : 'retryable';
      await q(`UPDATE stripe_price_migrations SET attempts = $2, migration_status = $3, last_error = $4, updated_at = now() WHERE id = $1`, [r.id, attempts, status, (e as Error).message.slice(0, 500)]);
      if (status === 'failed') {
        const { reportAnomaly } = await import('@/services/admin/anomaly.service');
        await reportAnomaly({ domain: 'stripe', fingerprint: `stripe:revaluation:${r.id}`, title: 'Revalorisation en échec : ancien tarif maintenu', accountId: (r.account_id as number) ?? null, detail: { migrationId: r.id, error: (e as Error).message } }).catch(() => undefined);
      }
      out.failed++;
    }
  }
  return out;
}

async function setRow(id: unknown, patch: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 2}${k === 'evidence' ? '::jsonb' : k.endsWith('_at') ? '::timestamptz' : ''}`).join(', ');
  await q(`UPDATE stripe_price_migrations SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => (k === 'evidence' ? JSON.stringify(patch[k]) : patch[k]))]);
}

async function processRow(stripe: Stripe, r: Row, now: Date): Promise<keyof TickResult> {
  const sub = await stripe.subscriptions.retrieve(String(r.stripe_subscription_id));
  const item = sub.items.data.find((i) => i.id === r.stripe_subscription_item_id) ?? null;

  // Constat de bascule (completed) — quel que soit l'état de la ligne.
  if (item && item.price.id === r.target_price_id) {
    await setRow(r.id, { migration_status: 'completed', evidence: { ...(r.evidence as object ?? {}), completedAt: now.toISOString(), latestInvoice: idOf(sub.latest_invoice as string | { id: string } | null) } });
    return 'completed';
  }
  if (!item) {
    await setRow(r.id, { migration_status: 'canceled', eligibility_reason: 'ITEM_REPLACED' });
    return 'canceled';
  }
  const local = await localContext(sub.id);
  const scheduleId = idOf(sub.schedule as string | { id: string } | null);
  let ownSchedule = false;
  if (scheduleId && r.schedule_id === scheduleId) ownSchedule = true;
  const verdict = evaluateEligibility(sub, { ...local, scheduleIsOwnRevaluation: ownSchedule });

  if (r.migration_status === 'scheduled') {
    if (verdict.status !== 'eligible') {
      // La situation a changé (résiliation, impayé, changement utilisateur) :
      // l'échéancier de revalorisation est libéré, l'ancien tarif reste.
      if (ownSchedule && scheduleId) await stripe.subscriptionSchedules.release(scheduleId);
      const deferred = verdict.status === 'deferred';
      await setRow(r.id, { migration_status: deferred ? 'deferred' : verdict.migration, eligibility_status: verdict.status, eligibility_reason: verdict.reason, schedule_id: null });
      return deferred ? 'deferred' : 'canceled';
    }
    if (!ownSchedule) {
      const renewal = r.renewal_at ? new Date(r.renewal_at as string) : null;
      if (renewal && renewal.getTime() < now.getTime()) {
        await setRow(r.id, { migration_status: 'failed', last_error: 'SCHEDULE_MISSING_AT_RENEWAL' });
        return 'failed';
      }
    }
    return 'waiting';
  }

  if (verdict.status !== 'eligible') {
    const deferred = verdict.status === 'deferred';
    await setRow(r.id, { migration_status: deferred ? 'deferred' : verdict.migration, eligibility_status: verdict.status, eligibility_reason: verdict.reason, subscription_status: sub.status });
    return deferred ? 'deferred' : 'canceled';
  }
  if (r.notification_status !== 'proven') {
    await setRow(r.id, { migration_status: 'planned', eligibility_status: 'eligible', eligibility_reason: null, subscription_status: sub.status });
    return 'waiting';
  }
  const renewalAt = toDate(item.current_period_end);
  const timing = revaluationTiming(renewalAt, r.notice_deadline ? new Date(r.notice_deadline as string) : null, now);
  if (!timing.ready) {
    await setRow(r.id, { migration_status: 'planned', renewal_at: renewalAt?.toISOString() ?? null, evidence: { ...(r.evidence as object ?? {}), waiting: timing.reason } });
    return 'waiting';
  }

  // ── Échéancier de revalorisation (EX-020) ──
  const scheduleIdNew = scheduleId ?? (await stripe.subscriptionSchedules.create({ from_subscription: sub.id }, { idempotencyKey: `vb-reval:${r.id}:create` })).id;
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleIdNew);
  const current = schedule.phases.find((ph) => ph.start_date === schedule.current_phase?.start_date) ?? schedule.phases[0];
  if (!current || schedule.phases.length > 1) {
    // Structure non reconnue : on n'écrase rien (LK-56).
    if (!scheduleId) await stripe.subscriptionSchedules.release(scheduleIdNew).catch(() => undefined);
    await setRow(r.id, { migration_status: 'blocked', eligibility_reason: 'UNRECOGNIZED_SCHEDULE' });
    return 'failed';
  }
  const phases = buildRevaluationPhases(current, String(r.target_price_id), r.billing_period as BillingPeriod, {
    verebona_revaluation: String(r.revision_id),
    verebona_migration_id: String(r.id),
  });
  await stripe.subscriptionSchedules.update(scheduleIdNew, {
    end_behavior: 'release',
    proration_behavior: 'none',
    metadata: { verebona_revaluation: String(r.revision_id), verebona_migration_id: String(r.id) },
    phases,
  }, { idempotencyKey: `vb-reval:${r.id}:phases:${current.end_date}` });
  await setRow(r.id, {
    migration_status: 'scheduled', schedule_id: scheduleIdNew, renewal_at: toDate(current.end_date)?.toISOString() ?? renewalAt?.toISOString() ?? null,
    attempts: Number(r.attempts ?? 0) + 1, last_error: null,
    evidence: { ...(r.evidence as object ?? {}), scheduledAt: now.toISOString(), scheduleId: scheduleIdNew },
  });
  return 'scheduled';
}

/**
 * Une opération VOLONTAIRE (montée en gamme, changement programmé, changement
 * admin) remplace une revalorisation devenue obsolète (EX-024, RX-13) :
 * l'échéancier de revalorisation est libéré, la ligne annulée.
 */
export async function supersedeRevaluation(subscriptionId: string, reason: string, stripe?: Stripe): Promise<number> {
  const rows = await q(
    `SELECT id, schedule_id, migration_status FROM stripe_price_migrations
      WHERE stripe_subscription_id = $1 AND migration_status IN ('planned', 'deferred', 'retryable', 'scheduled')`,
    [subscriptionId],
  ).catch(() => []);
  for (const r of rows) {
    if (r.migration_status === 'scheduled' && r.schedule_id) {
      const s = stripe ?? getStripeServer();
      const schedule = await s.subscriptionSchedules.retrieve(String(r.schedule_id)).catch(() => null);
      if (schedule && schedule.status === 'active' && schedule.metadata?.verebona_migration_id === String(r.id)) {
        await s.subscriptionSchedules.release(String(r.schedule_id));
      }
    }
    await setRow(r.id, { migration_status: 'canceled', eligibility_reason: reason, schedule_id: null });
  }
  return rows.length;
}

/** L'échéancier attaché est-il une revalorisation Verebona ? */
export function isRevaluationSchedule(schedule: Pick<Stripe.SubscriptionSchedule, 'metadata'> | null | undefined): boolean {
  return Boolean(schedule?.metadata?.verebona_revaluation);
}

/** Retour arrière : la campagne de la révision abandonnée est annulée (lignes non effectives). */
export async function cancelCampaign(revisionId: string, reason: string): Promise<number> {
  if (!revisionId) return 0;
  const rows = await q(`SELECT DISTINCT stripe_subscription_id FROM stripe_price_migrations WHERE revision_id = $1 AND migration_status IN ('planned','deferred','retryable','scheduled')`, [revisionId]).catch(() => []);
  let n = 0;
  for (const r of rows) n += await supersedeRevaluation(String(r.stripe_subscription_id), reason);
  return n;
}

/** Constat immédiat après synchronisation d'un abonnement (webhook). */
export async function reconcileRevaluationFromSubscription(sub: Pick<Stripe.Subscription, 'id' | 'items'>): Promise<void> {
  const prices = new Set(sub.items.data.map((i) => i.price.id));
  const rows = await q(`SELECT id, target_price_id FROM stripe_price_migrations WHERE stripe_subscription_id = $1 AND migration_status IN ('scheduled','planned','retryable')`, [sub.id]).catch(() => []);
  for (const r of rows) {
    if (prices.has(String(r.target_price_id))) await setRow(r.id, { migration_status: 'completed', evidence: { completedBy: 'webhook', at: new Date().toISOString() } });
  }
}

/** Revalorisation confirmée à venir pour un abonnement (affichage compte, LK-113). */
export async function confirmedRevaluationFor(subscriptionId: string | null | undefined): Promise<{ amountCents: number; effectiveAt: string | null; billingPeriod: BillingPeriod } | null> {
  if (!subscriptionId) return null;
  const [r] = await q(`SELECT target_amount_cents, renewal_at, billing_period FROM stripe_price_migrations WHERE stripe_subscription_id = $1 AND migration_status = 'scheduled' ORDER BY id DESC LIMIT 1`, [subscriptionId]).catch(() => []);
  if (!r) return null;
  return { amountCents: Number(r.target_amount_cents), effectiveAt: r.renewal_at ? new Date(r.renewal_at as string).toISOString() : null, billingPeriod: r.billing_period as BillingPeriod };
}
