/**
 * D-J1 (lot 21) — seuils et interrupteurs de l'assistant administrés dans le
 * BO : ordre de résolution, journal, double validation, invalidation entre
 * instances (stockage partagé simulé).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AssistantSettingsStore, StoredRequest } from '../assistant-settings';

const audit = vi.fn(async (_e: Record<string, unknown>) => {});
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: (e: Record<string, unknown>) => audit(e) }));
vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) } }));

const S = await import('../assistant-settings');
const { getAssistantConfig, areWriteCommandsEnabled } = await import('../assistant-config');
const { isAssistantFlagOn } = await import('../assistant-flags');

/** Stockage partagé en mémoire : deux « instances » le lisent. */
function sharedStore() {
  const rows = new Map<string, { value: unknown; updatedBy: number | null; updatedAt: string }>();
  const requests: StoredRequest[] = [];
  let version = 0;
  const store: AssistantSettingsStore = {
    version: async () => version,
    readAll: async () => [...rows.entries()].map(([key, r]) => ({ key, ...r })),
    write: async (key, value, adminId) => {
      const before = rows.get(key)?.value ?? null;
      rows.set(key, { value, updatedBy: adminId, updatedAt: new Date().toISOString() });
      version += 1;
      return { before };
    },
    createRequest: async (key, value, adminId) => {
      if (requests.some((r) => r.key === key && r.status === 'PENDING')) throw Object.assign(new Error('dup'), { code: '23505' });
      const r: StoredRequest = { id: requests.length + 1, key, value, requestedBy: adminId, requestedAt: new Date().toISOString(), decidedBy: null, decidedAt: null, status: 'PENDING' };
      requests.push(r);
      return r;
    },
    getRequest: async (id) => requests.find((r) => r.id === id) ?? null,
    decideRequest: async (id, adminId, status) => {
      const r = requests.find((x) => x.id === id);
      if (!r || r.status !== 'PENDING') return false;
      Object.assign(r, { status, decidedBy: adminId, decidedAt: new Date().toISOString() });
      // Même « transaction » : la valeur approuvée est écrite avec la clôture.
      if (status === 'APPROVED') await store.write(r.key, r.value, adminId);
      return true;
    },
    listRequests: async () => [...requests].reverse(),
  };
  return { store, rows, bumpExternally: (key: string, value: unknown) => { rows.set(key, { value, updatedBy: 9, updatedAt: new Date().toISOString() }); version += 1; } };
}

let shared: ReturnType<typeof sharedStore>;
const ENV = { ...process.env };

beforeEach(() => {
  shared = sharedStore();
  S.setAssistantSettingsStoreForTests(shared.store);
  audit.mockClear();
});
afterEach(() => {
  S.setAssistantSettingsStoreForTests(null);
  process.env = { ...ENV };
  vi.useRealTimers();
});

describe('résolution : BO > environnement > défaut', () => {
  it('défaut, puis variable d’environnement, puis valeur administrée', async () => {
    delete process.env.VEREBONA_ASSISTANT_RATE_LIMIT_PER_MINUTE;
    expect(S.effectiveSetting('rate_limit_per_minute')).toBe(10);
    process.env.VEREBONA_ASSISTANT_RATE_LIMIT_PER_MINUTE = '15';
    expect(S.effectiveSetting('rate_limit_per_minute')).toBe(15);
    await S.updateAssistantSetting({ key: 'rate_limit_per_minute', value: 25, adminId: 1 });
    expect(S.effectiveSetting('rate_limit_per_minute')).toBe(25);
    expect(getAssistantConfig().rateLimitPerMinute).toBe(25);
    const row = S.effectiveAssistantSettings().find((s) => s.key === 'rate_limit_per_minute')!;
    expect(row).toMatchObject({ value: 25, source: 'bo' });
  });

  it('interrupteurs §39 et commandes d’écriture : la valeur du BO prime', async () => {
    process.env.VEREBONA_ASSISTANT_SOURCES = 'on';
    await S.updateAssistantSetting({ key: 'sources', value: false, adminId: 1 });
    expect(isAssistantFlagOn('sources')).toBe(false);
    await S.updateAssistantSetting({ key: 'write_commands', value: false, adminId: 1 });
    expect(areWriteCommandsEnabled()).toBe(false);
    expect(getAssistantConfig().writeCommandsEnabled).toBe(false);
  });

  it('valeur hors bornes ou de mauvais type : refusée', async () => {
    await expect(S.updateAssistantSetting({ key: 'rate_limit_per_minute', value: 0, adminId: 1 })).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await expect(S.updateAssistantSetting({ key: 'sources', value: 'oui', adminId: 1 })).rejects.toMatchObject({ code: 'INVALID_VALUE' });
    await expect(S.updateAssistantSetting({ key: 'inconnu', value: 1, adminId: 1 })).rejects.toMatchObject({ code: 'UNKNOWN_SETTING' });
  });
});

describe('journal (CA-30)', () => {
  it('chaque modification : auteur, avant, après', async () => {
    delete process.env.VEREBONA_ASSISTANT_HISTORY_DAYS;
    await S.updateAssistantSetting({ key: 'history_days', value: 60, adminId: 7 });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      adminId: 7, action: 'ASSISTANT_SETTING_UPDATE', result: 'SUCCESS',
      before: { key: 'history_days', value: 90 }, after: { key: 'history_days', value: 60 },
    }));
  });
});

describe('double validation (§32.7)', () => {
  // Lot 35B : « Modèles preview en production » est supprimé ; le mécanisme
  // de double validation reste, exercé ici sur un réglage de test.
  let retirer: () => void = () => {};
  beforeEach(() => {
    retirer = S.registerAssistantSettingForTests({
      key: 'reglage_sensible_test', env: 'VEREBONA_TEST_REGLAGE_SENSIBLE', group: 'interrupteurs', label: 'Réglage sensible (test)',
      description: 'test', type: 'bool', default: false, doubleValidation: (v) => v === true,
    });
  });
  afterEach(() => retirer());

  it('réglage sensible : demande, puis accord d’un SECOND administrateur', async () => {
    const r = await S.updateAssistantSetting({ key: 'reglage_sensible_test', value: true, adminId: 1 });
    expect(r).toMatchObject({ status: 'PENDING_APPROVAL' });
    expect(S.effectiveSetting('reglage_sensible_test')).toBe(false);
    const id = (r as { requestId: number }).requestId;
    await expect(S.decideAssistantSettingRequest({ requestId: id, adminId: 1, decision: 'approve' })).rejects.toMatchObject({ code: 'SAME_ADMIN' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'ASSISTANT_SETTING_APPROVE', result: 'DENIED' }));
    await S.decideAssistantSettingRequest({ requestId: id, adminId: 2, decision: 'approve' });
    expect(S.effectiveSetting('reglage_sensible_test')).toBe(true);
    await expect(S.decideAssistantSettingRequest({ requestId: id, adminId: 3, decision: 'approve' })).rejects.toMatchObject({ code: 'REQUEST_CLOSED' });
  });

  it('une seule demande en attente ; annulation par le demandeur seulement ; désactiver : immédiat', async () => {
    const r = await S.updateAssistantSetting({ key: 'reglage_sensible_test', value: true, adminId: 1 }) as { requestId: number };
    await expect(S.updateAssistantSetting({ key: 'reglage_sensible_test', value: true, adminId: 2 })).rejects.toMatchObject({ code: 'REQUEST_PENDING' });
    await expect(S.decideAssistantSettingRequest({ requestId: r.requestId, adminId: 2, decision: 'cancel' })).rejects.toMatchObject({ code: 'NOT_REQUESTER' });
    await S.decideAssistantSettingRequest({ requestId: r.requestId, adminId: 1, decision: 'cancel' });
    expect((await S.updateAssistantSetting({ key: 'reglage_sensible_test', value: false, adminId: 1 })).status).toBe('APPLIED');
  });

  it('lot 35B — « Modèles preview en production » supprimé ; statut preview informatif, expérimental distinct', async () => {
    await expect(S.updateAssistantSetting({ key: 'preview_models_allowed', value: true, adminId: 1 })).rejects.toMatchObject({ code: 'UNKNOWN_SETTING' });
    expect(S.isPreviewModel('gemini-3.5-flash-preview-09-2026')).toBe(true);
    expect(S.isPreviewModel('gemini-2.0-flash-exp')).toBe(false); // expérimental, pas preview
    expect(S.isPreviewModel('gemini-3.5-flash-lite')).toBe(false);
  });
});

describe('invalidation entre instances sans redémarrage', () => {
  it('une modification faite ailleurs est vue au plus tard après REFRESH_MS', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await S.refreshAssistantSettings(true);
    expect(S.effectiveSetting('max_ai_calls_per_request')).toBe(2);
    shared.bumpExternally('max_ai_calls_per_request', 1); // autre instance
    await S.refreshAssistantSettings();
    expect(S.effectiveSetting('max_ai_calls_per_request')).toBe(2); // dans la fenêtre
    vi.setSystemTime(Date.now() + S.REFRESH_MS + 1);
    await S.refreshAssistantSettings();
    expect(S.effectiveSetting('max_ai_calls_per_request')).toBe(1);
    expect(getAssistantConfig().maxAiCallsPerRequest).toBe(1);
  });

  it('stockage illisible : les valeurs courantes restent, jamais d’erreur', async () => {
    await S.updateAssistantSetting({ key: 'history_days', value: 45, adminId: 1 });
    S.setAssistantSettingsStoreForTests({ ...shared.store, version: async () => { throw new Error('base'); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(S.refreshAssistantSettings(true)).resolves.toBeUndefined();
  });
});
