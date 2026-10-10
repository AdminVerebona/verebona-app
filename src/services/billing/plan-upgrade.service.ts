/**
 * Montée en gamme immédiate — Standard → Premium / Premium Duo,
 * Premium → Premium Duo.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE MONTÉE EN GAMME N'ATTEND PLUS L'ÉCHÉANCE
 *
 * Tout changement d'un compte abonné était programmé à la prochaine
 * échéance (toast « Changement programmé pour le JJ/MM/AAAA »), y compris
 * une montée en gamme. Comportement attendu :
 *
 *   - le clic sur « Passer à Premium » / « Passer à Premium Duo » mène à
 *     Stripe ;
 *   - la date d'échéance est conservée (pas de nouveau cycle) ;
 *   - Stripe affiche et encaisse le prorata de la différence d'offre ;
 *   - une fois le paiement effectué, le retour sur Verebona met à jour
 *     l'offre du compte.
 *
 * ── MÉCANISME : PORTAIL CLIENT, FLUX `subscription_update_confirm` ─────────
 *
 * Stripe affiche la facture de prorata, gère l'échec de paiement et la 3DS,
 * puis redirige vers `after_completion.redirect.return_url`. Le prorata
 * n'est encaissé immédiatement que si la configuration du portail porte
 * `proration_behavior: 'always_invoice'` : la configuration par défaut
 * (`create_prorations`) le reporterait sur la facture suivante. D'où une
 * configuration dédiée, retrouvée par ses métadonnées ou créée une fois
 * (voir `portal-configuration.service.ts`, prix réalignés sur la révision active), surchargeable par
 * `STRIPE_PORTAL_UPGRADE_CONFIGURATION_ID`.
 *
 * L'offre du compte est mise à jour par le webhook
 * `customer.subscription.updated` et, sans l'attendre, par
 * `POST /api/billing/sync-subscription` au retour de Stripe.
 *
 * ── PÉRIODICITÉ ───────────────────────────────────────────────────────────
 *
 * À périodicité identique, Stripe conserve l'ancre de facturation. Si
 * l'utilisateur change AUSSI de périodicité (mensuel → annuel), Stripe
 * démarre obligatoirement un nouveau cycle à la date du changement, en
 * déduisant le temps non consommé : c'est une règle Stripe, pas un choix.
 *
 * ── CDC LOOKUP_KEY V4 (§11, LK-47 à LK-54, TC-39 à TC-44) ─────────────────
 *
 *   - le prix cible est résolu UNE fois (révision active, relu chez Stripe,
 *     révision affichée vérifiée), puis utilisé pour la configuration, le
 *     flux et la traçabilité (`billing_price_operations`) ;
 *   - la configuration du portail est ALIGNÉE sur la révision active avant
 *     l'ouverture (y compris imposée par variable, LK-48) ;
 *   - prix ET portail validés AVANT de libérer une programmation : une
 *     erreur de résolution ne fait perdre aucun changement demandé (LK-53,
 *     TC-44) ; si une programmation est libérée, le retour d'abandon le dit ;
 *   - l'item principal est l'item Verebona RECONNU (registre historique),
 *     jamais `items.data[0]` à l'aveugle (LK-73) — un abonné à un ancien
 *     prix monte en gamme vers le prix courant (TC-40) ;
 *   - les droits supérieurs ne sont accordés que par la synchronisation de
 *     l'abonnement payé, jamais par le retour d'URL (LK-52, TC-42) ;
 *   - une revalorisation planifiée devient obsolète (EX-024, RX-13).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { accounts, accountSubscriptions, duoAccounts, duoMemberships } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import { isBillingPeriod, isPlanCode, isUpgrade } from '@/lib/stripe-prices';
import { parseDisplayedRevision } from '@/lib/billing/plan-catalog';
import { cancelScheduledChange } from '@/services/plan-change.service';
import { BillingCatalogError, type PublicOffer, type ResolvedPrice } from './catalog-types';
import { assertDisplayedRevision, resolveCurrentPrice } from './price-catalog.service';
import { ensureUpgradePortalConfiguration } from './portal-configuration.service';
import { primaryItem } from './price-history.service';
import { pendingMutation, recordPriceOperation } from './price-operations.service';
import { supersedeRevaluation } from './price-revaluation.service';

export type UpgradeResult =
  | { ok: true; url: string; scheduledChangeReleased: boolean; offer: PublicOffer }
  | {
      ok: false;
      reason:
        | 'INVALID_TARGET'
        | 'NO_SUBSCRIPTION'
        | 'NOT_AN_UPGRADE'
        | 'SUBSCRIPTION_NOT_ACTIVE'
        | 'NO_STRIPE_CUSTOMER'
        | 'SCHEDULE_RELEASE_FAILED'
        | 'UNRECOGNIZED_SUBSCRIPTION_ITEM'
        | 'MUTATION_IN_PROGRESS'
        | 'PORTAL_UNAVAILABLE'
        | BillingCatalogError['code'];
      offer?: PublicOffer;
    };

export { PORTAL_CONFIG_METADATA_KEY, PORTAL_CONFIG_METADATA_VALUE } from './portal-configuration.service';

/**
 * Premium Duo : le compte Duo doit exister avant la mise à jour, et
 * l'abonnement porter son identifiant (`metadata.duoId`), lu par
 * `syncSubscriptionFromStripe` pour rattacher l'abonnement au Duo.
 * Même règle que la souscription par Checkout.
 */
async function ensureDuoAccount(params: {
  stripe: Stripe;
  accountId: number;
  ownerUserId: number;
  customerId: string;
  subscriptionId: string;
}): Promise<void> {
  const [existing] = await db
    .select({ id: duoAccounts.id })
    .from(duoAccounts)
    .where(eq(duoAccounts.billingOwnerUserId, params.ownerUserId))
    .limit(1);

  let duoId = existing?.id ?? null;
  if (!duoId) {
    const now = new Date();
    const [created] = await db
      .insert(duoAccounts)
      .values({
        billingOwnerUserId: params.ownerUserId,
        subscriptionStatus: 'CANCELED', // activé par la synchronisation
        stripeCustomerId: params.customerId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: duoAccounts.id });
    duoId = created.id;
    await db.insert(duoMemberships).values({
      duoId,
      userId: params.ownerUserId,
      status: 'ACTIVE',
      slot: 0,
      invitedAt: now,
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  await db
    .update(accounts)
    .set({ duoAccountId: duoId, updatedAt: new Date() })
    .where(eq(accounts.id, params.accountId));

  // Mise à jour des seules métadonnées : aucun effet de facturation.
  await params.stripe.subscriptions.update(params.subscriptionId, {
    metadata: { duoId: String(duoId), accountId: String(params.accountId) },
  });
}

/**
 * Prépare la montée en gamme et rend l'URL Stripe où l'utilisateur
 * confirme le prorata.
 */
export async function startImmediateUpgrade(params: {
  accountId: number;
  planCode: string;
  billingPeriod: string;
  appBaseUrl: string;
  /** Révision du prix affiché (LK-34). */
  displayedPriceRevision?: unknown;
  userId?: number | null;
}): Promise<UpgradeResult> {
  const { accountId, planCode, billingPeriod, appBaseUrl } = params;
  if (!isPlanCode(planCode) || !isBillingPeriod(billingPeriod)) {
    return { ok: false, reason: 'INVALID_TARGET' };
  }

  const [row] = await db
    .select({
      planCode: accountSubscriptions.planCode,
      status: accountSubscriptions.status,
      stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
      scheduledPlanCode: accountSubscriptions.scheduledPlanCode,
      stripeCustomerId: accounts.stripeCustomerId,
      ownerUserId: accounts.ownerUserId,
    })
    .from(accountSubscriptions)
    .innerJoin(accounts, eq(accounts.id, accountSubscriptions.accountId))
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);

  if (!row?.stripeSubscriptionId) return { ok: false, reason: 'NO_SUBSCRIPTION' };
  if (!row.stripeCustomerId) return { ok: false, reason: 'NO_STRIPE_CUSTOMER' };
  if (!isUpgrade(row.planCode, planCode)) return { ok: false, reason: 'NOT_AN_UPGRADE' };

  const stripe = getStripeServer();
  let subscription = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
  if (!['active', 'past_due'].includes(subscription.status)) {
    return { ok: false, reason: 'SUBSCRIPTION_NOT_ACTIVE' };
  }

  // ── Prix cible et portail validés AVANT toute libération (LK-53) ──
  let target: ResolvedPrice;
  let configuration: string;
  try {
    target = await resolveCurrentPrice(planCode, billingPeriod, { forPayment: true });
    assertDisplayedRevision(target, parseDisplayedRevision(params.displayedPriceRevision));
  } catch (error) {
    if (error instanceof BillingCatalogError) return { ok: false, reason: error.code, offer: error.offer };
    throw error;
  }
  // Mutation concurrente vers une autre cible (LK-54) : refus, rien n'est libéré.
  if (await pendingMutation(accountId, { targetRevision: target.priceRevision })) return { ok: false, reason: 'MUTATION_IN_PROGRESS' };
  try {
    configuration = await ensureUpgradePortalConfiguration();
  } catch (error) {
    console.error('[upgrade] portail indisponible :', (error as Error).message);
    return { ok: false, reason: 'PORTAL_UNAVAILABLE' };
  }

  // Item principal reconnu (LK-73), vérifié lui aussi avant toute libération.
  const primary = await primaryItem(subscription, 'upgrade');
  if ('error' in primary) return { ok: false, reason: 'UNRECOGNIZED_SUBSCRIPTION_ITEM' };
  const item = primary.item;

  // ══════════════════════════════════════════════════════════════════════
  // UNE BAISSE PROGRAMMÉE EST TOUJOURS ABANDONNÉE
  //
  // La montée en gamme la remplace. Qu'elle vive dans un échéancier Stripe
  // OU seulement en base (baisse programmée avant ce déploiement, ou repli
  // local si l'échéancier n'a pu être créé) : sans cela, le renouvellement
  // appliquerait l'ancienne baisse et annulerait l'offre payée au prorata.
  // Un abonnement encore piloté par un échéancier ne peut pas être modifié
  // depuis le portail : on le vérifie après libération.
  // ══════════════════════════════════════════════════════════════════════
  let scheduledChangeReleased = false;
  if (subscription.schedule || row.scheduledPlanCode) {
    await supersedeRevaluation(subscription.id, 'SUPERSEDED_BY_UPGRADE', stripe).catch((e: Error) =>
      console.error('[upgrade] revalorisation non remplacée :', e.message),
    );
    const cancelled = await cancelScheduledChange(accountId);
    if (!cancelled.ok) return { ok: false, reason: 'SCHEDULE_RELEASE_FAILED' };
    scheduledChangeReleased = Boolean(row.scheduledPlanCode);
    subscription = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
    if (subscription.schedule) return { ok: false, reason: 'SCHEDULE_RELEASE_FAILED' };
  }

  if (planCode === 'premium_duo') {
    await ensureDuoAccount({
      stripe,
      accountId,
      ownerUserId: row.ownerUserId,
      customerId: row.stripeCustomerId,
      subscriptionId: subscription.id,
    });
  }

  const portal = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    configuration,
    locale: 'fr',
    // Abandon : retour sur les offres. Si une programmation a été libérée,
    // l'écran le dit (on ne prétend pas qu'aucun état n'a changé, LK-53).
    return_url: `${appBaseUrl}/mon-compte/offres${scheduledChangeReleased ? '?programmation=annulee' : ''}`,
    flow_data: {
      type: 'subscription_update_confirm',
      subscription_update_confirm: {
        subscription: subscription.id,
        items: [{ id: item.id, price: target.priceId, quantity: 1 }],
      },
      after_completion: {
        type: 'redirect',
        redirect: { return_url: `${appBaseUrl}/mon-compte/offres?changement=confirme` },
      },
    },
  });

  await recordPriceOperation({
    kind: 'upgrade', accountId, userId: params.userId ?? null, price: target,
    previousPriceId: item.price.id, previousAmountCents: item.price.unit_amount ?? null,
    initiator: params.userId ? `user:${params.userId}` : 'user', stripeReference: portal.id ?? null,
  });

  const { toPublicOffer } = await import('./catalog-types');
  return { ok: true, url: portal.url, scheduledChangeReleased, offer: toPublicOffer(target) };
}
