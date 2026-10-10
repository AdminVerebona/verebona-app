/**
 * Diagnostic du catalogue Stripe pour le BO (Exploitation › Catalogue
 * Stripe) — CDC lookup_key V4 LK-64, LK-83, LK-92, LK-93, LK-112, EX-039.
 *
 * Lecture seule : contexte Stripe, six clés, prix résolus et montants,
 * statut de validation, dates, version, portail, état de publication,
 * journal, registre historique, produits approuvés, santé des prix des
 * abonnés (« prix courant », « historique reconnu », « inconnu » — un ancien
 * abonnement n'est PAS défectueux parce qu'il n'utilise plus le prix public),
 * anomalies ouvertes, campagne de revalorisation, variables historiques
 * encore présentes (retrait D10). Aucun secret, aucun montant modifiable.
 */
import { pgClient } from '@/db';
import { CATALOG_COUPLES, coupleKey } from '@/lib/billing/plan-catalog';
import { getStripeKeyMode, getExpectedStripeMode } from '@/lib/stripe-client';
import { catalogDeps, STALE_AFTER_MS } from './price-catalog.service';
import { PRICING_MANIFEST, manifestRevision } from './pricing-manifest';
import { shouldAutoPublish } from './catalog-publication.service';
import { LEGACY_PRICE_VARS } from './legacy-price-env';
import { listCampaign } from './price-revaluation.service';

type Row = Record<string, unknown>;
async function q<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pgClient.unsafe(text, params as never[]).catch(() => [])) as unknown as T[];
}

export async function getCatalogDiagnostic() {
  const d = catalogDeps();
  const ctx = d.context();
  const state = ctx.mode ? await d.store.getState(ctx.catalogContext).catch(() => null) : null;
  const candidate = manifestRevision();
  const now = d.now();
  const active = state?.activeSnapshot ?? null;

  const couples = CATALOG_COUPLES.map((c) => {
    const key = coupleKey(c.planCode, c.billingPeriod);
    const e = active?.entries[key] ?? null;
    const target = PRICING_MANIFEST[c.planCode][c.billingPeriod];
    const status = !e
      ? 'unavailable'
      : e.unitAmountCents === target.unitAmountCents && e.taxBehavior === target.taxBehavior
        ? 'ok'
        : state?.publishedManifestRevision === candidate ? 'drift' : 'pending_publication';
    return {
      lookupKey: c.lookupKey,
      planCode: c.planCode,
      billingPeriod: c.billingPeriod,
      priceId: e?.priceId ?? null,
      productId: e?.productId ?? null,
      unitAmountCents: e?.unitAmountCents ?? null,
      taxBehavior: e?.taxBehavior ?? null,
      priceRevision: e?.priceRevision ?? null,
      verifiedAt: e?.verifiedAt ?? null,
      unavailableReason: active?.unavailable?.[key] ?? null,
      manifestAmountCents: target.unitAmountCents,
      status,
    };
  });

  const versions = ctx.mode ? await d.store.listPriceVersions(ctx.catalogContext).catch(() => []) : [];
  const products = ctx.mode ? await d.store.listApprovedProducts(ctx.catalogContext).catch(() => []) : [];
  const runs = ctx.mode ? await d.store.listRuns(ctx.catalogContext, 15).catch(() => []) : [];
  const currentIds = new Set(Object.values(active?.entries ?? {}).map((e) => e?.priceId));
  const knownIds = new Set(versions.map((v) => v.stripePriceId));

  const subRows = await q<{ stripe_price_id: string | null; n: number }>(
    `SELECT stripe_price_id, count(*)::int AS n FROM account_subscriptions
      WHERE stripe_subscription_id IS NOT NULL AND status IN ('active','past_due') GROUP BY stripe_price_id`,
  );
  const subscriptions = { current: 0, historical: 0, unknown: 0, notYetSynced: 0 };
  for (const r of subRows) {
    if (!r.stripe_price_id) subscriptions.notYetSynced += Number(r.n);
    else if (currentIds.has(r.stripe_price_id)) subscriptions.current += Number(r.n);
    else if (knownIds.has(r.stripe_price_id)) subscriptions.historical += Number(r.n);
    else subscriptions.unknown += Number(r.n);
  }

  const anomalies = await q<{ id: number; title: string; fingerprint: string; last_seen_at: string; occurrence_count: number }>(
    `SELECT id, title, fingerprint, last_seen_at, occurrence_count FROM admin_anomalies
      WHERE status = 'open' AND domain = 'stripe'
        AND (fingerprint LIKE 'stripe:catalog:%' OR fingerprint LIKE 'stripe:unknown-price:%' OR fingerprint LIKE 'stripe:revaluation%')
      ORDER BY last_seen_at DESC LIMIT 50`,
  );

  const legacyVars = LEGACY_PRICE_VARS.map((v) => ({ name: v.name, present: Boolean(process.env[v.name]?.trim()) }));
  const campaign = ctx.mode ? await listCampaign(null, 200).catch(() => ({ revisionId: null, counts: {}, rows: [] })) : { revisionId: null, counts: {}, rows: [] };

  return {
    context: {
      catalogContext: ctx.catalogContext,
      keyMode: getStripeKeyMode(process.env.STRIPE_SECRET_KEY),
      expectedMode: getExpectedStripeMode(),
      appEnv: ctx.appEnv,
      stripeAccountId: state?.stripeAccountId ?? null,
    },
    state: state ? {
      activeRevision: state.activeRevision,
      verifiedAt: state.verifiedAt?.toISOString() ?? null,
      stale: !state.verifiedAt || now.getTime() - state.verifiedAt.getTime() > STALE_AFTER_MS,
      generation: state.generation,
      publicationState: state.publicationState,
      publicationError: state.publicationError,
      publishedManifestRevision: state.publishedManifestRevision,
      previousRevision: state.previousRevision,
      portal: { configurationId: state.portalConfigurationId, verifiedAt: state.portalVerifiedAt?.toISOString() ?? null },
      backfillCompletedAt: state.backfillCompletedAt?.toISOString() ?? null,
      lastSyncError: state.lastSyncError,
    } : null,
    manifest: { revision: candidate, autoPublish: shouldAutoPublish(state, candidate, now) },
    couples,
    previous: state?.previousSnapshot
      ? CATALOG_COUPLES.map((c) => {
        const e = state.previousSnapshot!.entries[coupleKey(c.planCode, c.billingPeriod)];
        return { lookupKey: c.lookupKey, priceId: e?.priceId ?? null, unitAmountCents: e?.unitAmountCents ?? null };
      })
      : null,
    subscriptions,
    versions: versions.map((v) => ({
      priceId: v.stripePriceId, productId: v.stripeProductId, planCode: v.planCode, billingPeriod: v.billingPeriod,
      unitAmountCents: v.unitAmountCents, taxBehavior: v.taxBehavior, stripeActive: v.stripeActive,
      observedLookupKey: v.observedLookupKey, source: v.source, current: currentIds.has(v.stripePriceId),
      firstSeenAt: v.firstSeenAt?.toISOString() ?? null, lastVerifiedAt: v.lastVerifiedAt?.toISOString() ?? null,
    })),
    products,
    runs: runs.map((r) => ({
      id: r.id, kind: r.kind, state: r.state, trigger: r.trigger, actor: r.actor, fromRevision: r.fromRevision, toRevision: r.toRevision,
      error: r.error, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
      transfers: r.transfers, createdPrices: r.createdPrices, report: r.report,
    })),
    anomalies,
    legacyVars,
    /** D10 : variables retirables quand la reprise est terminée et aucun abonné n'est inconnu. */
    legacyVarsRemovable: Boolean(state?.backfillCompletedAt) && subscriptions.unknown === 0,
    campaign,
  };
}
