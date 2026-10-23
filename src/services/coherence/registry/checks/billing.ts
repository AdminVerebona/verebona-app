/**
 * Contrôles Abonnements, droits et Duo du registre — lot 83E (CDC cohérence
 * §4.8, §4.9 ; arbitrages C-Q2, C-Q10).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * STRIPE EN LECTURE SEULE — RÉPARATION PAR LA SYNCHRONISATION EXISTANTE
 *
 *   COH-BILLING-STRIPE  l'abonnement local (`account_subscriptions`) reflète
 *     l'abonnement Stripe : statut (dans les deux sens), périodicité,
 *     résiliation programmée, échéance, prix. Lecture Stripe : UNE requête
 *     `subscriptions.retrieve` par compte abonné — AUCUNE écriture Stripe,
 *     aucune facturation, aucun remboursement. Comparaison : `viewOf` /
 *     `desyncReasons` du rapprochement annuel (lot 72F / 76D, mêmes
 *     correspondances que la synchronisation). Réparation : la synchronisation
 *     EXISTANTE `syncSubscriptionFromStripe` (idempotente, sans e-mail
 *     client : `notify: false`), puis recontrôle.
 *   COH-ENTITLEMENTS  les droits effectifs (calculés depuis
 *     `account_subscriptions` par `entitlementsFromSubscription`, source
 *     unique) et l'état dénormalisé lu ailleurs (`accounts.plan_type`,
 *     `accounts.subscription_status`, `users.plan_type` du titulaire) disent
 *     la même chose : `expectedAccountState` (même correspondance que la
 *     synchronisation). Réparation : la même synchronisation depuis Stripe.
 *   COH-DUO-RELATIONS  relations Premium Duo et partage du compte cohérents
 *     avec l'abonnement : utilisateurs du compte dans le quota de l'offre, Duo
 *     actif seulement sous une offre Duo en vigueur, au plus deux membres
 *     actifs, aucun membre actif d'un Duo terminé. DÉTECTION SEULEMENT
 *     (CDC §4.8 : aucune correction ne touche aux droits ni à l'isolation).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * COMPTES NON ÉLIGIBLES (C-Q10) — POINT PO
 *
 * Ces trois contrôles sont déclarés `ineligibleAccounts:
 * 'SUBSCRIPTION_STATE_READ'` : sur un compte non éligible DU FAIT DE SON
 * ABONNEMENT (essai échu, impayé, abonnement terminé, lecture seule,
 * rétractation, sans abonnement), l'orchestrateur ne les exécute qu'en
 * LECTURE : lecture de `account_subscriptions`, `accounts`, `users`,
 * `account_memberships`, `duo_*` et d'UNE lecture Stripe de l'abonnement.
 * Aucun contrôle métier (documents, agenda, TCO…), aucune réparation (le
 * moteur la neutralise : constat FINDING), aucun appel IA, aucune écriture.
 * Un abonnement redevenu actif chez Stripe alors que le compte est resté en
 * lecture seule localement est ainsi CONSTATÉ et remonte en Supervision —
 * la resynchronisation reste celle des webhooks / du BO tant que le PO n'a
 * pas autorisé la réparation sur ces comptes (rapport du lot 83E).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { CheckContext, CoherenceCheck, Inspection, RepairResult } from '../types';
import { hashOf, rows, type Row } from '../util';

// ── Lecture Stripe (injectable pour les tests ; jamais d'écriture) ──────────

export type StripeSubscriptionReader = (subscriptionId: string) => Promise<unknown>;
let lecteurTest: StripeSubscriptionReader | null = null;

/** Réservé aux tests : lecteur Stripe simulé (`null` : client réel). */
export function __setCoherenceStripeReaderForTests(fn: StripeSubscriptionReader | null): void {
  lecteurTest = fn;
}

/** Stripe est-il configuré (sinon : contrôle non applicable, aucun objet) ? */
export function stripeReadable(env: NodeJS.ProcessEnv = process.env): boolean {
  return lecteurTest !== null || !!(env.STRIPE_SECRET_KEY ?? '').trim();
}

async function lireAbonnementStripe(subscriptionId: string): Promise<unknown> {
  if (lecteurTest) return lecteurTest(subscriptionId);
  const { getStripeServer } = await import('@/lib/stripe');
  return getStripeServer().subscriptions.retrieve(subscriptionId);
}

const ressourceAbsente = (e: unknown) => {
  const x = e as { code?: string; type?: string; statusCode?: number; raw?: { code?: string } };
  return x?.code === 'resource_missing' || x?.raw?.code === 'resource_missing' || x?.statusCode === 404;
};

// ── Lectures locales ────────────────────────────────────────────────────────

async function etatLocal(ctx: CheckContext, accountId: number): Promise<Row | null> {
  const [r] = await rows(ctx.sql, `
    SELECT a.id, a.plan_type, a.subscription_status, a.stripe_subscription_id AS account_sub, a.owner_user_id,
           (SELECT u.plan_type FROM users u WHERE u.id = a.owner_user_id) AS owner_plan_type,
           s.plan_code, s.status, s.billing_period, s.cancel_at_period_end, s.current_period_end_at, s.stripe_subscription_id AS row_sub,
           s.stripe_price_id, s.trial_ends_at, s.first_billed_at
      FROM accounts a LEFT JOIN account_subscriptions s ON s.account_id = a.id
     WHERE a.id = $1`, [accountId]);
  return r ?? null;
}

const abonnementStripeDe = (l: Row | null): string | null => ((l?.row_sub ?? l?.account_sub) as string | null) ?? null;

/** Comptes abonnés via Stripe (objet = le compte). */
async function compteAbonneStripe(ctx: CheckContext, accountId: number, afterId: number): Promise<number[]> {
  if (afterId >= accountId) return [];
  const [r] = await rows(ctx.sql, `
    SELECT (a.stripe_subscription_id IS NOT NULL OR s.stripe_subscription_id IS NOT NULL) AS ok
      FROM accounts a LEFT JOIN account_subscriptions s ON s.account_id = a.id WHERE a.id = $1`, [accountId]);
  return r?.ok === true ? [accountId] : [];
}

/**
 * Écarts Stripe ↔ ligne locale (pure, testée) : `base` = `desyncReasons` du
 * rapprochement annuel (statut dans les deux sens, annuel, résiliation,
 * échéance), complété de la périodicité MENSUELLE et du prix.
 */
export function billingDesync(
  base: readonly string[],
  view: { annual: boolean; priceIds: string[] },
  local: { billing_period: string | null; stripe_price_id: string | null } | null,
): string[] {
  if (!local) return ['LOCAL_MISSING'];
  const out = [...base];
  if (!view.annual && view.priceIds.length > 0 && local.billing_period === 'yearly' && !out.includes('BILLING_PERIOD')) out.push('BILLING_PERIOD');
  if (local.stripe_price_id && view.priceIds.length > 0 && !view.priceIds.includes(local.stripe_price_id)) out.push('PRICE');
  return out;
}

/** Resynchronisation EXISTANTE depuis l'abonnement Stripe relu (lecture), sans e-mail client. */
async function resynchroniser(ctx: CheckContext, accountId: number, subscriptionId: string): Promise<RepairResult> {
  const raw = await lireAbonnementStripe(subscriptionId);
  const { syncSubscriptionFromStripe } = await import('@/services/billing/subscription-sync.service');
  const r = await syncSubscriptionFromStripe({ subscription: raw as never, source: `coherence:${ctx.correlationId}`.slice(0, 120), notify: false, accountIdHint: accountId });
  return {
    called: true, service: 'syncSubscriptionFromStripe', aiCalls: 0,
    result: r ? { accountId: r.accountId, oldStatus: r.oldStatus, newStatus: r.newStatus, oldPlanType: r.oldPlanType, newPlanType: r.newPlanType, skipped: r.skipped ?? null } : { synced: false },
    rollbackRef: `subscription_communication_operations:account_id=${accountId};account_subscriptions:account_id=${accountId}`,
  };
}

// ══ COH-BILLING-STRIPE ══════════════════════════════════════════════════════

export const billingStripeCheck: CoherenceCheck = {
  id: 'COH-BILLING-STRIPE',
  version: 1,
  status: 'ACTIVE',
  title: 'Abonnement : la copie locale reflète l’abonnement Stripe (lecture Stripe seule)',
  domain: 'abonnements',
  level: 'N2',
  objectType: 'account',
  scope: 'comptes ayant un abonnement Stripe (un objet par compte)',
  sources: ['Stripe (lecture : subscriptions.retrieve)', 'account_subscriptions', 'accounts'],
  applicability: 'Stripe configuré ; compte éligible, ou non éligible du fait de son abonnement (lecture seule, sans réparation)',
  invariant: 'statut, périodicité, résiliation programmée, échéance et prix locaux = ceux de l’abonnement Stripe',
  anomalies: ['LOCAL_MISSING', 'STATUS', 'BILLING_PERIOD', 'CANCELLATION', 'PERIOD_END', 'PRICE', 'STRIPE_SUBSCRIPTION_NOT_FOUND'],
  autoRepairWhen: 'compte éligible : resynchronisation par le service existant, idempotente, sans e-mail client',
  forbiddenRepairs: ['écrire chez Stripe', 'facturer, rembourser, annuler', 'écrire la copie locale hors du service de synchronisation', 'réparer un compte non éligible'],
  services: ['billing/subscription-sync.service#syncSubscriptionFromStripe', 'billing/annual-renewal-reconcile.service#desyncReasons'],
  chain: ['PERSISTENCE'],
  triggers: ['PLAN_CHANGED'],
  frequency: 'campagne exhaustive quotidienne (webhooks Stripe en continu) + contrôle ciblé après un changement d’offre',
  criticality: 'HIGH',
  tests: ['L83E-E2E-07', 'L83E-E2E-08', 'L83E-U-BILLING'],
  ineligibleAccounts: 'SUBSCRIPTION_STATE_READ',

  async listObjects(ctx, accountId, afterId) {
    if (!stripeReadable()) return []; // Stripe non configuré : non applicable (aucune lecture possible)
    return compteAbonneStripe(ctx, accountId, afterId);
  },

  async objectsForEvent(ctx, accountId) {
    if (!stripeReadable()) return [];
    return compteAbonneStripe(ctx, accountId, 0);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { viewOf, desyncReasons } = await import('@/services/billing/annual-renewal-reconcile.service');
    for (const id of ids) {
      const l = id === accountId ? await etatLocal(ctx, accountId) : null;
      const subId = abonnementStripeDe(l);
      if (!l || !subId) { out.set(id, { verdict: 'GONE' }); continue; }
      let raw: unknown;
      try {
        raw = await lireAbonnementStripe(subId);
      } catch (e) {
        if (ressourceAbsente(e)) {
          out.set(id, {
            verdict: 'FINDING', anomaly: 'STRIPE_SUBSCRIPTION_NOT_FOUND', faultyLink: 'PERSISTENCE', observed: { subscriptionId: subId, localStatus: l.status },
            detail: { subscriptionId: subId, accountScope: ctx.accountScope ?? 'ELIGIBLE' }, inputHash: hashOf({ id, subId, missing: true, status: l.status }),
          });
          continue;
        }
        // Stripe illisible : le contrôle a ÉCHOUÉ (jamais « conforme » par défaut).
        throw new Error(`lecture Stripe de ${subId} impossible : ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
      const v = viewOf(raw);
      const priceIds = (((raw as { items?: { data?: Array<{ price?: { id?: string } }> } }).items?.data) ?? []).map((i) => i.price?.id).filter((x): x is string => !!x);
      const local = l.row_sub || l.status ? {
        status: (l.status as string | null) ?? null, billing_period: (l.billing_period as string | null) ?? null, cancel_at_period_end: (l.cancel_at_period_end as boolean | null) ?? null,
        current_period_end_at: l.current_period_end_at ? new Date(l.current_period_end_at as string).toISOString() : null, stripe_price_id: (l.stripe_price_id as string | null) ?? null,
      } : null;
      const ecarts = billingDesync(local ? desyncReasons(v, { account_id: accountId, ...local }) : [], { annual: v.annual, priceIds }, local);
      const detail = { subscriptionId: subId, stripeStatus: v.status, localStatus: local?.status ?? null, reasons: ecarts, accountScope: ctx.accountScope ?? 'ELIGIBLE' };
      if (!ecarts.length) { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      out.set(id, {
        verdict: 'REPAIRABLE', anomaly: ecarts[0], faultyLink: 'PERSISTENCE',
        expected: { status: v.status, annual: v.annual, cancelScheduled: v.cancelScheduled, renewalTs: v.renewalTs, priceIds },
        observed: local, detail,
        inputHash: hashOf({ id, subId, ecarts, v: [v.status, v.annual, v.cancelScheduled, v.renewalTs, priceIds], l: local }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    for (const { id, inspection } of items) {
      const subId = String((inspection.detail as { subscriptionId?: string }).subscriptionId ?? '');
      if (!subId) continue;
      out.set(id, await resynchroniser(ctx, accountId, subId));
    }
    return out;
  },
};

// ══ COH-ENTITLEMENTS ════════════════════════════════════════════════════════

/** Écarts entre la ligne d'abonnement (droits) et l'état dénormalisé (pure, testée). */
export function entitlementDesync(
  expected: { planType: string | null; status: string } | null,
  observed: { planType: string | null; status: string | null; ownerPlanType: string | null },
): string[] {
  if (!expected) return [];
  const out: string[] = [];
  if (observed.status !== expected.status) out.push('ACCOUNT_STATUS_MISMATCH');
  if (expected.planType && observed.planType !== expected.planType) out.push('ACCOUNT_PLAN_MISMATCH');
  if (observed.ownerPlanType !== null && observed.planType !== null && observed.ownerPlanType !== observed.planType) out.push('OWNER_PLAN_MISMATCH');
  return out;
}

export const entitlementsCheck: CoherenceCheck = {
  id: 'COH-ENTITLEMENTS',
  version: 1,
  status: 'ACTIVE',
  title: 'Droits : l’état d’abonnement lu par l’application concorde avec la ligne d’abonnement (source des droits)',
  domain: 'abonnements',
  level: 'N2',
  objectType: 'account',
  scope: 'comptes abonnés via Stripe (un objet par compte)',
  sources: ['account_subscriptions', 'accounts', 'users', 'entitlements.service#entitlementsFromSubscription'],
  applicability: 'compte éligible, ou non éligible du fait de son abonnement (lecture seule, sans réparation)',
  invariant: 'offre et statut du compte (et offre du titulaire) = ceux que la synchronisation écrit pour la ligne d’abonnement',
  anomalies: ['ACCOUNT_STATUS_MISMATCH', 'ACCOUNT_PLAN_MISMATCH', 'OWNER_PLAN_MISMATCH'],
  autoRepairWhen: 'compte éligible et Stripe lisible : resynchronisation par le service existant (même écriture de toutes les colonnes)',
  forbiddenRepairs: ['écrire les colonnes d’offre directement', 'attribuer un droit', 'écrire chez Stripe', 'réparer un compte non éligible'],
  services: ['billing/subscription-sync.service#expectedAccountState', 'billing/subscription-sync.service#syncSubscriptionFromStripe'],
  chain: ['PERSISTENCE'],
  triggers: ['PLAN_CHANGED'],
  frequency: 'campagne exhaustive quotidienne',
  criticality: 'HIGH',
  tests: ['L83E-E2E-07', 'L83E-U-BILLING'],
  ineligibleAccounts: 'SUBSCRIPTION_STATE_READ',

  async listObjects(ctx, accountId, afterId) {
    return compteAbonneStripe(ctx, accountId, afterId);
  },

  async objectsForEvent(ctx, accountId) {
    return compteAbonneStripe(ctx, accountId, 0);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const [{ expectedAccountState }, { entitlementsFromSubscription }] = await Promise.all([
      import('@/services/billing/subscription-sync.service'), import('@/services/entitlements.service'),
    ]);
    for (const id of ids) {
      const l = id === accountId ? await etatLocal(ctx, accountId) : null;
      if (!l || !abonnementStripeDe(l)) { out.set(id, { verdict: 'GONE' }); continue; }
      const attendu = expectedAccountState({ planCode: (l.plan_code as string | null) ?? null, status: (l.status as string | null) ?? null, cancelAtPeriodEnd: (l.cancel_at_period_end as boolean | null) ?? null });
      const observe = { planType: (l.plan_type as string | null) ?? null, status: (l.subscription_status as string | null) ?? null, ownerPlanType: (l.owner_plan_type as string | null) ?? null };
      const droits = l.status ? entitlementsFromSubscription({
        planCode: (l.plan_code as string | null) ?? null, status: String(l.status),
        trialEndsAt: l.trial_ends_at ? new Date(l.trial_ends_at as string) : null, firstBilledAt: l.first_billed_at ? new Date(l.first_billed_at as string) : null,
      }, ctx.now) : null;
      const ecarts = entitlementDesync(attendu, observe);
      const detail = { subscriptionId: abonnementStripeDe(l), rights: droits ? { plan: droits.plan, canWrite: droits.canWrite, quotas: droits.quotas } : null, accountScope: ctx.accountScope ?? 'ELIGIBLE' };
      if (!ecarts.length) { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      out.set(id, {
        verdict: stripeReadable() ? 'REPAIRABLE' : 'FINDING', anomaly: ecarts[0], faultyLink: 'PERSISTENCE', expected: attendu, observed: observe,
        detail: { ...detail, reasons: ecarts }, inputHash: hashOf({ id, ecarts, attendu, observe, row: [l.plan_code, l.status, l.cancel_at_period_end] }),
      });
    }
    return out;
  },

  async repair(ctx, accountId, items) {
    const out = new Map<number, RepairResult>();
    for (const { id, inspection } of items) {
      const subId = String((inspection.detail as { subscriptionId?: string }).subscriptionId ?? '');
      if (!subId) continue;
      out.set(id, await resynchroniser(ctx, accountId, subId));
    }
    return out;
  },
};

// ══ COH-DUO-RELATIONS ═══════════════════════════════════════════════════════

/** Constats Duo d'un compte (pure, testée). */
export function duoFindings(x: {
  activeMembers: number; maxUsers: number; duoStatus: string | null; duoPlanInForce: boolean; activeDuoMembers: number; endedDuoActiveGuests: number;
}): string[] {
  const out: string[] = [];
  if (x.activeMembers > x.maxUsers) out.push('USERS_OVER_QUOTA');
  if (x.duoStatus && ['ACTIVE', 'TRIALING'].includes(x.duoStatus) && !x.duoPlanInForce) out.push('DUO_ACTIVE_WITHOUT_DUO_PLAN');
  if (x.activeDuoMembers > 2) out.push('DUO_MEMBERS_OVER_LIMIT');
  if (x.endedDuoActiveGuests > 0) out.push('DUO_GUEST_IN_ENDED_DUO');
  return out;
}

export const duoRelationsCheck: CoherenceCheck = {
  id: 'COH-DUO-RELATIONS',
  version: 1,
  status: 'ACTIVE',
  title: 'Premium Duo : relations et partage du compte cohérents avec l’abonnement (détection seule)',
  domain: 'comptes',
  level: 'N2',
  objectType: 'account',
  scope: 'comptes partagés (plus d’un utilisateur) ou titulaires d’un Duo (un objet par compte)',
  sources: ['account_memberships', 'duo_accounts', 'duo_memberships', 'account_subscriptions'],
  applicability: 'compte éligible, ou non éligible du fait de son abonnement (lecture seule)',
  invariant: 'utilisateurs actifs dans le quota de l’offre ; Duo actif sous une offre Duo en vigueur ; au plus deux membres ; aucun invité actif d’un Duo terminé',
  anomalies: ['USERS_OVER_QUOTA', 'DUO_ACTIVE_WITHOUT_DUO_PLAN', 'DUO_MEMBERS_OVER_LIMIT', 'DUO_GUEST_IN_ENDED_DUO'],
  autoRepairWhen: 'jamais (CDC §4.8 : aucune correction automatique des droits ni de l’isolation)',
  forbiddenRepairs: ['retirer un membre', 'modifier un Duo', 'attribuer ou retirer un droit', 'déplacer un bien'],
  services: ['entitlements.service#entitlementsFromSubscription'],
  chain: ['PERSISTENCE'],
  triggers: ['PLAN_CHANGED', 'ACCOUNT_PERMISSION_CHANGED'],
  frequency: 'campagne exhaustive quotidienne',
  criticality: 'HIGH',
  tests: ['L83E-E2E-08', 'L83E-U-BILLING'],
  ineligibleAccounts: 'SUBSCRIPTION_STATE_READ',

  async listObjects(ctx, accountId, afterId) {
    if (afterId >= accountId) return [];
    const [r] = await rows(ctx.sql, `
      SELECT (a.duo_account_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM duo_accounts d WHERE d.billing_owner_user_id = a.owner_user_id)
              OR (SELECT count(*) FROM account_memberships m WHERE m.account_id = a.id AND m.status = 'active' AND m.removed_at IS NULL) > 1) AS ok
        FROM accounts a WHERE a.id = $1`, [accountId]);
    return r?.ok === true ? [accountId] : [];
  },

  async objectsForEvent(ctx, accountId) {
    return this.listObjects!(ctx, accountId, 0, 1);
  },

  async inspect(ctx, accountId, ids) {
    const out = new Map<number, Inspection>();
    const { entitlementsFromSubscription } = await import('@/services/entitlements.service');
    for (const id of ids) {
      if (id !== accountId) { out.set(id, { verdict: 'GONE' }); continue; }
      const [x] = await rows(ctx.sql, `
        SELECT a.id, s.plan_code, s.status, s.trial_ends_at, s.first_billed_at,
               (SELECT count(*)::int FROM account_memberships m WHERE m.account_id = a.id AND m.status = 'active' AND m.removed_at IS NULL) AS members,
               d.id AS duo_id, d.subscription_status AS duo_status,
               (SELECT count(*)::int FROM duo_memberships dm WHERE dm.duo_id = d.id AND dm.status = 'ACTIVE') AS duo_members,
               (SELECT count(*)::int FROM duo_memberships dm WHERE dm.duo_id = d.id AND dm.status = 'ACTIVE' AND dm.user_id <> d.billing_owner_user_id
                   AND d.subscription_status IN ('CANCELED', 'EXPIRED')) AS ended_guests
          FROM accounts a
          LEFT JOIN account_subscriptions s ON s.account_id = a.id
          LEFT JOIN LATERAL (SELECT * FROM duo_accounts d0 WHERE d0.id = a.duo_account_id OR d0.billing_owner_user_id = a.owner_user_id
                              ORDER BY (d0.id = a.duo_account_id) DESC, d0.id DESC LIMIT 1) d ON true
         WHERE a.id = $1`, [accountId]);
      if (!x) { out.set(id, { verdict: 'GONE' }); continue; }
      const droits = entitlementsFromSubscription(x.status ? {
        planCode: (x.plan_code as string | null) ?? null, status: String(x.status),
        trialEndsAt: x.trial_ends_at ? new Date(x.trial_ends_at as string) : null, firstBilledAt: x.first_billed_at ? new Date(x.first_billed_at as string) : null,
      } : null, ctx.now);
      // Offre Duo « en vigueur » : abonnement Duo payé, impayé compris (mode de récupération AID-DUO-005).
      const duoEnVigueur = x.plan_code === 'premium_duo' && ['active', 'trialing', 'past_due'].includes(String(x.status ?? ''));
      const constats = duoFindings({
        activeMembers: Number(x.members ?? 0), maxUsers: droits.quotas.maxUsers, duoStatus: (x.duo_status as string | null) ?? null, duoPlanInForce: duoEnVigueur,
        activeDuoMembers: Number(x.duo_members ?? 0), endedDuoActiveGuests: Number(x.ended_guests ?? 0),
      });
      const detail = {
        members: Number(x.members ?? 0), maxUsers: droits.quotas.maxUsers, plan: droits.plan, duoId: x.duo_id ?? null, duoStatus: x.duo_status ?? null,
        duoMembers: Number(x.duo_members ?? 0), accountScope: ctx.accountScope ?? 'ELIGIBLE',
      };
      if (!constats.length) { out.set(id, { verdict: 'CONSISTENT', detail }); continue; }
      out.set(id, { verdict: 'FINDING', anomaly: constats[0], faultyLink: 'PERSISTENCE', observed: detail, detail: { ...detail, findings: constats }, inputHash: hashOf({ id, constats, detail }) });
    }
    return out;
  },
};
