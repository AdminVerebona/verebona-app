/**
 * Centre d'aide GAP-11 — dépassement de quota après un changement d'offre.
 *
 * Règle unique : aucun bien n'est désactivé ni supprimé ; les biens restent
 * consultables et exportables, leur modification est suspendue (403
 * ASSET_QUOTA_EXCEEDED) sur toutes les routes qui modifient un bien.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
let selectRows: Record<string, Row[]> = {};
const ops: { kind: string; table: string; set?: Row }[] = [];
let decision: { allowed: boolean; reason?: string; message?: string; limit?: number } = { allowed: true };

vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  const select = () => {
    let table = '';
    const c: Record<string, unknown> = {
      from: (t: never) => { table = getTableName(t); return c; },
      innerJoin: () => c,
      where: () => c,
      orderBy: () => c,
      limit: async () => selectRows[table] ?? [],
      then: (res: (v: unknown) => unknown) => Promise.resolve(selectRows[table] ?? []).then(res),
    };
    return c;
  };
  const write = (kind: string) => (t: never) => {
    const op: { kind: string; table: string; set?: Row } = { kind, table: getTableName(t) };
    ops.push(op);
    const c: Record<string, unknown> = {
      set: (v: Row) => { op.set = v; return c; },
      values: () => c,
      where: () => c,
      then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
    };
    return c;
  };
  return { db: { select, update: write('update'), insert: write('insert'), delete: write('delete') } };
});
vi.mock('@/lib/email/billing-emails', () => ({
  sendDowngradeToStandardEmail: async () => undefined,
  sendMemberRemovedDueToDowngradeEmail: async () => undefined,
}));
const canModifyAssets = vi.fn(async () => decision);
vi.mock('@/services/entitlements.service', () => ({ canModifyAssets }));
// La sortie d'un membre (transaction : REMOVED, offre, demandes annulées,
// biens déverrouillés) est testée dans `api/duo/__tests__/duo-exit.test.ts`.
const endMembership = vi.fn(async () => 0);
vi.mock('@/services/duo/duo-exit.service', () => ({
  endMembership,
  isDuoUnpaid: (s: string) => s === 'PAST_DUE_GRACE' || s === 'UNPAID_RECOVERY',
}));

const { enforceStandardLimits, endDuoSharing } = await import('../plan-enforcement');
const { refuserSiModificationBiensSuspendue } = await import('../asset-quota-guard');
const { loadWritableAsset, AssetDetailsError } = await import('@/services/asset-details-write.service');

beforeEach(() => {
  ops.length = 0;
  selectRows = {};
  decision = { allowed: true };
  canModifyAssets.mockClear();
  endMembership.mockClear();
});

describe('enforceStandardLimits', () => {
  it('ne désactive ni ne supprime aucun bien, même au-delà de 2', async () => {
    selectRows = {
      account_memberships: [],
      assets: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    };
    await enforceStandardLimits(10, 1, false);
    expect(ops.filter((o) => o.table === 'assets')).toEqual([]);
    expect(ops.some((o) => o.set?.status === 'INACTIF')).toBe(false);
    // Les invitations en attente restent annulées (un seul utilisateur en Standard).
    expect(ops.some((o) => o.table === 'account_memberships' && o.set?.status === 'removed')).toBe(true);
  });

  it('le code ne contient plus de passage en INACTIF', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/plan-enforcement.ts'), 'utf8');
    expect(src).not.toMatch(/status:\s*'INACTIF'/);
  });
});

describe('fin du partage Duo (AID-DUO-005)', () => {
  it('invitation en attente annulée, second utilisateur retiré, aucun bien touché', async () => {
    selectRows = {
      duo_accounts: [{ id: 3, status: 'CANCELED' }],
      duo_memberships: [{ id: 10, userId: 1 }, { id: 11, userId: 2 }],
    };
    await endDuoSharing(1);
    const duo = ops.find((o) => o.table === 'duo_accounts')!;
    expect(duo.set).toMatchObject({ pendingInviteToken: null, pendingInviteEmail: null });
    // Même sortie complète que « Retirer » (demandes annulées, biens
    // déverrouillés), pour le seul second utilisateur.
    expect(endMembership).toHaveBeenCalledTimes(1);
    expect(endMembership).toHaveBeenCalledWith({ duoId: 3, membershipId: 11, memberUserId: 2, status: 'REMOVED' });
    expect(ops.filter((o) => o.table === 'assets')).toEqual([]);
  });

  it('impayé Duo en cours : le membre reste, pour pouvoir récupérer ses biens', async () => {
    selectRows = { duo_accounts: [{ id: 3, status: 'UNPAID_RECOVERY' }], duo_memberships: [{ id: 11, userId: 2 }] };
    await endDuoSharing(1);
    expect(ops).toEqual([]);
    expect(endMembership).not.toHaveBeenCalled();
  });

  it('passage en Standard : le partage Duo prend fin aussi', async () => {
    selectRows = {
      account_memberships: [],
      duo_accounts: [{ id: 3, status: 'CANCELED' }],
      duo_memberships: [{ id: 11, userId: 2 }],
    };
    await enforceStandardLimits(10, 1, false);
    expect(endMembership).toHaveBeenCalledWith(expect.objectContaining({ memberUserId: 2, status: 'REMOVED' }));
  });
});

describe('garde de modification au-dessus du quota', () => {
  it('compte au-dessus du quota : 403 ASSET_QUOTA_EXCEEDED avec le message des droits', async () => {
    selectRows = { assets: [{ value: 5 }] };
    decision = { allowed: false, reason: 'ASSET_QUOTA_EXCEEDED', limit: 2, message: 'Vos biens restent consultables et exportables.' };
    const res = await refuserSiModificationBiensSuspendue(10);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ code: 'ASSET_QUOTA_EXCEEDED', details: { max_assets: 2 } });
    expect(canModifyAssets).toHaveBeenCalledWith(10, 5);
  });

  it('compte dans son quota : aucune réponse', async () => {
    selectRows = { assets: [{ value: 2 }] };
    expect(await refuserSiModificationBiensSuspendue(10)).toBeNull();
  });

  it('sections de la fiche (et assistant) : WRITE_BLOCKED', async () => {
    selectRows = { assets: [{ id: 5, status: 'EN_SERVICE', lockState: 'NONE', value: 5 }] };
    decision = { allowed: false, reason: 'ASSET_QUOTA_EXCEEDED', limit: 2, message: 'suspendu' };
    await expect(loadWritableAsset(5, 10)).rejects.toBeInstanceOf(AssetDetailsError);
    await expect(loadWritableAsset(5, 10)).rejects.toMatchObject({ code: 'WRITE_BLOCKED' });
  });

  it('toutes les routes qui modifient un bien appliquent la garde', () => {
    const routes = [
      'src/app/api/assets/[id]/thumbnail/route.ts',
      'src/app/api/assets/[id]/substructures/route.ts',
      'src/app/api/assets/[id]/equipments/route.ts',
      'src/app/api/assets/[id]/equipments/[equipId]/route.ts',
      'src/app/api/assets/[id]/energy-materials/route.ts',
      'src/app/api/assets/[id]/cil-profile/route.ts',
      'src/app/api/assets/[id]/valuations/route.ts',
    ];
    for (const r of routes) {
      expect(readFileSync(join(process.cwd(), r), 'utf8'), r).toContain('refuserSiModificationBiensSuspendue');
    }
    const details = readFileSync(join(process.cwd(), 'src/app/api/assets/[id]/details/[section]/route.ts'), 'utf8');
    expect(details).toContain("case 'WRITE_BLOCKED'");
  });
});
