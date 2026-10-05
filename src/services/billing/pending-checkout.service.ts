/**
 * Paiement en attente — réconciliation durable (APP-PERF-18).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * HORS DU CHEMIN DE LECTURE DES DROITS
 *
 * `/api/billing/trial-status` attendait `syncPendingCheckoutForAccount` :
 * tant qu'un paiement Checkout récent restait non appliqué, CHAQUE lecture
 * des droits pouvait attendre une API Stripe (filet de 20 s par instance,
 * donc autant d'appels que d'instances). Les droits se lisent désormais
 * dans la base, sans jamais attendre Stripe.
 *
 * Un paiement validé est appliqué par, dans l'ordre habituel :
 *   1. le webhook `checkout.session.completed` / `invoice.paid` ;
 *   2. la page de retour (`/api/billing/me?session_id=…`) ;
 *   3. CE rattrapage, si les deux premiers ont échoué : tâche planifiée
 *      (`daily-maintenance-scheduler`, à chaque tour) et déclenchement NON
 *      BLOQUANT depuis la lecture des droits quand une vérification est due.
 *
 * Suivi explicite en base (0251) : `checkout_session_id` (le paiement
 * attendu), `checkout_check_attempts`, `checkout_next_check_at`. Ce dernier
 * sert de RÉSERVATION atomique : une seule instance interroge Stripe pour un
 * compte donné, puis la suivante attend le recul. La charge Stripe est donc
 * bornée par compte, quel que soit le nombre d'onglets, de composants ou
 * d'instances.
 *
 * Aucun droit n'est accordé ici : seul `syncSubscriptionFromStripe` écrit
 * l'état payé, et seulement pour une session `complete` dont l'abonnement
 * est payé. L'application est idempotente (le marqueur est effacé dans la
 * même écriture que l'état payé ; les notifications sont dédupliquées) : un
 * paiement n'est appliqué qu'une fois, même si les trois chemins passent.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { accounts } from '@/db/schema';
import { buildFingerprint, reportAnomaly } from '@/services/admin/anomaly.service';
import { syncFromCheckoutSession, type CheckoutSyncOutcome } from './subscription-sync.service';

/** Laisse d'abord au webhook et à la page de retour le temps d'aboutir. */
export const PENDING_CHECKOUT_FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
/** Réservation d'une vérification (une instance à la fois). */
const CLAIM_LEASE_MS = 5 * 60 * 1000;
/** Au-delà, le paiement n'est plus suivi (une session Stripe vit 24 h). */
export const PENDING_CHECKOUT_ABANDON_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Recul entre deux vérifications, selon le nombre déjà faites. */
const BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000];
/** Vérifications sans issue après lesquelles la Supervision est prévenue. */
const ANOMALY_AFTER_ATTEMPTS = 8;

/** Délai avant la prochaine vérification après `attempts` vérifications. Pur. */
export function pendingCheckoutBackoffMs(attempts: number): number {
  const i = Math.max(0, Math.min(BACKOFF_MS.length - 1, attempts - 1));
  return BACKOFF_MS[i];
}

export interface PendingCheckoutRow {
  checkoutSessionId: string | null;
  checkoutSessionCreatedAt: Date | null;
  checkoutNextCheckAt?: Date | null;
}

/**
 * Paiement en attente à signaler à l'utilisateur (sans droit associé). Pur.
 * `due` : une vérification peut être déclenchée maintenant.
 */
export function pendingCheckoutState(
  row: PendingCheckoutRow | null | undefined,
  now: Date = new Date(),
): { since: Date; due: boolean } | null {
  if (!row?.checkoutSessionId || !row.checkoutSessionCreatedAt) return null;
  const since = new Date(row.checkoutSessionCreatedAt);
  if (now.getTime() - since.getTime() > PENDING_CHECKOUT_ABANDON_AFTER_MS) return null;
  const next = row.checkoutNextCheckAt ? new Date(row.checkoutNextCheckAt).getTime() : null;
  return { since, due: next === null || next <= now.getTime() };
}

export type PendingCheckoutOutcome =
  | 'NOT_DUE'      // rien à vérifier, ou vérification réservée par ailleurs
  | 'APPLIED'      // paiement appliqué (ou déjà appliqué)
  | 'PENDING'      // pas encore payé : nouvelle vérification programmée
  | 'EXPIRED'      // session expirée : suivi arrêté, aucun droit
  | 'ABANDONED'    // trop ancien : suivi arrêté
  | 'CLEARED'      // session étrangère au compte : marqueur retiré
  | 'ERROR';       // Stripe injoignable : nouvelle vérification programmée

export interface PendingCheckoutDeps {
  syncFromCheckoutSession: (p: { sessionId: string; accountId: number; userId?: number }) => Promise<CheckoutSyncOutcome>;
}

const defaultDeps: PendingCheckoutDeps = { syncFromCheckoutSession };

/** Réserve la vérification d'un compte (atomique entre instances). */
async function claim(accountId: number, now: Date) {
  const [row] = await db
    .update(accounts)
    .set({
      checkoutNextCheckAt: new Date(now.getTime() + CLAIM_LEASE_MS),
      checkoutCheckAttempts: sql`${accounts.checkoutCheckAttempts} + 1`,
    })
    .where(and(
      eq(accounts.id, accountId),
      isNotNull(accounts.checkoutSessionId),
      or(isNull(accounts.checkoutNextCheckAt), lte(accounts.checkoutNextCheckAt, now)),
    ))
    .returning({
      sessionId: accounts.checkoutSessionId,
      createdAt: accounts.checkoutSessionCreatedAt,
      ownerUserId: accounts.ownerUserId,
      attempts: accounts.checkoutCheckAttempts,
    });
  return row?.sessionId ? row : null;
}

/** Fin du suivi — seulement si le marqueur désigne toujours cette session. */
async function clearMarker(accountId: number, sessionId: string): Promise<void> {
  await db
    .update(accounts)
    .set({ checkoutSessionId: null, checkoutSessionCreatedAt: null, checkoutCheckAttempts: 0, checkoutNextCheckAt: null })
    .where(and(eq(accounts.id, accountId), eq(accounts.checkoutSessionId, sessionId)));
}

async function scheduleNext(accountId: number, sessionId: string, attempts: number, now: Date): Promise<void> {
  await db
    .update(accounts)
    .set({ checkoutNextCheckAt: new Date(now.getTime() + pendingCheckoutBackoffMs(attempts)) })
    .where(and(eq(accounts.id, accountId), eq(accounts.checkoutSessionId, sessionId)));
}

/**
 * Vérifie le paiement en attente d'un compte, si une vérification est due.
 * Ne lève jamais.
 */
export async function reconcilePendingCheckout(
  accountId: number,
  options: { now?: Date } = {},
  deps: PendingCheckoutDeps = defaultDeps,
): Promise<PendingCheckoutOutcome> {
  const now = options.now ?? new Date();
  let claimed: Awaited<ReturnType<typeof claim>> = null;
  try {
    claimed = await claim(accountId, now);
    if (!claimed?.sessionId) return 'NOT_DUE';
    const sessionId = claimed.sessionId;

    const age = claimed.createdAt ? now.getTime() - new Date(claimed.createdAt).getTime() : Infinity;
    if (age > PENDING_CHECKOUT_ABANDON_AFTER_MS) {
      await clearMarker(accountId, sessionId);
      return 'ABANDONED';
    }

    const outcome = await deps.syncFromCheckoutSession({ sessionId, accountId, userId: claimed.ownerUserId });

    if (outcome.status === 'synced' && !outcome.result.skipped && outcome.result.isPaid) {
      // La synchronisation a déjà effacé le marqueur ; effacement défensif.
      await clearMarker(accountId, sessionId);
      console.info(`[pending-checkout] paiement en attente appliqué au compte ${accountId}`);
      return 'APPLIED';
    }
    if (outcome.status === 'ignored' && outcome.reason === 'EXPIRED') {
      await clearMarker(accountId, sessionId);
      return 'EXPIRED';
    }
    if (outcome.status === 'ignored' && outcome.reason === 'NOT_OWNED') {
      await clearMarker(accountId, sessionId);
      return 'CLEARED';
    }

    // Session ouverte, paiement en cours (3DS…), ou complète mais non
    // applicable pour l'instant : on réessaiera, avec recul.
    await scheduleNext(accountId, sessionId, claimed.attempts, now);
    if (claimed.attempts >= ANOMALY_AFTER_ATTEMPTS && outcome.status === 'ignored' && outcome.reason !== 'NOT_COMPLETE') {
      await reportAnomaly({
        domain: 'stripe',
        fingerprint: buildFingerprint('stripe', 'pending-checkout', accountId),
        title: 'Paiement Checkout complet mais non appliqué',
        accountId,
        detail: { sessionId, reason: outcome.reason, attempts: claimed.attempts },
      }).catch(() => undefined);
    }
    return 'PENDING';
  } catch (e) {
    console.error(`[pending-checkout] vérification du compte ${accountId} :`, (e as Error).message);
    if (claimed?.sessionId) {
      await scheduleNext(accountId, claimed.sessionId, claimed.attempts, now).catch(() => undefined);
    }
    return 'ERROR';
  }
}

export interface PendingCheckoutSweepResult {
  scanned: number;
  outcomes: Partial<Record<PendingCheckoutOutcome, number>>;
}

/** Balayage : tous les paiements en attente dont la vérification est due. */
export async function reconcilePendingCheckouts(
  options: { now?: Date; limit?: number } = {},
  deps: PendingCheckoutDeps = defaultDeps,
): Promise<PendingCheckoutSweepResult> {
  const now = options.now ?? new Date();
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(
      isNotNull(accounts.checkoutSessionId),
      or(isNull(accounts.checkoutNextCheckAt), lte(accounts.checkoutNextCheckAt, now)),
    ))
    .orderBy(asc(accounts.checkoutNextCheckAt))
    .limit(options.limit ?? 100);

  const result: PendingCheckoutSweepResult = { scanned: rows.length, outcomes: {} };
  for (const { id } of rows) {
    const o = await reconcilePendingCheckout(id, { now }, deps);
    result.outcomes[o] = (result.outcomes[o] ?? 0) + 1;
  }
  return result;
}

/**
 * Déclenchement NON BLOQUANT depuis une lecture (droits) : la réponse
 * n'attend pas Stripe ; le résultat sera visible à la lecture suivante.
 */
export function kickPendingCheckoutReconciliation(accountId: number): void {
  void reconcilePendingCheckout(accountId).catch(() => undefined);
}
