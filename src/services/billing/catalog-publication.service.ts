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
 *  6. relecture des six clés ; configuration du portail SAUVEGARDÉE, puis
 *     portail aligné sur EXACTEMENT les six prix candidats (un mensuel et un
 *     annuel par produit — lot 49A : l'union ancienne + nouvelle révision
 *     était refusée par Stripe, « For each product, its price must have
 *     unique billing intervals. »), relu et comparé à l'égalité stricte ;
 *     activation atomique en base (photographie, registre, miroirs) SEULEMENT
 *     après cette validation ; un échec avant activation RESTAURE (et
 *     vérifie) le portail de l'ancienne révision (EX-012) ;
 *  7. campagne de revalorisation créée (opération DISTINCTE, EX-016, EX-028)
 *     — sauf rattrapage ciblé (aucune revalorisation) — puis contrôles après
 *     activation (`verifyPublishedCatalog`, EX-013).
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
  planFromMetadataValue,
  type CatalogCouple,
  type PlanCode,
} from '@/lib/billing/plan-catalog';
import {
  catalogVersionOf,
  groupByLookupKey,
  productIdOf,
  validateSalePrice,
  type CatalogSnapshot,
  type ResolvedPrice,
} from './catalog-types';
import type { CatalogStateRow, PriceVersionRow } from './catalog-store';
import {
  buildPublicCatalog,
  catalogDeps,
  catalogFingerprint,
  forgetCatalogMemory,
  listKeyedPrices,
  refreshCatalog,
  resolveCurrentPrice,
  type CatalogDeps,
} from './price-catalog.service';
import { isStripeTransient, versionRowFrom } from './price-history.service';
import { PLAN_PRODUCT_DEFINITIONS, PRICING_MANIFEST, manifestRevision, validateManifest } from './pricing-manifest';
import {
  capturePortalConfiguration,
  portalProductsFor,
  restorePortalConfiguration,
  syncUpgradePortal,
  type PortalBackup,
} from './portal-configuration.service';
import { getExpectedStripeMode } from '@/lib/stripe-client';
import { legacyPriceRefs } from './legacy-price-env';

/**
 * Arrêt de publication (lot 49A) : `SCHEDULED_TASK_STRIPE_CATALOG_PUBLISH=off`
 * ou arrêt global des tâches. Respecté sur TOUS les chemins automatiques :
 * tâche de publication, amorçage depuis `stripe-catalog-sync` (aucun
 * contournement) et rattrapage ciblé.
 */
export function publicationStopped(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  const off = new Set(['off', 'false', '0', 'disabled', 'no']);
  if (['true', '1', 'yes', 'on'].includes((env.SCHEDULED_TASKS_DISABLED ?? '').trim().toLowerCase())) return true;
  return off.has((env.SCHEDULED_TASK_STRIPE_CATALOG_PUBLISH ?? '').trim().toLowerCase());
}

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
/** Amorçage en échec alors que rien n'est vendu : reprise automatique au plus toutes les 15 min. */
export const BOOTSTRAP_RETRY_MS = 15 * 60_000;

export interface AutoPublishDecision {
  publish: boolean;
  reason: string;
  /** Amorçage seulement : `resume` reprend une exécution en échec / interrompue. */
  trigger?: 'auto' | 'resume';
}

/** Nombre de couples vendables de la révision active. */
export function sellableCount(state: CatalogStateRow | null): number {
  return Object.values(state?.activeSnapshot?.entries ?? {}).filter(Boolean).length;
}

/**
 * PREMIÈRE PUBLICATION (amorçage, lot 36B) — pure.
 *
 * Constat préprod : prix historiques créés à la main (sans clé), variables
 * STRIPE_PRICE_* absentes ou sous d'autres noms → aucune clé initialisable →
 * révision active VIDE → « Tarif indisponible » partout ; et la publication
 * automatique attendait une reprise historique qui ne pouvait pas aboutir
 * (abonnés de test à des prix non rapprochables) : blocage définitif.
 *
 * Quand le manifeste n'a JAMAIS été publié dans ce contexte et que la
 * révision active n'est pas une grille complète vendable, la grille du code
 * est publiée sans attendre la reprise historique :
 *   - rien de vendu (0/6) : immédiatement — il n'y a ni ancienne grille à
 *     protéger, ni abonné dont le prix changerait (aucune campagne de
 *     revalorisation : elle ne vise que les couples dont un montant
 *     PRÉCÉDENT existe) ; un échec est repris automatiquement (≤ 15 min) ;
 *   - grille partielle (1 à 5/6) : après le délai d'homogénéité des
 *     instances (20 min) ; un échec reste une décision BO (LK-27).
 * Les prix historiques et les abonnements existants ne sont jamais modifiés ;
 * seuls des prix NEUFS sont créés et les clés leur sont transférées.
 * `null` : la règle normale s'applique.
 */
export function bootstrapDecision(state: CatalogStateRow | null, candidate: string, now: Date, lastRunFinishedAt: Date | null = null): AutoPublishDecision | null {
  if (state?.publishedManifestRevision) return null;
  const n = sellableCount(state);
  if (n >= CATALOG_COUPLES.length) return null;
  if (state?.publicationError === `ABANDONED:${candidate}`) return { publish: false, reason: 'ABANDONED' };
  const st = state?.publicationState ?? 'ACTIVE';
  if (st !== 'ACTIVE') {
    if (n > 0) return null;
    if (lastRunFinishedAt && now.getTime() - lastRunFinishedAt.getTime() < BOOTSTRAP_RETRY_MS) return { publish: false, reason: 'BOOTSTRAP_RETRY_WAIT' };
    return { publish: true, reason: 'BOOTSTRAP_RESUME', trigger: 'resume' };
  }
  if (n > 0) {
    if (state?.candidateManifestRevision !== candidate || !state.candidateFirstSeenAt) return { publish: false, reason: 'CANDIDATE_NOT_SEEN' };
    if (now.getTime() - state.candidateFirstSeenAt.getTime() < AUTO_PUBLISH_DELAY_MS) return { publish: false, reason: 'WAITING_INSTANCES' };
  }
  return { publish: true, reason: 'BOOTSTRAP', trigger: 'auto' };
}

/**
 * Publication AUTOMATIQUE permise ? (LK-102, LK-97, D3 avant D7, LK-27). Pure.
 * Amorçage d'abord (voir `bootstrapDecision`), sinon :
 *   - manifeste du code différent du dernier publié ;
 *   - code en service depuis au moins 20 min (instances homogènes) ;
 *   - reprise historique terminée ;
 *   - révision active présente ;
 *   - aucun échec de publication non traité.
 */
export function shouldAutoPublish(state: CatalogStateRow | null, candidate: string, now: Date, lastRunFinishedAt: Date | null = null): AutoPublishDecision {
  const boot = bootstrapDecision(state, candidate, now, lastRunFinishedAt);
  if (boot) return boot;
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

/**
 * Exécution automatique (tâches `stripe-catalog-sync` et
 * `stripe-catalog-publish`) : décision, puis publication sous bail partagé.
 * Ne lève pas.
 */
export async function runAutoPublication(
  d: CatalogDeps = catalogDeps(),
  opts: { actor?: string; onlyBootstrap?: boolean } = {},
): Promise<{ decision: AutoPublishDecision; result?: PublishResult }> {
  const actor = opts.actor ?? 'task:stripe-catalog-publish';
  const context = d.context();
  if (!context.mode) return { decision: { publish: false, reason: 'NO_STRIPE_KEY' } };
  if (publicationStopped(d.env)) return { decision: { publish: false, reason: 'PUBLICATION_STOPPED' } };
  const state = await d.store.getState(context.catalogContext);
  const lastRun = state?.publicationRunId ? await d.store.getRun(state.publicationRunId).catch(() => null) : null;
  const decision = opts.onlyBootstrap
    ? bootstrapDecision(state, manifestRevision(), d.now(), lastRun?.finishedAt ?? null) ?? { publish: false, reason: 'NOT_BOOTSTRAP' }
    : shouldAutoPublish(state, manifestRevision(), d.now(), lastRun?.finishedAt ?? null);
  if (!decision.publish) return { decision };
  const result = await publishCodeCatalog({ trigger: decision.trigger ?? 'auto', actor }, d);
  if (decision.reason.startsWith('BOOTSTRAP')) {
    console.info(JSON.stringify({ evt: 'billing.catalog.bootstrap_publication', context: context.catalogContext, decision: decision.reason, status: result.status, reason: 'reason' in result ? result.reason : null }));
  }
  return { decision, result };
}

export interface PublishOptions {
  trigger: 'auto' | 'manual' | 'resume';
  actor?: string | null;
  dryRun?: boolean;
  manifest?: Manifest;
  /** Tests : simule un incident juste avant le transfert n° N (1-based). */
  failBeforeTransfer?: number;
  /**
   * Lot 49A — reprise d'une publication EXISTANTE (même exécution, mêmes
   * prix candidats, mêmes clés d'idempotence) : aucune nouvelle exécution.
   */
  resumeRunId?: number;
  /** Lot 49A — rattrapage ciblé : aucun Price créé, aucune campagne de revalorisation. */
  recovery?: boolean;
}

export type PublishResult =
  | { status: 'noop'; reason: string; version: string | null }
  | { status: 'simulated'; plan: DiffEntry[]; manifestRevision: string }
  | { status: 'refused'; reason: string }
  | { status: 'published'; runId: number; version: string; created: Record<string, string>; plan: DiffEntry[]; checks?: PublishedCatalogChecks;
      /**
       * Lot 53I : publication INTÉGRALEMENT réussie — révision active ET
       * portail final vérifié par relecture ET contrôles après activation
       * conformes. `false` : grille active, mais chaîne non vérifiée (jamais
       * présentée comme un succès complet).
       */
      complete?: boolean; portalFinal?: { ok: boolean; error?: string } }
  | { status: 'failed'; runId: number; reason: string; step: string; /** Panne Stripe passagère (reprise espacée possible). */ transient?: boolean };

/**
 * Produit de vente de l'offre (LK-03, LK-80) : produit déjà approuvé ; à
 * défaut (lot 36B), produit des prix configurés par l'exploitant
 * (STRIPE_PRICE_*, V2 puis legacy) — preuve d'identité, jamais le nom ; puis
 * produit portant la métadonnée du seed (`verebona_<offre>`) ; sinon créé.
 * Plusieurs candidats sans preuve départageante : anomalie, jamais le premier.
 */
async function ensureSaleProduct(d: CatalogDeps, ctx: string, plan: PlanCode, livemode: boolean): Promise<{ ok: true; productId: string } | { ok: false; reason: string }> {
  const approved = await d.store.listApprovedProducts(ctx);
  const sale = approved.find((a) => a.planCode === plan && a.role === 'sale');
  if (sale) return { ok: true, productId: sale.stripeProductId };
  const stripe = d.stripe();
  // `null` : produit déjà approuvé pour une AUTRE offre (produit partagé) → option suivante.
  const approve = async (productId: string, source: string) => {
    const r = await d.store.approveProduct(ctx, { planCode: plan, stripeProductId: productId, role: 'sale', source, livemode });
    return r === 'conflict' ? null : { ok: true as const, productId };
  };

  // Preuve configurée : produits des prix STRIPE_PRICE_* de cette offre.
  const configured: Record<'v2' | 'legacy', Set<string>> = { v2: new Set(), legacy: new Set() };
  for (const ref of legacyPriceRefs(d.env).filter((r) => r.planCode === plan)) {
    try {
      const p = await stripe.prices.retrieve(ref.priceId, { expand: ['product'] });
      const product = typeof p.product === 'object' && p.product ? (p.product as Stripe.Product) : null;
      const productId = productIdOf(p);
      if (!productId || p.livemode !== livemode || (product && (product.active === false || ('deleted' in product && product.deleted)))) continue;
      const other = planFromMetadataValue(product?.metadata?.verebona_plan);
      if (other && other !== plan) continue;
      configured[ref.generation].add(productId);
    } catch { /* identifiant obsolète : sans effet */ }
  }
  for (const gen of ['v2', 'legacy'] as const) {
    if (configured[gen].size !== 1) continue;
    const r = await approve([...configured[gen]][0], `publication:legacy-env:${gen}`);
    if (r) return r;
  }

  const found = await stripe.products.search({ query: `metadata['verebona_plan']:'verebona_${plan}' AND active:'true'`, limit: 10 });
  if (found.data.length > 1) {
    const proven = found.data.filter((p) => configured.v2.has(p.id) || configured.legacy.has(p.id));
    const r = proven.length === 1 ? await approve(proven[0].id, 'publication:search+legacy-env') : null;
    return r ?? { ok: false, reason: `PRODUCT_AMBIGUOUS:${plan}` };
  }
  if (found.data[0]) {
    const r = await approve(found.data[0].id, 'publication:product-metadata');
    if (r) return r;
  }
  const created = await stripe.products.create({
    name: PLAN_PRODUCT_DEFINITIONS[plan].name,
    description: PLAN_PRODUCT_DEFINITIONS[plan].description,
    metadata: { verebona_plan: `verebona_${plan}` },
  }, { idempotencyKey: `vb-product:${ctx}:${plan}` });
  return (await approve(created.id, 'publication:provision')) ?? { ok: false, reason: `PRODUCT_CONFLICT:${plan}` };
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

/**
 * Publication par un appelant qui DÉTIENT déjà le bail partagé
 * `stripe-catalog-publication:<contexte>` (rattrapage ciblé, lot 49A) : même
 * séquence, mêmes contrôles de clé, de mode et de manifeste.
 */
export async function publishWithHeldLock(opts: PublishOptions, d: CatalogDeps): Promise<PublishResult> {
  const ctx = d.context();
  if (!ctx.mode) return { status: 'refused', reason: 'NO_STRIPE_KEY' };
  const modeIssue = expectedModeIssue(d);
  if (modeIssue) return { status: 'refused', reason: modeIssue };
  const manifest = opts.manifest ?? PRICING_MANIFEST;
  const issues = validateManifest(manifest);
  if (issues.length) return { status: 'refused', reason: `MANIFEST_INVALID: ${issues.join('; ')}` };
  return doPublish(opts, manifest, d);
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

  // Lot 49A : reprise de l'exécution EXISTANTE (rattrapage) — mêmes prix
  // candidats (journal `created_prices`), mêmes clés d'idempotence.
  let runId: number;
  const created: Record<string, string> = {};
  if (opts.resumeRunId) {
    const previous = await d.store.getRun(opts.resumeRunId);
    if (!previous || previous.kind !== 'publish') return { status: 'refused', reason: 'RESUME_RUN_NOT_FOUND' };
    if (previous.manifestRevision !== rev) return { status: 'refused', reason: 'RESUME_MANIFEST_CHANGED' };
    runId = previous.id;
    for (const [k, v] of Object.entries(previous.createdPrices ?? {})) if (typeof v === 'string') created[k] = v;
    await d.store.updateRun(runId, { state: 'RECOVERING', step: { step: 'resume', trigger: opts.trigger, actor: opts.actor ?? null, recovery: Boolean(opts.recovery), knownCandidates: Object.keys(created).length } });
  } else {
    runId = await d.store.createRun({ context, kind: 'publish', state: 'PREPARED', trigger: opts.trigger, actor: opts.actor ?? null, manifestRevision: rev, fromRevision: state.activeRevision });
  }
  const step = (name: string, detail: Record<string, unknown> = {}) => d.store.updateRun(runId, { step: { step: name, ...detail } });

  // Portail : sauvegarde AVANT modification, restauration si échec AVANT activation.
  const oldSnapshot = state.activeSnapshot;
  let portalBackup: PortalBackup | null = null;
  let portalTouched = false;
  let activated = false;

  const fail = async (stepName: string, reason: string, error?: unknown): Promise<PublishResult> => {
    let fullReason = reason;
    if (portalTouched && !activated && sellableCount(state) > 0) {
      try {
        const restored = await restorePortalConfiguration(portalBackup, oldSnapshot, `publication:${runId}`, d);
        await step('portal-restored', restored);
      } catch (e) {
        fullReason = `${reason} ; portail NON restauré (${(e as Error).message}) : montées en gamme bloquées`;
        await step('portal-restore-failed', { error: (e as Error).message }).catch(() => undefined);
        await d.anomalies.report({
          fingerprint: catalogFingerprint(context, 'portal-restore'),
          title: 'Catalogue Stripe : portail de l’ancienne révision NON restauré — montées en gamme bloquées',
          detail: { runId, error: (e as Error).message },
        }).catch(() => undefined);
      }
    }
    await d.store.setPublication(context, { state: 'FAILED', runId, error: `${stepName}: ${fullReason}`.slice(0, 500), activatingUntil: null });
    await d.store.updateRun(runId, { state: 'FAILED', error: `${stepName}: ${fullReason}`.slice(0, 1000), finished: true, step: { step: stepName, failed: true, reason: fullReason } });
    forgetCatalogMemory();
    await d.anomalies.report({
      fingerprint: catalogFingerprint(context, 'publication'),
      title: `Catalogue Stripe : publication en échec (${stepName}) — ancienne grille conservée`,
      detail: { runId, step: stepName, reason: fullReason },
    }).catch(() => undefined);
    console.error(JSON.stringify({ evt: 'billing.catalog.publication_failed', context, runId, step: stepName, reason: fullReason }));
    return { status: 'failed', runId, reason: fullReason, step: stepName, transient: error ? isStripeTransient(error) : false };
  };

  try {
    await d.store.setPublication(context, { state: opts.trigger === 'resume' ? 'RECOVERING' : 'VALIDATING', runId, error: null });
    await step('preflight', { plan, trigger: opts.trigger });
    const stripe = d.stripe();

    // ── 3. Candidats ──
    const candidates = new Map<string, ResolvedPrice>();
    for (const p of toCreate) {
      const couple = CATALOG_COUPLES.find((c) => c.lookupKey === p.lookupKey)!;
      const product = await ensureSaleProduct(d, context, couple.planCode, livemode);
      if (!product.ok) return await fail('products', product.reason);
      let price: Stripe.Price | null = null;
      // Candidat journalisé par l'exécution reprise : relu chez Stripe (état RÉEL).
      const known = created[couple.lookupKey];
      if (known) {
        try {
          price = await stripe.prices.retrieve(known, { expand: ['product'] });
        } catch (e) {
          if (isStripeTransient(e)) throw e;
          price = null;
        }
        const sameCandidate = price && price.active && productIdOf(price) === product.productId
          && price.metadata?.verebona_manifest_revision === rev && price.metadata?.verebona_lookup_key === couple.lookupKey;
        if (!sameCandidate) {
          if (opts.recovery) return await fail('candidate', `${couple.lookupKey}: candidat journalisé ${known} introuvable ou non conforme (aucun Price recréé)`);
          price = null;
        }
      }
      if (!price) price = await findExistingCandidate(stripe, product.productId, couple, rev);
      if (!price) {
        // Rattrapage : jamais de nouveau Price (la grille candidate existe déjà).
        if (opts.recovery) return await fail('candidate', `${couple.lookupKey}: CANDIDATE_MISSING (rattrapage : aucun Price créé)`);
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
      if (check.resolved.unitAmountCents !== p.targetAmountCents) return await fail('validate-candidate', `${couple.lookupKey}: montant ${check.resolved.unitAmountCents} ≠ ${p.targetAmountCents}`);
      candidates.set(couple.lookupKey, check.resolved);
    }

    // ── 5. Transferts de clés (fenêtre verrouillée, vente sur la révision active) ──
    await d.store.setPublication(context, { state: 'PUBLISHING', runId, error: null });
    await d.store.updateRun(runId, { state: 'PUBLISHING' });
    // État RÉEL des clés (reprise après transferts partiels : rien n'est refait).
    const holders = groupByLookupKey(await listKeyedPrices(stripe));
    const transfers: Array<Record<string, unknown>> = [];
    let n = 0;
    for (const p of toCreate) {
      n++;
      const candidate = candidates.get(p.lookupKey)!;
      if (opts.failBeforeTransfer === n) return await fail('transfer', `incident simulé avant le transfert ${n}`);
      const record: Record<string, unknown> = { lookupKey: p.lookupKey, from: p.currentPriceId, to: candidate.priceId, at: d.now().toISOString() };
      const current = holders.get(p.lookupKey) ?? [];
      if (current.length === 1 && current[0].id === candidate.priceId) {
        transfers.push({ ...record, ok: true, already: true });
        await d.store.updateRun(runId, { transfers: [...transfers] });
        continue;
      }
      try {
        await stripe.prices.update(candidate.priceId, { lookup_key: p.lookupKey, transfer_lookup_key: true });
        transfers.push({ ...record, ok: true });
        await d.store.updateRun(runId, { transfers: [...transfers] });
      } catch (e) {
        transfers.push({ ...record, ok: false, error: (e as Error).message });
        await d.store.updateRun(runId, { transfers: [...transfers] });
        return await fail('transfer', `${p.lookupKey}: ${(e as Error).message}`, e);
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

    // ── Portail : EXACTEMENT les six prix candidats, validé AVANT activation ──
    const oldEntries = Object.values(state.activeSnapshot.entries).filter(Boolean) as ResolvedPrice[];
    if (oldEntries.length > 0) {
      try {
        portalBackup = await capturePortalConfiguration(d);
        await step('portal-backup', { configurationId: portalBackup?.configurationId ?? null, products: portalBackup?.products ?? null });
      } catch (e) {
        return await fail('portal-backup', (e as Error).message, e);
      }
      try {
        portalTouched = true;
        const r = await syncUpgradePortal({ reason: `publication:${runId}`, snapshot, persist: false, requireComplete: true }, d);
        await step('portal-candidate', { configurationId: r.configurationId, prices: portalProductsFor(snapshot) });
      } catch (e) {
        // Contrôles structurels levés AVANT tout appel : portail intact.
        if (['PORTAL_DUPLICATE_INTERVAL', 'PORTAL_INCOMPLETE', 'PORTAL_PRODUCT_NOT_APPROVED'].includes((e as { code?: string })?.code ?? '')) portalTouched = false;
        return await fail('portal', (e as Error).message, e);
      }
    } else {
      // Amorçage (lot 36B) : aucune ancienne révision vendue, donc aucune
      // bascule de portail à sécuriser — le portail (montée en gamme) est
      // réaligné plus tard (au clic, à la synchronisation) et signalé ; il ne
      // bloque pas l'affichage des offres ni Checkout.
      try {
        await syncUpgradePortal({ reason: `publication:${runId}`, snapshot, persist: false }, d);
        await step('portal-candidate');
      } catch (e) {
        await step('portal-candidate', { deferred: true, error: (e as Error).message });
        await d.anomalies.report({ fingerprint: catalogFingerprint(context, 'portal'), title: 'Catalogue Stripe : portail de montée en gamme non configuré (première publication)', detail: { runId, error: (e as Error).message } }).catch(() => undefined);
      }
    }

    // ── Activation (courte fenêtre BILLING_CATALOG_UPDATING) ──
    await d.store.setPublication(context, { state: 'READY', runId, error: null, activatingUntil: new Date(d.now().getTime() + 60_000) });
    await d.store.activateSnapshot({
      // Une révision précédente VIDE (amorçage) n'est pas un point de retour arrière.
      context, stripeAccountId: state.stripeAccountId, livemode, snapshot, keepPrevious: sellableCount(state) > 0,
      publishedManifestRevision: rev, versions, publicationState: 'ACTIVE', publicationRunId: runId,
    });
    activated = true;
    forgetCatalogMemory();
    await d.store.updateRun(runId, { state: 'ACTIVE', toRevision: snapshot.version, step: { step: 'activated', version: snapshot.version } });
    await d.anomalies.resolve(catalogFingerprint(context, 'publication')).catch(() => undefined);
    await d.anomalies.resolve(catalogFingerprint(context, 'portal-restore')).catch(() => undefined);
    console.info(JSON.stringify({ evt: 'billing.catalog.published', context, runId, from: state.activeRevision, to: snapshot.version, created, recovery: Boolean(opts.recovery) }));

    // Portail de la révision active, vérifié (exclusivement ses six prix, LK-50) et mémorisé.
    // Lot 53I : un échec ici n'est JAMAIS silencieux — la publication n'est
    // pas « intégralement réussie » (journal, anomalie, tâche en erreur).
    let portalFinal: { ok: boolean; error?: string } = { ok: true };
    try {
      await syncUpgradePortal({ reason: `publication:${runId}:final`, force: true }, d);
      await step('portal-final', { ok: true });
    } catch (e) {
      portalFinal = { ok: false, error: (e as Error).message };
      await step('portal-final', { ok: false, error: (e as Error).message });
      await d.anomalies.report({
        fingerprint: catalogFingerprint(context, 'portal-final'),
        title: 'Catalogue Stripe : grille active mais portail de montée en gamme NON vérifié après publication',
        detail: { runId, error: (e as Error).message },
      }).catch(() => undefined);
    }
    if (portalFinal.ok) await d.anomalies.resolve(catalogFingerprint(context, 'portal-final')).catch(() => undefined);

    // ── 7. Campagne de revalorisation (opération distincte) ──
    if (opts.recovery) {
      // Rattrapage ciblé : aucune revalorisation, aucun envoi (lot 49A).
      await step('revaluation-campaign', { skipped: 'rattrapage ciblé : aucune revalorisation ni information des abonnés' });
    } else {
      try {
        const { createRevaluationCampaign } = await import('./price-revaluation.service');
        const campaign = await createRevaluationCampaign({ revisionId: snapshot.version, previous: state.activeSnapshot, next: snapshot });
        await step('revaluation-campaign', campaign as unknown as Record<string, unknown>);
      } catch (e) {
        await step('revaluation-campaign', { error: (e as Error).message });
        await d.anomalies.report({ fingerprint: catalogFingerprint(context, 'revaluation-campaign'), title: 'Revalorisation : campagne non créée', detail: { runId, error: (e as Error).message } }).catch(() => undefined);
      }
    }

    // ── Sondes (EX-013) et contrôles après activation (lot 49A) ──
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
    const checks = await verifyPublishedCatalog(d, { manifest }).catch((e: Error) => ({ ok: false, issues: [`contrôle impossible : ${e.message}`], couples: [], portal: null } as PublishedCatalogChecks));
    const fpChecks = catalogFingerprint(context, 'post-check');
    if (checks.ok) await d.anomalies.resolve(fpChecks).catch(() => undefined);
    else await d.anomalies.report({ fingerprint: fpChecks, title: 'Catalogue Stripe : contrôles après publication en écart', detail: { runId, issues: checks.issues } }).catch(() => undefined);
    const complete = portalFinal.ok && checks.ok && divergent.length === 0;
    await d.store.updateRun(runId, { report: { plan, created, transfers, probes, checks, portalFinal, complete }, finished: true, step: { step: 'probes', probes, checksOk: checks.ok, complete } });
    return { status: 'published', runId, version: snapshot.version, created, plan, checks, complete, portalFinal };
  } catch (error) {
    if (activated) {
      // Révision déjà active : jamais d'état FAILED a posteriori.
      await step('post-activation-error', { error: (error as Error)?.message ?? String(error) }).catch(() => undefined);
      await d.store.updateRun(runId, { report: { plan, created, complete: false, error: (error as Error)?.message ?? String(error) }, finished: true }).catch(() => undefined);
      return { status: 'published', runId, version: (await d.store.getState(context))?.activeRevision ?? '', created, plan, complete: false };
    }
    return fail('unexpected', (error as Error)?.message ?? String(error), error);
  }
}

// ─── Contrôles après activation (lot 49A) ───────────────────────────────────

export interface PublishedCatalogChecks {
  ok: boolean;
  issues: string[];
  couples: Array<{ lookupKey: string; priceId: string | null; unitAmountCents: number | null; taxBehavior: string | null; ok: boolean }>;
  portal: { configurationId: string | null; exclusive: boolean; determinate?: boolean; accepted?: Array<{ product: string; prices: string[] }> | null } | null;
}

/**
 * Contrôle automatique du résultat d'une publication (lecture seule) :
 *   - six lookup_key portées chacune par UN Price actif, égal à la révision
 *     active, sous le produit de vente approuvé, EUR, bonne périodicité,
 *     `tax_behavior = inclusive`, montant du manifeste (et de `expectedGrid`) ;
 *   - concordance révision active ↔ catalogue public (vitrine, page Offres)
 *     ↔ prix engagé par Checkout (relecture `forPayment`) ;
 *   - portail : exclusivement les six prix actifs ;
 *   - état ACTIVE, manifeste publié.
 */
export async function verifyPublishedCatalog(
  d: CatalogDeps,
  opts: { manifest?: Manifest; expectedGrid?: Record<PlanCode, Record<'monthly' | 'yearly', number>> } = {},
): Promise<PublishedCatalogChecks> {
  const manifest = opts.manifest ?? PRICING_MANIFEST;
  const ctx = d.context();
  const context = ctx.catalogContext;
  const issues: string[] = [];
  forgetCatalogMemory();
  const state = await d.store.getState(context);
  const snap = state?.activeSnapshot ?? null;
  if (!state || !snap) return { ok: false, issues: ['aucune révision active'], couples: [], portal: null };
  if (state.publicationState !== 'ACTIVE') issues.push(`état de publication ${state.publicationState}`);
  if (state.publishedManifestRevision !== manifestRevision(manifest)) issues.push('manifeste du code non publié');
  const stripe = d.stripe();
  const keyed = groupByLookupKey(await listKeyedPrices(stripe));
  const approved = await d.store.listApprovedProducts(context);
  const publicView = buildPublicCatalog(state, d.now());
  const couples: PublishedCatalogChecks['couples'] = [];
  for (const c of CATALOG_COUPLES) {
    const key = coupleKey(c.planCode, c.billingPeriod);
    const e = snap.entries[key];
    const before = issues.length;
    const target = manifest[c.planCode][c.billingPeriod].unitAmountCents;
    const expected = opts.expectedGrid?.[c.planCode]?.[c.billingPeriod];
    if (!e) {
      issues.push(`${c.lookupKey} : absent de la révision active`);
      couples.push({ lookupKey: c.lookupKey, priceId: null, unitAmountCents: null, taxBehavior: null, ok: false });
      continue;
    }
    const found = keyed.get(c.lookupKey) ?? [];
    const p = found[0];
    if (found.length !== 1 || p.id !== e.priceId) issues.push(`${c.lookupKey} : clé portée par ${found.map((f) => f.id).join(',') || '∅'} ≠ ${e.priceId}`);
    if (p) {
      if (!p.active) issues.push(`${c.lookupKey} : Price inactif`);
      if ((p.currency ?? '').toLowerCase() !== 'eur') issues.push(`${c.lookupKey} : devise ${p.currency}`);
      if (p.recurring?.interval !== c.interval || (p.recurring?.interval_count ?? 1) !== 1) issues.push(`${c.lookupKey} : périodicité ${p.recurring?.interval}`);
      if (p.tax_behavior !== 'inclusive') issues.push(`${c.lookupKey} : tax_behavior ${p.tax_behavior}`);
      if (p.unit_amount !== target) issues.push(`${c.lookupKey} : montant ${p.unit_amount} ≠ manifeste ${target}`);
      if (expected != null && p.unit_amount !== expected) issues.push(`${c.lookupKey} : montant ${p.unit_amount} ≠ attendu ${expected}`);
      const sale = approved.find((a) => a.planCode === c.planCode && a.role === 'sale')?.stripeProductId;
      if (!sale || productIdOf(p) !== sale) issues.push(`${c.lookupKey} : produit ${productIdOf(p)} non approuvé pour la vente`);
    }
    const offer = publicView.offers.find((o) => o.plan_code === c.planCode && o.billing_period === c.billingPeriod);
    if (!offer || offer.unit_amount_cents !== e.unitAmountCents || offer.price_revision !== e.priceRevision) issues.push(`${c.lookupKey} : catalogue public divergent`);
    try {
      const r = await resolveCurrentPrice(c.planCode, c.billingPeriod, { forPayment: true }, d);
      if (r.priceId !== e.priceId) issues.push(`${c.lookupKey} : Checkout engagerait ${r.priceId}`);
    } catch (err) {
      issues.push(`${c.lookupKey} : Checkout indisponible (${(err as Error).message})`);
    }
    couples.push({ lookupKey: c.lookupKey, priceId: e.priceId, unitAmountCents: e.unitAmountCents, taxBehavior: e.taxBehavior, ok: issues.length === before });
  }
  let portal: PublishedCatalogChecks['portal'] = null;
  try {
    // Lot 53I : relecture AVEC expansion ; indéterminé ≠ conforme.
    const backup = await capturePortalConfiguration(d);
    const determinate = Boolean(backup && backup.products !== null);
    const exclusive = Boolean(backup) && determinate && JSON.stringify(backup!.products) === JSON.stringify(portalProductsFor(snap)) && backup!.settingsOk;
    portal = { configurationId: backup?.configurationId ?? null, exclusive, determinate, accepted: backup?.products ?? null };
    if (!backup) issues.push('portail : aucune configuration de montée en gamme');
    else if (!determinate) issues.push('portail : prix autorisés non relus (propriété absente de la réponse Stripe, état indéterminé)');
    else if (!exclusive) issues.push('portail : ne correspond pas exclusivement aux six prix actifs');
  } catch (e) {
    issues.push(`portail illisible : ${(e as Error).message}`);
  }
  return { ok: issues.length === 0, issues, couples, portal };
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
