/**
 * Lot 26 — rétractation (point 3) et espace de stockage (point 7) sur
 * PostgreSQL réel.
 *
 *   AC3 : `GET /api/withdrawal/eligibility` propose la rétractation pendant
 *         la fenêtre et plus à J+15 ; `POST /api/withdrawal/confirm` refuse
 *         hors délai (409) sans rien enregistrer ; aucun contrat payant :
 *         rien n'est proposé.
 *   AC7 : la migration 0260 aligne `plan_limits.max_storage_bytes` sur
 *         1 / 5 / 10 Go ; `/api/account/storage` sert ce plafond.
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const session = { userId: 0, currentAccountId: 0 as number | null };
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));

const GO = 1024 ** 3;
const JOUR = 24 * 3600 * 1000;

scenario('L26-RS', 'Rétractation (fenêtre de 15 jours) et espace de stockage', ({ sql, make }) => {
  async function abonne(joursDepuisSouscription: number) {
    const acc = await make.account({ plan: 'premium' });
    const conclu = new Date(Date.now() - joursDepuisSouscription * JOUR).toISOString();
    await sql`UPDATE account_subscriptions
                 SET billing_period = 'yearly', contract_concluded_at = ${conclu}, first_billed_at = ${conclu}
               WHERE account_id = ${acc.id}`;
    session.userId = acc.ownerUserId;
    session.currentAccountId = acc.id;
    return acc;
  }

  async function eligibilite() {
    const { GET } = await import('@/app/api/withdrawal/eligibility/route');
    const res = await GET(new NextRequest('http://localhost/api/withdrawal/eligibility'));
    expect(res.status).toBe(200);
    return res.json();
  }

  it('lot 26 — AC3 : souscription récente → rétractation proposée', async () => {
    await abonne(2);
    const body = await eligibilite();
    expect(body.eligible).toBe(true);
    expect(body.offerWithdrawal).toBe(true);
    expect(body.contract).not.toBeNull();
  });

  it('lot 26 — AC3 : 15 jours après la souscription → bloc retiré, confirmation refusée (409), rien d’enregistré', async () => {
    const acc = await abonne(15);
    const body = await eligibilite();
    expect(body.offerWithdrawal).toBe(false);
    expect(body.reason).toBe('DEADLINE_PASSED');
    expect(body.existingRequest).toBeNull();

    const { POST } = await import('@/app/api/withdrawal/confirm/route');
    const res = await POST(new NextRequest('http://localhost/api/withdrawal/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Geo', lastName: 'M', receiptEmail: 'geo@test.invalid', idempotencyKey: `wd-${acc.id}` }),
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('WITHDRAWAL_WINDOW_CLOSED');
    const rows = await sql`SELECT 1 FROM withdrawal_requests WHERE account_id = ${acc.id}`;
    expect(rows).toHaveLength(0);
  });

  it('lot 26 — AC3 : aucun contrat payant → rien n’est proposé', async () => {
    const acc = await make.account();
    session.userId = acc.ownerUserId;
    session.currentAccountId = acc.id;
    const body = await eligibilite();
    expect(body.offerWithdrawal).toBe(false);
    expect(body.reason).toBe('NO_PAID_CONTRACT');
  });

  it('lot 26 — AC7 : plafonds 1 / 5 / 10 Go en base et servis à Mon compte', async () => {
    const rows = await sql<{ plan_code: string; max: string }[]>`
      SELECT plan_code, max_storage_bytes::text AS max FROM plan_limits
       WHERE plan_code IN ('standard', 'premium', 'premium_duo')`;
    const parOffre = Object.fromEntries(rows.map((r) => [r.plan_code, Number(r.max)]));
    // Lignes créées par la migration 0066, plafonds posés par 0170 puis 0260.
    expect(parOffre).toEqual({ standard: 1 * GO, premium: 5 * GO, premium_duo: 10 * GO });

    const { getStorageLimitBytes } = await import('@/lib/storage-quota');
    expect(await getStorageLimitBytes('standard')).toBe(1 * GO);
    expect(await getStorageLimitBytes('premium')).toBe(5 * GO);
    expect(await getStorageLimitBytes('premium_duo')).toBe(10 * GO);

    const acc = await make.account({ plan: 'premium' });
    session.userId = acc.ownerUserId;
    session.currentAccountId = acc.id;
    const { GET } = await import('@/app/api/account/storage/route');
    const res = await GET(new NextRequest('http://localhost/api/account/storage'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.limitBytes).toBe(5 * GO);
    expect(body.usedBytes).toBe(0);
  });
});
