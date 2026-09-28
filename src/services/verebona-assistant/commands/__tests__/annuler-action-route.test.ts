/**
 * POST /api/verebona/commands/[planId]/undo — « Annuler » une action exécutée.
 *
 * Défaire écrit dans les données du compte : l'interrupteur
 * VEREBONA_ASSISTANT_WRITE_COMMANDS coupé la refuse (403), comme la
 * confirmation — à la différence de l'annulation d'une proposition.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  undoCommandPlan: vi.fn(async () => ({ ok: true, status: 'UNDONE', alreadyHandled: false, message: 'J’ai annulé cette action.', entities: [{ type: 'agenda_item', id: 5 }] })),
  confirmCommandPlan: vi.fn(async () => ({ ok: true, status: 'EXECUTED', summary: 'Fait.', results: [], undoUntil: '2026-09-28T10:15:00.000Z' })),
}));

vi.mock('@/db', () => ({
  pgClient: Object.assign(vi.fn(), { unsafe: vi.fn(async () => []), begin: vi.fn() }),
  db: {},
  ensureMigrations: vi.fn(async () => {}),
  ensureUnaccent: vi.fn(async () => {}),
}));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => ({ userId: 3, currentAccountId: 7, planType: 'PREMIUM' })),
    handleSessionError: vi.fn(),
  },
}));
vi.mock('../undo.service', () => ({ undoCommandPlan: h.undoCommandPlan }));
vi.mock('../plan.service', () => ({
  confirmCommandPlan: h.confirmCommandPlan,
  outcomeText: (summary: string) => summary,
}));

const { WRITE_COMMANDS_DISABLED_MESSAGE } = await import('../../config/assistant-config');
const undo = await import('@/app/api/verebona/commands/[planId]/undo/route');
const confirm = await import('@/app/api/verebona/commands/[planId]/confirm/route');

const post = (url = 'http://x/api/verebona/commands/p1/undo') => new NextRequest(url, { method: 'POST' });
const params = (planId = 'p1') => ({ params: Promise.resolve({ planId }) });

beforeEach(() => { h.undoCommandPlan.mockClear(); h.confirmCommandPlan.mockClear(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('route d’annulation d’une action exécutée', () => {
  it('succès : 200, propriétaire transmis (compte + utilisateur de la session), entités à rafraîchir', async () => {
    const res = await undo.POST(post(), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      planId: 'p1', status: 'UNDONE', message: 'J’ai annulé cette action.', alreadyHandled: false, entities: [{ type: 'agenda_item', id: 5 }],
    });
    expect(h.undoCommandPlan).toHaveBeenCalledWith({ planId: 'p1', accountId: 7, userId: 3 });
  });

  it('interrupteur coupé : 403 WRITE_COMMANDS_DISABLED, message français, service non appelé', async () => {
    vi.stubEnv('VEREBONA_ASSISTANT_WRITE_COMMANDS', 'off');
    const res = await undo.POST(post(), params());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatchObject({ code: 'WRITE_COMMANDS_DISABLED', message: WRITE_COMMANDS_DISABLED_MESSAGE });
    expect(h.undoCommandPlan).not.toHaveBeenCalled();
  });

  it('identifiant mal formé : 404 sans appel au service', async () => {
    const res = await undo.POST(post(), params('../x'));
    expect(res.status).toBe(404);
    expect(h.undoCommandPlan).not.toHaveBeenCalled();
  });

  it('codes : introuvable 404, lecture seule 403, délai / irréversible / conflit 409, rejouée 200', async () => {
    const cas: Array<[string, number]> = [
      ['PLAN_NOT_FOUND', 404], ['WRITE_REFUSED', 403], ['UNDO_EXPIRED', 409], ['IRREVERSIBLE', 409], ['UNDO_CONFLICT', 409], ['NOT_UNDOABLE', 409],
    ];
    for (const [code, status] of cas) {
      h.undoCommandPlan.mockResolvedValueOnce({ ok: false, code, message: 'm', status: 'EXECUTED' } as never);
      const res = await undo.POST(post(), params());
      expect(res.status, code).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
    h.undoCommandPlan.mockResolvedValueOnce({ ok: true, status: 'UNDONE', alreadyHandled: true, message: 'm', entities: [] } as never);
    const rejouee = await undo.POST(post(), params());
    expect(rejouee.status).toBe(200);
    expect((await rejouee.json()).alreadyHandled).toBe(true);
  });

  it('la confirmation rend la fin de la fenêtre « Annuler »', async () => {
    const res = await confirm.POST(post('http://x/api/verebona/commands/p1/confirm'), params());
    expect((await res.json()).undoUntil).toBe('2026-09-28T10:15:00.000Z');
  });
});
