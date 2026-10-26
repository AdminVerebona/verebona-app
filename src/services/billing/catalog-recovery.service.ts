/**
 * Rattrapage CIBLÉ d'une publication de catalogue en échec — lot 49A.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INCIDENT PRÉPROD (contexte test:preprod, compte acct_1SX8QQL7bbQ8HKBX)
 *
 * La publication de la grille V4 (3,90/39, 6,90/69, 9,90/99 € TTC) a échoué
 * à l'étape du portail : « For each product, its price must have unique
 * billing intervals. » (l'ancien code transmettait au portail l'union des
 * prix de l'ancienne ET de la nouvelle révision). Les six nouveaux Price
 * existent et les clés leur ont été transférées ; l'ancienne grille reste
 * vendue (révision active), l'état est FAILED et la tâche automatique ne
 * relance jamais un échec (LK-27).
 *
 * Après déploiement du correctif, la tâche interne `stripe-catalog-publish`
 * termine CETTE publication sans clic BO ni manipulation Stripe :
 *
 *   ciblage strict   contexte `test:preprod`, mode test, compte
 *                    `acct_1SX8QQL7bbQ8HKBX`, état FAILED dont l'erreur est
 *                    le doublon de périodicité du portail (ou rattrapage déjà
 *                    engagé sur la même exécution). Production, autres
 *                    comptes, autres erreurs : IGNORÉS, aucune lecture Stripe
 *                    en dehors du contexte ciblé ;
 *   arrêt            `SCHEDULED_TASK_STRIPE_CATALOG_PUBLISH=off` (ou arrêt
 *                    global) l'empêche, comme toute publication automatique ;
 *   préconditions    bon compte, mode test, produits de vente approuvés,
 *                    grille candidate complète (six prix journalisés),
 *                    manifeste inchangé, reprise historique terminée (sauf
 *                    amorçage, mêmes règles que `bootstrapDecision`), aucune
 *                    opération concurrente ;
 *   verrou           bail partagé `stripe-catalog-publication:<contexte>` :
 *                    deux instances simultanées → une seule reprise ;
 *   reprise          MÊME exécution, MÊMES prix candidats, MÊMES clés
 *                    d'idempotence ; état réel des prix et des lookup_key
 *                    relu chez Stripe ; aucun Price créé ;
 *   succès           révision activée, publication terminée, anomalie
 *                    résolue, contrôles après activation (six clés, montants
 *                    attendus, tax_behavior inclusive, concordance révision
 *                    active / catalogue public / Checkout, portail exclusif,
 *                    abonnements existants inchangés), rattrapage DONE ;
 *   échec            panne Stripe passagère → reprises espacées et bornées
 *                    (RETRY_WAIT, au plus `RECOVERY_MAX_ATTEMPTS`) ; erreur
 *                    fonctionnelle → FAILED, visible au BO, plus aucune
 *                    tentative automatique (pas de boucle).
 *
 * Aucune revalorisation, aucun envoi d'information, aucun abonnement modifié.
 * Ce n'est PAS une reprise générale des états FAILED.
 *
 * LOT 53I — SECONDE REPRISE CIBLÉE (`portal-products-includable-2026-10`)
 *
 * Le rattrapage 49A a échoué en préprod après 1/5 : le portail relu sans
 * l'expansion du champ includable `features.subscription_update.products`
 * semblait n'accepter aucun prix (« PORTAL_MISMATCH : prix acceptés ∅ »), et
 * la restauration, vérifiée de la même façon, échouait aussi
 * (« PORTAL_RESTORE_FAILED »). Erreur FONCTIONNELLE → FAILED définitif, plus
 * aucune tentative (anti-boucle respecté, mais incident figé).
 *
 * Après déploiement du correctif de lecture, la même tâche interne exécute
 * UNE reprise corrective distincte (clé propre, compteur propre) :
 *   cible        même contexte / compte / mode test, publication FAILED dont
 *                l'erreur est celle du portail (PORTAL_MISMATCH,
 *                PORTAL_RESTORE_FAILED, PORTAL_UNVERIFIABLE ou l'erreur
 *                d'origine), ou reprise déjà engagée sur la même exécution
 *                (y compris interrompue : processus arrêté en cours de
 *                reprise, état intermédiaire, bail expiré) ; jamais pendant
 *                que le rattrapage 49A est encore actif ;
 *   live         GARDE EXPLICITE : mode de clé live, clé `sk_live_`/`rk_live_`,
 *                mode attendu live, environnement de production, état
 *                `livemode` → IGNORÉ, aucune lecture Stripe ;
 *   reprise      même exécution, mêmes six Price, mêmes contrôles
 *                (lookup_key, produit, montant, périodicité, tax_behavior,
 *                identifiants), aucun Price créé, aucun transfert de clé déjà
 *                fait, aucune revalorisation ;
 *   fin          DONE seulement si la publication est ACTIVE ET que le
 *                portail final et les contrôles après activation sont
 *                conformes ; sinon CHECK_FAILED (visible au BO).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { CATALOG_COUPLES, type PlanCode } from '@/lib/billing/plan-catalog';
import type { CatalogRecoveryRow } from './catalog-store';
import { catalogDeps, catalogFingerprint, type CatalogDeps } from './price-catalog.service';
import { PRICING_MANIFEST, manifestRevision, validateManifest } from './pricing-manifest';
import { publicationStopped, publishWithHeldLock, sellableCount, verifyPublishedCatalog, type PublishedCatalogChecks } from './catalog-publication.service';
import { getExpectedStripeMode, getStripeKeyMode } from '@/lib/stripe-client';

/** Définition d'un rattrapage ciblé (jamais généralisé). */
interface RecoveryDefinition {
  key: string;
  catalogContext: string;
  stripeAccountId: string;
  /** Erreur(s) de publication visées. */
  errorPattern: RegExp;
  /** Rattrapages antérieurs : s'ils sont encore actifs (non terminés), celui-ci attend. */
  after?: readonly string[];
  /** Reprise d'une tentative INTERROMPUE (processus arrêté, bail expiré) — lot 53I. */
  resumeInterrupted?: boolean;
  /** Libellé BO. */
  label: string;
}

/** Cible unique de ce rattrapage (jamais généralisé). */
export const PORTAL_INTERVAL_RECOVERY = {
  key: 'portal-unique-intervals-2026-10',
  catalogContext: 'test:preprod',
  stripeAccountId: 'acct_1SX8QQL7bbQ8HKBX',
  /** Message Stripe de l'incident. */
  errorPattern: /unique billing intervals/i,
  label: 'Rattrapage lot 49A : doublons de périodicité du portail',
} as const satisfies RecoveryDefinition;

/**
 * Lot 53I — reprise corrective de la publication restée FAILED après l'échec
 * du rattrapage 49A (lecture du portail sans expansion : « ∅ »).
 */
export const PORTAL_PRODUCTS_RECOVERY = {
  key: 'portal-products-includable-2026-10',
  catalogContext: 'test:preprod',
  stripeAccountId: 'acct_1SX8QQL7bbQ8HKBX',
  errorPattern: /PORTAL_MISMATCH|PORTAL_RESTORE_FAILED|PORTAL_UNVERIFIABLE|unique billing intervals/i,
  after: [PORTAL_INTERVAL_RECOVERY.key],
  resumeInterrupted: true,
  label: 'Reprise corrective lot 53 : prix autorisés du portail relus avec expansion',
} as const satisfies RecoveryDefinition;

/** Rattrapages ciblés, dans l'ordre d'exécution. */
export const CATALOG_RECOVERIES: readonly RecoveryDefinition[] = [PORTAL_INTERVAL_RECOVERY, PORTAL_PRODUCTS_RECOVERY];

const PRODUCTION_APP_ENVS = new Set(['production', 'prod', 'live']);

/**
 * GARDE LIVE explicite (lot 53I) — aucun rattrapage de préproduction ne
 * s'exécute jamais dans un contexte Stripe de production. Pure.
 * `null` si le contexte est sûr (test, hors production).
 */
export function liveGuard(input: { mode: string | null; appEnv?: string | null; env: NodeJS.ProcessEnv | Record<string, string | undefined>; stateLivemode?: boolean | null }): string | null {
  if (input.mode !== 'test') return 'LIVE_GUARD:KEY_MODE';
  if (getStripeKeyMode(input.env.STRIPE_SECRET_KEY) === 'live') return 'LIVE_GUARD:SECRET_KEY';
  if (getExpectedStripeMode(input.env as NodeJS.ProcessEnv) === 'live') return 'LIVE_GUARD:EXPECTED_MODE';
  const appEnv = (input.env.NEXT_PUBLIC_APP_ENV ?? input.appEnv ?? '').trim().toLowerCase();
  if (PRODUCTION_APP_ENVS.has(appEnv) || PRODUCTION_APP_ENVS.has((input.appEnv ?? '').trim().toLowerCase())) return 'LIVE_GUARD:APP_ENV';
  if (input.stateLivemode === true) return 'LIVE_GUARD:STATE_LIVEMODE';
  return null;
}

/** Grille attendue après reprise (centimes TTC). */
export const EXPECTED_V4_GRID: Record<PlanCode, Record<'monthly' | 'yearly', number>> = {
  standard: { monthly: 390, yearly: 3900 },
  premium: { monthly: 690, yearly: 6900 },
  premium_duo: { monthly: 990, yearly: 9900 },
};

export const RECOVERY_MAX_ATTEMPTS = 5;
const RECOVERY_BASE_DELAY_MS = 10 * 60_000;
const LOCK_TTL_MS = 15 * 60_000;
/** Une exécution non terminée depuis moins longtemps est réputée en cours. */
const CONCURRENT_WINDOW_MS = 20 * 60_000;

/** Délai avant la tentative suivante (10, 20, 40, 80 min). Pure. */
export function recoveryDelayMs(attempts: number): number {
  return RECOVERY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1);
}

/** Empreinte des abonnements existants (prix contractuel, échéance, échéancier). */
type SubscriptionsProbe = () => Promise<string>;

const pgSubscriptionsProbe: SubscriptionsProbe = async () => {
  const { pgClient } = await import('@/db');
  const rows = await pgClient.unsafe(
    `SELECT id, stripe_price_id, contract_unit_amount_cents, current_period_end_at, scheduled_stripe_price_id, scheduled_schedule_id, plan_code, billing_period
       FROM account_subscriptions WHERE stripe_subscription_id IS NOT NULL ORDER BY id`,
  );
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
};

type RecoveryOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'waiting'; reason: string }
  | { status: 'retry_wait'; reason: string; nextAttemptAt: string | null }
  | { status: 'done'; runId: number; version: string; checks: PublishedCatalogChecks }
  | { status: 'failed'; reason: string };

interface RecoveryOptions {
  subscriptionsProbe?: SubscriptionsProbe;
  actor?: string;
}

type TargetInput = { catalogContext: string; mode: string | null; publicationState: string | null; publicationError: string | null; publicationRunId: number | null };

/** Le rattrapage 49A cible-t-il CET état ? (sans appel Stripe). Pure. */
export function recoveryTargets(input: TargetInput, row: CatalogRecoveryRow | null): { targeted: boolean; reason: string } {
  return recoveryTargetsFor(PORTAL_INTERVAL_RECOVERY, input, row);
}

/** États intermédiaires d'une reprise interrompue (processus arrêté). */
// ACTIVE : arrêt APRÈS activation, avant la fin des contrôles (seuls les contrôles restent à faire).
const INTERRUPTED_STATES = new Set(['PREPARED', 'VALIDATING', 'PUBLISHING', 'READY', 'RECOVERING', 'ACTIVE']);

/**
 * Un rattrapage cible-t-il CET état ? (sans appel Stripe). Pure.
 * `others` : autres rattrapages du contexte (ordre, lot 53I) ; `now` :
 * détection d'une tentative interrompue (bail expiré).
 */
export function recoveryTargetsFor(
  def: RecoveryDefinition,
  input: TargetInput,
  row: CatalogRecoveryRow | null,
  others: CatalogRecoveryRow[] = [],
  now: Date | null = null,
): { targeted: boolean; reason: string } {
  if (input.catalogContext !== def.catalogContext) return { targeted: false, reason: 'OUT_OF_SCOPE_CONTEXT' };
  if (input.mode !== 'test') return { targeted: false, reason: 'NOT_TEST_MODE' };
  if (row?.status === 'DONE' || row?.status === 'CHECK_FAILED') return { targeted: false, reason: 'ALREADY_DONE' };
  if (row?.status === 'FAILED') return { targeted: false, reason: 'RECOVERY_FAILED' };
  // Un rattrapage antérieur encore actif garde la main (un seul à la fois).
  const active = others.find((o) => (def.after ?? []).includes(o.recoveryKey) && ['WAITING', 'RUNNING', 'RETRY_WAIT'].includes(o.status));
  if (active) return { targeted: false, reason: 'PREVIOUS_RECOVERY_ACTIVE' };
  const engaged = Boolean(row && row.runId != null && row.runId === input.publicationRunId);
  // Lot 53I : tentative INTERROMPUE (processus arrêté en pleine reprise) —
  // état intermédiaire laissé par la même exécution, bail expiré.
  if (def.resumeInterrupted && engaged && row?.status === 'RUNNING' && INTERRUPTED_STATES.has(input.publicationState ?? '')
    && now && row.lastAttemptAt && now.getTime() - row.lastAttemptAt.getTime() > LOCK_TTL_MS) {
    return { targeted: true, reason: 'INTERRUPTED' };
  }
  if (input.publicationState !== 'FAILED') return { targeted: false, reason: 'NOT_FAILED' };
  // Rattrapage déjà engagé sur la même exécution (l'erreur peut avoir changé
  // après une tentative passagère) — sinon, seule l'erreur de l'incident.
  if (!engaged && !def.errorPattern.test(input.publicationError ?? '')) return { targeted: false, reason: 'UNRELATED_ERROR' };
  return { targeted: true, reason: engaged ? 'ENGAGED' : 'INCIDENT' };
}

/**
 * Exécuté par la tâche `stripe-catalog-publish` (toutes les 5 min) avant la
 * décision de publication automatique. Ne lève pas.
 */
export async function runPortalIntervalRecovery(d: CatalogDeps = catalogDeps(), opts: RecoveryOptions = {}): Promise<RecoveryOutcome> {
  return runRecovery(PORTAL_INTERVAL_RECOVERY, d, opts);
}

/** Lot 53I — reprise corrective (voir l'en-tête). Ne lève pas. */
export async function runPortalProductsRecovery(d: CatalogDeps = catalogDeps(), opts: RecoveryOptions = {}): Promise<RecoveryOutcome> {
  return runRecovery(PORTAL_PRODUCTS_RECOVERY, d, opts);
}

/**
 * Rattrapages ciblés, dans l'ordre (tâche `stripe-catalog-publish`) : le
 * premier qui n'est pas « ignoré » donne le résultat. Ne lève pas.
 */
export async function runCatalogRecoveries(d: CatalogDeps = catalogDeps(), opts: RecoveryOptions = {}): Promise<RecoveryOutcome & { key?: string }> {
  let last: RecoveryOutcome & { key?: string } = { status: 'skipped', reason: 'NONE' };
  for (const def of CATALOG_RECOVERIES) {
    const r = await runRecovery(def, d, opts);
    if (r.status !== 'skipped') return { ...r, key: def.key };
    last = { ...r, key: def.key };
  }
  return last;
}

export async function runRecovery(def: RecoveryDefinition, d: CatalogDeps = catalogDeps(), opts: RecoveryOptions = {}): Promise<RecoveryOutcome> {
  try {
    return await recoveryInner(def, d, opts);
  } catch (e) {
    console.error(JSON.stringify({ evt: 'billing.catalog.recovery_error', key: def.key, error: (e as Error).message }));
    return { status: 'skipped', reason: `ERROR:${(e as Error).message}` };
  }
}

async function targetFor(def: RecoveryDefinition, d: CatalogDeps) {
  const ctx = d.context();
  const state = await d.store.getState(ctx.catalogContext);
  const row = await d.store.getRecovery(ctx.catalogContext, def.key);
  const others = def.after?.length ? (await d.store.listRecoveries(ctx.catalogContext)).filter((r) => r.recoveryKey !== def.key) : [];
  const target = recoveryTargetsFor(def, {
    catalogContext: ctx.catalogContext, mode: ctx.mode, publicationState: state?.publicationState ?? null,
    publicationError: state?.publicationError ?? null, publicationRunId: state?.publicationRunId ?? null,
  }, row, others, d.now());
  return { state, row, target };
}

async function recoveryInner(def: RecoveryDefinition, d: CatalogDeps, opts: RecoveryOptions): Promise<RecoveryOutcome> {
  const ctx = d.context();
  // Hors cible : aucune lecture (ni base ni Stripe) — production comprise.
  if (ctx.catalogContext !== def.catalogContext || ctx.mode !== 'test') return { status: 'skipped', reason: 'OUT_OF_SCOPE_CONTEXT' };
  // Garde live explicite (lot 53I) : clé, mode attendu, environnement.
  const guard = liveGuard({ mode: ctx.mode, appEnv: ctx.appEnv, env: d.env });
  if (guard) return { status: 'skipped', reason: guard };
  if (publicationStopped(d.env)) return { status: 'skipped', reason: 'PUBLICATION_STOPPED' };

  const { state: pre, row: preRow, target: preTarget } = await targetFor(def, d);
  if (!preTarget.targeted) return { status: 'skipped', reason: preTarget.reason };
  const stateGuard = liveGuard({ mode: ctx.mode, appEnv: ctx.appEnv, env: d.env, stateLivemode: pre?.livemode ?? null });
  if (stateGuard) return { status: 'skipped', reason: stateGuard };
  if (preRow?.status === 'RETRY_WAIT' && preRow.nextAttemptAt && preRow.nextAttemptAt.getTime() > d.now().getTime()) {
    return { status: 'retry_wait', reason: preRow.lastError ?? 'RETRY_WAIT', nextAttemptAt: preRow.nextAttemptAt.toISOString() };
  }

  const locked = await d.lock(`stripe-catalog-publication:${ctx.catalogContext}`, LOCK_TTL_MS, () => attempt(def, d, opts));
  return locked ?? { status: 'skipped', reason: 'LOCKED' };
}

async function attempt(def: RecoveryDefinition, d: CatalogDeps, opts: RecoveryOptions): Promise<RecoveryOutcome> {
  const T = def;
  const ctx = d.context();
  const context = ctx.catalogContext;
  const now = d.now();
  // Relecture SOUS le bail (une autre instance a pu terminer entre-temps).
  const { state, row, target } = await targetFor(def, d);
  if (!target.targeted || !state) return { status: 'skipped', reason: target.reason };
  if (row?.status === 'RETRY_WAIT' && row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime()) {
    return { status: 'retry_wait', reason: row.lastError ?? 'RETRY_WAIT', nextAttemptAt: row.nextAttemptAt.toISOString() };
  }

  const base: CatalogRecoveryRow = row ?? {
    catalogContext: context, recoveryKey: T.key, status: 'WAITING', runId: state.publicationRunId, attempts: 0,
    lastError: null, lastAttemptAt: null, nextAttemptAt: null, completedAt: null, report: null,
  };
  const save = async (patch: Partial<CatalogRecoveryRow>) => { Object.assign(base, patch); await d.store.saveRecovery({ ...base }); };
  const fpRecovery = catalogFingerprint(context, 'recovery', T.key);
  const terminal = async (reason: string, extra: Record<string, unknown> = {}): Promise<RecoveryOutcome> => {
    await save({ status: 'FAILED', lastError: reason.slice(0, 1000), nextAttemptAt: null, report: { ...(base.report ?? {}), ...extra, definitive: true } });
    await d.anomalies.report({ fingerprint: fpRecovery, title: `Catalogue Stripe : rattrapage automatique de la publication en échec (${reason.slice(0, 120)})`, detail: { context, key: T.key, runId: base.runId, reason, ...extra } }).catch(() => undefined);
    console.error(JSON.stringify({ evt: 'billing.catalog.recovery_failed', context, key: T.key, runId: base.runId, reason }));
    return { status: 'failed', reason };
  };
  const waiting = async (reason: string): Promise<RecoveryOutcome> => {
    await save({ status: 'WAITING', lastError: reason });
    return { status: 'waiting', reason };
  };

  // ── Préconditions communes (aucune écriture Stripe) ──
  const stripe = d.stripe();
  let accountId: string | null = null;
  try {
    accountId = (await (stripe.accounts as unknown as { retrieve: () => Promise<{ id: string }> }).retrieve())?.id ?? null;
  } catch (e) {
    return waiting(`compte Stripe illisible : ${(e as Error).message}`);
  }
  // Autre compte : rattrapage IGNORÉ (aucune ligne, aucune écriture).
  if (accountId !== T.stripeAccountId || (state.stripeAccountId && state.stripeAccountId !== T.stripeAccountId)) {
    return { status: 'skipped', reason: 'OTHER_ACCOUNT' };
  }
  if (!state.publicationRunId) return terminal('PRECONDITION: aucune exécution de publication associée');
  const run = await d.store.getRun(state.publicationRunId);
  if (!run || run.kind !== 'publish') return terminal('PRECONDITION: exécution de publication introuvable');
  const rev = manifestRevision();
  if (validateManifest().length) return terminal('PRECONDITION: manifeste invalide');
  if (run.manifestRevision !== rev) return terminal(`PRECONDITION: manifeste du code (${rev}) ≠ publication en échec (${run.manifestRevision})`);
  const gridMismatch = CATALOG_COUPLES.filter((c) => PRICING_MANIFEST[c.planCode][c.billingPeriod].unitAmountCents !== EXPECTED_V4_GRID[c.planCode][c.billingPeriod]);
  if (gridMismatch.length) return terminal(`PRECONDITION: grille du code différente de la grille attendue (${gridMismatch.map((c) => c.lookupKey).join(', ')})`);
  const createdKeys = Object.keys(run.createdPrices ?? {});
  const missing = CATALOG_COUPLES.filter((c) => !createdKeys.includes(c.lookupKey));
  if (missing.length) return terminal(`PRECONDITION: grille candidate incomplète (${missing.map((c) => c.lookupKey).join(', ')})`);
  if (sellableCount(state) === 0) return terminal('PRECONDITION: aucune révision active vendable');
  const approved = await d.store.listApprovedProducts(context);
  const noProduct = (['standard', 'premium', 'premium_duo'] as const).filter((p) => !approved.some((a) => a.planCode === p && a.role === 'sale'));
  if (noProduct.length) return terminal(`PRECONDITION: produit de vente non approuvé (${noProduct.join(', ')})`);
  // Reprise historique : exigée comme pour toute publication — sauf amorçage
  // (manifeste jamais publié et grille vendue incomplète : même exemption que
  // `bootstrapDecision`, lot 36B), où elle n'a jamais été une condition.
  const bootstrap = !state.publishedManifestRevision && sellableCount(state) < CATALOG_COUPLES.length;
  if (!state.backfillCompletedAt && !bootstrap) return waiting('PRECONDITION: reprise historique non terminée (la tâche stripe-catalog-sync la poursuit)');
  const runs = await d.store.listRuns(context, 20);
  const concurrent = runs.find((r) => r.id !== run.id && !r.finishedAt && (r.kind === 'publish' || r.kind === 'rollback') && now.getTime() - r.startedAt.getTime() < CONCURRENT_WINDOW_MS);
  if (concurrent) return waiting(`PRECONDITION: opération concurrente en cours (exécution ${concurrent.id})`);

  // ── Tentative ──
  const attempts = base.attempts + 1;
  await save({ status: 'RUNNING', runId: run.id, attempts, lastAttemptAt: now, nextAttemptAt: null, lastError: null, report: { ...(base.report ?? {}), target: target.reason, step: 'publication' } });
  console.info(JSON.stringify({ evt: 'billing.catalog.recovery_attempt', context, key: T.key, runId: run.id, attempt: attempts, target: target.reason }));
  const probe = opts.subscriptionsProbe ?? pgSubscriptionsProbe;
  // Empreinte « avant » : celle enregistrée à la PREMIÈRE tentative (une
  // reprise après interruption compare à l'état d'origine).
  const firstBefore = typeof base.report?.subscriptionsBefore === 'string' ? base.report.subscriptionsBefore : null;
  const before = firstBefore ?? await probe().catch(() => null);
  if (before && !firstBefore) await save({ report: { ...(base.report ?? {}), subscriptionsBefore: before } });
  let result = await publishWithHeldLock({ trigger: 'resume', actor: opts.actor ?? `task:stripe-catalog-publish:recovery:${T.key}`, resumeRunId: run.id, recovery: true }, d);
  // Interruption APRÈS activation (révision déjà active) : rien à republier,
  // seuls les contrôles restent à faire (lot 53I).
  if (result.status === 'noop' && result.reason === 'NO_DIFFERENCE') {
    result = { status: 'published', runId: run.id, version: result.version ?? '', created: {}, plan: [], complete: true };
  }

  if (result.status === 'published') {
    // Contrôles après activation, montants attendus compris (3,90/39, 6,90/69, 9,90/99 € TTC).
    const grid = await verifyPublishedCatalog(d, { expectedGrid: EXPECTED_V4_GRID })
      .catch((e: Error): PublishedCatalogChecks => ({ ok: false, issues: [`contrôle impossible : ${e.message}`], couples: [], portal: null }));
    const after = await probe().catch(() => null);
    const subscriptionsUnchanged = before != null && after != null && before === after;
    const portalFinalIssue = result.portalFinal && !result.portalFinal.ok ? [`portail final non vérifié : ${result.portalFinal.error ?? '?'}`] : [];
    const issues = [...grid.issues, ...portalFinalIssue, ...(subscriptionsUnchanged ? [] : ['abonnements existants : empreinte modifiée ou illisible pendant la reprise'])];
    const report = {
      ...(base.report ?? {}), key: T.key, runId: run.id, version: result.version, checks: grid, portalFinal: result.portalFinal ?? null, subscriptionsUnchanged,
      subscriptionsBefore: before, subscriptionsAfter: after,
      pricesCreated: 0, revaluation: 'aucune', notifications: 'aucune', backfill: state.backfillCompletedAt ? 'terminée' : 'non exigée (amorçage)',
      step: issues.length ? 'controles' : 'terminee',
    };
    if (issues.length) {
      await save({ status: 'CHECK_FAILED', completedAt: d.now(), lastError: issues.join(' ; ').slice(0, 1000), report });
      await d.anomalies.report({ fingerprint: fpRecovery, title: 'Catalogue Stripe : grille publiée par le rattrapage, contrôles en écart', detail: { context, ...report, issues } }).catch(() => undefined);
      return { status: 'failed', reason: issues.join(' ; ') };
    }
    await save({ status: 'DONE', completedAt: d.now(), lastError: null, report });
    await d.anomalies.resolve(fpRecovery).catch(() => undefined);
    // Chaîne entière vérifiée : anomalies de l'incident résolues (rattrapages
    // antérieurs compris — leur ligne reste FAILED pour l'historique).
    for (const fp of ['publication', 'portal', 'portal-restore', 'portal-final', 'post-check']) {
      await d.anomalies.resolve(catalogFingerprint(context, fp)).catch(() => undefined);
    }
    for (const k of T.after ?? []) await d.anomalies.resolve(catalogFingerprint(context, 'recovery', k)).catch(() => undefined);
    console.info(JSON.stringify({ evt: 'billing.catalog.recovery_done', context, key: T.key, runId: run.id, version: result.version }));
    return { status: 'done', runId: run.id, version: result.version, checks: grid };
  }

  const reason = result.status === 'failed' ? `${result.step}: ${result.reason}` : result.status === 'refused' ? `refus : ${result.reason}` : `résultat inattendu : ${result.status}`;
  const transient = result.status === 'failed' && result.transient === true;
  const blocking = { step: result.status === 'failed' ? result.step : result.status, error: reason.slice(0, 1000) };
  if (transient && attempts < RECOVERY_MAX_ATTEMPTS) {
    const next = new Date(d.now().getTime() + recoveryDelayMs(attempts));
    await save({ status: 'RETRY_WAIT', lastError: reason.slice(0, 1000), nextAttemptAt: next, report: { ...(base.report ?? {}), blocking, step: blocking.step } });
    return { status: 'retry_wait', reason, nextAttemptAt: next.toISOString() };
  }
  return terminal(transient ? `${reason} (tentatives épuisées : ${attempts})` : reason, { blocking, step: blocking.step });
}
