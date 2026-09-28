/**
 * Fiche Compte : suppression en cours exposée en lecture seule — CDC
 * Back-Office V1 §5.2.1 (« Nom et statut du compte »), ACC-L01, GDP-008.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { accounts, scheduledAccountDeletions } from '@/db/schema';

/** Lignes renvoyées par table interrogée, et clauses WHERE reçues. */
let rowsByTable = new Map<unknown, unknown[]>();
const wheresByTable = new Map<unknown, unknown>();
function selectChain() {
  let table: unknown;
  const chain: Record<string, unknown> = {};
  chain.from = (t: unknown) => { table = t; return chain; };
  chain.where = (cond: unknown) => { wheresByTable.set(table, cond); return chain; };
  for (const m of ['limit', 'orderBy', 'leftJoin', 'innerJoin']) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(rowsByTable.get(table) ?? []).then(res, rej);
  return chain;
}
vi.mock('@/db', () => ({
  db: { select: () => selectChain() },
  pgClient: { unsafe: async () => [] },
}));
vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => 1,
  isSessionError: () => false,
  sessionErrorResponse: () => NextResponse.json({ error: 'AUTH' }, { status: 401 }),
}));
vi.mock('@/lib/session-service', () => ({
  SessionService: { handleSessionError: () => NextResponse.json({ error: 'AUTH' }, { status: 401 }) },
}));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/lib/stripe-links', () => ({ stripeDashboardUrl: () => null }));
vi.mock('@/lib/storage-quota', () => ({
  getAccountStorageUsage: async () => ({ planCode: 'STANDARD', usedBytes: 0, limitBytes: 1 }),
}));
vi.mock('@/services/billing/admin-plan-change.service', () => ({
  changePlanAsAdmin: vi.fn(),
  isAdminAssignablePlan: () => true,
  ADMIN_ASSIGNABLE_PLANS: ['STANDARD', 'PREMIUM'],
  ADMIN_PLAN_CHANGE_HTTP_STATUS: {},
}));
vi.mock('@/services/account/admin-account-deletion.service', () => ({ deleteAccountAsAdmin: vi.fn() }));
vi.mock('@/services/admin/account-history.service', () => ({ loadAccountHistory: async () => [] }));

const { GET } = await import('../route');

const call = () => GET(
  new NextRequest('http://localhost/api/admin/accounts/70'),
  { params: Promise.resolve({ id: '70' }) },
);

const account = {
  id: 70, name: 'Compte Test', ownerUserId: 7, planType: 'PREMIUM', subscriptionStatus: 'ACTIVE',
  stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', isActive: true, createdAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  rowsByTable = new Map<unknown, unknown[]>([[accounts, [account]]]);
  wheresByTable.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('GET /api/admin/accounts/[id] — suppression en cours (§5.2.1)', () => {
  it('expose la date prévue, le motif et l’origine', async () => {
    const scheduledAt = new Date('2026-10-28T08:00:00Z');
    rowsByTable.set(scheduledAccountDeletions, [{ scheduledAt, reason: 'VOLUNTARY', origin: 'user' }]);
    const r = await call();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.deletion).toEqual({ scheduledAt: scheduledAt.toISOString(), reason: 'VOLUNTARY', origin: 'user' });
    // Toujours aucun identifiant Stripe exposé (SUB-012).
    expect(body.account.stripeCustomerId).toBeUndefined();
  });

  it('même règle que la liste : SCHEDULED, portée account ou demande du titulaire', async () => {
    await call();
    const q = new PgDialect().sqlToQuery(wheresByTable.get(scheduledAccountDeletions) as SQL);
    expect(q.sql).toContain('"scheduled_account_deletions"."account_id" = $1');
    expect(q.sql).toContain('"scheduled_account_deletions"."status" = $2');
    expect(q.sql).toMatch(/"scheduled_account_deletions"\."scope" = \$3 or "scheduled_account_deletions"\."user_id" = \$4/);
    expect(q.params).toEqual([70, 'SCHEDULED', 'account', 7]);
  });

  it('aucune suppression programmée : deletion = null', async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect((await r.json()).deletion).toBeNull();
  });
});
