/**
 * CDC 11 §15 (lot 19) : un export qui passe à prêt / erreur, constaté par
 * interrogation GET, émet `verebona:data-mutated` (mascotte, PROC-EXPORT).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExportSettleWatcher, exportJustSettled, mutatedSince, resetDataFreshness } from '../data-freshness';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', () => ({ apiClient: { get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

afterEach(() => { vi.unstubAllGlobals(); resetDataFreshness(); apiGet.mockReset(); });

describe('exportJustSettled', () => {
  it('non final → prêt / partiel / erreur ; jamais deux fois', () => {
    expect(exportJustSettled('generating', 'ready')).toBe(true);
    expect(exportJustSettled('queued', 'failed')).toBe(true);
    expect(exportJustSettled(undefined, 'partial')).toBe(true);
    expect(exportJustSettled('ready', 'ready')).toBe(false);
    expect(exportJustSettled('generating', 'generating')).toBe(false);
    expect(exportJustSettled('ready', 'expired')).toBe(false);
  });
});

describe('createExportSettleWatcher', () => {
  it('génération suivie : un seul événement au passage à prêt', () => {
    const notify = vi.fn();
    const w = createExportSettleWatcher(notify);
    expect(w.observe('g1', 'generating')).toBe(false);
    expect(w.observe('g1', 'ready')).toBe(true);
    expect(w.observe('g1', 'ready')).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('historique : premier relevé mémorisé sans émettre ; ensuite un événement par relevé où un export se termine', () => {
    const notify = vi.fn();
    const w = createExportSettleWatcher(notify);
    w.observeList([{ id: 1, status: 'ready' }, { id: 2, status: 'generating' }]);
    expect(notify).not.toHaveBeenCalled();
    w.observeList([{ id: 1, status: 'ready' }, { id: 2, status: 'generating' }]);
    expect(notify).not.toHaveBeenCalled();
    expect(w.observeList([{ id: 1, status: 'ready' }, { id: 2, status: 'failed' }, { id: 3, status: 'ready' }])).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('défaut : fraîcheur de l’accueil et événement verebona:data-mutated', () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    createExportSettleWatcher().observe('g', 'failed');
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'verebona:data-mutated' }));
    expect(mutatedSince(0)).toBe(true);
  });
});

describe('écran de préparation : interrogation de la génération', () => {
  it('poll : événement émis au passage à prêt, pas pendant la génération', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    const { httpPreparationApi } = await import('@/components/exports/preparation/api');
    const api = httpPreparationApi(3);
    apiGet.mockResolvedValueOnce({ publicId: 'p', generationStatus: 'generating' });
    await api.poll('p');
    expect(dispatchEvent).not.toHaveBeenCalled();
    apiGet.mockResolvedValueOnce({ publicId: 'p', generationStatus: 'ready' });
    expect((await api.poll('p')).generationStatus).toBe('ready');
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect(apiGet).toHaveBeenCalledWith('/api/export-generations/p');
  });
});
