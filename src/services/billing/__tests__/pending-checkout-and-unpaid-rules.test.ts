/**
 * APP-PERF-18 (paiement en attente hors du chemin de lecture) et
 * APP-FUNC-31 §6 (événements Stripe désordonnés) — règles pures et câblage.
 * Le comportement en base est vérifié par le scénario E2E
 * `perf18-func31-paiement-impaye.e2e.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PENDING_CHECKOUT_ABANDON_AFTER_MS,
  pendingCheckoutBackoffMs,
  pendingCheckoutState,
} from '@/services/billing/pending-checkout.service';
import { failedPaymentOpensCycle, unpaidRestrictionMessage } from '@/services/billing/unpaid-cycle.rules';
import { isRecentPendingPayment, PENDING_PAYMENT_NOTICE_MS } from '@/lib/trial-status';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const NOW = new Date('2026-10-05T10:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('APP-PERF-18 CA-01 — la lecture des droits n’attend pas Stripe', () => {
  it('trial-status ne synchronise plus le paiement en attente (ni await, ni import Stripe)', () => {
    const src = read('src/app/api/billing/trial-status/route.ts');
    expect(src).not.toMatch(/syncPendingCheckoutForAccount|syncFromCheckoutSession|getStripeServer/);
    expect(src).not.toMatch(/await\s+kickPendingCheckoutReconciliation/);
    expect(src).toContain('if (pending?.due) kickPendingCheckoutReconciliation(accountId);');
  });

  it('le filet de 20 s par instance a disparu du service de synchronisation', () => {
    const src = read('src/services/billing/subscription-sync.service.ts');
    expect(src).not.toMatch(/export async function syncPendingCheckoutForAccount|checkout-pending:/);
  });
});

describe('APP-PERF-18 — état du paiement en attente (pur)', () => {
  it('aucun marqueur → rien à signaler', () => {
    expect(pendingCheckoutState(null, NOW)).toBeNull();
    expect(pendingCheckoutState({ checkoutSessionId: null, checkoutSessionCreatedAt: NOW }, NOW)).toBeNull();
  });

  it('marqueur récent : signalé ; vérification due selon checkout_next_check_at', () => {
    const base = { checkoutSessionId: 'cs_1', checkoutSessionCreatedAt: ago(60_000) };
    expect(pendingCheckoutState({ ...base, checkoutNextCheckAt: null }, NOW)).toEqual({ since: base.checkoutSessionCreatedAt, due: true });
    expect(pendingCheckoutState({ ...base, checkoutNextCheckAt: new Date(NOW.getTime() + 1000) }, NOW)?.due).toBe(false);
    expect(pendingCheckoutState({ ...base, checkoutNextCheckAt: ago(1) }, NOW)?.due).toBe(true);
  });

  it('marqueur trop ancien : plus suivi', () => {
    expect(pendingCheckoutState({ checkoutSessionId: 'cs', checkoutSessionCreatedAt: ago(PENDING_CHECKOUT_ABANDON_AFTER_MS + 1) }, NOW)).toBeNull();
  });

  it('recul progressif, plafonné à 1 h', () => {
    expect(pendingCheckoutBackoffMs(1)).toBe(60_000);
    expect(pendingCheckoutBackoffMs(2)).toBe(120_000);
    expect(pendingCheckoutBackoffMs(50)).toBe(60 * 60_000);
    // Charge bornée : au plus ~1 vérification Stripe par heure et par compte en régime établi.
    const sur24h = Array.from({ length: 40 }, (_, i) => pendingCheckoutBackoffMs(i + 1)).reduce((a, b) => a + b, 0);
    expect(sur24h).toBeGreaterThan(24 * 60 * 60_000);
  });

  it('annonce « en cours de confirmation » limitée à la dernière heure, jamais un droit', () => {
    const now = NOW.getTime();
    expect(isRecentPendingPayment({ pendingPayment: { since: ago(10 * 60_000).toISOString() } }, now)).toBe(true);
    expect(isRecentPendingPayment({ pendingPayment: { since: ago(PENDING_PAYMENT_NOTICE_MS + 1).toISOString() } }, now)).toBe(false);
    expect(isRecentPendingPayment({ pendingPayment: null }, now)).toBe(false);
  });

  it('la tâche planifiée et la création de session posent le suivi explicite', () => {
    expect(read('src/services/scheduling/daily-maintenance-scheduler.ts')).toContain("lock: 'frequent-pending-checkout'");
    const checkout = read('src/app/api/billing/create-checkout-session/route.ts');
    expect(checkout).toContain('checkoutNextCheckAt: new Date(Date.now() + PENDING_CHECKOUT_FIRST_CHECK_DELAY_MS)');
    expect(checkout).toContain('checkoutCheckAttempts: 0');
  });
});

describe('APP-FUNC-31 CA-17 — échec de paiement périmé ou désordonné', () => {
  it.each([
    ['past_due', true],
    ['unpaid', true],
    ['active', false],
    ['trialing', false],
    ['incomplete', false],
    ['canceled', false],
    [null, true],
  ])('abonnement Stripe actuellement %s → cycle ouvert : %s', (status, attendu) => {
    expect(failedPaymentOpensCycle(status)).toBe(attendu);
  });

  it('customer.subscription.* relit l’état courant chez Stripe (jamais l’instantané de l’événement)', () => {
    const src = read('src/app/api/billing/stripe-webhook/route.ts');
    expect(src).toMatch(/syncSubscriptionFromEvent\(subscription,/);
    expect(src).not.toMatch(/syncSubscriptionFromStripe\(\{\s*subscription,/);
    expect(src).toMatch(/if \(!\(await isPaymentFailureCurrent\(subscriptionId\)\)\)/);
  });

  it('Duo : plus de 15 jours de grâce au premier échec', () => {
    const src = read('src/app/api/billing/stripe-webhook/route.ts');
    expect(src).not.toMatch(/15 \* 24 \* 60 \* 60 \* 1000/);
    expect(src).toContain("subscriptionStatus: 'UNPAID_RECOVERY'");
  });
});

describe('APP-FUNC-31 CA-16 — textes', () => {
  it('le message de restriction dit : paiement échoué, restreint, date limite, conséquence ; jamais « grâce »', () => {
    const m = unpaidRestrictionMessage(new Date('2026-12-31T12:00:00Z'));
    expect(m).toMatch(/paiement a échoué/);
    expect(m).toMatch(/suspendues/);
    expect(m).toMatch(/31 décembre 2026/);
    expect(m).toMatch(/supprimées/);
    expect(m).not.toMatch(/gr[âa]ce/i);
  });
});
