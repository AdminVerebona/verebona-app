/**
 * Reprise historique AUTOMATIQUE — CDC lookup_key V4 §16.2, LK-82, LK-83,
 * LK-58, D1/D3, TC-15 à TC-17, TC-51, TC-52.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE COMMANDE À LANCER
 *
 * Exécutée par la tâche planifiée `stripe-catalog-sync` tant qu'elle n'a pas
 * abouti (puis relançable depuis le BO › Exploitation › Catalogue Stripe).
 * Idempotente, sans aucune hausse d'abonnement :
 *
 *   1. synchronise le catalogue (produits de vente approuvés, révision
 *      active, clés stables initialisées sur les prix V2 configurés si elles
 *      manquaient) ;
 *   2. inventorie TOUTES les références de prix : neuf variables historiques,
 *      `subscription_plans`, abonnements locaux, factures, abonnements Stripe
 *      (pagination) et phases d'échéancier ;
 *   3. reconnaît chaque Price (registre, puis Stripe même inactif, produit
 *      approuvé ou preuve de transition) et l'inscrit au registre ;
 *   4. enrichit le prix contractuel des abonnements depuis l'objet Stripe et
 *      la cible EXACTE des changements programmés depuis la phase future
 *      réellement enregistrée — absente, multiple ou contradictoire : dossier
 *      bloqué et signalé, jamais remplacé par le prix public (LK-58) ;
 *   5. produit un bilan (références, reconnus, contrats et programmations
 *      enrichis, anomalies bloquantes). Un ancien montant inconnu n'est JAMAIS
 *      deviné à partir de l'offre actuelle du compte.
 *
 * « Terminée » (condition de la publication automatique, D3 avant D7) quand
 * aucune référence portée par un abonné Verebona n'est inconnue. Les
 * abonnements Stripe sans compte Verebona (autres produits) sont ignorés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { pgClient } from '@/db';
import { getStripeServer, getStripeCatalogContext } from '@/lib/stripe-client';
import { legacyPriceRefs } from './legacy-price-env';
import { primaryItem, resolveHistoricalPrice } from './price-history.service';
import { catalogDeps, catalogFingerprint, refreshCatalog, type CatalogDeps } from './price-catalog.service';

type Row = Record<string, unknown>;
async function q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pgClient.unsafe(text, params as never[])) as unknown as T[];
}
const idOf = (v: string | { id: string } | null | undefined): string | null => (!v ? null : typeof v === 'string' ? v : v.id);
const toIso = (unix: number | null | undefined) => (typeof unix === 'number' && unix > 0 ? new Date(unix * 1000).toISOString() : null);

export interface BackfillReport {
  references: number;
  recognized: number;
  unknown: string[];
  inconsistent: string[];
  unavailable: string[];
  contractsEnriched: number;
  schedulesEnriched: number;
  schedulesBlocked: number;
  multiItemSubscriptions: string[];
  foreignSubscriptions: number;
  blocking: number;
  completed: boolean;
}

export async function runPriceBackfill(
  opts: { trigger: string; actor?: string | null; deadline?: number; stripe?: Stripe },
  d: CatalogDeps = catalogDeps(),
): Promise<BackfillReport | { skipped: string }> {
  const ctx = getStripeCatalogContext();
  if (!ctx.mode) return { skipped: 'NO_STRIPE_KEY' };
  const runId = await d.store.createRun({ context: ctx.catalogContext, kind: 'backfill', state: 'VALIDATING', trigger: opts.trigger, actor: opts.actor ?? null });
  const report: BackfillReport = {
    references: 0, recognized: 0, unknown: [], inconsistent: [], unavailable: [], contractsEnriched: 0,
    schedulesEnriched: 0, schedulesBlocked: 0, multiItemSubscriptions: [], foreignSubscriptions: 0, blocking: 0, completed: false,
  };
  try {
    await refreshCatalog({ source: 'backfill' }, d);
    const stripe = opts.stripe ?? getStripeServer();

    // ── Inventaire des références ──
    const refs = new Map<string, { localSubscriber: boolean }>();
    const add = (id: string | null | undefined, localSubscriber = false) => {
      if (!id) return;
      const cur = refs.get(id);
      refs.set(id, { localSubscriber: Boolean(cur?.localSubscriber || localSubscriber) });
    };
    for (const r of legacyPriceRefs(d.env)) add(r.priceId);
    for (const r of await q<{ a: string | null; b: string | null; c: string | null }>(
      `SELECT stripe_price_id AS a, stripe_price_id_monthly AS b, stripe_price_id_yearly AS c FROM subscription_plans`,
    ).catch(() => [])) { add(r.a); add(r.b); add(r.c); }
    for (const r of await q<{ id: string }>(`SELECT DISTINCT stripe_price_id AS id FROM account_subscriptions WHERE stripe_price_id IS NOT NULL`).catch(() => [])) add(r.id, true);
    for (const r of await q<{ id: string }>(`SELECT DISTINCT stripe_price_id AS id FROM invoices WHERE stripe_price_id IS NOT NULL`).catch(() => [])) add(r.id);

    const localSubs = new Map<string, { accountId: number; scheduledPlan: string | null; scheduledPeriod: string | null; scheduledPrice: string | null }>();
    for (const r of await q<{ account_id: number; stripe_subscription_id: string; scheduled_plan_code: string | null; scheduled_billing_period: string | null; scheduled_stripe_price_id: string | null }>(
      `SELECT account_id, stripe_subscription_id, scheduled_plan_code, scheduled_billing_period, scheduled_stripe_price_id
         FROM account_subscriptions WHERE stripe_subscription_id IS NOT NULL`,
    )) {
      localSubs.set(r.stripe_subscription_id, { accountId: r.account_id, scheduledPlan: r.scheduled_plan_code, scheduledPeriod: r.scheduled_billing_period, scheduledPrice: r.scheduled_stripe_price_id });
    }

    const subs: Stripe.Subscription[] = [];
    for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
      if (opts.deadline && Date.now() > opts.deadline) break;
      subs.push(s);
      for (const it of s.items.data) add(it.price?.id, localSubs.has(s.id));
    }

    // ── Reconnaissance ──
    for (const [priceId, meta] of refs) {
      report.references++;
      const r = await resolveHistoricalPrice(priceId, { source: 'backfill' });
      if (r.status === 'recognized') { report.recognized++; continue; }
      const bucket = r.status === 'unknown' ? report.unknown : r.status === 'inconsistent' ? report.inconsistent : report.unavailable;
      bucket.push(priceId);
      if (meta.localSubscriber || r.status === 'unavailable') report.blocking++;
    }

    // ── Prix contractuel des abonnements locaux (LK-19) ──
    for (const s of subs) {
      const local = localSubs.get(s.id);
      if (!local) { report.foreignSubscriptions++; continue; }
      const primary = await primaryItem(s, 'backfill');
      if ('error' in primary) {
        if (primary.error === 'MULTIPLE') report.multiItemSubscriptions.push(s.id);
        continue;
      }
      const { item } = primary;
      await q(
        `UPDATE account_subscriptions SET
           stripe_subscription_item_id = $2, stripe_price_id = $3, stripe_product_id = $4,
           contract_unit_amount_cents = $5, contract_currency = $6, contract_quantity = $7,
           contract_interval = $8, contract_tax_behavior = $9, contract_verified_at = now(), updated_at = now()
         WHERE account_id = $1 AND stripe_subscription_id = $10`,
        [local.accountId, item.id, item.price.id, idOf(item.price.product as string | { id: string }), item.price.unit_amount ?? null,
          (item.price.currency ?? 'eur').toLowerCase(), item.quantity ?? 1, item.price.recurring?.interval ?? null,
          item.price.tax_behavior ?? 'unspecified', s.id],
      );
      report.contractsEnriched++;

      // ── Cible exacte d'une programmation (LK-58) ──
      if (local.scheduledPlan && !local.scheduledPrice) {
        const outcome = await enrichScheduledTarget(stripe, s, local);
        if (outcome === 'enriched') report.schedulesEnriched++;
        else {
          report.schedulesBlocked++;
          await d.anomalies.report({
            fingerprint: catalogFingerprint(ctx.catalogContext, 'scheduled', s.id),
            title: `Changement programmé non rapprochable (${outcome}) : conversion automatique bloquée`,
            detail: { subscriptionId: s.id, accountId: local.accountId, outcome },
          }).catch(() => undefined);
        }
      }
    }

    report.completed = report.blocking === 0;
    if (report.completed) {
      await d.store.setBackfillCompleted(ctx.catalogContext, d.now());
      await d.anomalies.resolve(catalogFingerprint(ctx.catalogContext, 'backfill')).catch(() => undefined);
    } else {
      await d.anomalies.report({
        fingerprint: catalogFingerprint(ctx.catalogContext, 'backfill'),
        title: `Reprise historique : ${report.blocking} référence(s) de prix d'abonnés non rapprochée(s)`,
        detail: { unknown: report.unknown.slice(0, 20), inconsistent: report.inconsistent.slice(0, 20), unavailable: report.unavailable.slice(0, 20) },
      }).catch(() => undefined);
    }
    await d.store.updateRun(runId, { state: 'DONE', report: report as unknown as Record<string, unknown>, finished: true });
    console.info(JSON.stringify({ evt: 'billing.catalog.backfill', context: ctx.catalogContext, ...report, unknown: report.unknown.length }));
    return report;
  } catch (e) {
    await d.store.updateRun(runId, { state: 'FAILED', error: (e as Error).message, report: report as unknown as Record<string, unknown>, finished: true });
    throw e;
  }
}

/**
 * Lit la phase future Stripe d'une programmation existante. Exactement une
 * phase future à un item, d'offre et de périodicité conformes à l'intention
 * locale → cible inscrite ; sinon `blocked` (TC-51, TC-52).
 */
async function enrichScheduledTarget(
  stripe: Stripe,
  sub: Stripe.Subscription,
  local: { accountId: number; scheduledPlan: string | null; scheduledPeriod: string | null },
): Promise<'enriched' | 'NO_SCHEDULE' | 'AMBIGUOUS_PHASES' | 'UNKNOWN_TARGET' | 'TARGET_MISMATCH'> {
  const scheduleId = idOf(sub.schedule as string | { id: string } | null);
  if (!scheduleId) {
    await q(`UPDATE account_subscriptions SET scheduled_change_state = 'blocked', updated_at = now() WHERE account_id = $1`, [local.accountId]);
    return 'NO_SCHEDULE';
  }
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  const currentStart = schedule.current_phase?.start_date ?? 0;
  const future = schedule.phases.filter((p) => p.start_date > currentStart);
  if (future.length !== 1 || future[0].items.length !== 1) {
    await q(`UPDATE account_subscriptions SET scheduled_change_state = 'blocked', scheduled_schedule_id = $2, updated_at = now() WHERE account_id = $1`, [local.accountId, scheduleId]);
    return 'AMBIGUOUS_PHASES';
  }
  const priceId = idOf(future[0].items[0].price as string | { id: string });
  const r = await resolveHistoricalPrice(priceId, { source: 'backfill:schedule' });
  if (r.status !== 'recognized') {
    await q(`UPDATE account_subscriptions SET scheduled_change_state = 'blocked', scheduled_schedule_id = $2, updated_at = now() WHERE account_id = $1`, [local.accountId, scheduleId]);
    return 'UNKNOWN_TARGET';
  }
  if (r.planCode !== local.scheduledPlan || r.billingPeriod !== local.scheduledPeriod) {
    await q(`UPDATE account_subscriptions SET scheduled_change_state = 'blocked', scheduled_schedule_id = $2, updated_at = now() WHERE account_id = $1`, [local.accountId, scheduleId]);
    return 'TARGET_MISMATCH';
  }
  await q(
    `UPDATE account_subscriptions SET scheduled_stripe_price_id = $2, scheduled_unit_amount_cents = $3, scheduled_currency = $4,
       scheduled_schedule_id = $5, scheduled_change_at = COALESCE($6::timestamptz, scheduled_change_at), scheduled_change_state = NULL, updated_at = now()
     WHERE account_id = $1`,
    [local.accountId, priceId, r.unitAmountCents, r.currency, scheduleId, toIso(future[0].start_date)],
  );
  return 'enriched';
}
