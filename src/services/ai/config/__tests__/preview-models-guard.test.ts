/**
 * Lot 35B — ticket « Catalogue IA dynamique Google » : la garde « modèle
 * preview en production » (lot 21, D-J1) est SUPPRIMÉE. Un modèle preview est
 * activable dans les mêmes conditions techniques qu'un stable ; le réglage
 * « preview_models_allowed », le flag VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS
 * et le refus PREVIEW_NOT_ALLOWED / PREVIEW_MODEL_NOT_APPROVED n'existent plus.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {}, ensureMigrations: vi.fn() }));
vi.mock('@/lib/admin-audit', () => ({ logAdminAction: vi.fn(async () => {}) }));

const svc = await import('../config-version.service');
const S = await import('@/services/verebona-assistant/config/assistant-settings');

const version = (model: string) => ({ entries: [{ treatment: 'T2', primaryModel: 'gemini-3.5-flash-lite', fallback1: model, fallback2: null }] }) as never;

afterEach(() => { delete process.env.VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS; });

describe('CAT-05 — modèle preview : plus aucune autorisation spécifique', () => {
  it('la garde d’activation preview n’existe plus', () => {
    expect((svc as Record<string, unknown>).assertPreviewModelsApproved).toBeUndefined();
  });

  it('cohérence avec le registre : preview déclaré ou nouveau modèle preview acceptés sur T2, sans flag ni réglage', async () => {
    await expect(svc.assertModelRegistryCoherence(version('gemini-3-flash-preview'))).resolves.toEqual([]);
    await expect(svc.assertModelRegistryCoherence(version('gemini-9-flash-preview'))).resolves.toEqual([]);
  });

  it('le réglage « Modèles preview en production » est supprimé (clé inconnue, valeur en base ignorée)', () => {
    expect(S.assistantSettingDef('preview_models_allowed')).toBeUndefined();
    expect(S.effectiveAssistantSettings().some((d) => d.key === 'preview_models_allowed')).toBe(false);
  });

  it('le flag d’environnement n’est plus lu par aucun contrôle', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const f of [
      'src/services/ai/registry/usable-models.ts',
      'src/services/ai/config/config-version.service.ts',
      'src/services/verebona-assistant/core/model-startup-check.ts',
    ]) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/process\.env\.VEREBONA_ASSISTANT_ALLOW_PREVIEW_MODELS|effectiveSetting\('preview_models_allowed'\)/);
      expect(src, f).not.toMatch(/code: 'PREVIEW_NOT_ALLOWED'|'PREVIEW_MODEL_NOT_APPROVED'/);
    }
  });
});
