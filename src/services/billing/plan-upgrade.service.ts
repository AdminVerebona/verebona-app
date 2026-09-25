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
 * (voir `getUpgradePortalConfigurationId`), surchargeable par
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
 * ══════════════════════════════════════════════════════════════════════════
 */
import type Stripe from 'stripe';
import { db } from '@/db';
import { accounts, accountSubscriptions, duoAccounts, duoMemberships } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getStripeServer } from '@/lib/stripe';
import {
  PRICE_CATALOG,
  isBillingPeriod,
  isPlanCode,
  isUpgrade,
  resolvePriceId,
  type BillingPeriod,
  type PlanCode,
} from '@/lib/stripe-prices';
import { cancelScheduledChange } from '@/services/plan-change.service';

export type UpgradeResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason:
        | 'INVALID_TARGET'
        | 'NO_SUBSCRIPTION'
        | 'NOT_AN_UPGRADE'
        | 'SUBSCRIPTION_NOT_ACTIVE'
        | 'NO_STRIPE_CUSTOMER'
        | 'SCHEDULE_RELEASE_FAILED';
    };

const PORTAL_CONFIG_METADATA_KEY = 'verebona_flow';
const PORTAL_CONFIG_METADATA_VALUE = 'immediate_upgrade_v1';
let cachedPortalConfigurationId: string | null = null;

/**
 * Configuration de portail dédiée à la montée en gamme immédiate.
 *
 * Ordre : variable d'environnement, cache mémoire, configuration existante
 * portant nos métadonnées, sinon création (une seule fois par compte
 * Stripe : les suivantes sont retrouvées par leurs métadonnées).
 */
export async function getUpgradePortalConfigurationId(stripe: Stripe): Promise<string> {
  const fromEnv = process.env.STRIPE_PORTAL_UPGRADE_CONFIGURATION_ID?.trim();
  if (fromEnv) return fromEnv;
  if (cachedPortalConfigurationId) return cachedPortalConfigurationId;

  for await (const conf of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
    if (conf.metadata?.[PORTAL_CONFIG_METADATA_KEY] === PORTAL_CONFIG_METADATA_VALUE) {
      cachedPortalConfigurationId = conf.id;
      return conf.id;
    }
  }

  // Produits et prix autorisés : les six prix du catalogue, regroupés par produit.
  const productsById = new Map<string, string[]>();
  for (const plan of Object.keys(PRICE_CATALOG) as PlanCode[]) {
    for (const period of ['monthly', 'yearly'] as BillingPeriod[]) {
      const priceId = resolvePriceId(plan, period);
      const price = await stripe.prices.retrieve(priceId);
      const productId = typeof price.product === 'string' ? price.product : price.product.id;
      productsById.set(productId, [...(productsById.get(productId) ?? []), priceId]);
    }
  }

  const created = await stripe.billingPortal.configurations.create({
    name: 'Verebona — montée en gamme immédiate',
    metadata: { [PORTAL_CONFIG_METADATA_KEY]: PORTAL_CONFIG_METADATA_VALUE },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ['price'],
        // Prorata facturé et encaissé immédiatement (et non reporté).
        proration_behavior: 'always_invoice',
        products: [...productsById].map(([product, prices]) => ({ product, prices })),
      },
    },
  });
  cachedPortalConfigurationId = created.id;
  return created.id;
}

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
  if (subscription.schedule || row.scheduledPlanCode) {
    await cancelScheduledChange(accountId);
    subscription = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
    if (subscription.schedule) return { ok: false, reason: 'SCHEDULE_RELEASE_FAILED' };
  }

  const item = subscription.items.data[0];
  if (!item) return { ok: false, reason: 'NO_SUBSCRIPTION' };

  if (planCode === 'premium_duo') {
    await ensureDuoAccount({
      stripe,
      accountId,
      ownerUserId: row.ownerUserId,
      customerId: row.stripeCustomerId,
      subscriptionId: subscription.id,
    });
  }

  const configuration = await getUpgradePortalConfigurationId(stripe);
  const portal = await stripe.billingPortal.sessions.create({
    customer: row.stripeCustomerId,
    configuration,
    locale: 'fr',
    // Abandon : retour sur les offres, rien n'a changé.
    return_url: `${appBaseUrl}/mon-compte/offres`,
    flow_data: {
      type: 'subscription_update_confirm',
      subscription_update_confirm: {
        subscription: subscription.id,
        items: [{ id: item.id, price: resolvePriceId(planCode, billingPeriod), quantity: 1 }],
      },
      after_completion: {
        type: 'redirect',
        redirect: { return_url: `${appBaseUrl}/mon-compte/offres?changement=confirme` },
      },
    },
  });

  return { ok: true, url: portal.url };
}
