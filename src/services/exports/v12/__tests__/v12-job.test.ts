/**
 * Job de génération V12 (§15.3) : étapes, statuts (ready / partial / failed /
 * nouvelle tentative), codes d'erreur distincts (§21), notification support
 * réelle et message générique (DRH-008), expiration à 30 jours (DRH-005),
 * archive ZIP seulement avec des pièces ZIP (ZIP-001), bail perdu, délai
 * global dépassé, objets orphelins confiés à la purge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
const state = { asset: null as Row | null, updates: [] as Row[], logs: [] as Row[], items: [] as unknown[], owned: true };

vi.mock('@/db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = () => chain;
  chain.limit = async () => (state.asset ? [state.asset] : []);
  return { db: chain };
});
vi.mock('../generation/repository', () => ({
  MAX_ATTEMPTS: 3,
  updateOwnedGeneration: async (_id: number, _w: string, values: Row) => { if (!state.owned) return false; state.updates.push(values); return true; },
  addGenerationLog: async (_id: number, entry: Row) => { state.logs.push(entry); },
  replaceGenerationItems: async (_id: number, items: unknown[]) => { state.items = items; },
}));
const renderMock = vi.fn((..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined));
vi.mock('../render/render-dossier', () => ({ renderDossier: (p: unknown) => renderMock(p) }));
const zipMock = vi.fn(async (..._a: unknown[]) => 1234);
vi.mock('../zip', () => ({ writeDossierZip: (p: unknown) => zipMock(p) }));

const { runGeneration } = await import('../generation/job');
const { ExportGenerationError } = await import('../generation/errors');

const NOW = new Date('2026-09-28T07:14:00Z');
const upload = vi.fn(async () => undefined);
const notifySupport = vi.fn(async () => true);
const loadSource = vi.fn(async () => ({
  exportType: 'DOSSIER_COMPLET', family: 'IMMOBILIER',
  asset: { id: 5, name: 'Maison', characteristics: {}, equipmentList: [] },
  documents: [], photos: [], events: [], equipments: [], rooms: [],
  additionalInfo: { commercial: {}, rental: {}, insurance: {}, claim: {}, updatedAt: null },
  cil: null, preparedBy: 'Claire Martin',
}));
const scheduleOrphans = vi.fn(async (..._a: unknown[]) => 1);
const deps = { upload, notifySupport, loadSource: loadSource as never, scheduleOrphans: scheduleOrphans as never, now: () => NOW };

const row = (over: Row = {}) => ({
  id: 7, publicId: 'p', assetId: 5, accountId: 10, userId: 2, exportType: 'DOSSIER_COMPLET', status: 'generating',
  generationAttemptCount: 1, createdAt: NOW, snapshotJson: { request: { outputFormat: 'PDF', requestedAt: NOW.toISOString() } }, ...over,
}) as never;

const rendered = (over: Row = {}) => ({
  pdf: Buffer.from('%PDF-1.7 test'), pageCount: 9, passes: 2, data: { export: {} }, plan: { sections: {} }, templateVersion: 'dossier_complet-v1.0.0',
  fileBaseName: 'Verebona_Dossier-complet_Maison_2026-09-28', zipEntries: [], items: [{ sourceType: 'document', sourceId: 1, label: 'x', mode: 'PDF', status: 'included', reason: null }],
  partial: false, warnings: [], counts: { integratedPdf: 1, zip: 0, excluded: 0, photos: 2 }, ...over,
});

beforeEach(() => {
  state.asset = { id: 5, accountId: 10, category: 'IMMOBILIER', subtype: 'Maison', deletedAt: null };
  state.updates = []; state.logs = []; state.items = []; state.owned = true;
  renderMock.mockReset(); zipMock.mockClear(); upload.mockReset(); notifySupport.mockClear(); loadSource.mockClear(); scheduleOrphans.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('runGeneration', () => {
  it('succès : PDF stocké sous exports/, statut ready, expiration à 30 jours, métriques et traçabilité', async () => {
    renderMock.mockResolvedValue(rendered());
    expect(await runGeneration(row(), 'w1', { deps })).toBe('ready');
    expect(upload).toHaveBeenCalledWith(expect.stringMatching(/\.pdf$/), 'exports/10/5/7/a1/Verebona_Dossier-complet_Maison_2026-09-28.pdf', 'application/pdf');
    const final = state.updates.at(-1)!;
    expect(final).toMatchObject({ status: 'ready', outputFormat: 'PDF', fileKey: 'exports/10/5/7/a1/Verebona_Dossier-complet_Maison_2026-09-28.pdf', lockedBy: null, errorCode: null });
    expect(scheduleOrphans).not.toHaveBeenCalled();
    expect((final.expiresAt as Date).toISOString()).toBe('2026-10-28T07:14:00.000Z');
    expect(final.metricsJson).toMatchObject({ 'generation.pdf_pages': 9, 'items.integrated_pdf_count': 1, 'renderer.template_version': 'dossier_complet-v1.0.0', 'generation.output_format': 'PDF' });
    // Snapshot §16.3 : choix, données, version.
    expect((final.snapshotJson as Row).export).toMatchObject({ type: 'DOSSIER_COMPLET', templateVersion: 'dossier_complet-v1.0.0' });
    expect((final.snapshotJson as Row).choices).toMatchObject({ origin: 'default', outputFormat: 'PDF' });
    expect(state.items).toHaveLength(1);
    // Méta imprimée : référence et heure de Paris.
    expect(renderMock.mock.calls[0][0]).toMatchObject({ code: 'DOSSIER_COMPLET', today: '2026-09-28', meta: { reference: 'VBN-COMPLET-20260928-000007', generatedAt: '2026-09-28T09:14:00+02:00' } });
    // LOG-004 : journal avec type et version de template.
    expect(state.logs.every((l) => (l.details as Row).templateVersion === 'dossier_complet-v1.0.0')).toBe(true);
  });

  it('fichier exclu : statut partial (ALT-004)', async () => {
    renderMock.mockResolvedValue(rendered({
      partial: true, counts: { integratedPdf: 0, zip: 0, excluded: 1, photos: 0 },
      items: [{ sourceType: 'document', sourceId: 1, label: 'x', mode: 'PDF', status: 'excluded', reason: 'corrupted' }],
    }));
    expect(await runGeneration(row(), 'w1', { deps })).toBe('partial');
    expect(state.updates.at(-1)).toMatchObject({ status: 'partial' });
    expect(state.logs.some((l) => l.code === 'FILE_UNAVAILABLE')).toBe(true);
    // LOG-001/005 : exclusions tracées par identifiant et motif, sans titre de document.
    const log = state.logs.find((l) => l.code === 'FILE_UNAVAILABLE')!;
    expect((log.details as Row).excluded).toEqual([{ sourceType: 'document', sourceId: 1, reason: 'corrupted' }]);
  });

  it('pièces ZIP : archive /pdf + /documents, deux fichiers stockés, format ZIP (ZIP-001/002)', async () => {
    renderMock.mockResolvedValue(rendered({ zipEntries: [{ path: 'documents/notice.docx', localPath: '/tmp/x' }] }));
    await runGeneration(row({ snapshotJson: { request: { outputFormat: 'ZIP', requestedAt: 'x' } } }), 'w1', { deps });
    expect(zipMock).toHaveBeenCalledWith(expect.objectContaining({ pdfName: 'Verebona_Dossier-complet_Maison_2026-09-28.pdf', entries: [{ path: 'documents/notice.docx', localPath: '/tmp/x' }] }));
    expect(upload).toHaveBeenCalledTimes(2);
    expect(state.updates.at(-1)).toMatchObject({ outputFormat: 'ZIP', fileKey: 'exports/10/5/7/a1/Verebona_Dossier-complet_Maison_2026-09-28.zip', fileSizeBytes: 1234 });
  });

  it('erreur transitoire : remise en file différée, sans notification', async () => {
    renderMock.mockRejectedValue(new ExportGenerationError('RENDER_ERROR', 'render_pdf', 'chromium crashed'));
    expect(await runGeneration(row({ generationAttemptCount: 1 }), 'w1', { deps })).toBe('retry');
    const last = state.updates.at(-1)!;
    expect(last).toMatchObject({ status: 'queued', errorCode: 'RENDER_ERROR', lockedBy: null });
    expect((last.nextAttemptAt as Date).getTime()).toBe(NOW.getTime() + 30_000);
    expect(notifySupport).not.toHaveBeenCalled();
  });

  it('dernière tentative : échec définitif, support notifié, message générique', async () => {
    const SECRET = 'S3 AccessDenied bucket=verebona-prod';
    renderMock.mockResolvedValue(rendered());
    upload.mockRejectedValueOnce(new Error(SECRET));
    expect(await runGeneration(row({ generationAttemptCount: 3 }), 'w1', { deps })).toBe('failed');
    const last = state.updates.at(-1)!;
    expect(last).toMatchObject({ status: 'failed', errorCode: 'STORAGE_ERROR' });
    const payload = JSON.parse(String(last.errorPayload));
    expect(payload).toMatchObject({ code: 'STORAGE_ERROR', step: 'store_result', category: 'storage', technicalMessage: SECRET, supportEmailSent: true });
    expect(payload.message).toBe('La génération a échoué lors du stockage.');
    expect(notifySupport).toHaveBeenCalledWith(expect.objectContaining({ exportId: 7, accountId: 10, attemptCount: 3 }));
  });

  it('délai de rendu dépassé : échec immédiat (RENDER_TIMEOUT, pas de nouvelle tentative)', async () => {
    renderMock.mockRejectedValue(Object.assign(new Error('Rendu Chromium interrompu'), { exportErrorCode: 'RENDER_TIMEOUT' }));
    expect(await runGeneration(row({ generationAttemptCount: 1 }), 'w1', { deps })).toBe('failed');
    expect(state.updates.at(-1)).toMatchObject({ status: 'failed', errorCode: 'RENDER_TIMEOUT' });
  });

  it('dossier non éligible : échec métier, sans notification support', async () => {
    state.asset = { id: 5, accountId: 10, category: 'VEHICULE', subtype: 'Voiture', deletedAt: null };
    expect(await runGeneration(row({ exportType: 'LOCATION' }), 'w1', { deps })).toBe('failed');
    expect(state.updates.at(-1)).toMatchObject({ status: 'failed', errorCode: 'NOT_ELIGIBLE' });
    expect(notifySupport).not.toHaveBeenCalled();
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('ancien code accepté ; bien supprimé → ASSET_NOT_FOUND', async () => {
    state.asset = null;
    expect(await runGeneration(row({ exportType: 'DOSSIER_VENTE' }), 'w1', { deps })).toBe('failed');
    expect(state.updates.at(-1)).toMatchObject({ errorCode: 'ASSET_NOT_FOUND' });
  });

  it('bail perdu : arrêt sans écrire de statut', async () => {
    renderMock.mockResolvedValue(rendered());
    expect(await runGeneration(row(), 'w1', { deps, isActive: () => false })).toBe('lost');
    expect(state.updates.find((u) => u.status)).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });

  it('bail perdu après l’envoi : objets de l’exécution confiés à la purge', async () => {
    renderMock.mockResolvedValue(rendered());
    let active = true;
    upload.mockImplementation(async () => { active = false; });
    expect(await runGeneration(row({ generationAttemptCount: 2 }), 'w1', { deps, isActive: () => active })).toBe('lost');
    expect(state.updates.find((u) => u.status)).toBeUndefined();
    expect(scheduleOrphans).toHaveBeenCalledWith(7, ['exports/10/5/7/a2/Verebona_Dossier-complet_Maison_2026-09-28.pdf']);
  });

  it('clôture refusée (génération reprise ailleurs) : objets confiés à la purge', async () => {
    renderMock.mockResolvedValue(rendered({ zipEntries: [{ path: 'documents/a.docx', localPath: '/tmp/x' }] }));
    upload.mockImplementation(async () => { state.owned = false; });
    expect(await runGeneration(row({ snapshotJson: { request: { outputFormat: 'ZIP', requestedAt: 'x' } } }), 'w1', { deps })).toBe('lost');
    expect(scheduleOrphans).toHaveBeenCalledWith(7, [
      'exports/10/5/7/a1/Verebona_Dossier-complet_Maison_2026-09-28.pdf',
      'exports/10/5/7/a1/Verebona_Dossier-complet_Maison_2026-09-28.zip',
    ]);
  });

  it('délai global dépassé (signal) : arrêt sans écrire, sans nouvelle tentative', async () => {
    const controller = new AbortController();
    renderMock.mockImplementation(async () => { controller.abort(); throw new ExportGenerationError('RENDER_ERROR', 'render_pdf', 'interrompu'); });
    expect(await runGeneration(row(), 'w1', { deps, signal: controller.signal })).toBe('lost');
    expect(state.updates.find((u) => u.status)).toBeUndefined();
    expect(notifySupport).not.toHaveBeenCalled();
  });
});

describe('failTimedOutGeneration', () => {
  it('clôt en échec RENDER_TIMEOUT (message générique), support notifié', async () => {
    const { failTimedOutGeneration } = await import('../generation/job');
    expect(await failTimedOutGeneration(row({ generationAttemptCount: 1 }), 'w1', { notifySupport, now: () => NOW })).toBe(true);
    const last = state.updates.at(-1)!;
    expect(last).toMatchObject({ status: 'failed', errorCode: 'RENDER_TIMEOUT', lockedBy: null, lockedUntil: null });
    expect(JSON.parse(String(last.errorPayload))).toMatchObject({ code: 'RENDER_TIMEOUT', supportEmailSent: true });
    expect(notifySupport).toHaveBeenCalledWith(expect.objectContaining({ exportId: 7 }));
  });
});
