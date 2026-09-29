/**
 * De bout en bout, par les routes : prepare → estimate → génération (§17)
 * → rendu réel (Chromium), avec les données structurées des informations
 * complémentaires (schéma v2) :
 *   · sinistre : événement de l'agenda lié (sans date saisie), dommages avec
 *     photos et pièces liées, actions, échanges ; pièce sensible liée mais
 *     non cochée → jamais citée ;
 *   · dossier complet : section financière cochée à l'écran → valeur retenue
 *     et charges dans le PDF.
 * Droits vérifiés à chaque étape : co-titulaire Duo admis, autre compte 404,
 * offre sans dossiers 403.
 *
 * Le rendu part des choix ENREGISTRÉS dans la génération mise en file
 * (`snapshot_json.request`), comme le worker (`effectiveChoices`).
 * Ignoré sans Chromium.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getTableName } from 'drizzle-orm';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { makeSource, doc, photo, event, TODAY } from '@/services/exports/v12/__tests__/fixtures/sources';
import type { ExportSource } from '@/services/exports/v12/data/source';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && !process.env.CHROMIUM_EXECUTABLE_PATH && fs.existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

type Row = Record<string, unknown>;
const state = {
  session: { userId: 2, currentAccountId: 10 } as { userId: number; currentAccountId?: number },
  asset: null as Row | null,
  premium: { allowed: true } as { allowed: boolean; reason?: string; message?: string },
  inserts: [] as Array<{ table: string; values: Row }>,
  source: null as ExportSource | null,
};

const tableOf = (t: unknown) => { try { return getTableName(t as never); } catch { return '?'; } };
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
  c.then = (resolve: (v: unknown) => void) => resolve(kind === 'insert' && returning
    ? [{ id: 99, publicId: '00000000-0000-4000-8000-000000000099', createdAt: new Date(), ...values }]
    : []);
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
  SessionService: { getSession: async () => state.session, handleSessionError: () => new Response('{}', { status: 500 }) },
}));
vi.mock('@/services/exports/export-access', () => ({
  findAccessibleAssetForExport: async (session: { currentAccountId?: number }, assetId: number) =>
    (state.asset && state.asset.id === assetId && state.asset.accountId === session.currentAccountId ? state.asset : null),
}));
vi.mock('@/services/entitlements.service', () => ({ canUsePremiumFeature: async () => state.premium }));
vi.mock('@/services/exports/v12/data/source', async (orig) => ({
  ...(await orig<typeof import('@/services/exports/v12/data/source')>()),
  loadExportSource: async () => state.source!,
}));
vi.mock('@/services/exports/v12/generation/clock', async (orig) => ({ ...(await orig<object>()), parisDate: () => TODAY }));
vi.mock('@/services/exports/v12/generation/rate-limit', () => ({ exportRateLimitResponse: () => null }));
vi.mock('@/services/exports/v12/generation/worker', () => ({ nudgeExportWorker: () => {} }));
vi.mock('@/services/export-upload.service', () => ({ uploadExportFile: async () => '', buildExportS3Key: () => '' }));
vi.mock('@/services/export-snapshot.service', () => ({ buildAssetSnapshot: async () => ({}) }));
vi.mock('@/services/export-manifest.service', () => ({ buildExportManifest: () => ({}) }));
vi.mock('@/services/export-zip.service', () => ({ buildExportZip: async () => Buffer.from('zip') }));

const { isChromiumAvailable, closeBrowser } = await import('@/services/exports/v12/render/browser');
const enabled = process.env.EXPORTS_CHROMIUM_TESTS !== '0' && (await isChromiumAvailable());

const { POST: prepareRoute } = await import('../[id]/exports/prepare/route');
const { POST: estimateRoute } = await import('../[id]/exports/estimate/route');
const { POST: createExport } = await import('../[id]/exports/route');
const { prepReducer, initialPrepState, buildEstimateBody, buildGenerateBody } = await import('@/lib/exports/preparation-state');
type PrepAction = import('@/lib/exports/preparation-state').PrepAction;

const call = (route: typeof prepareRoute, body: unknown) => route(
  new NextRequest('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: '5' }) },
);

async function pdfText(bytes: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/') }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) out.push((await (await pdf.getPage(i)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' '));
  await pdf.destroy();
  return out.join(' ').normalize('NFKC').replace(/\s+/g, ' ');
}

const DUO = { userId: 2, currentAccountId: 10 };
const AUTRE = { userId: 3, currentAccountId: 20 };

describe.skipIf(!enabled)('Routes de préparation → PDF réel (données structurées, Duo, droits)', () => {
  let dir: string;
  const files: Record<string, string> = {};

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v12-prep-routes-'));
    for (const [k, t] of [['devis', 'CONTENU DEVIS'], ['facture', 'CONTENU FACTURE'], ['releve', 'CONTENU RELEVE']]) {
      const d = await PDFDocument.create();
      d.addPage([595, 842]).drawText(t, { x: 60, y: 760, size: 20, font: await d.embedFont(StandardFonts.Helvetica) });
      fs.writeFileSync(files[k] = path.join(dir, `${k}.pdf`), await d.save());
    }
    await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 90, g: 120, b: 160 } } }).jpeg().toFile(files.photo = path.join(dir, 'p.jpg'));
  }, 60_000);
  afterAll(async () => { await closeBrowser('fin des tests'); fs.rmSync(dir, { recursive: true, force: true }); });

  beforeEach(() => {
    state.session = { ...DUO };
    state.asset = { id: 5, userId: 1, accountId: 10, deletedAt: null, category: 'IMMOBILIER', subtype: 'Appartement', name: 'Appartement', address: '1 rue', postalCode: '69002', city: 'Lyon' };
    state.premium = { allowed: true };
    state.inserts = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** Parcours complet par les routes, en co-titulaire Duo ; renvoie le PDF rendu. */
  async function journey(exportType: string, actions: (prep: import('@/services/exports/v12/preparation/types').PreparationDto) => PrepAction[], format: 'PDF' | 'ZIP') {
    const prepRes = await call(prepareRoute, { exportType });
    expect(prepRes.status).toBe(200);
    const prep = await prepRes.json();
    let s = prepReducer(initialPrepState, { type: 'LOAD_SUCCESS', prep });
    for (const a of actions(prep)) s = prepReducer(s, a);
    const estRes = await call(estimateRoute, buildEstimateBody(s));
    expect(estRes.status).toBe(200);
    const est = await estRes.json();
    expect(est.actions.canGeneratePdf).toBe(true);
    const genRes = await call(createExport, buildGenerateBody(s, format));
    expect(genRes.status).toBe(202);
    const inserted = state.inserts.find((i) => i.table === 'export_generation')!.values;
    // Le co-titulaire Duo est l'auteur de la génération (DRH-003).
    expect(inserted).toMatchObject({ userId: 2, accountId: 10, status: 'queued' });

    const { effectiveChoices } = await import('@/services/exports/v12/generation/job');
    const { renderDossier } = await import('@/services/exports/v12/render/render-dossier');
    const req = (inserted.snapshotJson as { request: Parameters<typeof effectiveChoices>[2] }).request;
    const code = exportType as 'ASSURANCE_SINISTRE';
    const choices = effectiveChoices(code, state.source!, req, TODAY);
    const r = await renderDossier({
      code, source: state.source!, choices, today: TODAY, workDir: fs.mkdtempSync(path.join(dir, 'w-')), timeoutMs: 90_000,
      fetchToFile: async (key, _b, dest) => { if (!files[key]) return false; fs.copyFileSync(files[key], dest); return true; },
      meta: { reference: 'VBN-TEST', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'Co-titulaire' },
    });
    // Casse ignorée : les sur-titres du PDF sont en capitales (CSS).
    const text = (await pdfText(r.pdf)).toLowerCase();
    return { prep, est, r, text };
  }

  it('sinistre : agenda lié, dommages / actions / échanges, pièce sensible liée jamais citée', async () => {
    state.source = makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE', {
      asset: { ...makeSource('IMMOBILIER', 'ASSURANCE_SINISTRE').asset, id: 5 },
      additionalInfo: {
        commercial: {}, rental: {}, insurance: {}, updatedAt: null,
        claim: {
          claimEventKey: 'agenda:9', claimType: 'DEGAT_DES_EAUX',
          damages: [{ id: 'd1', zone: 'Salle de bain', element: 'Plafond', finding: 'Auréoles au plafond', photoIds: [1], documentIds: [1, 3] }],
          actions: [{ id: 'a1', title: 'Séchage du plafond', date: '2026-08-15', status: 'REALISEE', invoiceDocumentId: 2 }],
          exchanges: [{ id: 'x1', date: '2026-08-20', summary: 'Convocation à l’expertise', party: 'EXPERT', channel: 'EMAIL', direction: 'RECU' }],
        },
      } as never,
      documents: [
        doc({ id: 1, kind: 'DEVIS', title: 'Devis réfection plafond', date: '2026-08-18', s3Key: 'devis' }),
        doc({ id: 2, kind: 'FACTURE', title: 'Facture séchage', date: '2026-08-16', s3Key: 'facture' }),
        doc({ id: 3, kind: 'DOCUMENT_BANCAIRE', title: 'Relevé bancaire remboursement', date: '2026-08-25', sensitive: true, s3Key: 'releve' }),
      ],
      photos: [photo(1, { s3Key: 'photo', date: '2026-08-15', caption: 'Plafond' }), photo(2, { s3Key: 'photo', date: '2025-01-01', caption: 'Avant' })],
      events: [{ ...event(9, { title: 'Dégât des eaux', date: '2026-08-14' }), key: 'agenda:9', source: 'agenda', category: null }],
    });
    const { prep, text, r } = await journey('ASSURANCE_SINISTRE', (p) => {
      const damages = p.sections.find((x) => x.id === 'damages')!;
      expect(damages.rows[0].linked).toEqual(['photo:1', 'document:1', 'document:3']);
      // Écran : « Retenir les pièces liées » — la pièce sensible reste décochée.
      return [{ type: 'SELECT_LINKED', keys: damages.rows[0].linked }];
    }, 'PDF');
    // Date du sinistre reprise de l'agenda : pièces et photos postérieures pré-cochées.
    const items = prep.sections.flatMap((x: { items: Array<{ key: string; selected: boolean }> }) => x.items);
    expect(items.find((i: { key: string }) => i.key === 'document:1').selected).toBe(true);
    expect(items.find((i: { key: string }) => i.key === 'photo:1').selected).toBe(true);
    expect(items.find((i: { key: string }) => i.key === 'photo:2').selected).toBe(false);
    expect(items.find((i: { key: string }) => i.key === 'document:3').selected).toBe(false);

    for (const t of ['Salle de bain', 'Auréoles au plafond', 'Séchage du plafond', 'Convocation à l’expertise', 'Devis réfection plafond', 'CONTENU DEVIS']) expect(text).toContain(t.toLowerCase());
    expect(text).not.toContain('relevé bancaire');
    expect(text).not.toContain('contenu releve');
    expect(r.plan.documents.map((d) => d.doc.id).sort()).toEqual([1, 2]);
  }, 150_000);

  it('dossier complet : section financière cochée à l’écran → valeur retenue et charges dans le PDF', async () => {
    state.source = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      asset: { ...makeSource('IMMOBILIER', 'DOSSIER_COMPLET').asset, id: 5 },
      additionalInfo: {
        commercial: {}, rental: {}, insurance: {}, claim: {}, updatedAt: null,
        finance: { retainedValueCents: 34_000_000, retainedValueSource: 'EXPERTISE', retainedValueDate: '2026-05-01', charges: [{ id: 'c1', kind: 'TAXE_FONCIERE', amountCents: 125_000, year: 2025, period: 'AN' }] },
      } as never,
      documents: [doc({ id: 1, kind: 'FACTURE', title: 'Facture chaudière', s3Key: 'facture' })],
    });
    const { prep, text } = await journey('DOSSIER_COMPLET', (p) => {
      expect(p.sections.find((x) => x.id === 'finance')).toMatchObject({ enabled: false, rows: expect.arrayContaining([expect.objectContaining({ label: 'Valeur retenue' })]) });
      return [{ type: 'SET_SECTION', id: 'finance', enabled: true }];
    }, 'PDF');
    expect(prep.exportType).toBe('DOSSIER_COMPLET');
    for (const t of ['Valeur, acquisition et informations financières', 'Valeur retenue', 'Taxe foncière', 'Facture chaudière']) expect(text).toContain(t.toLowerCase());
  }, 150_000);

  it('dossier complet : section financière laissée décochée → aucune donnée financière', async () => {
    state.source = makeSource('IMMOBILIER', 'DOSSIER_COMPLET', {
      asset: { ...makeSource('IMMOBILIER', 'DOSSIER_COMPLET').asset, id: 5 },
      additionalInfo: { commercial: {}, rental: {}, insurance: {}, claim: {}, updatedAt: null, finance: { retainedValueCents: 34_000_000 } } as never,
    });
    const { text } = await journey('DOSSIER_COMPLET', () => [], 'PDF');
    expect(text).not.toContain('valeur retenue');
  }, 150_000);

  it('autre compte : 404 à chaque étape ; offre sans dossiers : 403 à chaque étape, rien en file', async () => {
    state.source = makeSource('IMMOBILIER', 'DOSSIER_COMPLET');
    const gen = { exportType: 'DOSSIER_COMPLET', choices: { outputFormat: 'PDF', sections: [] } };
    state.session = { ...AUTRE };
    for (const [route, body] of [[prepareRoute, { exportType: 'DOSSIER_COMPLET' }], [estimateRoute, { exportType: 'DOSSIER_COMPLET', choices: {} }], [createExport, gen]] as const) {
      expect((await call(route, body)).status).toBe(404);
    }
    state.session = { ...DUO };
    state.premium = { allowed: false, reason: 'PREMIUM_REQUIRED', message: 'Premium requis.' };
    for (const [route, body] of [[prepareRoute, { exportType: 'DOSSIER_COMPLET' }], [estimateRoute, { exportType: 'DOSSIER_COMPLET', choices: {} }], [createExport, gen]] as const) {
      expect((await call(route, body)).status).toBe(403);
    }
    expect(state.inserts.filter((i) => i.table === 'export_generation')).toHaveLength(0);
  });
});
