/**
 * Calcul du remboursement — CDC 6 §3.2, §9.3, §9.4, §9.5.
 *
 * Un remboursement mal calculé coûte de l'argent ou expose à un litige. Ces
 * tests couvrent chaque cause d'exclusion du §9.3 séparément.
 */
import { describe, it, expect } from 'vitest';
import {
  isRefundable,
  buildRefundPlan,
  classifyRefundStatus,
  aggregateStatus,
  type PaymentRecord,
} from '@/services/withdrawal/refund-calculator';

const CONCLUDED = new Date('2026-07-01T10:00:00Z');

const payment = (over: Partial<PaymentRecord> = {}): PaymentRecord => ({
  id: 'pi_1',
  amount: 5900,
  amountRefunded: 0,
  currency: 'eur',
  captured: true,
  status: 'succeeded',
  createdAt: new Date('2026-07-01T10:00:05Z'),
  ...over,
});

describe('paiement remboursable (§9.3)', () => {
  it('retient un paiement encaissé', () => {
    expect(isRefundable(payment(), CONCLUDED)).toEqual({ refundable: true });
  });

  it('écarte un paiement échoué', () => {
    const v = isRefundable(payment({ status: 'failed' }), CONCLUDED);
    expect(v.refundable).toBe(false);
  });

  it('écarte un paiement autorisé mais non capturé', () => {
    const v = isRefundable(payment({ captured: false }), CONCLUDED);
    expect(v).toMatchObject({ refundable: false, reason: expect.stringContaining('capturé') });
  });

  it('écarte un paiement déjà intégralement remboursé', () => {
    const v = isRefundable(payment({ amountRefunded: 5900 }), CONCLUDED);
    expect(v).toMatchObject({ refundable: false, reason: expect.stringContaining('déjà') });
  });

  it('retient un paiement partiellement remboursé', () => {
    expect(isRefundable(payment({ amountRefunded: 1000 }), CONCLUDED).refundable).toBe(true);
  });

  it('écarte un paiement antérieur au contrat', () => {
    // Il relève d'un contrat précédent, qui n'est pas celui qu'on rétracte.
    const v = isRefundable(payment({ createdAt: new Date('2026-06-01T10:00:00Z') }), CONCLUDED);
    expect(v).toMatchObject({ refundable: false, reason: expect.stringContaining('antérieur') });
  });

  it('tolère le paiement initial posé juste avant la conclusion', () => {
    // Stripe et Verebona n'horodatent pas au même instant : le paiement
    // initial se situe naturellement à la frontière.
    const v = isRefundable(payment({ createdAt: new Date('2026-07-01T09:59:30Z') }), CONCLUDED);
    expect(v.refundable).toBe(true);
  });

  it('écarte un montant nul', () => {
    expect(isRefundable(payment({ amount: 0 }), CONCLUDED).refundable).toBe(false);
  });
});

describe('plan de remboursement', () => {
  it('rembourse intégralement, sans retenue (§3.2)', () => {
    const plan = buildRefundPlan([payment()], CONCLUDED, 'RET-20260715-ABC234');
    expect(plan.totalAmount).toBe(5900);
    expect(plan.instructions[0].amount).toBe(5900);
  });

  it('ne rembourse que le solde restant après un remboursement partiel', () => {
    const plan = buildRefundPlan([payment({ amountRefunded: 1000 })], CONCLUDED, 'RET-1');
    expect(plan.totalAmount).toBe(4900);
  });

  it('additionne plusieurs paiements du même contrat', () => {
    // Paiement initial plus complément de montée en gamme (§9.3).
    const plan = buildRefundPlan(
      [payment(), payment({ id: 'pi_2', amount: 300, createdAt: new Date('2026-07-05T10:00:00Z') })],
      CONCLUDED,
      'RET-1',
    );
    expect(plan.totalAmount).toBe(6200);
    expect(plan.instructions).toHaveLength(2);
  });

  it('journalise chaque exclusion avec son motif', () => {
    const plan = buildRefundPlan(
      [payment({ id: 'pi_ko', status: 'failed' }), payment()],
      CONCLUDED,
      'RET-1',
    );
    expect(plan.instructions).toHaveLength(1);
    expect(plan.excluded).toHaveLength(1);
    expect(plan.excluded[0].paymentId).toBe('pi_ko');
    expect(plan.excluded[0].reason).toBeTruthy();
  });

  it('ne dépasse jamais le montant encaissé (§9.3)', () => {
    const payments = [
      payment({ id: 'a', amount: 5900, amountRefunded: 2000 }),
      payment({ id: 'b', amount: 300 }),
      payment({ id: 'c', amount: 1000, amountRefunded: 1000 }),
      payment({ id: 'd', amount: 4000, status: 'failed' }),
    ];
    const encaisse = payments
      .filter((p) => p.status === 'succeeded' && p.captured)
      .reduce((sum, p) => sum + p.amount - p.amountRefunded, 0);
    const plan = buildRefundPlan(payments, CONCLUDED, 'RET-1');
    expect(plan.totalAmount).toBe(encaisse);
    expect(plan.totalAmount).toBeLessThanOrEqual(
      payments.reduce((s, p) => s + p.amount, 0),
    );
  });

  it('rend une clé d’idempotence propre à la demande et au paiement (§9.4)', () => {
    const a = buildRefundPlan([payment()], CONCLUDED, 'RET-A');
    const b = buildRefundPlan([payment()], CONCLUDED, 'RET-B');
    // Même paiement, demandes différentes : clés différentes, sinon Stripe
    // rejouerait le premier remboursement au lieu d'en créer un second.
    expect(a.instructions[0].idempotencyKey).not.toBe(b.instructions[0].idempotencyKey);
    // Même demande, même paiement : clé stable, donc rejeu sans effet.
    expect(buildRefundPlan([payment()], CONCLUDED, 'RET-A').instructions[0].idempotencyKey)
      .toBe(a.instructions[0].idempotencyKey);
  });

  it('produit un plan vide sans paiement remboursable', () => {
    const plan = buildRefundPlan([payment({ status: 'failed' })], CONCLUDED, 'RET-1');
    expect(plan.instructions).toHaveLength(0);
    expect(plan.totalAmount).toBe(0);
  });
});

describe('classification des états Stripe (§9.5)', () => {
  it('reconnaît un remboursement réglé', () => {
    expect(classifyRefundStatus('succeeded')).toBe('settled');
  });

  it('reconnaît un remboursement en route', () => {
    expect(classifyRefundStatus('pending')).toBe('in_flight');
    expect(classifyRefundStatus('processing')).toBe('in_flight');
  });

  it('reconnaît les situations appelant une intervention', () => {
    expect(classifyRefundStatus('failed')).toBe('needs_attention');
    expect(classifyRefundStatus('requires_action')).toBe('needs_attention');
    expect(classifyRefundStatus('canceled')).toBe('needs_attention');
  });

  it('traite un statut inconnu comme appelant une intervention', () => {
    // Stripe ajoute des statuts au fil du temps. Les supposer bénins ferait
    // clore des demandes non réglées.
    expect(classifyRefundStatus('quantum_superposition')).toBe('needs_attention');
  });
});

describe('statut global d’une demande', () => {
  it('reste en traitement tant qu’un remboursement est en route', () => {
    expect(aggregateStatus('cancelled', ['succeeded', 'pending'], 2)).toBe('processing');
  });

  it('n’est complète que si tout est réglé', () => {
    expect(aggregateStatus('cancelled', ['succeeded', 'succeeded'], 2)).toBe('completed');
  });

  it('reste en traitement si l’annulation n’a pas abouti', () => {
    expect(aggregateStatus('pending', ['succeeded'], 1)).toBe('processing');
  });

  it('échoue si l’annulation a échoué', () => {
    expect(aggregateStatus('failed', ['succeeded'], 1)).toBe('failed');
  });

  it('échoue si un remboursement appelle une intervention', () => {
    expect(aggregateStatus('cancelled', ['succeeded', 'failed'], 2)).toBe('failed');
  });

  it('se complète sans remboursement quand il n’y a rien à rembourser', () => {
    // Cas d'un contrat conclu sans encaissement encore réalisé.
    expect(aggregateStatus('cancelled', [], 0)).toBe('completed');
  });

  it('accepte une annulation sans objet', () => {
    // Pas d'abonnement Stripe : rien à annuler, seul le remboursement compte.
    expect(aggregateStatus('not_applicable', ['succeeded'], 1)).toBe('completed');
  });
});
