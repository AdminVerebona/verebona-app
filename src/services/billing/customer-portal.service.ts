/**
 * Accès au portail client Stripe (Customer Portal) — logique UNIQUE.
 *
 * Factorisée au lot 68C depuis `POST /api/billing/create-customer-portal-session`
 * pour servir aussi le lien PERMANENT des e-mails (`/mon-compte/abonnement/gerer`,
 * rappel J−7 avant renouvellement annuel) : une URL de session Stripe est
 * temporaire, elle est donc créée AU CLIC, jamais à l'envoi d'un e-mail.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI PEUT OUVRIR LE PORTAIL
 *
 * Le TITULAIRE (adhésion `owner`) d'un compte relié à un client Stripe.
 * Le compte retenu est celui que l'utilisateur POSSÈDE — jamais le compte
 * courant de la session s'il n'en est pas titulaire : l'invité d'un Premium
 * Duo, qui travaille dans l'espace du titulaire, n'obtient jamais le portail
 * du titulaire. Refus explicite et sans fuite (aucune donnée du titulaire) :
 *   · DUO_GUEST          invité actif d'un Duo, sans facturation propre ;
 *   · FORBIDDEN          membre non titulaire ;
 *   · NO_ACCOUNT         aucun compte ;
 *   · NO_STRIPE_CUSTOMER titulaire sans client Stripe (jamais abonné).
 * Ancien comportement corrigé : la première adhésion trouvée (`LIMIT 1` sans
 * ordre) décidait du compte et du refus.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Lot 70B : chaque session utilise la configuration Verebona du portail
 * (résiliation à la fin de la période, sans annulation immédiate) — plus la
 * configuration par défaut du compte Stripe.
 */
import { pgClient } from '@/db';
import type { CustomerPortalConfigStripe } from './customer-portal-configuration.service';

type PortalAccessCode = 'NO_ACCOUNT' | 'FORBIDDEN' | 'DUO_GUEST' | 'NO_STRIPE_CUSTOMER' | 'ACCOUNT_FORBIDDEN' | 'BILLING_MISMATCH' | 'INVALID_ACCOUNT_REF';

type PortalAccess =
  | { ok: true; accountId: number; customerId: string }
  | { ok: false; code: PortalAccessCode; status: 400 | 403 | 404 | 409; message: string };

const PORTAL_ACCESS_MESSAGES: Readonly<Record<PortalAccessCode, string>> = {
  NO_ACCOUNT: 'Aucun compte Verebona n’est associé à votre connexion.',
  FORBIDDEN: 'Seul le propriétaire du compte peut accéder à la facturation.',
  DUO_GUEST: 'La facturation de cet espace Premium Duo est gérée par la personne titulaire de l’abonnement. Vous n’avez pas accès à sa gestion.',
  NO_STRIPE_CUSTOMER: 'Aucun compte de facturation n\'est associé à ce compte.',
  // Lot 72F : réponse UNIFORME (compte d'autrui ou inexistant : aucune information).
  ACCOUNT_FORBIDDEN: 'Ce lien concerne un abonnement que vous ne pouvez pas gérer avec ce compte Verebona. Connectez-vous avec le compte titulaire qui a reçu l’e-mail.',
  BILLING_MISMATCH: 'Les informations de facturation de ce compte doivent être vérifiées par notre équipe avant d’ouvrir l’espace de gestion. Contactez le support.',
  INVALID_ACCOUNT_REF: 'Lien de gestion de l’abonnement invalide.',
};

const deny = (code: PortalAccessCode, status: 400 | 403 | 404 | 409): PortalAccess => ({ ok: false, code, status, message: PORTAL_ACCESS_MESSAGES[code] });

/** Lot 72F : référence durable du compte facturé portée par le lien permanent (identifiant du compte). */
export function parseAccountRef(raw: unknown): number | null | 'INVALID' {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^[1-9][0-9]{0,9}$/.test(v)) return 'INVALID';
  const n = Number(v);
  return n <= 2_147_483_647 ? n : 'INVALID';
}

/** Sous-ensemble Stripe pour le contrôle de cohérence abonnement / client. */
interface PortalSubscriptionReader {
  subscriptions: { retrieve(id: string): Promise<unknown> };
}

/**
 * Lot 72F — accès au portail d'UN compte facturé précis (lien permanent de
 * l'e-mail J−7). Contrôles serveur, jamais de repli vers un autre compte :
 *   · titulaire : adhésion `owner` active ET propriétaire (`owner_user_id`)
 *     du compte ; Premium Duo : payeur du Duo (`billing_owner_user_id`) ;
 *   · invité Duo de ce compte → DUO_GUEST ; tout autre cas (compte d'autrui,
 *     inexistant, adhésion close) → ACCOUNT_FORBIDDEN, réponse uniforme ;
 *   · cohérence compte / abonnement / client Stripe : client du compte et de
 *     l'abonnement local identiques, et client de l'abonnement Stripe relu
 *     identique → sinon BILLING_MISMATCH (aucune session créée).
 * Une erreur Stripe à la relecture LÈVE (portail indisponible, « Réessayer »).
 */
export async function resolveBillingPortalAccessForAccount(userId: number, accountId: number, opts: { stripe?: PortalSubscriptionReader } = {}): Promise<PortalAccess> {
  const [acc] = await pgClient.unsafe<{
    id: number; owner_user_id: number; account_customer: string | null; row_customer: string | null; account_sub: string | null; row_sub: string | null;
    owner_member: boolean; duo_billing_owner: number | null; any_member: boolean; duo_guest: boolean;
  }[]>(
    `SELECT a.id, a.owner_user_id, a.stripe_customer_id AS account_customer, s.stripe_customer_id AS row_customer,
            a.stripe_subscription_id AS account_sub, s.stripe_subscription_id AS row_sub,
            EXISTS (SELECT 1 FROM account_memberships m WHERE m.account_id = a.id AND m.user_id = $1 AND m.role = 'owner'
                       AND lower(COALESCE(m.status, 'active')) NOT IN ${ENDED_MEMBERSHIP}) AS owner_member,
            d.billing_owner_user_id AS duo_billing_owner,
            EXISTS (SELECT 1 FROM account_memberships m WHERE m.account_id = a.id AND m.user_id = $1
                       AND lower(COALESCE(m.status, 'active')) NOT IN ${ENDED_MEMBERSHIP}) AS any_member,
            EXISTS (SELECT 1 FROM duo_memberships dm WHERE dm.duo_id = a.duo_account_id AND dm.user_id = $1 AND dm.status = 'ACTIVE'
                       AND d.billing_owner_user_id IS DISTINCT FROM $1) AS duo_guest
       FROM accounts a
       LEFT JOIN account_subscriptions s ON s.account_id = a.id
       LEFT JOIN duo_accounts d ON d.id = a.duo_account_id
      WHERE a.id = $2`,
    [userId, accountId] as never[],
  );
  if (!acc) return deny('ACCOUNT_FORBIDDEN', 403);
  const holder = acc.owner_member && Number(acc.owner_user_id) === Number(userId)
    && (acc.duo_billing_owner == null || Number(acc.duo_billing_owner) === Number(userId));
  if (!holder) {
    // Invité du Duo de ce compte : refus dédié (sans donnée du titulaire).
    if (acc.duo_guest || (acc.any_member && acc.duo_billing_owner != null)) return deny('DUO_GUEST', 403);
    return deny('ACCOUNT_FORBIDDEN', 403);
  }
  const customers = [acc.account_customer, acc.row_customer].filter((c): c is string => !!c);
  if (customers.length === 0) return deny('NO_STRIPE_CUSTOMER', 404);
  if (new Set(customers).size > 1) return mismatch(accountId, 'LOCAL_CUSTOMERS_DIFFER');
  const customerId = customers[0];
  const subscriptionId = acc.row_sub ?? acc.account_sub;
  if (acc.row_sub && acc.account_sub && acc.row_sub !== acc.account_sub) return mismatch(accountId, 'LOCAL_SUBSCRIPTIONS_DIFFER');
  if (subscriptionId) {
    const stripe = opts.stripe ?? ((await import('@/lib/stripe')).getStripeServer() as unknown as PortalSubscriptionReader);
    let sub: { customer?: string | { id: string } | null } | null = null;
    try {
      sub = await stripe.subscriptions.retrieve(subscriptionId) as { customer?: string | { id: string } | null };
    } catch (e) {
      const err = e as { code?: string; statusCode?: number };
      // Abonnement supprimé chez Stripe : le client reste celui du compte (portail : factures, moyens de paiement).
      if (!(err?.code === 'resource_missing' || err?.statusCode === 404)) throw e;
    }
    const subCustomer = !sub?.customer ? null : typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    if (sub && subCustomer !== customerId) return mismatch(accountId, 'STRIPE_CUSTOMER_DIFFERS');
  }
  return { ok: true, accountId, customerId };
}

/** Incohérence de facturation : refus + journal technique (sans identifiant Stripe). */
function mismatch(accountId: number, detail: string): PortalAccess {
  console.warn(JSON.stringify({ evt: 'billing.customer_portal.billing_mismatch', accountId, detail }));
  return deny('BILLING_MISMATCH', 409);
}

/** Statuts d'adhésion qui ne donnent plus aucun droit. */
const ENDED_MEMBERSHIP = `('removed', 'left', 'revoked', 'declined')`;

/** Compte de facturation que l'utilisateur peut gérer, ou motif de refus. */
export async function resolveBillingPortalAccess(userId: number, currentAccountId?: number | null): Promise<PortalAccess> {
  // Lot 72D : rôle d'adhésion sur l'ESPACE OUVERT. Un membre (non titulaire)
  // n'accède pas à la facturation de cet espace — ni, par repli, à celle d'un
  // autre de ses espaces : il change d'espace pour gérer sa propre offre.
  if (currentAccountId) {
    const [m] = await pgClient.unsafe<{ role: string; duo: boolean }[]>(
      `SELECT m.role, (a.duo_account_id IS NOT NULL OR a.plan_type = 'PREMIUM_DUO') AS duo
         FROM account_memberships m JOIN accounts a ON a.id = m.account_id
        WHERE m.user_id = $1 AND m.account_id = $2 AND lower(m.status) = 'active' LIMIT 1`,
      [userId, currentAccountId] as never[],
    );
    if (m && m.role !== 'owner') return deny(m.duo ? 'DUO_GUEST' : 'FORBIDDEN', 403);
  }
  const owned = await pgClient.unsafe<{ id: number; customer: string | null }[]>(
    `SELECT a.id, COALESCE(a.stripe_customer_id, s.stripe_customer_id) AS customer
       FROM account_memberships m
       JOIN accounts a ON a.id = m.account_id
       LEFT JOIN account_subscriptions s ON s.account_id = a.id
      WHERE m.user_id = $1 AND m.role = 'owner' AND lower(COALESCE(m.status, 'active')) NOT IN ${ENDED_MEMBERSHIP}
      ORDER BY (a.id = $2) DESC, (COALESCE(a.stripe_customer_id, s.stripe_customer_id) IS NOT NULL) DESC, a.id
      LIMIT 1`,
    [userId, currentAccountId ?? 0] as never[],
  );
  const own = owned[0];
  if (own?.customer) return { ok: true, accountId: own.id, customerId: own.customer };

  // Invité d'un Premium Duo sans facturation propre : refus dédié.
  const [guest] = await pgClient.unsafe<{ ok: number }[]>(
    `SELECT 1 AS ok FROM duo_memberships dm JOIN duo_accounts d ON d.id = dm.duo_id
      WHERE dm.user_id = $1 AND dm.status = 'ACTIVE' AND d.billing_owner_user_id <> $1 LIMIT 1`,
    [userId] as never[],
  );
  if (guest) return deny('DUO_GUEST', 403);
  if (own) return deny('NO_STRIPE_CUSTOMER', 404);
  const [member] = await pgClient.unsafe<{ ok: number }[]>(
    `SELECT 1 AS ok FROM account_memberships WHERE user_id = $1 LIMIT 1`, [userId] as never[],
  );
  return member ? deny('FORBIDDEN', 403) : deny('NO_ACCOUNT', 404);
}

/** Sous-ensemble du client Stripe (injectable dans les tests). */
interface PortalStripe {
  billingPortal: {
    sessions: { create(p: { customer: string; return_url: string; locale?: string; configuration?: string }): Promise<{ url: string }> };
    configurations: CustomerPortalConfigStripe['billingPortal']['configurations'];
  };
}

/**
 * Portail inaccessible : la configuration Verebona est introuvable et la
 * configuration par défaut du compte Stripe n'impose pas la fin de période.
 */
export class PortalConfigurationUnavailableError extends Error {
  readonly code = 'PORTAL_CONFIGURATION_UNAVAILABLE';
  constructor(message: string) { super(message); this.name = 'PortalConfigurationUnavailableError'; }
}

/**
 * Crée une session Customer Portal (URL temporaire, à utiliser tout de suite).
 *
 * Lot 70B : TOUJOURS avec la configuration Verebona (résiliation en fin de
 * période imposée, `customer-portal-configuration.service.ts`). Une
 * configuration mémorisée devenue invalide (supprimée, désactivée) est
 * recherchée de nouveau une fois. Configuration Verebona impossible à
 * trouver ou créer (anomalie BO déjà signalée) : repli sur la configuration
 * par défaut UNIQUEMENT si elle impose elle aussi la fin de période ; sinon
 * refus (`PortalConfigurationUnavailableError`) — jamais de portail qui
 * permettrait une annulation immédiate.
 */
export async function createCustomerPortalSession(p: { customerId: string; returnUrl: string; stripe?: PortalStripe; env?: NodeJS.ProcessEnv }): Promise<string> {
  const stripe = p.stripe ?? ((await import('@/lib/stripe')).getStripeServer() as unknown as PortalStripe);
  const cfg = await import('./customer-portal-configuration.service');
  const open = (configuration?: string) => stripe.billingPortal.sessions.create({
    customer: p.customerId, return_url: p.returnUrl, locale: 'fr', ...(configuration ? { configuration } : {}),
  });

  let configurationId: string | null = null;
  try {
    configurationId = (await cfg.ensureCustomerPortalConfiguration({ stripe, env: p.env })).configurationId;
  } catch (e) {
    const def = await cfg.readDefaultPortalConfiguration(stripe).catch(() => null);
    if (!cfg.customerPortalConfigurationUsable(def)) {
      throw new PortalConfigurationUnavailableError(`configuration Verebona du portail indisponible (${(e as Error).message}) et configuration par défaut non conforme`);
    }
    console.warn(JSON.stringify({ evt: 'billing.customer_portal.default_fallback', reason: (e as Error).message }));
    return (await open()).url;
  }

  try {
    return (await open(configurationId)).url;
  } catch (e) {
    // Configuration mémorisée supprimée ou désactivée entre-temps : nouvelle recherche, une fois.
    const err = e as { type?: string; statusCode?: number; param?: string; message?: string };
    const aboutConfiguration = err?.param === 'configuration' || /configuration/i.test(err?.message ?? '');
    if (!aboutConfiguration || !(err?.type === 'StripeInvalidRequestError' || err?.statusCode === 400 || err?.statusCode === 404)) throw e;
    cfg.resetCustomerPortalConfigurationCache();
    configurationId = (await cfg.ensureCustomerPortalConfiguration({ stripe, env: p.env, force: true })).configurationId;
    return (await open(configurationId)).url;
  }
}
