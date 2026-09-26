/**
 * Abonnements & paiements — CDC Back-Office V1 §7.
 * Synthèse (SUB-001), statut de paiement dérivé (SUB-003, SUB-010), tri
 * (SUB-007), pagination (SUB-008), absence de données interdites.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: { unsafe: vi.fn() } }));

const {
  buildSubscriptionSummary,
  deriveSubscriptionStatus,
  derivePaymentStatus,
  derivePaymentDisplayStatus,
  nextRenewalAt,
  scheduledEndAt,
  toListItem,
  sortSubscriptions,
  paginate,
  parseSubscriptionSort,
} = await import('../subscriptions.service');
type Row = import('../subscriptions.service').SubscriptionSourceRow;

const NOW = new Date('2026-09-26T10:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

function row(over: Partial<Row> = {}): Row {
  return {
    accountId: 1,
    accountName: 'Compte',
    ownerEmail: 'a@b.fr',
    planCode: 'premium',
    planLabel: 'Premium',
    status: 'active',
    billingPeriod: 'yearly',
    cancelAtPeriodEnd: false,
    trialEndsAt: null,
    currentPeriodEndAt: day(30),
    firstBilledAt: day(-300),
    accountSubscriptionStatus: 'ACTIVE',
    lastInvoiceStatus: 'paid',
    stripeSubscriptionId: 'sub_123',
    ...over,
  };
}

describe('statut d’abonnement dérivé', () => {
  it('essai en cours puis essai terminé sans facturation', () => {
    expect(deriveSubscriptionStatus(row({ status: 'trialing', firstBilledAt: null, trialEndsAt: day(3) }), NOW)).toBe('trialing');
    expect(deriveSubscriptionStatus(row({ status: 'trialing', firstBilledAt: null, trialEndsAt: day(-1) }), NOW)).toBe('trial_expired');
  });

  it('statuts inconnus traités comme terminés', () => {
    expect(deriveSubscriptionStatus(row({ status: 'canceled' }), NOW)).toBe('canceled');
    expect(deriveSubscriptionStatus(row({ status: 'weird' }), NOW)).toBe('canceled');
  });
});

describe('statut de paiement dérivé (SUB-003, SUB-010)', () => {
  it('échec : abonnement past_due', () => {
    expect(derivePaymentStatus(row({ status: 'past_due' }))).toBe('failed');
  });

  it('échec : compte en période de grâce ou recouvrement (webhooks)', () => {
    for (const s of ['PAST_DUE', 'PAST_DUE_GRACE', 'UNPAID_RECOVERY', 'past_due_grace']) {
      expect(derivePaymentStatus(row({ accountSubscriptionStatus: s }))).toBe('failed');
    }
  });

  it('échec : dernière facture irrécouvrable', () => {
    expect(derivePaymentStatus(row({ lastInvoiceStatus: 'uncollectible' }))).toBe('failed');
  });

  it('à jour : facture payée ou premier paiement connu', () => {
    expect(derivePaymentStatus(row())).toBe('up_to_date');
    expect(derivePaymentStatus(row({ lastInvoiceStatus: null }))).toBe('up_to_date');
  });

  it('aucun paiement : essai sans facturation', () => {
    expect(derivePaymentStatus(row({ status: 'trialing', firstBilledAt: null, lastInvoiceStatus: null }))).toBe('none');
  });

  it('historique : statut de facture affiché sans motif', () => {
    expect(derivePaymentDisplayStatus('paid')).toBe('paid');
    expect(derivePaymentDisplayStatus('uncollectible')).toBe('failed');
    expect(derivePaymentDisplayStatus('open')).toBe('pending');
    expect(derivePaymentDisplayStatus('void')).toBe('void');
  });
});

describe('échéances', () => {
  it('renouvellement = fin de période ; essai = fin d’essai', () => {
    expect(nextRenewalAt(row(), NOW)).toEqual(day(30));
    expect(nextRenewalAt(row({ status: 'trialing', firstBilledAt: null, trialEndsAt: day(5) }), NOW)).toEqual(day(5));
  });

  it('résiliation programmée : fin effective, plus de renouvellement', () => {
    const r = row({ cancelAtPeriodEnd: true });
    expect(nextRenewalAt(r, NOW)).toBeNull();
    expect(scheduledEndAt(r, NOW)).toEqual(day(30));
  });

  it('abonnement terminé : ni renouvellement ni fin programmée', () => {
    const r = row({ status: 'canceled', cancelAtPeriodEnd: true });
    expect(nextRenewalAt(r, NOW)).toBeNull();
    expect(scheduledEndAt(r, NOW)).toBeNull();
  });
});

describe('synthèse (SUB-001)', () => {
  it('compte actifs, essais, fins programmées et paiements échoués', () => {
    const summary = buildSubscriptionSummary([
      row({ accountId: 1 }),
      row({ accountId: 2, status: 'past_due' }),
      row({ accountId: 3, cancelAtPeriodEnd: true }),
      row({ accountId: 4, status: 'trialing', firstBilledAt: null, trialEndsAt: day(4), lastInvoiceStatus: null }),
      row({ accountId: 5, status: 'trialing', firstBilledAt: null, trialEndsAt: day(-4), lastInvoiceStatus: null }),
      row({ accountId: 6, status: 'canceled' }),
      row({ accountId: 7, accountSubscriptionStatus: 'PAST_DUE_GRACE' }),
    ], NOW);
    expect(summary).toEqual({ active: 4, trials: 1, scheduledEnds: 1, failedPayments: 2 });
  });

  it('ne porte pas de MRR (SUB-002)', () => {
    expect(Object.keys(buildSubscriptionSummary([], NOW))).not.toContain('mrr');
  });
});

describe('liste (SUB-003 à SUB-008, SUB-012)', () => {
  it('lien Stripe sans identifiant ni montant ni moyen de paiement', () => {
    const item = toListItem(row(), NOW);
    expect(item.stripeUrl).toMatch(/^https:\/\/dashboard\.stripe\.com\/(test\/)?subscriptions\/sub_123$/);
    const keys = Object.keys(item);
    for (const forbidden of ['stripeSubscriptionId', 'amount', 'amountCents', 'paymentMethod', 'mrr']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('tri par statut de paiement, statut puis échéance, valeurs absentes en fin', () => {
    const items = [
      toListItem(row({ accountId: 1, accountName: 'A' }), NOW),
      toListItem(row({ accountId: 2, accountName: 'B', status: 'past_due' }), NOW),
      toListItem(row({ accountId: 3, accountName: 'C', status: 'canceled' }), NOW),
    ];
    // Échecs d'abord ; à égalité, ordre alphabétique du compte.
    expect(sortSubscriptions(items, 'payment', 'asc').map((i) => i.accountId)).toEqual([2, 1, 3]);
    expect(sortSubscriptions(items, 'status', 'asc').map((i) => i.accountId)).toEqual([2, 1, 3]);
    expect(sortSubscriptions(items, 'renewal', 'asc').map((i) => i.accountId).at(-1)).toBe(3);
    expect(sortSubscriptions(items, 'renewal', 'desc').map((i) => i.accountId).at(-1)).toBe(3);
  });

  it('tri inconnu ramené à l’échéance', () => {
    expect(parseSubscriptionSort('amount')).toBe('renewal');
    expect(parseSubscriptionSort('payment')).toBe('payment');
  });

  it('pagination classique bornée', () => {
    const p = paginate(Array.from({ length: 51 }, (_, i) => i), 9, 25);
    expect(p).toMatchObject({ page: 3, total: 51, totalPages: 3 });
    expect(p.items).toEqual([50]);
    expect(paginate([], 1, 25)).toMatchObject({ page: 1, total: 0, totalPages: 1, items: [] });
  });
});
