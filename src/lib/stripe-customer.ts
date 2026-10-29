import Stripe from 'stripe';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { accounts, accountSubscriptions, duoAccounts } from '@/db/schema';

// ══════════════════════════════════════════════════════════════════════════
// CLIENT STRIPE ORPHELIN — AUTO-RÉPARATION
//
// `accounts.stripe_customer_id` n'était lu qu'une fois : s'il était renseigné,
// on l'utilisait sans vérifier qu'il existait encore. Or un identifiant peut
// devenir invalide pour le mode courant :
//   - client créé pendant que la preprod tournait avec une clé live,
//   - base preprod restaurée depuis la prod (tous les `cus_` sont live),
//   - client supprimé à la main dans le dashboard.
//
// Chaque clic sur « Choisir … » échouait alors définitivement sur
// « No such customer ». On vérifie désormais le client, et s'il est
// introuvable on en recrée un dans le mode courant, en purgeant les
// identifiants Stripe qui l'accompagnaient (ils appartiennent au même mode
// inaccessible).
// ══════════════════════════════════════════════════════════════════════════

interface EnsureStripeCustomerInput {
  stripe: Stripe;
  accountId: number;
  userId: number;
  email: string;
  name: string;
  storedCustomerId: string | null;
}

interface EnsureStripeCustomerResult {
  customerId: string;
  /** Un client a été créé (premier paiement ou remplacement d'un orphelin). */
  created: boolean;
  /** L'identifiant stocké était invalide et a été remplacé. */
  replacedCustomerId: string | null;
}

/** Erreur Stripe « objet introuvable » (mode différent, ou objet supprimé). */
export function isStripeResourceMissing(error: unknown): boolean {
  const e = error as { type?: string; code?: string; statusCode?: number } | null;
  return Boolean(
    e &&
    (e.code === 'resource_missing' ||
      (e.type === 'StripeInvalidRequestError' && e.statusCode === 404)),
  );
}

/** Le client stocké est-il utilisable avec la clé courante ? */
async function isCustomerUsable(stripe: Stripe, customerId: string): Promise<boolean> {
  try {
    const customer = await stripe.customers.retrieve(customerId);
    return !(customer as Stripe.DeletedCustomer).deleted;
  } catch (error) {
    if (isStripeResourceMissing(error)) return false;
    throw error;
  }
}

/**
 * Retourne un identifiant de client Stripe valide pour le compte, en le
 * créant si nécessaire, et met la base à jour.
 */
export async function ensureStripeCustomer(
  input: EnsureStripeCustomerInput,
): Promise<EnsureStripeCustomerResult> {
  const { stripe, accountId, userId, email, name, storedCustomerId } = input;

  if (storedCustomerId && (await isCustomerUsable(stripe, storedCustomerId))) {
    return { customerId: storedCustomerId, created: false, replacedCustomerId: null };
  }

  if (storedCustomerId) {
    console.warn(
      `[stripe-customer] client ${storedCustomerId} introuvable pour le compte ${accountId} ` +
      '(autre mode Stripe ou client supprimé) : un nouveau client va être créé.',
    );
  }

  const customer = await stripe.customers.create(
    {
      email,
      name,
      metadata: { userId: String(userId), accountId: String(accountId) },
    },
    // Un double-clic ne crée qu'un seul client. La clé inclut l'ancien
    // identifiant pour qu'un remplacement ultérieur ne rejoue pas ce résultat.
    { idempotencyKey: `verebona-customer-${accountId}-${storedCustomerId ?? 'none'}` },
  );

  if (!storedCustomerId) {
    await db
      .update(accounts)
      .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
      .where(eq(accounts.id, accountId));
    return { customerId: customer.id, created: true, replacedCustomerId: null };
  }

  // Remplacement : l'abonnement et la session de paiement stockés
  // appartiennent au mode inaccessible, ils sont inutilisables.
  await db
    .update(accounts)
    .set({
      stripeCustomerId: customer.id,
      stripeSubscriptionId: null,
      checkoutSessionId: null,
      checkoutSessionCreatedAt: null,
      checkoutCheckAttempts: 0,
      checkoutNextCheckAt: null,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

  await db
    .update(accountSubscriptions)
    .set({ stripeCustomerId: customer.id, stripeSubscriptionId: null, updatedAt: new Date() })
    .where(
      and(
        eq(accountSubscriptions.accountId, accountId),
        eq(accountSubscriptions.stripeCustomerId, storedCustomerId),
      ),
    );

  await db
    .update(duoAccounts)
    .set({ stripeCustomerId: customer.id, stripeSubscriptionId: null, updatedAt: new Date() })
    .where(
      and(
        eq(duoAccounts.billingOwnerUserId, userId),
        eq(duoAccounts.stripeCustomerId, storedCustomerId),
      ),
    );

  console.warn(
    `[stripe-customer] compte ${accountId} : client ${storedCustomerId} remplacé par ${customer.id}.`,
  );

  return { customerId: customer.id, created: true, replacedCustomerId: storedCustomerId };
}

// ══════════════════════════════════════════════════════════════════════════
// LOT 96A — ADRESSE DU CLIENT STRIPE APRÈS UN CHANGEMENT D'ADRESSE PRINCIPALE
// (CDC 18 Q8, P6 : « synchroniser les coordonnées de contact », « conserver
// l'identifiant Stripe »).
//
// Met à jour l'adresse des clients Stripe EXISTANTS dont l'utilisateur est le
// payeur (comptes dont il est titulaire, Premium Duo dont il est le payeur).
// Jamais de création, jamais de changement d'identifiant `cus_…` en base :
// l'abonnement, les factures et le Duo restent rattachés au même client.
// Au mieux : un échec (Stripe indisponible, clé absente, client d'un autre
// mode) est journalisé et n'annule pas le changement d'adresse.
// ══════════════════════════════════════════════════════════════════════════

type StripeCustomerEmailUpdater = (customerId: string, email: string) => Promise<void>;
const UPDATER_OVERRIDE_KEY = '__verebonaStripeCustomerEmailUpdater';

/** TESTS SEULEMENT : remplace l'appel Stripe (`null` : appel réel). */
export function __setStripeCustomerEmailUpdaterForTests(fn: StripeCustomerEmailUpdater | null): void {
  (globalThis as Record<string, unknown>)[UPDATER_OVERRIDE_KEY] = fn;
}

async function defaultUpdater(customerId: string, email: string): Promise<void> {
  const { getStripeServer } = await import('@/lib/stripe-client');
  await getStripeServer().customers.update(customerId, { email });
}

export interface StripeEmailSyncResult {
  customerIds: string[];
  updated: string[];
  failed: string[];
}

export async function syncStripeCustomerEmail(userId: number, email: string): Promise<StripeEmailSyncResult> {
  const owned = await db
    .select({ id: accounts.stripeCustomerId })
    .from(accounts)
    .where(eq(accounts.ownerUserId, userId));
  const duos = await db
    .select({ id: duoAccounts.stripeCustomerId })
    .from(duoAccounts)
    .where(eq(duoAccounts.billingOwnerUserId, userId));
  const customerIds = [...new Set([...owned, ...duos].map((r) => r.id).filter((id): id is string => !!id))];
  const update = ((globalThis as Record<string, unknown>)[UPDATER_OVERRIDE_KEY] as StripeCustomerEmailUpdater | null | undefined) ?? defaultUpdater;
  const result: StripeEmailSyncResult = { customerIds, updated: [], failed: [] };
  for (const id of customerIds) {
    try {
      await update(id, email);
      result.updated.push(id);
    } catch (e) {
      result.failed.push(id);
      console.error(`[stripe-customer] adresse du client ${id} non synchronisée (utilisateur ${userId}) :`, (e as Error)?.message ?? e);
    }
  }
  return result;
}
