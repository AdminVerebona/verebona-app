/**
 * Exports — corrections P1/P2 de l'audit CDC 16 (V12), adaptées au moteur V12
 * asynchrone (HTML/CSS + Chromium, file `export_generation`) :
 *   1. DOSSIER_COMPLET générable (mis en file, 202) ;
 *   2. kit de vente ouvert aux trois familles ;
 *   3. accès par compte (co-titulaire Duo admis, autre compte refusé) ;
 *   4. suppression : fichier purgé, entrée d'historique conservée (DRH-004) ;
 *   5. CIL « action requise » bloqué côté serveur (CIL-RULE-002) ;
 *   6. échec : message générique dans l'historique, détail technique jamais exposé ;
 *   7. anciens codes acceptés, liens de téléchargement revérifiés (DRH-010) ;
 *   8. dialogues d'export historiques retirés.
 * Le rendu lui-même (échec, notification support) est couvert par
 * `services/exports/v12/__tests__/v12-job.test.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// ── État simulé ──────────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
const state = {
  session: { userId: 1, currentAccountId: 10 } as { userId: number; currentAccountId?: number },
  asset: null as Row | null,
  exportRow: null as Row | null,
  exportRows: [] as Row[],
  files: [] as Row[],
  inserts: [] as Array<{ table: string; values: unknown }>,
  updates: [] as Array<{ table: string; set: Row }>,
  lastWhere: null as unknown,
};

function tableOf(t: unknown): string {
  try { return getTableName(t as never); } catch { return '?'; }
}

function makeChain(kind: 'select' | 'insert' | 'update' | 'delete') {
  let table = '?';
  let limited = false;
  let returning = false;
  let lastValues: Row = {};
  let lastSet: Row = {};
  const chain: Record<string, unknown> = {};
  chain.from = (t: unknown) => { table = tableOf(t); return chain; };
  chain.where = (w: unknown) => { state.lastWhere = w; return chain; };
  chain.innerJoin = () => chain;
  chain.leftJoin = () => chain;
  chain.orderBy = () => chain;
  chain.limit = (n: number) => { limited = n === 1; return chain; };
  chain.set = (v: Row) => { lastSet = v; state.updates.push({ table, set: v }); return chain; };
  chain.values = (v: unknown) => { lastValues = v as Row; state.inserts.push({ table, values: v }); return chain; };
  chain.returning = () => { returning = true; return chain; };
  chain.__setTable = (t: unknown) => { table = tableOf(t); };
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    try {
      let out: unknown = [];
      if (kind === 'select') {
        if (table === 'export_generation') out = limited ? (state.exportRow ? [state.exportRow] : []) : state.exportRows;
        else if (table === 'accounts') out = [{ planType: 'PREMIUM' }];
        else if (table === 'asset_files') out = state.files;
        else out = [];
      } else if (kind === 'insert' && returning) {
        out = [{ id: 99, publicId: '00000000-0000-4000-8000-000000000099', createdAt: new Date(), ...lastValues }];
      } else if (kind === 'update' && returning) {
        out = state.exportRow ? [{ ...state.exportRow, ...lastSet }] : [{ id: 99, ...lastSet }];
      }
      resolve(out);
    } catch (e) { reject(e); }
  };
  return chain;
}

vi.mock('@/db', () => {
  const db: Record<string, unknown> = {
    select: () => makeChain('select'),
    insert: (t: unknown) => { const c = makeChain('insert'); (c.__setTable as (t: unknown) => void)(t); return c; },
    update: (t: unknown) => { const c = makeChain('update'); (c.__setTable as (t: unknown) => void)(t); return c; },
    delete: (t: unknown) => { const c = makeChain('delete'); (c.__setTable as (t: unknown) => void)(t); return c; },
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  // Verrou consultatif de la mise en file, comptage des générations actives.
  db.execute = async () => [];
  return { db };
});
// Débit par utilisateur : couvert par v12-units ; neutralisé ici (nombreuses requêtes du même utilisateur).
vi.mock('@/services/exports/v12/generation/rate-limit', () => ({ exportRateLimitResponse: () => null }));

vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => state.session,
    handleSessionError: (e: unknown) => new Response(
      JSON.stringify({ error: 'Internal', message: 'An unexpected error occurred', detail: String(e) }),
      { status: (e as Error)?.message === 'AUTH_REQUIRED' ? 401 : 500 },
    ),
  },
}));

// Règle d'accès : mêmes critères que le helper réel (compte courant, non supprimé).
vi.mock('@/services/exports/export-access', () => ({
  findAccessibleAssetForExport: async (session: { currentAccountId?: number }, assetId: number) => {
    const a = state.asset;
    if (!a || a.id !== assetId || !session.currentAccountId || a.accountId !== session.currentAccountId || a.deletedAt) return null;
    return a;
  },
}));

const sourceMock = vi.fn(async (p: { assetId: number; accountId: number; userId: number; exportType: string }) => ({
  exportType: p.exportType, family: 'IMMOBILIER',
  asset: { id: p.assetId, name: 'Maison', category: 'IMMOBILIER', characteristics: {}, equipmentList: [] },
  documents: [], photos: [], events: [], equipments: [], rooms: [],
  additionalInfo: { commercial: {}, rental: {}, insurance: {}, claim: {}, updatedAt: null },
  cil: null, preparedBy: null,
}));
const nudgeMock = vi.fn();
const notifyMock = vi.fn(async (..._args: unknown[]) => false);

vi.mock('@/services/exports/v12/data/source', () => ({ loadExportSource: (p: never) => sourceMock(p) }));
vi.mock('@/services/exports/v12/generation/worker', () => ({ nudgeExportWorker: () => nudgeMock() }));
vi.mock('@/services/export-upload.service', () => ({
  getExportSignedUrl: async (k: string) => `https://signed/${k}`,
  uploadExportFile: async (_b: unknown, k: string) => k,
  buildExportS3Key: (acc: number, asset: number, exp: number, f: string) => `exports/${acc}/${asset}/${exp}/${f}`,
}));
vi.mock('@/services/export-snapshot.service', () => ({ buildAssetSnapshot: async () => ({}) }));
vi.mock('@/services/export-manifest.service', () => ({ buildExportManifest: () => ({}) }));
vi.mock('@/services/export-zip.service', () => ({ buildExportZip: async () => Buffer.from('zip') }));
vi.mock('@/services/entitlements.service', () => ({ canUsePremiumFeature: async () => ({ allowed: true }) }));
// Suppression S3 directe : clés en échec simulées via `failingKeys`.
const failingKeys = new Set<string>();
const deletedKeys: string[] = [];
vi.mock('@/services/storage/blob-purge.service', () => ({
  deleteStorageObjects: async (keys: string[]) => {
    const failed = keys.filter(k => failingKeys.has(k));
    const deleted = keys.filter(k => !failingKeys.has(k));
    deletedKeys.push(...deleted);
    return { deleted, failed };
  },
}));
vi.mock('@/services/exports/export-support-notifier', () => ({
  notifySupportOfExportFailure: (...a: unknown[]) => notifyMock(...a),
}));

const { GET: listExports, POST: createExport } = await import('../[id]/exports/route');
const { GET: getExport, DELETE: deleteExport } = await import('../[id]/exports/[exportId]/route');
const { POST: retryExport } = await import('../[id]/exports/[exportId]/retry/route');

const params = { params: Promise.resolve({ id: '5' }) };
const exportParams = { params: Promise.resolve({ id: '5', exportId: '7' }) };
const post = (body: unknown) => createExport(
  new NextRequest('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  params,
);

const TITULAIRE = { userId: 1, currentAccountId: 10 };
const DUO_MEMBRE = { userId: 2, currentAccountId: 10 };
const AUTRE_COMPTE = { userId: 3, currentAccountId: 20 };
const PUB = '00000000-0000-4000-8000-000000000007';

const baseAsset = (over: Row = {}): Row => ({
  id: 5, userId: 1, accountId: 10, deletedAt: null, category: 'IMMOBILIER', subtype: 'Maison',
  name: 'Maison', address: '1 rue', postalCode: '75001', city: 'Paris', ...over,
});

const genRow = (over: Row = {}): Row => ({
  id: 7, publicId: PUB, assetId: 5, accountId: 10, userId: 1, exportType: 'DOSSIER_COMPLET', status: 'ready',
  outputPayload: JSON.stringify({ pdfS3Key: 'k.pdf' }), requestedOutputs: null, errorPayload: null, errorCode: null,
  createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), ...over,
});

beforeEach(() => {
  state.session = { ...TITULAIRE };
  state.asset = baseAsset();
  state.exportRow = null;
  state.exportRows = [];
  state.files = [];
  state.inserts = [];
  state.updates = [];
  failingKeys.clear();
  deletedKeys.length = 0;
  sourceMock.mockClear();
  nudgeMock.mockClear();
  notifyMock.mockReset().mockResolvedValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('1. Dossier complet', () => {
  it('POST DOSSIER_COMPLET est accepté et mis en file (202, suivi par pollUrl)', async () => {
    const res = await post({ exportType: 'DOSSIER_COMPLET', requestedOutputs: ['PDF'] });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'pending', generationStatus: 'queued', downloadUrl: null });
    expect(body.pollUrl).toMatch(/^\/api\/export-generations\//);
    expect(state.inserts.find(i => i.table === 'export_generation')?.values).toMatchObject({ status: 'queued', exportType: 'DOSSIER_COMPLET', outputFormat: 'PDF' });
    expect(nudgeMock).toHaveBeenCalled();
  });

  it('plafond par compte : 3 générations actives → 429 en français, rien n’est inséré', async () => {
    state.exportRows = [{ n: 3 }]; // comptage des générations queued / generating du compte
    const res = await post({ exportType: 'DOSSIER_COMPLET', requestedOutputs: ['PDF'] });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe('TOO_MANY_GENERATIONS');
    expect(body.message).toMatch(/déjà 3 dossiers en cours de préparation/);
    expect(state.inserts.find(i => i.table === 'export_generation')).toBeUndefined();
  });

  it('la demande est empreinte (dédoublonnage) : options du tiroir comprises', async () => {
    await post({ exportType: 'DOSSIER_COMPLET', requestedOutputs: ['PDF'], options: { includePhotos: false } });
    const values = state.inserts.find(i => i.table === 'export_generation')?.values as Row;
    const hash = ((values.snapshotJson as Row).request as Row).requestHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const { requestHash } = await import('@/services/exports/v12/generation/enqueue');
    const a = requestHash('DOSSIER_COMPLET', { outputFormat: 'PDF', legacyOptions: { includePhotos: true, customDocIds: [1, 2] } }, null);
    expect(requestHash('DOSSIER_COMPLET', { outputFormat: 'PDF', legacyOptions: { customDocIds: [1, 2], includePhotos: true } }, null)).toBe(a);
    expect(requestHash('DOSSIER_COMPLET', { outputFormat: 'PDF', legacyOptions: { includePhotos: false, customDocIds: [1, 2] } }, null)).not.toBe(a);
    expect(requestHash('DOSSIER_COMPLET', { outputFormat: 'PDF', legacyOptions: { includePhotos: true, customDocIds: [1, 3] } }, null)).not.toBe(a);
    expect(requestHash('DOSSIER_COMPLET', { outputFormat: 'ZIP', legacyOptions: { includePhotos: true, customDocIds: [1, 2] } }, null)).not.toBe(a);
    expect(requestHash('VENTE', { outputFormat: 'PDF', legacyOptions: { includePhotos: true, customDocIds: [1, 2] } }, null)).not.toBe(a);
  });

  it('un type inconnu reste refusé (400) avec un message en français', async () => {
    const res = await post({ exportType: 'N_IMPORTE_QUOI' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_EXPORT_TYPE');
    expect(body.message).toMatch(/type de dossier/i);
  });
});

describe('2. Kit de vente — trois familles', () => {
  it.each(['OBJECT', 'VEHICULE', 'IMMOBILIER'])('accepte un bien de la famille %s', async (category) => {
    state.asset = baseAsset({ category, subtype: 'Autre' });
    const res = await post({ exportType: 'DOSSIER_VENTE' });
    expect(res.status).toBe(202);
    // Ancien code accepté, enregistré sous le code V12.
    expect(state.inserts.find(i => i.table === 'export_generation')?.values).toMatchObject({ exportType: 'VENTE' });
  });

  it('LOCATION : immobilier seulement (422 NOT_ELIGIBLE)', async () => {
    state.asset = baseAsset({ category: 'VEHICULE', subtype: 'Voiture' });
    const res = await post({ exportType: 'LOCATION' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('NOT_ELIGIBLE');
  });
});

describe('3. Accès par compte (Duo)', () => {
  it('le co-titulaire Duo liste, génère, consulte et supprime', async () => {
    state.session = { ...DUO_MEMBRE };
    expect((await listExports(new NextRequest('http://x'), params)).status).toBe(200);

    const created = await post({ exportType: 'DOSSIER_COMPLET' });
    expect(created.status).toBe(202);
    // La génération est rattachée au compte du bien et au co-titulaire qui l'a demandée.
    const insert = state.inserts.find(i => i.table === 'export_generation');
    expect(insert?.values).toMatchObject({ accountId: 10, userId: 2 });
    // Les données sont lues par compte, pas par propriétaire.
    expect(sourceMock).toHaveBeenCalledWith(expect.objectContaining({ assetId: 5, accountId: 10, userId: 2 }));

    state.exportRow = genRow();
    const one = await getExport(new NextRequest('http://x'), exportParams);
    expect(one.status).toBe(200);
    // DRH-010 : lien vers l'endpoint qui revérifie les droits, jamais une URL signée pré-émise.
    expect((await one.json()).downloadUrl).toBe(`/api/export-generations/${PUB}/download?file=pdf`);

    expect((await deleteExport(new NextRequest('http://x'), exportParams)).status).toBe(200);
  });

  it('un autre compte reçoit 404 partout (liste, création, consultation, suppression, relance)', async () => {
    state.session = { ...AUTRE_COMPTE };
    state.exportRow = genRow();
    expect((await listExports(new NextRequest('http://x'), params)).status).toBe(404);
    expect((await post({ exportType: 'DOSSIER_COMPLET' })).status).toBe(404);
    expect((await getExport(new NextRequest('http://x'), exportParams)).status).toBe(404);
    expect((await deleteExport(new NextRequest('http://x'), exportParams)).status).toBe(404);
    expect((await retryExport(new NextRequest('http://x', { method: 'POST' }), exportParams)).status).toBe(404);
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it('aucune route d’export ne filtre plus sur assets.userId', () => {
    for (const f of [
      'src/app/api/assets/[id]/exports/route.ts',
      'src/app/api/assets/[id]/exports/[exportId]/route.ts',
      'src/app/api/assets/[id]/exports/[exportId]/retry/route.ts',
      'src/app/api/assets/[id]/exports/cil/preparation/route.ts',
      'src/app/api/assets/[id]/exports/cil/resolutions/route.ts',
    ]) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/assets\.userId/);
      expect(src, f).toContain('findAccessibleAssetForExport');
    }
  });
});

describe('4. Suppression (DRH-004)', () => {
  const readyRow = () => genRow({
    outputPayload: JSON.stringify({ pdfS3Key: 'exports/10/5/7/a.pdf', zipS3Key: 'exports/10/5/7/a.zip', pdfSize: 3 }),
  });

  it('supprime directement les fichiers, sans passer par la file quand tout réussit', async () => {
    state.exportRow = readyRow();
    const res = await deleteExport(new NextRequest('http://x'), exportParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, fileDeleted: true, blobsDeleted: 2, blobsScheduled: 0 });
    expect(deletedKeys).toEqual(['exports/10/5/7/a.pdf', 'exports/10/5/7/a.zip']);
    expect(state.inserts.find(i => i.table === 'pending_blob_deletions')).toBeUndefined();
    const upd = state.updates.find(u => u.table === 'export_generation');
    expect(upd?.set.status).toBe('deleted');
    expect(upd?.set.deletedAt).toBeInstanceOf(Date);
    expect(upd?.set.fileKey).toBeNull();
  });

  it('confie à la file seulement les objets en échec, et conserve l’entrée au statut deleted', async () => {
    state.exportRow = readyRow();
    failingKeys.add('exports/10/5/7/a.zip');
    const res = await deleteExport(new NextRequest('http://x'), exportParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ blobsDeleted: 1, blobsScheduled: 1 });

    const purge = state.inserts.find(i => i.table === 'pending_blob_deletions');
    expect((purge?.values as Row[]).map(v => v.storagePath)).toEqual(['exports/10/5/7/a.zip']);

    const upd = state.updates.find(u => u.table === 'export_generation');
    expect(upd?.set.status).toBe('deleted');
    // Plus aucune clé de stockage : aucun lien ne peut viser l'objet purgé.
    expect(String(upd?.set.outputPayload)).not.toMatch(/S3Key/);
  });

  it('refuse pendant la génération ou la mise en file (409, message français)', async () => {
    for (const status of ['generating', 'queued']) {
      state.exportRow = genRow({ status, outputPayload: null });
      const res = await deleteExport(new NextRequest('http://x'), exportParams);
      expect(res.status).toBe(409);
      expect((await res.json()).message).toMatch(/en cours de génération/);
    }
  });

  it('l’historique affiche les entrées supprimées ou expirées, sans lien', async () => {
    state.exportRows = [
      genRow({ id: 7, status: 'deleted', outputPayload: JSON.stringify({ fileDeletedAt: 'x' }) }),
      genRow({ id: 8, status: 'ready', expiresAt: new Date(Date.now() - 1000) }),
    ];
    const res = await listExports(new NextRequest('http://x'), params);
    const { exports } = await res.json();
    expect(exports).toHaveLength(2);
    expect(exports[0]).toMatchObject({ status: 'deleted', generationStatus: 'deleted', downloadUrl: null, downloadZipUrl: null });
    // DRH-006 : au-delà de 30 jours, « Expiré » même avant le passage de la purge.
    expect(exports[1]).toMatchObject({ generationStatus: 'expired', downloadUrl: null });
  });
});

describe('5. CIL « action requise » bloqué', () => {
  it('422 CIL_ACTION_REQUIRED quand B3 (plans) et B8 (DPE) manquent', async () => {
    const res = await post({ exportType: 'CIL_REGLEMENTAIRE' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('CIL_ACTION_REQUIRED');
    expect(body.message).toMatch(/Le CIL ne peut pas encore être généré/);
    expect(body.blockingBlocks.map((b: Row) => b.id)).toEqual(['B3', 'B8']);
    expect(state.inserts).toHaveLength(0);
  });

  it('B1 sans adresse bloque aussi', async () => {
    state.asset = baseAsset({ address: null });
    state.files = [
      { id: 1, retainedFunctionCode: 'PLAN_CONSTRUCTION', documentType: null, cilRubricCodes: null },
      { id: 2, retainedFunctionCode: 'DPE', documentType: null, cilRubricCodes: null },
    ];
    const res = await post({ exportType: 'CIL' });
    expect(res.status).toBe(422);
    expect((await res.json()).blockingBlocks.map((b: Row) => b.id)).toEqual(['B1']);
  });

  it('met en file quand B1, B3 et B8 sont complets', async () => {
    state.files = [
      { id: 1, retainedFunctionCode: 'PLAN_CONSTRUCTION', documentType: null, cilRubricCodes: null },
      { id: 2, retainedFunctionCode: null, documentType: 'DPE', cilRubricCodes: null },
    ];
    const res = await post({ exportType: 'CIL' });
    expect(res.status).toBe(202);
  });

  it('la relance d’un CIL est bloquée de la même façon', async () => {
    state.exportRow = genRow({ exportType: 'CIL_REGLEMENTAIRE', status: 'failed', outputPayload: null });
    const res = await retryExport(new NextRequest('http://x', { method: 'POST' }), exportParams);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CIL_ACTION_REQUIRED');
  });
});

describe('6-7. Échec, relance et messages génériques', () => {
  const SECRET = 'S3 AccessDenied: bucket verebona-prod key=exports/10/5/99 at /srv/app/node_modules/x.js:12';

  it('relance : remise en file sur le compte du bien, pas celui (ancien, aléatoire) de la ligne', async () => {
    state.exportRow = genRow({ accountId: 77, status: 'failed', outputPayload: null, generationAttemptCount: 3 });
    const res = await retryExport(new NextRequest('http://x', { method: 'POST' }), exportParams);
    expect(res.status).toBe(202);
    const upd = state.updates.find(u => u.set.status === 'queued');
    expect(upd?.set).toMatchObject({ accountId: 10, errorCode: null });
    // Le compteur de tentatives n'est jamais remis à zéro ; la relance est comptée.
    expect(upd?.set).not.toHaveProperty('generationAttemptCount');
    expect(upd?.set).toHaveProperty('userRetryCount');
    expect(nudgeMock).toHaveBeenCalled();
  });

  it('relance plafonnée : 429 au-delà de 3 relances manuelles', async () => {
    state.exportRow = genRow({ status: 'failed', outputPayload: null, generationAttemptCount: 6, userRetryCount: 3 });
    const res = await retryExport(new NextRequest('http://x', { method: 'POST' }), exportParams);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe('RETRY_LIMIT_REACHED');
    expect(body.message).toMatch(/relancé/);
    expect(state.updates.find(u => u.set.status === 'queued')).toBeUndefined();
  });

  it('relance refusée pour une génération prête', async () => {
    state.exportRow = genRow();
    const res = await retryExport(new NextRequest('http://x', { method: 'POST' }), exportParams);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('RETRY_NOT_ALLOWED');
  });

  it('l’historique ne renvoie jamais le message technique (anciens payloads compris)', async () => {
    state.exportRows = [
      genRow({ exportType: 'DOSSIER_VENTE', status: 'error', outputPayload: null,
        errorPayload: JSON.stringify({ code: 'GENERATION_FAILED', message: SECRET, supportEmailSent: true }) }),
      genRow({ id: 8, status: 'failed', outputPayload: null, errorCode: 'RENDER_TIMEOUT',
        errorPayload: JSON.stringify({ code: 'RENDER_TIMEOUT', technicalMessage: SECRET }) }),
    ];
    const res = await listExports(new NextRequest('http://x'), params);
    const text = await res.text();
    expect(text).not.toContain('AccessDenied');
    const { exports } = JSON.parse(text);
    expect(exports[0]).toMatchObject({ exportType: 'VENTE', status: 'error', generationStatus: 'failed' });
    expect(exports[0].errorMessage).toMatch(/La génération du dossier a échoué/);
    // Code distinct (§21) et message propre au code (§17.3).
    expect(exports[1]).toMatchObject({ errorCode: 'RENDER_TIMEOUT' });
    expect(exports[1].errorMessage).toMatch(/Réessayez avec moins de contenu/);

    state.exportRow = state.exportRows[0] ?? null;
    const one = await (await getExport(new NextRequest('http://x'), exportParams)).text();
    expect(one).not.toContain('AccessDenied');
  });

  it('corps JSON invalide : 400 générique en français', async () => {
    const res = await createExport(
      new NextRequest('http://x', { method: 'POST', body: '{pas du json', headers: { 'content-type': 'application/json' } }),
      params,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_PAYLOAD');
    expect(JSON.stringify(body)).not.toMatch(/JSON|Unexpected/);
  });

  it('plus de TODO ni de supportEmailSent: true codé en dur', () => {
    for (const f of ['src/app/api/assets/[id]/exports/route.ts', 'src/app/api/assets/[id]/exports/[exportId]/retry/route.ts', 'src/services/exports/v12/generation/job.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/supportEmailSent:\s*true/);
      expect(src, f).not.toMatch(/sendSupportEmail/);
    }
  });
});

describe('8. Dialogues d’export historiques retirés', () => {
  // `export-preset-dialogs.tsx` (1 800 lignes, importé nulle part) appelait
  // cinq routes `/api/exports/*` inexistantes et assemblait un ZIP côté
  // navigateur : retiré. Les dossiers passent par POST /api/assets/[id]/exports.
  it('plus aucun appel client vers /api/exports/*', () => {
    expect(existsSync(join(process.cwd(), 'src/components/export-preset-dialogs.tsx'))).toBe(false);
    const drawer = readFileSync(join(process.cwd(), 'src/components/assets/ExportPrepareDrawer.tsx'), 'utf8');
    expect(drawer).not.toMatch(/['`]\/api\/exports\//);
    expect(drawer).toContain('`/api/assets/${assetId}/exports`');
  });
});

describe('Interface', () => {
  const tab = readFileSync(join(process.cwd(), 'src/components/assets/AssetExportsTab.tsx'), 'utf8');
  const drawer = readFileSync(join(process.cwd(), 'src/components/assets/ExportPrepareDrawer.tsx'), 'utf8');

  it('le kit de vente et le dossier complet restent proposés à toutes les familles (catalogue V12)', async () => {
    const { isDossierEligibleForFamily } = await import('@/services/exports/catalog');
    for (const code of ['VENTE', 'DOSSIER_COMPLET']) {
      for (const family of ['IMMOBILIER', 'VEHICULE', 'OBJECT']) expect(isDossierEligibleForFamily(code, family)).toBe(true);
    }
    expect(tab).toContain('isDossierEligibleForFamily(usage.type, assetCategory)');
  });

  it('historique : « Fichier supprimé », sans bouton de suppression', () => {
    expect(tab).toContain('Fichier supprimé');
    expect(tab).toContain("exp.status !== 'deleted'");
  });

  it('tiroir CIL : génération désactivée et message « Action requise »', () => {
    expect(drawer).toMatch(/const cilBlocked = usage === 'CIL'[^\n]*action_required/);
    expect(drawer).toMatch(/isDisabled = generating \|\| loadingData \|\| cilLoading \|\| cilBlocked/);
    expect(drawer).toContain('Action requise : le CIL ne peut pas être généré');
  });
});

describe('Règle d’accès réelle (findAccessibleAssetForExport)', () => {
  it('filtre sur le compte courant et les biens non supprimés, jamais sur userId', async () => {
    const real = await vi.importActual<typeof import('@/services/exports/export-access')>('@/services/exports/export-access');
    state.lastWhere = null;
    await real.findAccessibleAssetForExport({ userId: 2, currentAccountId: 10 }, 5);
    const q = new PgDialect().sqlToQuery(state.lastWhere as never);
    expect(q.sql).toContain('"account_id" = $');
    expect(q.sql).toContain('"deleted_at" is null');
    expect(q.sql).not.toContain('"user_id"');
    expect(q.params).toEqual([5, 10]);
  });

  it('sans compte courant : aucun accès, aucune requête', async () => {
    const real = await vi.importActual<typeof import('@/services/exports/export-access')>('@/services/exports/export-access');
    state.lastWhere = null;
    expect(await real.findAccessibleAssetForExport({ userId: 2 }, 5)).toBeNull();
    expect(state.lastWhere).toBeNull();
  });
});
