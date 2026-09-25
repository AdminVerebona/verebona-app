/**
 * VER-012 (§26), TST-01 — retour « À tester » → Brouillon.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

let admis = true;
vi.mock('../../../_shared', async (orig) => ({
  ...(await orig<typeof import('../../../_shared')>()),
  requireAdminContext: async () => (admis
    ? { ok: true, ctx: { adminUserId: 1 } }
    : { ok: false, response: NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 }) }),
}));

const demoteToDraft = vi.fn();
vi.mock('@/services/ai/config/config-version.repository', () => ({
  demoteToDraft: (id: number) => demoteToDraft(id),
}));
const invalidateConfigCache = vi.fn();
const invalidateConfigVersionCache = vi.fn();
vi.mock('@/services/ai/config/config-resolver', () => ({ invalidateConfigCache: () => invalidateConfigCache() }));
vi.mock('@/services/ai/telemetry/execution-context', () => ({
  invalidateConfigVersionCache: () => invalidateConfigVersionCache(),
}));

const { POST } = await import('../route');
const { InvalidConfigTransition } = await import('@/services/ai/config/version-state-machine');

const call = (id: string) => POST(
  new NextRequest(`http://localhost/api/admin/ai/config-versions/${id}/demote`, { method: 'POST' }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  admis = true;
  demoteToDraft.mockReset();
  invalidateConfigCache.mockReset();
  invalidateConfigVersionCache.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /config-versions/[id]/demote', () => {
  it('renvoie en Brouillon et vide les caches (la préproduction revient sur l’Active)', async () => {
    demoteToDraft.mockResolvedValue('DRAFT');
    const r = await call('12');
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toEqual({ demoted: true, status: 'DRAFT' });
    expect(demoteToDraft).toHaveBeenCalledWith(12);
    expect(invalidateConfigCache).toHaveBeenCalled();
    expect(invalidateConfigVersionCache).toHaveBeenCalled();
  });

  it('409 si la version n’est pas « À tester » (machine à états)', async () => {
    demoteToDraft.mockRejectedValue(new InvalidConfigTransition('ACTIVE', 'demote'));
    const r = await call('12');
    expect(r.status).toBe(409);
    await expect(r.json()).resolves.toMatchObject({ error: 'INVALID_TRANSITION' });
    expect(invalidateConfigCache).not.toHaveBeenCalled();
  });

  it('400 sur un identifiant illisible, sans toucher à la base', async () => {
    const r = await call('12abc');
    expect(r.status).toBe(400);
    expect(demoteToDraft).not.toHaveBeenCalled();
  });

  it('garde admin : refus rendu tel quel', async () => {
    admis = false;
    const r = await call('12');
    expect(r.status).toBe(403);
    expect(demoteToDraft).not.toHaveBeenCalled();
  });
});
