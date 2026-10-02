/**
 * D-J1 (lot 21) — routes BO des réglages de l'assistant : garde admin,
 * modification journalisée, double validation par un second administrateur.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { AssistantSettingsStore, StoredRequest } from '@/services/verebona-assistant/config/assistant-settings';

const h = vi.hoisted(() => ({ admin: 1 as number | null }));
vi.mock('../../config-versions/_shared', () => ({
  requireAdminContext: async () => (h.admin
    ? { ok: true, ctx: { adminUserId: h.admin } }
    : { ok: false, response: NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 }) }),
  toErrorResponse: (e: Error) => NextResponse.json({ error: e.message }, { status: 500 }),
}));
const audit = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: (e: Record<string, unknown>) => audit(e) }));
vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));
vi.mock('@/services/ai/telemetry/t2-request-detail.repository', () => ({ listT2ContentAccesses: async () => [{ requestId: 'r1', result: 'GRANTED' }] }));

const S = await import('@/services/verebona-assistant/config/assistant-settings');
const route = await import('../route');
const decide = await import('../requests/[requestId]/route');

function store(): AssistantSettingsStore {
  const rows = new Map<string, unknown>();
  const reqs: StoredRequest[] = [];
  let v = 0;
  const st: AssistantSettingsStore = {
    version: async () => v,
    readAll: async () => [...rows].map(([key, value]) => ({ key, value, updatedBy: 1, updatedAt: '2026-10-01T00:00:00.000Z' })),
    write: async (k, val) => { rows.set(k, val); v += 1; return { before: null }; },
    createRequest: async (key, value, by) => { const r: StoredRequest = { id: reqs.length + 1, key, value, requestedBy: by, requestedAt: 'x', decidedBy: null, decidedAt: null, status: 'PENDING' }; reqs.push(r); return r; },
    getRequest: async (id) => reqs.find((r) => r.id === id) ?? null,
    decideRequest: async (id, by, status) => {
      const r = reqs.find((x) => x.id === id)!; if (r.status !== 'PENDING') return false;
      Object.assign(r, { status, decidedBy: by });
      if (status === 'APPROVED') await st.write(r.key, r.value, by);
      return true;
    },
    listRequests: async () => reqs,
  };
  return st;
}

const put = (body: unknown) => new NextRequest('http://x/api/admin/ai/assistant-settings', { method: 'PUT', body: JSON.stringify(body) });
const postDecision = (id: number, decision: string) => decide.POST(
  new NextRequest(`http://x/r/${id}`, { method: 'POST', body: JSON.stringify({ decision }) }), { params: Promise.resolve({ requestId: String(id) }) });

beforeEach(() => { h.admin = 1; audit.mockClear(); S.setAssistantSettingsStoreForTests(store()); });

describe('routes des réglages de l’assistant', () => {
  it('administrateurs seulement', async () => {
    h.admin = null;
    expect((await route.GET(new NextRequest('http://x'))).status).toBe(403);
    expect((await route.PUT(put({ key: 'history_days', value: 60 }))).status).toBe(403);
  });

  it('GET : réglages, provenance, journal des consultations sensibles, état du limiteur', async () => {
    const body = await (await route.GET(new NextRequest('http://x'))).json();
    expect(body.settings.find((s: { key: string }) => s.key === 'rate_limit_per_minute')).toMatchObject({ group: 'debits', source: expect.any(String) });
    expect(body.contentReads).toEqual([{ requestId: 'r1', result: 'GRANTED' }]);
    expect(body.rateLimiter).toMatchObject({ mode: 'memory' });
    expect(body.adminUserId).toBe(1);
  });

  it('PUT : appliqué et journalisé ; valeur invalide : 400', async () => {
    expect(await (await route.PUT(put({ key: 'history_days', value: 60 }))).json()).toMatchObject({ status: 'APPLIED', after: 60 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ASSISTANT_SETTING_UPDATE', adminId: 1 }));
    expect((await route.PUT(put({ key: 'history_days', value: 2 }))).status).toBe(400);
  });

  it('modèle preview : demande, refus du même administrateur (403), accord d’un second', async () => {
    const r = await (await route.PUT(put({ key: 'preview_models_allowed', value: true }))).json();
    expect(r).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect((await postDecision(r.requestId, 'approve')).status).toBe(403);
    h.admin = 2;
    expect(await (await postDecision(r.requestId, 'approve')).json()).toEqual({ status: 'APPROVED', key: 'preview_models_allowed' });
    expect(S.effectiveSetting('preview_models_allowed')).toBe(true);
    expect((await postDecision(r.requestId, 'nimporte')).status).toBe(400);
  });
});
