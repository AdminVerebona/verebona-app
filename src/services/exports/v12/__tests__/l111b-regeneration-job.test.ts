/**
 * Lot 111B — arrêt coopératif d'une génération remplacée (job + worker) :
 * annulation pendant le rendu, l'envoi et la finalisation ; aucune
 * publication, aucune notification du support, objets non publiés confiés à
 * la purge, répertoire temporaire supprimé ; délai d'arrêt dépassé.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Row = Record<string, unknown>;
const state = { asset: null as Row | null, updates: [] as Row[], owned: true };

vi.mock('@/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = () => chain;
  chain.limit = async () => (state.asset ? [state.asset] : []);
  return { db: chain };
});
const repo = vi.hoisted(() => ({
  cancelRequested: false,
  claimed: [] as unknown[],
  markCancelled: vi.fn(async (..._a: unknown[]) => true),
}));
vi.mock('../generation/repository', () => ({
  MAX_ATTEMPTS: 3,
  LEASE_SECONDS: 120,
  updateOwnedGeneration: async (_id: number, _w: string, values: Row) => {
    // Préconditions renforcées : refus dès que l'annulation est demandée.
    if (!state.owned || repo.cancelRequested) return false;
    state.updates.push(values); return true;
  },
  addGenerationLog: async () => undefined,
  replaceGenerationItems: async () => undefined,
  isGenerationCancelRequested: async () => repo.cancelRequested,
  markGenerationCancelled: (...a: unknown[]) => repo.markCancelled(...a),
  claimNextGeneration: async () => (repo.claimed.length ? repo.claimed.shift() : null),
  renewGenerationLease: async () => true,
}));
const renderMock = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined));
vi.mock('../render/render-dossier', () => ({ renderDossier: (p: unknown) => renderMock(p) }));
vi.mock('../zip', () => ({ writeDossierZip: async () => 1234 }));

const { runGeneration } = await import('../generation/job');

const NOW = new Date('2026-11-05T07:14:00Z');
const upload = vi.fn(async (..._a: unknown[]) => undefined);
const notifySupport = vi.fn(async () => true);
const loadSource = vi.fn(async () => ({
  exportType: 'DOSSIER_COMPLET', family: 'IMMOBILIER',
  asset: { id: 5, name: 'Maison', characteristics: {}, equipmentList: [] },
  documents: [], photos: [], events: [], equipments: [], rooms: [],
  additionalInfo: { commercial: {}, rental: {}, insurance: {}, updatedAt: null },
  cil: null, preparedBy: 'Claire Martin',
}));
const scheduleOrphans = vi.fn(async (..._a: unknown[]) => 1);
const deps = { upload, notifySupport, loadSource: loadSource as never, scheduleOrphans: scheduleOrphans as never, now: () => NOW };

const row = (over: Row = {}) => ({
  id: 7, publicId: 'p', assetId: 5, accountId: 10, userId: 2, exportType: 'DOSSIER_COMPLET', status: 'generating',
  generationAttemptCount: 1, createdAt: NOW, snapshotJson: { request: { outputFormat: 'PDF', requestedAt: NOW.toISOString() } }, ...over,
}) as never;

const rendered = () => ({
  pdf: Buffer.from('%PDF-1.7 test'), pageCount: 9, passes: 2, data: { export: {} }, plan: { sections: {} }, templateVersion: 'dossier_complet-v1.0.0',
  fileBaseName: 'Verebona_Dossier-complet_Maison_2026-11-05', zipEntries: [], items: [],
  partial: false, warnings: [], counts: { integratedPdf: 0, zip: 0, excluded: 0, photos: 0 },
});

const workDirs = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('verebona-export-7-'));

beforeEach(() => {
  state.asset = { id: 5, accountId: 10, category: 'IMMOBILIER', subtype: 'Maison', deletedAt: null };
  state.updates = []; state.owned = true;
  repo.cancelRequested = false; repo.claimed = []; repo.markCancelled.mockClear();
  renderMock.mockReset(); upload.mockReset(); notifySupport.mockClear(); scheduleOrphans.mockClear();
  for (const d of workDirs()) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('runGeneration — génération remplacée', () => {
  it('annulation pendant le rendu (signal + observation) : arrêt, statut cancelled, rien publié ni notifié, temporaires supprimés', async () => {
    const controller = new AbortController();
    let cancelled = false;
    renderMock.mockImplementation(async (p: unknown) => {
      const { signal, onStep } = p as { signal?: AbortSignal; onStep: (s: string) => Promise<void> };
      expect(signal).toBe(controller.signal); // signal transmis au rendu Chromium
      await onStep('resolve_files');
      cancelled = true; repo.cancelRequested = true; controller.abort();
      await onStep('render_pdf'); // garde : lève l'annulation
      return rendered();
    });
    const out = await runGeneration(row(), 'w1', { deps, signal: controller.signal, isCancelled: () => cancelled });
    expect(out).toBe('cancelled');
    expect(repo.markCancelled).toHaveBeenCalledWith(7, 'w1', 'render_pdf');
    expect(upload).not.toHaveBeenCalled();
    expect(notifySupport).not.toHaveBeenCalled();
    expect(state.updates.some((u) => u.status === 'ready' || u.status === 'failed' || u.status === 'queued')).toBe(false);
    expect(workDirs()).toEqual([]);
  });

  it('annulation demandée en base juste avant l’envoi (relecture) : aucun envoi OVH', async () => {
    renderMock.mockImplementation(async () => { repo.cancelRequested = true; return rendered(); });
    expect(await runGeneration(row(), 'w1', { deps })).toBe('cancelled');
    expect(upload).not.toHaveBeenCalled();
    expect(repo.markCancelled).toHaveBeenCalledWith(7, 'w1', 'store_result');
    expect(scheduleOrphans).not.toHaveBeenCalled();
  });

  it('annulation pendant l’envoi : transfert interrompu, objet partiel confié à la purge', async () => {
    const controller = new AbortController();
    let cancelled = false;
    renderMock.mockResolvedValue(rendered());
    upload.mockImplementation(async (...a: unknown[]) => {
      const opts = a[3] as { signal?: AbortSignal } | undefined;
      expect(opts?.signal).toBe(controller.signal);
      cancelled = true; repo.cancelRequested = true; controller.abort();
      throw new Error('aborted');
    });
    expect(await runGeneration(row(), 'w1', { deps, signal: controller.signal, isCancelled: () => cancelled })).toBe('cancelled');
    expect(scheduleOrphans).toHaveBeenCalledWith(7, ['exports/10/5/7/a1/Verebona_Dossier-complet_Maison_2026-11-05.pdf']);
    expect(notifySupport).not.toHaveBeenCalled();
  });

  it('annulation pendant la finalisation : clôture refusée par les préconditions, aucune publication, objets purgés', async () => {
    renderMock.mockResolvedValue(rendered());
    upload.mockImplementation(async () => { repo.cancelRequested = true; }); // remplacée après l'envoi
    // La relecture avant clôture voit l'annulation ; même sans elle, updateOwnedGeneration refuse.
    expect(await runGeneration(row(), 'w1', { deps })).toBe('cancelled');
    expect(state.updates.some((u) => u.status === 'ready')).toBe(false);
    expect(scheduleOrphans).toHaveBeenCalledWith(7, ['exports/10/5/7/a1/Verebona_Dossier-complet_Maison_2026-11-05.pdf']);
  });

  it('échec technique d’une génération remplacée : annulation, ni « en échec », ni nouvelle tentative, ni support', async () => {
    renderMock.mockImplementation(async () => { repo.cancelRequested = true; throw Object.assign(new Error('chromium mort'), { exportErrorCode: 'RENDER_ERROR' }); });
    expect(await runGeneration(row(), 'w1', { deps })).toBe('cancelled');
    expect(notifySupport).not.toHaveBeenCalled();
    expect(state.updates.some((u) => u.status === 'failed' || u.status === 'queued')).toBe(false);
  });

  it('bail perdu (sans annulation) : issue « lost » inchangée, aucune clôture d’annulation', async () => {
    renderMock.mockResolvedValue(rendered());
    expect(await runGeneration(row(), 'w1', { deps, isActive: () => false })).toBe('lost');
    expect(repo.markCancelled).not.toHaveBeenCalled();
  });

  it('génération non remplacée : succès inchangé', async () => {
    renderMock.mockResolvedValue(rendered());
    expect(await runGeneration(row(), 'w1', { deps })).toBe('ready');
    expect(state.updates.at(-1)).toMatchObject({ status: 'ready' });
  });
});

describe('worker — observation de l’annulation', () => {
  afterEach(() => { vi.useRealTimers(); delete process.env.EXPORTS_CANCEL_POLL_MS; delete process.env.EXPORTS_CANCEL_GRACE_MS; });

  it('étape non interruptible : au-delà du délai d’arrêt, annulation close par le worker et file poursuivie', async () => {
    vi.resetModules();
    process.env.EXPORTS_CANCEL_POLL_MS = '500';
    process.env.EXPORTS_CANCEL_GRACE_MS = '2000';
    const signals: AbortSignal[] = [];
    vi.doMock('../generation/job', () => ({
      runGeneration: (_r: unknown, _w: string, o: { signal: AbortSignal }) => { signals.push(o.signal); return new Promise(() => {}); },
      failTimedOutGeneration: async () => true,
      jobTimeoutMs: () => 600_000,
    }));
    vi.doMock('@/lib/runtime/memory-monitor', () => ({ admitHeavyTask: () => true, trackMemory: (_k: string, fn: () => unknown) => fn() }));
    vi.useFakeTimers();
    const { drainExportQueue } = await import('../generation/worker');
    repo.claimed.push({ id: 1 });
    const drained = drainExportQueue('w1');
    await vi.advanceTimersByTimeAsync(600);
    expect(signals[0].aborted).toBe(false);
    repo.cancelRequested = true;
    await vi.advanceTimersByTimeAsync(600);
    expect(signals[0].aborted).toBe(true); // rendu / transferts interrompus
    await vi.advanceTimersByTimeAsync(2_100);
    expect(await drained).toBe(1);
    expect(repo.markCancelled).toHaveBeenCalledWith(1, 'w1', 'forced_after_grace');
    vi.doUnmock('../generation/job');
    vi.doUnmock('@/lib/runtime/memory-monitor');
  });
});
