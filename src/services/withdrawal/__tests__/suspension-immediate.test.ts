/**
 * Rétractation confirmée : suspension locale des droits AVANT tout appel
 * Stripe, qu'il réussisse ou non.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const order: string[] = [];
let request: Record<string, unknown>;
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: (t: { _name?: string }) => ({ where: () => ({ limit: async () => (order.push('select'), [request]) }) }) }),
    update: (t: unknown) => ({ set: (v: Record<string, unknown>) => ({ where: async () => { if ('subscriptionStatus' in v) order.push(`compte:${v.subscriptionStatus}`); if ('status' in v && v.status === 'readonly') order.push('droits:readonly'); if ('failureCode' in v) order.push(`demande:${v.failureCode}`); } }) }),
  },
}));
vi.mock('@/lib/stripe', () => ({ getStripeServer: () => { order.push('stripe'); throw new Error('Stripe indisponible'); } }));
vi.mock('@/services/account/scheduled-deletion.service', () => ({
  scheduleDeletion: async (i: { delayDays?: number }) => { order.push(`suppression-planifiée:${i.delayDays}`); return { id: 77, scheduledAt: new Date() }; },
  executeScheduledDeletion: async () => { order.push('suppression-exécutée'); return { status: 'executed', preserved: { legalAcceptances: 0, withdrawalRequests: 1, invoices: 1 } }; },
}));
vi.mock('@/services/admin/account-status.service', () => ({ revokeUserSessionsNow: async () => { order.push('sessions-révoquées'); return new Date(); } }));
vi.mock('../withdrawal-journal.service', () => ({ recordWithdrawalEvent: async (e: { eventType: string }) => { order.push(`journal:${e.eventType}`); } }));
vi.mock('@/lib/server-cache', () => ({ serverCacheDeleteByPrefix: () => 0, invalidateAccountReadCache: () => 0 }));

const { processWithdrawal } = await import('../withdrawal-processor.service');

beforeEach(() => {
  order.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  request = { publicReference: 'RET-X', status: 'received', accountId: 5, userId: 9, stripeSubscriptionId: 'sub_1', cancellationStatus: 'pending', confirmedAt: new Date(), requestedAt: new Date(), stripeRefundsJson: [] };
});

describe('Stripe indisponible', () => {
  it('le compte passe en lecture seule avant l’appel Stripe ; la demande reste en échec technique pour reprise', async () => {
    const r = await processWithdrawal('RET-X');
    expect(r).toMatchObject({ status: 'failed', failureCode: 'STRIPE_UNAVAILABLE' });
    expect(order.indexOf('droits:readonly')).toBeGreaterThan(-1);
    expect(order.indexOf('compte:WITHDRAWN')).toBeLessThan(order.indexOf('stripe'));
    expect(order).toContain('demande:STRIPE_UNAVAILABLE');
  });

  // Lot 32 (PO-Q2) : la suppression du compte est IMMÉDIATE (délai 0) et ne
  // dépend pas de Stripe — la reprise Stripe se fait sur la demande seule.
  it('PO-Q2 — Stripe indisponible : compte supprimé quand même, immédiatement (délai 0)', async () => {
    const r = await processWithdrawal('RET-X');
    expect(r.accountDeletion).toBe('deleted');
    expect(order).toContain('suppression-planifiée:0');
    expect(order.indexOf('suppression-exécutée')).toBeGreaterThan(order.indexOf('stripe'));
    expect(order).toContain('journal:DELETION_EXECUTED');
  });
});

describe('aucun droit rendu ensuite', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
  it('la synchronisation d’abonnement ne rétablit pas l’écriture sur un abonnement rétracté', () => {
    const sync = read('src/services/billing/subscription-sync.service.ts');
    expect(sync).toContain('const withdrawn = await isWithdrawnSubscription(account.id, subscription.id);');
    expect(sync).toContain("newStatus = 'WITHDRAWN';");
    expect(sync).toContain("rowStatus = 'readonly';");
  });
  it('le statut WITHDRAWN est accepté par la base (0150)', () => {
    expect(read('src/db/migrations/0150_account_status_withdrawn.sql')).toContain("'WITHDRAWN'");
  });
  it('refus d’écriture explicite (pas « essai terminé »)', () => {
    expect(read('src/services/entitlements.service.ts')).toContain('Vous avez exercé votre droit de rétractation');
  });
});
