/**
 * CDC Assistant §15.13, §32.7 ; D-J1 (lot 21) — en production, une version
 * de configuration utilisant un modèle preview n'est activée qu'avec le
 * réglage « Modèles preview en production », accordé par deux administrateurs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn() }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: vi.fn(async () => {}) }));

const { assertPreviewModelsApproved } = await import('../config-version.service');
const S = await import('@/services/verebona-assistant/config/assistant-settings');

const version = (model: string) => ({ entries: [{ treatment: 'T2', primaryModel: 'gemini-3.5-flash-lite', fallback1: model, fallback2: null }] }) as never;

function store(allowed: boolean) {
  return {
    version: async () => 1,
    readAll: async () => (allowed ? [{ key: 'preview_models_allowed', value: true, updatedBy: 2, updatedAt: 'x' }] : []),
  } as never;
}

afterEach(() => S.setAssistantSettingsStoreForTests(null));

describe('modèle preview en production', () => {
  it('refusé sans le réglage accordé, avec le traitement et le modèle en cause', async () => {
    S.setAssistantSettingsStoreForTests(store(false));
    await expect(assertPreviewModelsApproved(version('gemini-4-flash-preview'), 'production'))
      .rejects.toMatchObject({ code: 'PREVIEW_MODEL_NOT_APPROVED', details: [{ treatment: 'T2', model: 'gemini-4-flash-preview' }] });
  });

  it('accepté avec le réglage accordé ; aucun contrôle hors production ni sans modèle preview', async () => {
    S.setAssistantSettingsStoreForTests(store(true));
    await expect(assertPreviewModelsApproved(version('gemini-4-flash-preview'), 'production')).resolves.toBeUndefined();
    S.setAssistantSettingsStoreForTests(store(false));
    await expect(assertPreviewModelsApproved(version('gemini-4-flash-preview'), 'preprod')).resolves.toBeUndefined();
    await expect(assertPreviewModelsApproved(version('gemini-3.1-flash-lite'), 'production')).resolves.toBeUndefined();
  });
});
