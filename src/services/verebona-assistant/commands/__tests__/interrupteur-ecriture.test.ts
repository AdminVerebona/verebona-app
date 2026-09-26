/**
 * Interrupteur des commandes d'écriture — décision produit (écart assumé au
 * CDC §4.8, §5.2, §22.5) : commandes CONSERVÉES, derrière
 * `VEREBONA_ASSISTANT_WRITE_COMMANDS` (défaut activé ; off/false/0 → coupé).
 *
 * Coupé : aucun plan préparé (ports.prepareCommand), confirmation et
 * annulation refusées proprement, en français, sans aucune écriture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  prepareCommand: vi.fn(async () => ({ kind: 'plan', preview: { planId: 'p1', summary: 'Ajouter un rappel.' } })),
  confirmCommandPlan: vi.fn(async () => ({ ok: true, status: 'EXECUTED', summary: 'Fait.', results: [] })),
  cancelCommandPlan: vi.fn(async () => true),
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
vi.mock('../plan.service', () => ({
  prepareCommand: h.prepareCommand,
  confirmCommandPlan: h.confirmCommandPlan,
  cancelCommandPlan: h.cancelCommandPlan,
}));

const { flagOnByDefault, areWriteCommandsEnabled, WRITE_COMMANDS_DISABLED_MESSAGE } = await import('../../config/assistant-config');
const { buildOrchestratorPorts } = await import('../../core/ports');
const confirm = await import('@/app/api/verebona/commands/[planId]/confirm/route');
const cancel = await import('@/app/api/verebona/commands/[planId]/cancel/route');

const INPUT = { accountId: 7, userId: 3, planType: 'PREMIUM', message: 'Ajoute un rappel demain', clientRequestId: 'c', locale: 'fr-FR' };
const post = (url: string) => new NextRequest(url, { method: 'POST' });
const params = { params: Promise.resolve({ planId: 'p1' }) };

beforeEach(() => {
  h.prepareCommand.mockClear();
  h.confirmCommandPlan.mockClear();
  h.cancelCommandPlan.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('valeur de l’interrupteur', () => {
  it('activé par défaut, et pour toute valeur autre que off / false / 0 / no', () => {
    expect(flagOnByDefault(undefined)).toBe(true);
    for (const v of ['on', 'true', '1', 'yes', 'n’importe quoi']) expect(flagOnByDefault(v)).toBe(true);
  });
  it('off / false / 0 / no (casse et espaces ignorés) → désactivé', () => {
    for (const v of ['off', 'OFF', ' false ', '0', 'No']) expect(flagOnByDefault(v)).toBe(false);
  });
  it('relu à chaque appel (pas de cache)', () => {
    vi.stubEnv('VEREBONA_ASSISTANT_WRITE_COMMANDS', 'off');
    expect(areWriteCommandsEnabled()).toBe(false);
    vi.stubEnv('VEREBONA_ASSISTANT_WRITE_COMMANDS', 'on');
    expect(areWriteCommandsEnabled()).toBe(true);
  });
});

describe('ports.prepareCommand', () => {
  it('activé : le plan est préparé', async () => {
    const r = await buildOrchestratorPorts().prepareCommand!(INPUT as never);
    expect(r?.kind).toBe('plan');
    expect(h.prepareCommand).toHaveBeenCalledTimes(1);
  });

  it('désactivé : aucun plan, le service n’est même pas appelé', async () => {
    vi.stubEnv('VEREBONA_ASSISTANT_WRITE_COMMANDS', 'false');
    const r = await buildOrchestratorPorts().prepareCommand!(INPUT as never);
    expect(r).toBeNull();
    expect(h.prepareCommand).not.toHaveBeenCalled();
  });
});

describe('routes de confirmation et d’annulation', () => {
  it('activé : la confirmation exécute le plan', async () => {
    const res = await confirm.POST(post('http://x/api/verebona/commands/p1/confirm'), params);
    expect(res.status).toBe(200);
    expect(h.confirmCommandPlan).toHaveBeenCalledTimes(1);
  });

  it('désactivé : confirmation refusée (403), message français, aucune exécution', async () => {
    vi.stubEnv('VEREBONA_ASSISTANT_WRITE_COMMANDS', '0');
    const res = await confirm.POST(post('http://x/api/verebona/commands/p1/confirm'), params);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('WRITE_COMMANDS_DISABLED');
    expect(body.error.message).toBe(WRITE_COMMANDS_DISABLED_MESSAGE);
    expect(body.error.message).toMatch(/Rien n’a été modifié/);
    expect(h.confirmCommandPlan).not.toHaveBeenCalled();
  });

  it('désactivé : annulation refusée de la même façon', async () => {
    vi.stubEnv('VEREBONA_ASSISTANT_WRITE_COMMANDS', 'off');
    const res = await cancel.POST(post('http://x/api/verebona/commands/p1/cancel'), params);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('WRITE_COMMANDS_DISABLED');
    expect(h.cancelCommandPlan).not.toHaveBeenCalled();
  });
});
