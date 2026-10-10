/**
 * Publication contrôlée de la grille du code, reprise et retour arrière —
 * CDC lookup_key V4 §16.3, §16.4, §19, LK-26, LK-27, LK-79 à LK-87, LK-99,
 * LK-100, LK-102 à LK-105, EX-007 à EX-015.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SÉQUENCE (une seule exécution à la fois, verrou partagé à bail)
 *
 *  1. préflight : clé et mode, contexte, révision active, produits de vente
 *     approuvés, manifeste valide, aucun échec antérieur non traité ;
 *  2. manifeste de différences : un couple inchangé garde son Price ; un
 *     couple modifié reçoit un NOUVEAU Price immuable (EX-008) ;
 *  3. création des candidats SANS clé, clé d'idempotence stable par
 *     contexte/révision/couple, identifiant journalisé avant toute suite
 *     (EX-009) ; une relance retrouve le candidat (métadonnées) au lieu d'en
 *     créer un second (TC-72, TC-83) ;
 *  4. validation des candidats ;
 *  5. transferts de clé (`transfer_lookup_key`), un par un, chacun journalisé
 *     avant / après (LK-86). Pendant ce temps la VENTE continue sur les
 *     identifiants de la révision active en base (EX-010, EX-011) ;
 *  6. relecture des six clés, portail validé avec l'union ancienne+nouvelle
 *     révision, puis activation atomique en base (photographie, registre,
 *     miroirs) et portail réduit à la nouvelle révision (EX-012) ;
 *  7. campagne de revalorisation créée (opération DISTINCTE, EX-016, EX-028)
 *     et sondes de cohérence (EX-013).
 *
 * Un échec à n'importe quelle étape laisse l'ANCIENNE révision active et
 * vendue sur toutes les surfaces (LK-104, LK-105, TC-84) ; l'état passe
 * FAILED et la tâche automatique ne relance plus rien : la reprise (même
 * séquence, reprise au dernier point confirmé, EX-014) ou le retour arrière
 * sont décidés dans le BO (LK-27 : pas de dégel automatique sur échec).
 *
 * Aucun processus de démarrage ne crée ni ne transfère un Price (EX-006) :
 * seule la tâche planifiée `stripe-catalog-publish` (bail partagé) ou une
 * action BO explicite y parviennent.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import {
  CATALOG_COUPLES,
  coupleKey,
  type CatalogCouple,
  type PlanCode,
} from '@/lib/billing/plan-catalog';
import {
  catalogVersionOf,
  groupByLookupKey,
  validateSalePrice,
  type CatalogSnapshot,
  type ResolvedPrice,
} from './catalog-types';
import type { CatalogStateRow, PriceVersionRow } from './catalog-store';
import {
  catalogDeps,
  catalogFingerprint,
  forgetCatalogMemory,
  listKeyedPrices,
  refreshCatalog,
  resolveCurrentPrice,
  type CatalogDeps,
} from './price-catalog.service';
import { versionRowFrom } from './price-history.service';
import { PLAN_PRODUCT_DEFINITIONS, PRICING_MANIFEST, manifestRevision, validateManifest } from './pricing-manifest';
import { syncUpgradePortal } from './portal-configuration.service';
import { getExpectedStripeMode } from '@/lib/stripe-client';

/** Écritures Stripe : mode attendu explicite exigé (LK-88). */
function expectedModeIssue(d: CatalogDeps): string | null {
  const expected = getExpectedStripeMode(d.env);
  if (!expected) return 'EXPECTED_MODE_MISSING';
  if (d.context().mode !== expected) return 'MODE_MISMATCH';
  return null;
}

type Manifest = typeof PRICING_MANIFEST;

export interface DiffEntry {
  lookupKey: string;
  planCode: PlanCode;
  billingPeriod: 'monthly' | 'yearly';
  action: 'keep' | 'create';
  currentPriceId: string | null;
  currentAmountCents: number | null;
  targetAmountCents: number;
  targetTaxBehavior: 'inclusive';
}

/** Manifeste de différences (pur, EX-008). */
export function diffManifest(manifest: Manifest, snapshot: CatalogSnapshot | null): DiffEntry[] {
  return CATALOG_COUPLES.map((c) => {
    const target = manifest[c.planCode][c.billingPeriod];
    const cur = snapshot?.entries[coupleKey(c.planCode, c.billingPeriod)] ?? null;
    const same = cur && cur.unitAmountCents === target.unitAmountCents && cur.taxBehavior === target.taxBehavior && cur.currency === target.currency;
    return {
      lookupKey: c.lookupKey,
      planCode: c.planCode,
      billingPeriod: c.billingPeriod,
      action: same ? 'keep' : 'create',
      currentPriceId: cur?.priceId ?? null,
      currentAmountCents: cur?.unitAmountCents ?? null,
      targetAmountCents: target.unitAmountCents,
      targetTaxBehavior: target.taxBehavior,
    };
  });
}

/** Délai laissé à toutes les instances pour exécuter le nouveau code avant une publication automatique (LK-97). */
export const AUTO_PUBLISH_DELAY_MS = 20 * 60_000;

/**
 * Publication AUTOMATIQUE permise ? (LK-102, LK-97, D3 avant D7, LK-27). Pure.
 *   - manifeste du code différent du dernier publié ;
 *   - code en service depuis au moins 20 min (instances homogènes) ;
 *   - reprise historique terminée ;
 *   - révision active présente ;
 *   - aucun échec de publication non traité.
 */
export function shouldAutoPublish(state: CatalogStateRow | null, candidate: string, now: Date): { publish: boolean; reason: string } {
  if (!state?.activeSnapshot) return { publish: false, reason: 'NO_ACTIVE_REVISION' };
  if (state.publishedManifestRevision === candidate) return { publish: false, reason: 'ALREADY_PUBLISHED' };
  if (state.publicationState === 'FAILED') return { publish: false, reason: 'PREVIOUS_FAILURE' };
  if (state.publicationState !== 'ACTIVE') return { publish: false, reason: `STATE_${state.publicationState}` };
  if (state.publicationError === `ABANDONED:${candidate}`) return { publish: false, reason: 'ABANDONED' };
  if (!state.backfillCompletedAt) return { publish: false, reason: 'BACKFILL_PENDING' };
  if (state.candidateManifestRevision !== candidate || !state.candidateFirstSeenAt) return { publish: false, reason: 'CANDIDATE_NOT_SEEN' };
  if (now.getTime() - state.candidateFirstSeenAt.getTime() < AUTO_PUBLISH_DELAY_MS) return { publish: false, reason: 'WAITING_INSTANCES' };
  return { publish: true, reason: 'OK' };
}

export interface PublishOptions {
  trigger: 'auto' | 'manual' | 'resume';
  actor?: string | null;
  dryRun?: boolean;
  manifest?: Manifest;
  /** Tests : simule un incident juste avant le transfert n° N (1-based). */
  failBeforeTransfer?: number;
}

export type PublishResult =
  | { status: 'noop'; reason: string; version: string | null }
  | { status: 'simulated'; plan: DiffEntry[]; manifestRevision: string }
  | { status: 'refused'; reason: string }
  | { status: 'published'; runId: number; version: string; created: Record<string, string>; plan: DiffEntry[] }
  | { status: 'failed'; runId: number; reason: string; step: string };

/** Produit de vente de l'offre ; provisionné seulement s'il n'existe vraiment aucun produit (LK-03, LK-80). */
async function ensureSaleProduct(d: CatalogDeps, ctx: string, plan: PlanCode, livemode: boolean): Promise<{ ok: true; productId: string } | { ok: false; reason: string }> {
  const approved = await d.store.listApprovedProducts(ctx);
  const sale = approved.find((a) => a.planCode === plan && a.role === 'sale');
  if (sale) return { ok: true, productId: sale.stripeProductId };
  const stripe = d.stripe();
  const found = await stripe.products.search({ query: `metadata['verebona_plan']:'verebona_${plan}' AND active:'true'`, limit: 10 });
  if (found.data.length > 1) return { ok: false, reason: `PRODUCT_AMBIGUOUS:${plan}` };
  let productId = found.data[0]?.id ?? null;
  if (!productId) {
    const created = await stripe.products.create({
      name: PLAN_PRODUCT_DEFINITIONS[plan].name,
      description: PLAN_PRODUCT_DEFINITIONS[plan].description,
      metadata: { verebona_plan: `verebona_${plan}` },
    }, { idempotencyKey: `vb-product:${ctx}:${plan}` });
    productId = created.id;
  }
  const r = await d.store.approveProduct(ctx, { planCode: plan, stripeProductId: productId, role: 'sale', source: 'publication:provision', livemode });
  return r === 'conflict' ? { ok: false, reason: `PRODUCT_CONFLICT:${plan}` } : { ok: true, productId };
}

/** Candidat déjà créé pour cette révision et ce couple (reprise sans doublon). */
async function findExistingCandidate(stripe: Stripe, productId: string, couple: CatalogCouple, rev: string): Promise<Stripe.Price | null> {
  for await (const p of stripe.prices.list({ product: productId, active: true, limit: 100, expand: ['data.product'] })) {
    if (p.metadata?.verebona_manifest_revision === rev && p.metadata?.verebona_lookup_key === couple.lookupKey) return p;
  }
  return null;
}

/**
 * Publie la grille du code (voir l'en-tête). Ne lève pas : chaque issue est
 * un résultat typé, journalisé dans `stripe_catalog_runs`.
 */
export async function publishCodeCatalog(opts: PublishOptions, d: CatalogDeps = catalogDeps()): Promise<PublishResult> {
  const ctx = d.context();
  if (!ctx.mode) return { status: 'refused', reason: 'NO_STRIPE_KEY' };
  const modeIssue = expectedModeIssue(d);
  if (modeIssue && !opts.dryRun) return { status: 'refused', reason: modeIssue };
  const manifest = opts.manifest ?? PRICING_MANIFEST;
  const issues = validateManifest(manifest);
  if (issues.length) return { status: 'refused', reason: `MANIFEST_INVALID: ${issues.join('; ')}` };

  const locked = await d.lock(`stripe-catalog-publication:${ctx.catalogContext}`, 15 * 60_000, () => doPublish(opts, manifest, d));
  return locked ?? { status: 'refused', reason: 'LOCKED' };
}

async function doPublish(opts: PublishOptions, manifest: Manifest, d: CatalogDeps): Promise<PublishResult> {
  const ctx = d.context();
  const context = ctx.catalogContext;
  const livemode = ctx.mode === 'live';
  let state = await d.store.ensureState(context);
  // Échec ou exécution interrompue (processus tué, état resté intermédiaire) :
  // seule une REPRISE explicite repart (LK-27) — jamais une publication neuve.
  if (state.publicationState !== 'ACTIVE' && opts.trigger !== 'resume') return { status: 'refused', reason: state.publicationState === 'FAILED' ? 'PREVIOUS_FAILURE' : `INTERRUPTED_${state.publicationState}` };
  if (!state.activeSnapshot) {
    await refreshCatalog({ source: 'publication-preflight' }, d);
    state = await d.store.ensureState(context);
    if (!state.activeSnapshot) return { status: 'refused', reason: 'NO_ACTIVE_REVISION' };
  }
  const rev = manifestRevision(manifest);
  const plan = diffManifest(manifest, state.activeSnapshot);
  const toCreate = plan.filter((p) => p.action === 'create');

  if (toCreate.length === 0) {
    if (state.publishedManifestRevision !== rev && !opts.dryRun) {
      await d.store.activateSnapshot({
        context, stripeAccountId: state.stripeAccountId, livemode, snapshot: state.activeSnapshot,
        keepPrevious: false, publishedManifestRevision: rev, versions: [], publicationState: 'ACTIVE',
      });
    }
    return { status: 'noop', reason: 'NO_DIFFERENCE', version: state.activeRevision };
  }
  if (opts.dryRun) return { status: 'simulated', plan, manifestRevision: rev };

  const runId = await d.store.createRun({ context, kind: 'publish', state: 'PREPARED', trigger: opts.trigger, actor: opts.actor ?? null, manifestRevision: rev, fromRevision: state.activeRevision });
  const step = (name: string, detail: Record<string, unknown> = {}) => d.store.updateRun(runId, { step: { step: name, ...detail } });
  const fail = async (stepName: string, reason: string): Promise<PublishResult> => {
    await d.store.setPublication(context, { state: 'FAILED', runId, error: `${stepName}: ${reason}`.slice(0, 500), activatingUntil: null });
    await d.store.updateRun(runId, { state: 'FAILED', error: `${stepName}: ${reason}`.slice(0, 1000), finished: true, step: { step: stepName, failed: true, reason } });
    forgetCatalogMemory();
    await d.anomalies.report({
      fingerprint: catalogFingerprint(context, 'publication'),
      title: `Catalogue Stripe : publication en échec (${stepName}) — ancienne grille conservée`,
      detail: { runId, step: stepName, reason },
    }).catch(() => undefined);
    console.error(JSON.stringify({ evt: 'billing.catalog.publication_failed', context, runId, step: stepName, reason }));
    return { status: 'failed', runId, reason, step: stepName };
  };

  try {
    await d.store.setPublication(context, { state: opts.trigger === 'resume' ? 'RECOVERING' : 'VALIDATING', runId, error: null });
    await step('preflight', { plan, trigger: opts.trigger });
    const stripe = d.stripe();

    // ── 3. Candidats ──
    const created: Record<string, string> = {};
    const candidates = new Map<string, ResolvedPrice>();
    for (const p of toCreate) {
      const couple = CATALOG_COUPLES.find((c) => c.lookupKey === p.lookupKey)!;
      const product = await ensureSaleProduct(d, context, couple.planCode, livemode);
      if (!product.ok) return await fail('products', product.reason);
      let price = await findExistingCandidate(stripe, product.productId, couple, rev);
      if (!price) {
        price = await stripe.prices.create({
          product: product.productId,
          currency: 'eur',
          unit_amount: p.targetAmountCents,
          recurring: { interval: couple.interval, interval_count: 1 },
          tax_behavior: 'inclusive',
          nickname: `${PLAN_PRODUCT_DEFINITIONS[couple.planCode].name} ${couple.billingPeriod === 'monthly' ? 'mensuel' : 'annuel'} (${rev})`,
          metadata: {
            verebona_plan: couple.planCode,
            verebona_period: couple.billingPeriod,
            verebona_lookup_key: couple.lookupKey,
            verebona_manifest_revision: rev,
          },
          expand: ['product'],
        }, { idempotencyKey: `vb-price:${context}:${rev}:${couple.lookupKey}` });
      }
      created[couple.lookupKey] = price.id;
      // Journal durable AVANT toute étape suivante (EX-009).
      await d.store.updateRun(runId, { createdPrices: { ...created }, step: { step: 'candidate', lookupKey: couple.lookupKey, priceId: price.id } });
      const check = validateSalePrice(price, couple, { livemode, saleProductId: product.productId, checkLookupKey: false, verifiedAt: d.now().toISOString() });
      if (!check.ok) return await fail('validate-candidate', `${couple.lookupKey}: ${check.code} ${check.detail}`);
      candidates.set(couple.lookupKey, check.resolved);
    }

    // ── 5. Transferts de clés (fenêtre verrouillée, vente sur la révision active) ──
    await d.store.setPublication(context, { state: 'PUBLISHING', runId, error: null });
    await d.store.updateRun(runId, { state: 'PUBLISHING' });
    const transfers: Array<Record<string, unknown>> = [];
    let n = 0;
    for (const p of toCreate) {
      n++;
      const candidate = candidates.get(p.lookupKey)!;
      if (opts.failBeforeTransfer === n) return await fail('transfer', `incident simulé avant le transfert ${n}`);
      const record: Record<string, unknown> = { lookupKey: p.lookupKey, from: p.currentPriceId, to: candidate.priceId, at: d.now().toISOString() };
      try {
        await stripe.prices.update(candidate.priceId, { lookup_key: p.lookupKey, transfer_lookup_key: true });
        transfers.push({ ...record, ok: true });
        await d.store.updateRun(runId, { transfers: [...transfers] });
      } catch (e) {
        transfers.push({ ...record, ok: false, error: (e as Error).message });
        await d.store.updateRun(runId, { transfers: [...transfers] });
        return await fail('transfer', `${p.lookupKey}: ${(e as Error).message}`);
      }
    }

    // ── 6. Relecture complète des six clés ──
    const reread = groupByLookupKey(await listKeyedPrices(stripe));
    const entries: CatalogSnapshot['entries'] = {};
    const versions: PriceVersionRow[] = [];
    const nowIso = d.now().toISOString();
    for (const couple of CATALOG_COUPLES) {
      const key = coupleKey(couple.planCode, couple.billingPeriod);
      const expectedId = created[couple.lookupKey] ?? state.activeSnapshot.entries[key]?.priceId ?? null;
      const found = reread.get(couple.lookupKey) ?? [];
      if (!expectedId) continue; // couple déjà indisponible et hors manifeste
      if (found.length !== 1 || found[0].id !== expectedId) {
        return await fail('reread', `${couple.lookupKey}: attendu ${expectedId}, trouvé ${found.map((f) => f.id).join(',') || '∅'}`);
      }
      const saleProduct = candidates.get(couple.lookupKey)?.productId ?? state.activeSnapshot.entries[key]?.productId ?? null;
      const check = validateSalePrice(found[0], couple, { livemode, saleProductId: saleProduct, verifiedAt: nowIso });
      if (!check.ok) return await fail('reread', `${couple.lookupKey}: ${check.code}`);
      entries[key] = check.resolved;
      versions.push(versionRowFrom(found[0], couple.planCode, couple.billingPeriod, ctx, 'publication', state.stripeAccountId));
    }
    const snapshot: CatalogSnapshot = { version: catalogVersionOf(entries), verifiedAt: nowIso, entries, unavailable: {}, source: 'publish' };
    await step('reread', { version: snapshot.version });

    // Portail : union ancienne + nouvelle révision, validée AVANT activation.
    const oldEntries = Object.values(state.activeSnapshot.entries).filter(Boolean) as ResolvedPrice[];
    await syncUpgradePortal({ reason: `publication:${runId}`, snapshot, persist: false, extraPrices: oldEntries.map((e) => ({ productId: e.productId, priceId: e.priceId })) }, d);
    await step('portal-union');

    // ── Activation (courte fenêtre BILLING_CATALOG_UPDATING) ──
    await d.store.setPublication(context, { state: 'READY', runId, error: null, activatingUntil: new Date(d.now().getTime() + 60_000) });
    await d.store.activateSnapshot({
      context, stripeAccountId: state.stripeAccountId, livemode, snapshot, keepPrevious: true,
      publishedManifestRevision: rev, versions, publicationState: 'ACTIVE', publicationRunId: runId,
    });
    forgetCatalogMemory();
    await d.store.updateRun(runId, { state: 'ACTIVE', toRevision: snapshot.version, step: { step: 'activated', version: snapshot.version } });
    await d.anomalies.resolve(catalogFingerprint(context, 'publication')).catch(() => undefined);
    console.info(JSON.stringify({ evt: 'billing.catalog.published', context, runId, from: state.activeRevision, to: snapshot.version, created }));

    // Portail réduit à la nouvelle révision (les anciens prix ne sont plus des cibles, LK-50).
    try {
      await syncUpgradePortal({ reason: `publication:${runId}:final`, force: true }, d);
    } catch (e) {
      await step('portal-final', { error: (e as Error).message });
    }

    // ── 7. Campagne de revalorisation (opération distincte) ──
    try {
      const { createRevaluationCampaign } = await import('./price-revaluation.service');
      const campaign = await createRevaluationCampaign({ revisionId: snapshot.version, previous: state.activeSnapshot, next: snapshot });
      await step('revaluation-campaign', campaign as unknown as Record<string, unknown>);
    } catch (e) {
      await step('revaluation-campaign', { error: (e as Error).message });
      await d.anomalies.report({ fingerprint: catalogFingerprint(context, 'revaluation-campaign'), title: 'Revalorisation : campagne non créée', detail: { runId, error: (e as Error).message } }).catch(() => undefined);
    }

    // ── Sondes (EX-013) ──
    const probes: Record<string, string> = {};
    for (const p of toCreate) {
      try {
        const r = await resolveCurrentPrice(p.planCode, p.billingPeriod, { forPayment: true }, d);
        probes[p.lookupKey] = r.priceId === created[p.lookupKey] ? 'ok' : `divergent:${r.priceId}`;
      } catch (e) {
        probes[p.lookupKey] = `erreur:${(e as Error).message}`;
      }
    }
    const divergent = Object.entries(probes).filter(([, v]) => v !== 'ok');
    if (divergent.length) {
      await d.anomalies.report({ fingerprint: catalogFingerprint(context, 'probe'), title: 'Catalogue Stripe : sonde de cohérence divergente après publication', detail: { runId, probes } }).catch(() => undefined);
    }
    await d.store.updateRun(runId, { report: { plan, created, transfers, probes }, finished: true, step: { step: 'probes', probes } });
    return { status: 'published', runId, version: snapshot.version, created, plan };
  } catch (error) {
    return fail('unexpected', (error as Error)?.message ?? String(error));
  }
}

export type RollbackResult =
  | { status: 'refused'; reason: string }
  | { status: 'rolled_back'; runId: number; version: string }
  | { status: 'failed'; runId: number; reason: string };

/**
 * Retour arrière COMMERCIAL (§19, EX-015) : les clés reviennent aux prix de
 * la révision précédente (réactivés si besoin), puis portail, projections et
 * caches. Ne touche AUCUNE transaction conclue : abonnements souscrits au
 * nouveau tarif, factures, phases acceptées restent intacts (LK-100, TC-74).
 */
export async function rollbackCatalog(opts: { actor?: string | null; reason?: string }, d: CatalogDeps = catalogDeps()): Promise<RollbackResult> {
  const ctx = d.context();
  if (!ctx.mode) return { status: 'refused', reason: 'NO_STRIPE_KEY' };
  const modeIssue = expectedModeIssue(d);
  if (modeIssue) return { status: 'refused', reason: modeIssue };
  const r = await d.lock(`stripe-catalog-publication:${ctx.catalogContext}`, 15 * 60_000, () => doRollback(opts, d));
  return r ?? { status: 'refused', reason: 'LOCKED' };
}

async function doRollback(opts: { actor?: string | null; reason?: string }, d: CatalogDeps): Promise<RollbackResult> {
  const ctx = d.context();
  const context = ctx.catalogContext;
  const livemode = ctx.mode === 'live';
  const state = await d.store.ensureState(context);
  const target = state.previousSnapshot;
  if (!target || !state.activeSnapshot) return { status: 'refused', reason: 'NO_PREVIOUS_REVISION' };
  const runId = await d.store.createRun({ context, kind: 'rollback', state: 'RECOVERING', trigger: 'manual', actor: opts.actor ?? null, fromRevision: state.activeRevision });
  try {
    await d.store.setPublication(context, { state: 'RECOVERING', runId, error: null });
    const stripe = d.stripe();
    const transfers: Array<Record<string, unknown>> = [];
    for (const couple of CATALOG_COUPLES) {
      const key = coupleKey(couple.planCode, couple.billingPeriod);
      const back = target.entries[key];
      const cur = state.activeSnapshot.entries[key];
      if (!back || back.priceId === cur?.priceId) continue;
      const price = await stripe.prices.retrieve(back.priceId);
      if (!price.active) await stripe.prices.update(back.priceId, { active: true });
      await stripe.prices.update(back.priceId, { lookup_key: couple.lookupKey, transfer_lookup_key: true });
      transfers.push({ lookupKey: couple.lookupKey, from: cur?.priceId ?? null, to: back.priceId, at: d.now().toISOString(), ok: true });
      await d.store.updateRun(runId, { transfers: [...transfers] });
    }
    const reread = groupByLookupKey(await listKeyedPrices(stripe));
    const entries: CatalogSnapshot['entries'] = {};
    const nowIso = d.now().toISOString();
    for (const couple of CATALOG_COUPLES) {
      const key = coupleKey(couple.planCode, couple.billingPeriod);
      const back = target.entries[key];
      if (!back) continue;
      const found = reread.get(couple.lookupKey) ?? [];
      if (found.length !== 1 || found[0].id !== back.priceId) throw new Error(`${couple.lookupKey}: relecture ${found.map((f) => f.id).join(',') || '∅'} ≠ ${back.priceId}`);
      const check = validateSalePrice(found[0], couple, { livemode, saleProductId: back.productId, verifiedAt: nowIso });
      if (!check.ok) throw new Error(`${couple.lookupKey}: ${check.code}`);
      entries[key] = check.resolved;
    }
    const snapshot: CatalogSnapshot = { version: catalogVersionOf(entries), verifiedAt: nowIso, entries, unavailable: {}, source: 'rollback' };
    await syncUpgradePortal({ reason: `rollback:${runId}`, snapshot, persist: false }, d);
    await d.store.activateSnapshot({ context, stripeAccountId: state.stripeAccountId, livemode, snapshot, keepPrevious: true, versions: [], publicationState: 'ACTIVE', publicationRunId: runId });
    forgetCatalogMemory();
    await syncUpgradePortal({ reason: `rollback:${runId}:final`, force: true }, d).catch(() => undefined);
    try {
      const { cancelCampaign } = await import('./price-revaluation.service');
      await cancelCampaign(state.activeRevision ?? '', 'ROLLBACK');
    } catch (e) {
      console.error('[catalog-publication] campagne non annulée :', (e as Error).message);
    }
    await d.store.updateRun(runId, { state: 'DONE', toRevision: snapshot.version, report: { transfers, reason: opts.reason ?? null }, finished: true });
    await d.anomalies.resolve(catalogFingerprint(context, 'publication')).catch(() => undefined);
    return { status: 'rolled_back', runId, version: snapshot.version };
  } catch (e) {
    const reason = (e as Error).message;
    await d.store.setPublication(context, { state: 'FAILED', runId, error: `rollback: ${reason}`.slice(0, 500) });
    await d.store.updateRun(runId, { state: 'FAILED', error: reason, finished: true });
    await d.anomalies.report({ fingerprint: catalogFingerprint(context, 'publication'), title: 'Catalogue Stripe : retour arrière en échec', detail: { runId, reason } }).catch(() => undefined);
    return { status: 'failed', runId, reason };
  }
}

/**
 * Abandon d'une publication en échec (décision BO, LK-99) : les clés déjà
 * transférées sont COMPENSÉES (rendues aux prix de la révision active, qui
 * n'a jamais cessé d'être vendue), la relecture le confirme, puis l'état
 * redevient ACTIVE. La publication automatique reste SUSPENDUE pour ce
 * manifeste (marqueur `ABANDONED:<révision>`) : une nouvelle tentative passe
 * par « Reprendre la publication » ou par un nouveau déploiement.
 */
export async function abandonPublication(opts: { actor?: string | null }, d: CatalogDeps = catalogDeps()): Promise<{ status: 'abandoned' | 'refused' | 'failed'; reason?: string; restored?: string[] }> {
  const ctx = d.context();
  if (!ctx.mode) return { status: 'refused', reason: 'NO_STRIPE_KEY' };
  const r = await d.lock(`stripe-catalog-publication:${ctx.catalogContext}`, 15 * 60_000, async () => {
    const context = ctx.catalogContext;
    const state = await d.store.ensureState(context);
    if (state.publicationState === 'ACTIVE') return { status: 'refused' as const, reason: 'NOT_FAILED' };
    if (!state.activeSnapshot) return { status: 'refused' as const, reason: 'NO_ACTIVE_REVISION' };
    const stripe = d.stripe();
    const restored: string[] = [];
    try {
      const keyed = groupByLookupKey(await listKeyedPrices(stripe));
      for (const couple of CATALOG_COUPLES) {
        const active = state.activeSnapshot.entries[coupleKey(couple.planCode, couple.billingPeriod)];
        if (!active) continue;
        const holder = keyed.get(couple.lookupKey)?.[0];
        if (holder?.id === active.priceId) continue;
        await stripe.prices.update(active.priceId, { lookup_key: couple.lookupKey, transfer_lookup_key: true });
        restored.push(couple.lookupKey);
      }
      const reread = groupByLookupKey(await listKeyedPrices(stripe));
      for (const couple of CATALOG_COUPLES) {
        const active = state.activeSnapshot.entries[coupleKey(couple.planCode, couple.billingPeriod)];
        if (active && reread.get(couple.lookupKey)?.[0]?.id !== active.priceId) throw new Error(`${couple.lookupKey} non restaurée`);
      }
      // Manifeste abandonné : celui de l'exécution en échec (à défaut, la candidate).
      const failedRun = state.publicationRunId ? await d.store.getRun(state.publicationRunId) : null;
      const abandoned = failedRun?.manifestRevision ?? state.candidateManifestRevision ?? '?';
      const runId = await d.store.createRun({ context, kind: 'rollback', state: 'DONE', trigger: 'abandon', actor: opts.actor ?? null, fromRevision: state.activeRevision, manifestRevision: abandoned });
      await d.store.updateRun(runId, { toRevision: state.activeRevision, report: { restored, abandonedManifest: abandoned }, finished: true });
      await d.store.setPublication(context, { state: 'ACTIVE', error: `ABANDONED:${abandoned}` });
      forgetCatalogMemory();
      await d.anomalies.resolve(catalogFingerprint(context, 'publication')).catch(() => undefined);
      return { status: 'abandoned' as const, restored };
    } catch (e) {
      return { status: 'failed' as const, reason: (e as Error).message, restored };
    }
  });
  return r ?? { status: 'refused', reason: 'LOCKED' };
}
