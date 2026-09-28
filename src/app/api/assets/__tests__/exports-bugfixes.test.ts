/**
 * Exports — corrections P1/P2 de l'audit CDC 16 (V12) sur le système actuel :
 *   1. DOSSIER_COMPLET générable ;
 *   2. dossier de vente ouvert aux objets ;
 *   3. accès par compte (co-titulaire Duo admis, autre compte refusé) ;
 *   4. suppression : fichier purgé, entrée d'historique conservée (DRH-004) ;
 *   5. CIL « action requise » bloqué côté serveur (CIL-RULE-002) ;
 *   6. notification support réelle, `supportEmailSent` jamais forcé ;
 *   7. messages d'erreur génériques (détail technique en journal seulement) ;
 *   8. dialogues d'export : signal `verebona:data-mutated` après succès.
 */
import { readFileSync } from 'node:fs';
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
  const chain: Record<string, unknown> = {};
  chain.from = (t: unknown) => { table = tableOf(t); return chain; };
  chain.where = (w: unknown) => { state.lastWhere = w; return chain; };
  chain.orderBy = () => chain;
  chain.limit = (n: number) => { limited = n === 1; return chain; };
  chain.set = (v: Row) => { state.updates.push({ table, set: v }); return chain; };
  chain.values = (v: unknown) => { state.inserts.push({ table, values: v }); return chain; };
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
      } else if (kind === 'insert' && returning) out = [{ id: 99, publicId: 'pub-99' }];
      else if (kind === 'update' && returning) out = [{ id: 99 }];
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
  return { db };
});

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

const renderMock = vi.fn(async () => Buffer.from('%PDF'));
const snapshotMock = vi.fn(async (..._args: unknown[]) => ({ address: '1 rue', postalCode: '75001', city: 'Paris', category: 'OBJET' }));
const notifyMock = vi.fn(async (..._args: unknown[]) => false);

vi.mock('@/services/export-upload.service', () => ({
  getExportSignedUrl: async (k: string) => `https://signed/${k}`,
  uploadExportFile: async (_b: unknown, k: string) => k,
  buildExportS3Key: (acc: number, asset: number, exp: number, f: string) => `exports/${acc}/${asset}/${exp}/${f}`,
}));
vi.mock('@/services/export-snapshot.service', () => ({ buildAssetSnapshot: (...a: unknown[]) => snapshotMock(...a) }));
vi.mock('@/services/export-manifest.service', () => ({ buildExportManifest: () => ({}) }));
vi.mock('@/services/pdf-renderer.service', () => ({ renderExportToPdf: () => renderMock() }));
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

const baseAsset = (over: Row = {}): Row => ({
  id: 5, userId: 1, accountId: 10, deletedAt: null, category: 'IMMOBILIER', subtype: 'Maison',
  name: 'Maison', address: '1 rue', postalCode: '75001', city: 'Paris', ...over,
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
  renderMock.mockReset().mockResolvedValue(Buffer.from('%PDF'));
  snapshotMock.mockClear();
  notifyMock.mockReset().mockResolvedValue(false);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('1. Dossier complet', () => {
  it('POST DOSSIER_COMPLET est accepté et génère le PDF', async () => {
    const res = await post({ exportType: 'DOSSIER_COMPLET', requestedOutputs: ['PDF'] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ready');
    expect(body.downloadUrl).toContain('exports/10/5/99/');
  });

  it('un type inconnu reste refusé (400) avec un message en français', async () => {
    const res = await post({ exportType: 'N_IMPORTE_QUOI' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_EXPORT_TYPE');
    expect(body.message).toMatch(/Type de dossier/);
  });
});

describe('2. Dossier de vente — trois familles', () => {
  it.each(['OBJET', 'VEHICULE', 'IMMOBILIER'])('accepte un bien de la famille %s', async (category) => {
    state.asset = baseAsset({ category, subtype: 'Autre' });
    const res = await post({ exportType: 'DOSSIER_VENTE' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ready');
  });

  it('le manifeste n’exclut plus les objets', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/export-manifest.service.ts'), 'utf8');
    expect(src).not.toMatch(/DOSSIER_VENTE is only available/);
  });
});

describe('3. Accès par compte (Duo)', () => {
  it('le co-titulaire Duo liste, génère, consulte et supprime', async () => {
    state.session = { ...DUO_MEMBRE };
    expect((await listExports(new NextRequest('http://x'), params)).status).toBe(200);

    const created = await post({ exportType: 'DOSSIER_COMPLET' });
    expect(created.status).toBe(200);
    // L'export est rattaché au compte du bien et au co-titulaire qui l'a généré.
    const insert = state.inserts.find(i => i.table === 'export_generation');
    expect(insert?.values).toMatchObject({ accountId: 10, userId: 2 });
    // Le snapshot est lu par compte, pas par propriétaire.
    expect(snapshotMock).toHaveBeenCalledWith(5, 2, { accountId: 10 });

    state.exportRow = { id: 7, assetId: 5, status: 'ready', outputPayload: JSON.stringify({ pdfS3Key: 'k.pdf' }) };
    const one = await getExport(new NextRequest('http://x'), exportParams);
    expect(one.status).toBe(200);
    expect((await one.json()).downloadUrl).toBe('https://signed/k.pdf');

    expect((await deleteExport(new NextRequest('http://x'), exportParams)).status).toBe(200);
  });

  it('un autre compte reçoit 404 partout (liste, création, téléchargement, suppression, relance)', async () => {
    state.session = { ...AUTRE_COMPTE };
    state.exportRow = { id: 7, assetId: 5, status: 'ready', outputPayload: JSON.stringify({ pdfS3Key: 'k.pdf' }) };
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
  const readyRow = () => ({
    id: 7, assetId: 5, status: 'ready',
    outputPayload: JSON.stringify({ pdfS3Key: 'exports/10/5/7/a.pdf', zipS3Key: 'exports/10/5/7/a.zip', pdfSize: 3 }),
  });

  it('supprime directement les fichiers, sans passer par la file quand tout réussit', async () => {
    state.exportRow = readyRow();
    const res = await deleteExport(new NextRequest('http://x'), exportParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, fileDeleted: true, blobsDeleted: 2, blobsScheduled: 0 });
    expect(deletedKeys).toEqual(['exports/10/5/7/a.pdf', 'exports/10/5/7/a.zip']);
    expect(state.inserts.find(i => i.table === 'pending_blob_deletions')).toBeUndefined();
    expect(state.updates.find(u => u.table === 'export_generation')?.set.status).toBe('deleted');
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
    // Pas de DELETE de ligne : l'entrée reste.
  });

  it('refuse pendant la génération (409, message français)', async () => {
    state.exportRow = { id: 7, assetId: 5, status: 'generating', outputPayload: null };
    const res = await deleteExport(new NextRequest('http://x'), exportParams);
    expect(res.status).toBe(409);
    expect((await res.json()).message).toMatch(/en cours de génération/);
  });

  it('l’historique affiche les entrées supprimées, sans lien', async () => {
    state.exportRows = [
      { id: 7, publicId: 'a', exportType: 'DOSSIER_COMPLET', status: 'deleted', outputPayload: JSON.stringify({ fileDeletedAt: 'x' }), requestedOutputs: null, errorPayload: null },
    ];
    const res = await listExports(new NextRequest('http://x'), params);
    const { exports } = await res.json();
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ status: 'deleted', downloadUrl: null, downloadZipUrl: null });
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
    const res = await post({ exportType: 'CIL_REGLEMENTAIRE' });
    expect(res.status).toBe(422);
    expect((await res.json()).blockingBlocks.map((b: Row) => b.id)).toEqual(['B1']);
  });

  it('génère quand B1, B3 et B8 sont complets', async () => {
    state.files = [
      { id: 1, retainedFunctionCode: 'PLAN_CONSTRUCTION', documentType: null, cilRubricCodes: null },
      { id: 2, retainedFunctionCode: null, documentType: 'DPE', cilRubricCodes: null },
    ];
    const res = await post({ exportType: 'CIL_REGLEMENTAIRE' });
    expect(res.status).toBe(200);
  });

  it('la relance d’un CIL est bloquée de la même façon', async () => {
    state.exportRow = { id: 7, assetId: 5, accountId: 10, exportType: 'CIL_REGLEMENTAIRE', status: 'error', outputPayload: null };
    const res = await retryExport(new NextRequest('http://x', { method: 'POST' }), exportParams);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('CIL_ACTION_REQUIRED');
  });
});

describe('6-7. Échec de génération : support notifié, message générique', () => {
  const SECRET = 'S3 AccessDenied: bucket verebona-prod key=exports/10/5/99 at /srv/app/node_modules/x.js:12';

  it('POST : message générique + code, détail seulement côté serveur, supportEmailSent réel', async () => {
    renderMock.mockRejectedValueOnce(new Error(SECRET));
    notifyMock.mockResolvedValueOnce(false);
    const res = await post({ exportType: 'DOSSIER_COMPLET' });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('AccessDenied');
    const body = JSON.parse(text);
    expect(body).toMatchObject({ status: 'error', code: 'GENERATION_FAILED', errorCode: 'GENERATION_FAILED' });
    expect(body.message).toMatch(/La génération du dossier a échoué/);

    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ exportId: 99, technicalMessage: SECRET, accountId: 10 }));
    const stored = JSON.parse(String(state.updates.find(u => u.set.status === 'error')?.set.errorPayload));
    expect(stored.supportEmailSent).toBe(false);
    expect(stored.technicalMessage).toBe(SECRET);
    expect(stored.message).not.toContain('AccessDenied');
  });

  it('supportEmailSent vaut true seulement si l’envoi a réussi', async () => {
    renderMock.mockRejectedValueOnce(new Error('boom'));
    notifyMock.mockResolvedValueOnce(true);
    await post({ exportType: 'DOSSIER_COMPLET' });
    const stored = JSON.parse(String(state.updates.find(u => u.set.status === 'error')?.set.errorPayload));
    expect(stored.supportEmailSent).toBe(true);
  });

  it('relance : compte du bien, pas celui (ancien, aléatoire) de la ligne d’export', async () => {
    state.exportRow = { id: 7, assetId: 5, accountId: 77, exportType: 'DOSSIER_COMPLET', status: 'error', outputPayload: null, generationAttemptCount: 1 };
    const res = await retryExport(new NextRequest('http://x', { method: 'POST' }), exportParams);
    expect(res.status).toBe(200);
    expect(snapshotMock).toHaveBeenCalledWith(5, 1, { accountId: 10 });
    expect((await res.json()).downloadUrl).toContain('exports/10/5/7/');
    // La ligne est réalignée sur le compte du bien.
    expect(state.updates.find(u => u.set.status === 'generating')?.set.accountId).toBe(10);

    state.exportRow = { ...state.exportRow, status: 'error' };
    renderMock.mockRejectedValueOnce(new Error('boom'));
    await retryExport(new NextRequest('http://x', { method: 'POST' }), exportParams);
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ accountId: 10 }));
  });

  it('relance : même traitement', async () => {
    state.exportRow = { id: 7, assetId: 5, accountId: 10, exportType: 'DOSSIER_COMPLET', status: 'error', outputPayload: null, generationAttemptCount: 1 };
    renderMock.mockRejectedValueOnce(new Error(SECRET));
    const res = await retryExport(new NextRequest('http://x', { method: 'POST' }), exportParams);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('AccessDenied');
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({ attemptCount: 2 }));
    const stored = JSON.parse(String(state.updates.find(u => u.set.status === 'error')?.set.errorPayload));
    expect(stored.supportEmailSent).toBe(false);
  });

  it('l’historique ne renvoie jamais le message technique (anciens payloads compris)', async () => {
    state.exportRows = [
      { id: 7, publicId: 'a', exportType: 'DOSSIER_VENTE', status: 'error', outputPayload: null, requestedOutputs: null,
        errorPayload: JSON.stringify({ code: 'GENERATION_FAILED', message: SECRET, supportEmailSent: true }) },
    ];
    const res = await listExports(new NextRequest('http://x'), params);
    const text = await res.text();
    expect(text).not.toContain('AccessDenied');
    expect(JSON.parse(text).exports[0].errorMessage).toMatch(/La génération du dossier a échoué/);

    state.exportRow = state.exportRows[0];
    const one = await (await getExport(new NextRequest('http://x'), exportParams)).text();
    expect(one).not.toContain('AccessDenied');
  });

  it('erreur inattendue hors génération : 500 générique en français', async () => {
    const res = await createExport(
      new NextRequest('http://x', { method: 'POST', body: '{pas du json', headers: { 'content-type': 'application/json' } }),
      params,
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('EXPORT_INTERNAL_ERROR');
    expect(body.message).toMatch(/Une erreur est survenue/);
    expect(JSON.stringify(body)).not.toMatch(/JSON|Unexpected/);
  });

  it('plus de TODO ni de supportEmailSent: true codé en dur', () => {
    for (const f of ['src/app/api/assets/[id]/exports/route.ts', 'src/app/api/assets/[id]/exports/[exportId]/retry/route.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/supportEmailSent:\s*true/);
      expect(src, f).not.toMatch(/sendSupportEmail/);
    }
  });
});

describe('8. Dialogues d’export : signal de mutation', () => {
  it('chaque génération réussie émet verebona:data-mutated', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/export-preset-dialogs.tsx'), 'utf8');
    expect(src).toContain("new CustomEvent('verebona:data-mutated')");
    const okChecks = src.match(/if \(!response\.ok\) throw new Error\('Erreur lors de la génération'\);\n\s*signalerExportCree\(\);/g) ?? [];
    const fetches = src.match(/await fetch\('\/api\/exports\//g) ?? [];
    expect(fetches.length).toBeGreaterThanOrEqual(4);
    expect(okChecks.length).toBe(fetches.length);
  });
});

describe('Interface', () => {
  const tab = readFileSync(join(process.cwd(), 'src/components/assets/AssetExportsTab.tsx'), 'utf8');
  const drawer = readFileSync(join(process.cwd(), 'src/components/assets/ExportPrepareDrawer.tsx'), 'utf8');

  it('le dossier de vente et le dossier complet restent proposés à toutes les familles', () => {
    for (const type of ['DOSSIER_VENTE', 'DOSSIER_COMPLET']) {
      const bloc = tab.slice(tab.indexOf(`type: '${type}'`), tab.indexOf('}', tab.indexOf(`type: '${type}'`)));
      expect(bloc).toContain("allowedCategories: 'ALL'");
    }
  });

  it('historique : « Fichier supprimé », sans bouton de suppression', () => {
    expect(tab).toContain('Fichier supprimé');
    expect(tab).toContain("exp.status !== 'deleted'");
  });

  it('tiroir CIL : génération désactivée et message « Action requise »', () => {
    expect(drawer).toMatch(/const cilBlocked = usage === 'CIL_REGLEMENTAIRE'[^\n]*action_required/);
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
