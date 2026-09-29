/**
 * API de préparation (CDC V12 §17.1) : `POST /api/assets/[id]/exports/prepare`
 * et `/estimate`, garde « PDF seul » de la génération (ALT-002, §17.2) et
 * suivi d'une génération (§15.3 : étape en cours, fichiers exclus).
 *
 * Droits : session requise, bien du compte courant (le co-titulaire Duo
 * prépare comme le titulaire — DRH-001/002), autre compte → 404 sans révéler
 * l'existence du bien ; type inconnu 400 ; famille non éligible 422 ; offre 403.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getTableName } from 'drizzle-orm';
import { makeSource, doc, photo, TODAY } from '@/services/exports/v12/__tests__/fixtures/sources';
import type { ExportSource } from '@/services/exports/v12/data/source';

type Row = Record<string, unknown>;
const state = {
  session: { userId: 1, currentAccountId: 10 } as { userId: number; currentAccountId?: number } | null,
  asset: null as Row | null,
  premium: { allowed: true } as { allowed: boolean; reason?: string; message?: string },
  generations: [] as Row[],
  users: [] as Row[],
  logs: [] as Row[],
  items: [] as Row[],
  inserts: [] as Array<{ table: string; values: unknown }>,
  source: null as ExportSource | null,
};

function tableOf(t: unknown): string {
  try { return getTableName(t as never); } catch { return '?'; }
}

function chain(kind: 'select' | 'insert') {
  let table = '?';
  let returning = false;
  let values: Row = {};
  const c: Record<string, unknown> = {};
  c.from = (t: unknown) => { table = tableOf(t); return c; };
  for (const m of ['where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) c[m] = () => c;
  c.values = (v: Row) => { values = v; state.inserts.push({ table, values: v }); return c; };
  c.returning = () => { returning = true; return c; };
  c.__setTable = (t: unknown) => { table = tableOf(t); };
  c.then = (resolve: (v: unknown) => void) => {
    let out: unknown = [];
    if (kind === 'select') {
      out = table === 'export_generation' ? state.generations
        : table === 'users' ? state.users
          : table === 'export_generation_logs' ? state.logs
            : table === 'export_generation_items' ? state.items : [];
    } else if (returning) {
      out = [{ id: 99, publicId: '00000000-0000-4000-8000-000000000099', createdAt: new Date(), ...values }];
    }
    resolve(out);
  };
  return c;
}

vi.mock('@/db', () => {
  const db: Record<string, unknown> = {
    select: () => chain('select'),
    insert: (t: unknown) => { const c = chain('insert'); (c.__setTable as (t: unknown) => void)(t); return c; },
    execute: async () => [],
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db };
});
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => { if (!state.session) throw new Error('AUTH_REQUIRED'); return state.session; },
    handleSessionError: (e: unknown) => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: (e as Error)?.message === 'AUTH_REQUIRED' ? 401 : 500 }),
  },
}));
vi.mock('@/services/exports/export-access', () => ({
  findAccessibleAssetForExport: async (session: { currentAccountId?: number }, assetId: number) => {
    const a = state.asset;
    if (!a || a.id !== assetId || !session.currentAccountId || a.accountId !== session.currentAccountId || a.deletedAt) return null;
    return a;
  },
}));
vi.mock('@/services/entitlements.service', () => ({ canUsePremiumFeature: async () => state.premium }));
const sourceMock = vi.fn(async (p: { assetId: number; accountId: number; userId: number; exportType: string }) => {
  void p;
  return state.source!;
});
vi.mock('@/services/exports/v12/data/source', async (orig) => ({
  ...(await orig<typeof import('@/services/exports/v12/data/source')>()),
  loadExportSource: (p: never) => sourceMock(p),
}));
vi.mock('@/services/exports/v12/generation/clock', async (orig) => ({ ...(await orig<object>()), parisDate: () => TODAY }));
vi.mock('@/services/exports/v12/generation/rate-limit', () => ({ exportRateLimitResponse: () => null }));
vi.mock('@/services/exports/v12/generation/worker', () => ({ nudgeExportWorker: () => {} }));
// Export brut (même route) : services de fichiers neutralisés.
vi.mock('@/services/export-upload.service', () => ({ uploadExportFile: async () => '', buildExportS3Key: () => '' }));
vi.mock('@/services/export-snapshot.service', () => ({ buildAssetSnapshot: async () => ({}) }));
vi.mock('@/services/export-manifest.service', () => ({ buildExportManifest: () => ({}) }));
vi.mock('@/services/export-zip.service', () => ({ buildExportZip: async () => Buffer.from('zip') }));
vi.mock('@/services/exports/cil-preparation.service', async (orig) => ({
  ...(await orig<typeof import('@/services/exports/cil-preparation.service')>()),
  evaluateCilReadiness: async () => ({ globalStatus: 'ready', completion: { resolvedBlocks: 9, applicableBlocks: 9, totalBlocks: 9, percentage: 100 }, blocks: [], blockingBlocks: [] }),
}));

const { POST: prepareRoute } = await import('../[id]/exports/prepare/route');
const { POST: estimateRoute } = await import('../[id]/exports/estimate/route');
const { POST: createExport } = await import('../[id]/exports/route');
const { GET: getGeneration } = await import('../../export-generations/[publicId]/route');

const call = (route: typeof prepareRoute, body: unknown, id = '5') => route(
  new NextRequest('http://x', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id }) },
);

const TITULAIRE = { userId: 1, currentAccountId: 10 };
const DUO_MEMBRE = { userId: 2, currentAccountId: 10 };
const AUTRE_COMPTE = { userId: 3, currentAccountId: 20 };

beforeEach(() => {
  state.session = { ...TITULAIRE };
  state.asset = { id: 5, userId: 1, accountId: 10, deletedAt: null, category: 'IMMOBILIER', subtype: 'Maison', name: 'Maison', address: '1 rue', postalCode: '75001', city: 'Paris' };
  state.premium = { allowed: true };
  state.generations = [];
  state.users = [];
  state.logs = [];
  state.items = [];
  state.inserts = [];
  state.source = makeSource('IMMOBILIER', 'VENTE', {
    asset: { ...makeSource('IMMOBILIER', 'VENTE').asset, id: 5 },
    documents: [doc({ id: 1, kind: 'DPE', title: 'DPE' }), doc({ id: 2, kind: 'FACTURE', title: 'Facture Word', format: 'DOCX', integrable: false, fileName: 'f.docx', mimeType: 'application/msword' })],
    photos: [photo(1), photo(2), photo(3), photo(4), photo(5)],
  });
  sourceMock.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('POST /exports/prepare — droits (DRH-001/002, §17.3)', () => {
  it('sans session : 401', async () => {
    state.session = null;
    expect((await call(prepareRoute, { exportType: 'VENTE' })).status).toBe(401);
  });

  it('bien d’un autre compte : 404, données jamais lues', async () => {
    state.session = { ...AUTRE_COMPTE };
    const res = await call(prepareRoute, { exportType: 'VENTE' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('ASSET_NOT_FOUND');
    expect(sourceMock).not.toHaveBeenCalled();
  });

  it('co-titulaire Duo : préparation servie, lue pour le compte du bien', async () => {
    state.session = { ...DUO_MEMBRE };
    const res = await call(prepareRoute, { exportType: 'VENTE' });
    expect(res.status).toBe(200);
    expect(sourceMock).toHaveBeenCalledWith({ assetId: 5, accountId: 10, userId: 2, exportType: 'VENTE' });
  });

  it('type inconnu ou export brut : 400 ; JSON invalide : 400', async () => {
    expect((await call(prepareRoute, { exportType: 'PDFMONKEY' })).status).toBe(400);
    expect((await call(prepareRoute, { exportType: 'EXPORT_BRUT' })).status).toBe(400);
    expect((await call(prepareRoute, '{pas du json')).status).toBe(400);
    expect((await call(prepareRoute, { exportType: 'VENTE' }, 'abc')).status).toBe(400);
  });

  it('dossier non éligible à la famille : 422 NOT_ELIGIBLE (location d’un véhicule, CIL d’un terrain)', async () => {
    state.asset = { ...state.asset!, category: 'VEHICULE', subtype: null };
    const res = await call(prepareRoute, { exportType: 'LOCATION' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('NOT_ELIGIBLE');
    state.asset = { ...state.asset!, category: 'IMMOBILIER', subtype: 'Terrain' };
    expect((await call(prepareRoute, { exportType: 'CIL' })).status).toBe(422);
  });

  it('offre sans dossiers : 403 avec le motif', async () => {
    state.premium = { allowed: false, reason: 'PREMIUM_REQUIRED', message: 'Premium requis.' };
    const res = await call(prepareRoute, { exportType: 'VENTE' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PREMIUM_REQUIRED', message: 'Premium requis.' });
  });
});

describe('POST /exports/prepare — contrat §17.1', () => {
  it('sections, éléments, estimation, actions ; anciens codes acceptés', async () => {
    const res = await call(prepareRoute, { exportType: 'DOSSIER_VENTE', clientContext: { viewport: 'desktop' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ assetId: 5, exportType: 'VENTE', status: 'ready_pristine', dossier: { label: 'Kit de mise en vente' }, photoCap: 4 });
    expect(body.sections.map((s: { id: string }) => s.id)).toEqual(['cover', 'summary', 'info', 'conditions', 'highlights', 'photos', 'followUp', 'documents', 'references']);
    expect(body.sections.find((s: { id: string }) => s.id === 'conditions').infoSections).toEqual(['commercial']);
    expect(body.estimate).toMatchObject({ outputFormat: 'PDF', pdfPhotos: 4, pdfDocuments: 0 });
    expect(body.actions).toEqual({ canGeneratePdf: true, canGenerateZip: false });
    expect(body.lastGeneration).toBeNull();
  });

  it('dernière génération et auteur (PREP-HEA-005/006)', async () => {
    state.generations = [{ id: 7, publicId: '00000000-0000-4000-8000-000000000007', assetId: 5, userId: 2, exportType: 'VENTE', status: 'partial', createdAt: new Date('2026-09-20T10:00:00Z'), expiresAt: new Date(Date.now() + 86_400_000) }];
    state.users = [{ firstName: 'Claire', lastName: 'Martin' }];
    const body = await (await call(prepareRoute, { exportType: 'VENTE' })).json();
    expect(body.lastGeneration).toMatchObject({ status: 'partial', authorName: 'Claire Martin' });
  });

  it('includeCurrentSelections : choix repris ; choix invalides : 400', async () => {
    const choices = { outputFormat: 'ZIP', sections: [{ id: 'documents', enabled: true, items: [{ sourceType: 'document', sourceId: 1, selected: true, mode: 'ZIP' }] }] };
    const body = await (await call(prepareRoute, { exportType: 'VENTE', includeCurrentSelections: true, choices })).json();
    expect(body.sections.find((s: { id: string }) => s.id === 'documents').items.find((i: { key: string }) => i.key === 'document:1')).toMatchObject({ selected: true, mode: 'ZIP' });
    expect(body.estimate.outputFormat).toBe('ZIP');
    const bad = await call(prepareRoute, { exportType: 'VENTE', includeCurrentSelections: true, choices: { items: [{ sourceType: 'virus', sourceId: 1 }] } });
    expect(bad.status).toBe(400);
  });
});

describe('POST /exports/estimate', () => {
  it('format naturel ZIP dès qu’une pièce est en ZIP ; pièces retirées par un « PDF seul »', async () => {
    const res = await call(estimateRoute, {
      exportType: 'VENTE',
      choices: { outputFormat: 'ZIP', sections: [{ id: 'documents', enabled: true, items: [{ sourceType: 'document', sourceId: 2, selected: true, mode: 'ZIP' }, { sourceType: 'document', sourceId: 1, selected: true, mode: 'PDF' }] }] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.estimate).toMatchObject({ outputFormat: 'ZIP', pdfDocuments: 1, zipDocuments: 1 });
    expect(body.estimate.zipOnlyItems).toEqual([{ key: 'document:2', label: 'Facture Word' }]);
    expect(body.actions).toEqual({ canGeneratePdf: true, canGenerateZip: true });
  });

  it('seuil bloquant : actions fermées et MSG-PREP-004', async () => {
    state.source = { ...state.source!, documents: Array.from({ length: 51 }, (_, i) => doc({ id: 100 + i, kind: 'FACTURE', title: `F${i}` })) };
    const res = await call(estimateRoute, { exportType: 'VENTE', choices: { items: state.source.documents.map((d) => ({ sourceType: 'document', sourceId: d.id, selected: true, mode: 'PDF' })), sections: [{ id: 'documents', enabled: true }] } });
    const body = await res.json();
    expect(body.actions.canGeneratePdf).toBe(false);
    expect(body.messages.map((m: { code: string }) => m.code)).toContain('MSG-PREP-004');
  });

  it('autre compte : 404 ; payload invalide : 400', async () => {
    expect((await call(estimateRoute, { exportType: 'VENTE', choices: { outputFormat: 'TIFF' } })).status).toBe(400);
    state.session = { ...AUTRE_COMPTE };
    expect((await call(estimateRoute, { exportType: 'VENTE', choices: {} })).status).toBe(404);
  });
});

describe('Génération (§17.2) : confirmation « PDF seul » exigée (ALT-002)', () => {
  const choices = { sections: [{ id: 'documents', enabled: true, items: [{ sourceType: 'document', sourceId: 2, selected: true, mode: 'ZIP' }] }] };

  it('PDF seul sans accusé, avec des pièces ZIP : 409, rien n’est mis en file', async () => {
    const res = await call(createExport, { exportType: 'VENTE', choices: { ...choices, outputFormat: 'PDF' } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PDF_ONLY_CONFIRMATION_REQUIRED', message: expect.stringContaining('PDF seul') });
    expect(state.inserts.filter((i) => i.table === 'export_generation')).toHaveLength(0);
  });

  it('PDF seul confirmé : mis en file ; PDF + ZIP : mis en file', async () => {
    const ok = await call(createExport, { exportType: 'VENTE', choices: { ...choices, outputFormat: 'PDF', acknowledgements: { pdfOnlyExcludesZipItems: true } } });
    expect(ok.status).toBe(202);
    const zip = await call(createExport, { exportType: 'VENTE', choices: { ...choices, outputFormat: 'ZIP' } });
    expect(zip.status).toBe(202);
    expect((await zip.json()).generationPublicId).toBeTruthy();
  });
});

describe('GET /api/export-generations/{publicId} — suivi (§15.3, ALT-004)', () => {
  const PUB = '00000000-0000-4000-8000-000000000007';
  const get = () => getGeneration(new NextRequest('http://x'), { params: Promise.resolve({ publicId: PUB }) });
  const gen = (over: Row = {}): Row => ({
    id: 7, publicId: PUB, assetId: 5, accountId: 10, userId: 2, exportType: 'VENTE', status: 'generating',
    outputPayload: null, createdAt: new Date(), expiresAt: null, ...over,
  });

  it('en cours : étape du job ; co-titulaire Duo autorisé, autre compte 404', async () => {
    state.generations = [gen()];
    state.logs = [{ step: 'render_pdf' }];
    state.session = { ...DUO_MEMBRE };
    const body = await (await get()).json();
    expect(body).toMatchObject({ generationStatus: 'generating', currentStep: 'render_pdf', excludedFiles: [] });
    state.session = { ...AUTRE_COMPTE };
    expect((await get()).status).toBe(404);
  });

  it('partielle : fichiers exclus (libellé, motif), jamais de détail technique', async () => {
    state.generations = [gen({ status: 'partial', outputPayload: JSON.stringify({ pdfS3Key: 'k.pdf' }), expiresAt: new Date(Date.now() + 86_400_000), metricsJson: { 'items.excluded_count': 1 } })];
    state.items = [{ label: 'Facture illisible', reason: 'corrupted' }];
    const body = await (await get()).json();
    expect(body).toMatchObject({ generationStatus: 'partial', partialMessage: expect.stringContaining('certains fichiers'), excludedFiles: [{ label: 'Facture illisible', reason: 'corrupted', reasonLabel: 'Fichier illisible' }] });
    expect(body.downloadUrl).toBe(`/api/export-generations/${PUB}/download?file=pdf`);
  });
});
