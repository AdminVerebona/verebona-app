/**
 * Centre d'aide GAP-13 / AID-DUO-006 — retirer le second utilisateur, quitter le Duo.
 *
 *   - DELETE /api/duo/member : le titulaire retire le membre (REMOVED) ;
 *   - POST /api/duo/leave : le membre quitte (LEFT) ; le titulaire ne peut pas ;
 *   - conséquences : `left_at`, offre du membre ramenée à la sienne, demandes
 *     en attente annulées et biens déverrouillés, AUCUN bien supprimé ;
 *   - l'interface expose les deux actions (pas seulement le service).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

type Row = Record<string, unknown>;
let selectRows: Record<string, Row[]> = {};
let returningRows: Record<string, Row[]> = {};
const ops: { kind: string; table: string; set?: Row }[] = [];

vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  const select = () => {
    let table = '';
    const c: Record<string, unknown> = {
      from: (t: never) => { table = getTableName(t); return c; },
      innerJoin: () => c,
      where: () => c,
      limit: async () => selectRows[table] ?? [],
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(selectRows[table] ?? []).then(res, rej),
    };
    return c;
  };
  const write = (kind: string) => (t: never) => {
    const table = getTableName(t);
    const op: { kind: string; table: string; set?: Row } = { kind, table };
    ops.push(op);
    const c: Record<string, unknown> = {
      set: (v: Row) => { op.set = v; return c; },
      values: () => c,
      where: () => c,
      returning: async () => returningRows[table] ?? [],
      then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
    };
    return c;
  };
  const db = { select, update: write('update'), insert: write('insert'), delete: write('delete') } as Record<string, unknown>;
  db.transaction = async (cb: (tx: unknown) => unknown) => cb(db);
  return { db };
});

let sessionUser = 1;
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: sessionUser, email: 'x@y.fr' }),
    handleSessionError: (e: Error) => new Response(JSON.stringify({ code: e.message }), { status: 401 }),
  },
}));

const { DELETE: removeMember } = await import('../member/route');
const { POST: leave } = await import('../leave/route');
const { planTypeAfterDuoExit } = await import('@/services/duo/duo-exit.service');

const req = (method: string) => new NextRequest('http://x', { method });
const updates = (table: string) => ops.filter((o) => o.kind === 'update' && o.table === table);

beforeEach(() => {
  ops.length = 0;
  selectRows = {};
  returningRows = {};
});

describe('DELETE /api/duo/member (titulaire)', () => {
  beforeEach(() => {
    sessionUser = 1;
    selectRows = {
      duo_accounts: [{ id: 3 }],
      duo_memberships: [{ id: 10, userId: 1 }, { id: 11, userId: 2 }],
      account_memberships: [{ planCode: 'standard', status: 'active' }],
    };
    returningRows = { asset_move_requests: [{ assetId: 50 }], asset_delete_requests: [] };
  });

  it('retire le membre : REMOVED + left_at, offre ramenée, demandes annulées, biens déverrouillés', async () => {
    const res = await removeMember(req('DELETE'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, status: 'REMOVED', cancelledRequests: 1 });

    const membership = updates('duo_memberships')[0];
    expect(membership.set).toMatchObject({ status: 'REMOVED' });
    expect(membership.set?.leftAt).toBeInstanceOf(Date);
    expect(updates('users')[0].set).toMatchObject({ planType: 'STANDARD' });
    expect(updates('asset_move_requests')[0].set).toMatchObject({ status: 'CANCELLED', resolvedByType: 'SYSTEM' });
    expect(updates('asset_delete_requests')[0].set).toMatchObject({ status: 'CANCELLED' });
    expect(updates('assets')[0].set).toMatchObject({ lockState: 'NONE' });
    expect(updates('duo_accounts')[0].set).toMatchObject({ activatedAt: null });
  });

  it('ne supprime aucun bien ni document', async () => {
    await removeMember(req('DELETE'));
    expect(ops.filter((o) => o.kind === 'delete')).toEqual([]);
    expect(updates('assets').every((o) => !('deletedAt' in (o.set ?? {})))).toBe(true);
  });

  it('sans second utilisateur actif : 404 NO_ACTIVE_MEMBER, aucune écriture', async () => {
    selectRows.duo_memberships = [{ id: 10, userId: 1 }];
    const res = await removeMember(req('DELETE'));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('NO_ACTIVE_MEMBER');
    expect(ops).toEqual([]);
  });

  it('impayé Duo : 409 DUO_UNPAID, le membre garde le mode récupération', async () => {
    selectRows.duo_accounts = [{ id: 3, status: 'UNPAID_RECOVERY' }];
    const res = await removeMember(req('DELETE'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('DUO_UNPAID');
    expect(ops).toEqual([]);
  });

  it('pas titulaire d’un Duo : 404 DUO_NOT_FOUND', async () => {
    selectRows.duo_accounts = [];
    expect((await removeMember(req('DELETE'))).status).toBe(404);
  });
});

describe('POST /api/duo/leave (membre)', () => {
  beforeEach(() => {
    sessionUser = 2;
    selectRows = {
      duo_memberships: [{ membershipId: 11, duoId: 3, billingOwnerUserId: 1 }],
      account_memberships: [{ planCode: 'premium', status: 'active' }],
    };
  });

  it('le membre quitte : LEFT, son offre personnelle est rétablie', async () => {
    const res = await leave(req('POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, status: 'LEFT' });
    expect(updates('duo_memberships')[0].set).toMatchObject({ status: 'LEFT' });
    expect(updates('users')[0].set).toMatchObject({ planType: 'PREMIUM' });
  });

  it('le titulaire ne peut pas quitter son propre Duo : 409', async () => {
    sessionUser = 1;
    selectRows.duo_memberships = [{ membershipId: 10, duoId: 3, billingOwnerUserId: 1 }];
    const res = await leave(req('POST'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('OWNER_CANNOT_LEAVE');
    expect(ops).toEqual([]);
  });

  it('hors Duo : 404', async () => {
    selectRows.duo_memberships = [];
    expect((await leave(req('POST'))).status).toBe(404);
  });
});

describe('offre du membre après sa sortie', () => {
  it('reprend celle de son propre compte, Standard à défaut', () => {
    expect(planTypeAfterDuoExit(null)).toBe('STANDARD');
    expect(planTypeAfterDuoExit({ planCode: 'premium', status: 'active' })).toBe('PREMIUM');
    expect(planTypeAfterDuoExit({ planCode: 'premium', status: 'canceled' })).toBe('STANDARD');
    expect(planTypeAfterDuoExit({ planCode: 'standard', status: 'active' })).toBe('STANDARD');
  });
});

describe('interface', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('le titulaire peut retirer le second utilisateur depuis Mon compte', () => {
    const panel = read('src/components/subscription/DuoInvitationPanel.tsx');
    expect(panel).toContain("apiClient.delete('/api/duo/member')");
    expect(panel).toContain('Retirer');
  });

  it('le membre peut quitter le Duo depuis Mon compte', () => {
    const summary = read('src/components/subscription/SubscriptionSummary.tsx');
    expect(summary).toContain('DuoLeaveButton');
    expect(read('src/components/subscription/DuoLeaveButton.tsx')).toContain("apiClient.post('/api/duo/leave'");
  });

  it('une ancienne ligne REMOVED / LEFT est réactivée à la réinvitation (unicité duo, utilisateur)', () => {
    expect(read('src/app/api/duo/join/route.ts')).toMatch(/if \(previous\)/);
  });
});
