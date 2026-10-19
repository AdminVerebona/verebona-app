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
 */
import { pgClient } from '@/db';

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
  billingPortal: { sessions: { create(p: { customer: string; return_url: string; locale?: string }): Promise<{ url: string }> } };
}

/** Crée une session Customer Portal (URL temporaire, à utiliser tout de suite). */
export async function createCustomerPortalSession(p: { customerId: string; returnUrl: string; stripe?: PortalStripe }): Promise<string> {
  const stripe = p.stripe ?? ((await import('@/lib/stripe')).getStripeServer() as unknown as PortalStripe);
  const session = await stripe.billingPortal.sessions.create({ customer: p.customerId, return_url: p.returnUrl, locale: 'fr' });
  return session.url;
}
