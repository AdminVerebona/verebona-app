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

export type PortalAccessCode = 'NO_ACCOUNT' | 'FORBIDDEN' | 'DUO_GUEST' | 'NO_STRIPE_CUSTOMER';

export type PortalAccess =
  | { ok: true; accountId: number; customerId: string }
  | { ok: false; code: PortalAccessCode; status: 403 | 404; message: string };

export const PORTAL_ACCESS_MESSAGES: Readonly<Record<PortalAccessCode, string>> = {
  NO_ACCOUNT: 'Aucun compte Verebona n’est associé à votre connexion.',
  FORBIDDEN: 'Seul le propriétaire du compte peut accéder à la facturation.',
  DUO_GUEST: 'La facturation de cet espace Premium Duo est gérée par la personne titulaire de l’abonnement. Vous n’avez pas accès à sa gestion.',
  NO_STRIPE_CUSTOMER: 'Aucun compte de facturation n\'est associé à ce compte.',
};

const deny = (code: PortalAccessCode, status: 403 | 404): PortalAccess => ({ ok: false, code, status, message: PORTAL_ACCESS_MESSAGES[code] });

/** Statuts d'adhésion qui ne donnent plus aucun droit. */
const ENDED_MEMBERSHIP = `('removed', 'left', 'revoked', 'declined')`;

/** Compte de facturation que l'utilisateur peut gérer, ou motif de refus. */
export async function resolveBillingPortalAccess(userId: number, currentAccountId?: number | null): Promise<PortalAccess> {
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
export interface PortalStripe {
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
