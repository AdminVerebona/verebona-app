/**
 * De bout en bout : écran de préparation → PDF réel (Chromium).
 *
 * La préparation serveur (`buildPreparation`) est chargée dans la machine
 * d'états de l'écran, l'utilisateur y fait des choix (pièce sensible cochée
 * explicitement, photo retirée, pièce passée en ZIP, section désactivée),
 * le payload §17.2 produit par l'écran est relu par la génération
 * (`parseChoicesPayload`) puis rendu par le moteur réel : le PDF et le ZIP
 * contiennent exactement ces choix (SEL-GEN-001, ZIP-001 à 004, DEC-006).
 *
 * Ignoré sans Chromium (`EXPORTS_CHROMIUM_TESTS=0` ou binaire absent).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';
import { makeSource, doc, photo, event, TODAY } from './fixtures/sources';

vi.mock('@/db', () => ({ db: {} }));

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && !process.env.CHROMIUM_EXECUTABLE_PATH && fs.existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

const { isChromiumAvailable, closeBrowser } = await import('../render/browser');
const enabled = process.env.EXPORTS_CHROMIUM_TESTS !== '0' && (await isChromiumAvailable());

async function pdfText(bytes: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/') }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    out.push(c.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await pdf.destroy();
  return out.join(' ').normalize('NFKC').replace(/\s+/g, ' ');
}

describe.skipIf(!enabled)('Préparation → génération réelle (kit de vente)', () => {
  let dir: string;
  const files: Record<string, string> = {};

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v12-prep-'));
    const mk = async (name: string, text: string) => {
      const d = await PDFDocument.create();
      const f = await d.embedFont(StandardFonts.Helvetica);
      d.addPage([595, 842]).drawText(text, { x: 60, y: 760, size: 20, font: f });
      fs.writeFileSync(files[name] = path.join(dir, `${name}.pdf`), await d.save());
    };
    await mk('dpe', 'CONTENU DPE');
    await mk('acte', 'CONTENU ACTE');
    await mk('facture', 'CONTENU FACTURE');
    fs.writeFileSync(files.word = path.join(dir, 'devis.docx'), 'PK fake docx');
    await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 60, g: 110, b: 170 } } }).jpeg().toFile(files.photo = path.join(dir, 'p.jpg'));
  }, 60_000);

  afterAll(async () => {
    await closeBrowser('fin des tests');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('les choix faits à l’écran se retrouvent dans le PDF et le ZIP', async () => {
    const { buildPreparation } = await import('../preparation/prepare');
    const { prepReducer, initialPrepState, buildGenerateBody } = await import('@/lib/exports/preparation-state');
    const { parseChoicesPayload } = await import('../data/choices');
    const { renderDossier } = await import('../render/render-dossier');

    const source = makeSource('IMMOBILIER', 'VENTE', {
      documents: [
        doc({ id: 1, kind: 'DPE', title: 'Diagnostic de performance énergétique', s3Key: 'dpe' }),
        doc({ id: 2, kind: 'ACTE_NOTARIE', title: 'Acte de vente 2019', sensitive: true, s3Key: 'acte' }),
        doc({ id: 3, kind: 'FACTURE', title: 'Facture non retenue', s3Key: 'facture' }),
        doc({ id: 4, kind: 'DEVIS', title: 'Devis cuisine', format: 'DOCX', integrable: false, fileName: 'devis cuisine.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', s3Key: 'word' }),
      ],
      photos: [1, 2, 3, 4, 5].map((i) => photo(i, { s3Key: 'photo', caption: `Vue ${i}` })),
      events: [event(1, { title: 'Ravalement de façade', category: 'travaux', date: '2025-05-02' })],
    });

    // 1. Préparation serveur chargée dans l'écran.
    const prep = buildPreparation('VENTE', source, { today: TODAY, lastGeneration: null });
    let s = prepReducer(initialPrepState, { type: 'LOAD_SUCCESS', prep });
    expect(prep.estimate.pdfPhotos).toBe(4);

    // 2. Choix de l'utilisateur.
    s = prepReducer(s, { type: 'TOGGLE_ITEM', key: 'document:1', selected: true });              // DPE → PDF
    s = prepReducer(s, { type: 'TOGGLE_ITEM', key: 'document:2', selected: true });              // sensible, explicite
    s = prepReducer(s, { type: 'SET_MODE', key: 'document:2', mode: 'ZIP' });                     // … joint au ZIP
    s = prepReducer(s, { type: 'TOGGLE_ITEM', key: 'document:4', selected: true });              // DOCX → ZIP automatique
    s = prepReducer(s, { type: 'TOGGLE_ITEM', key: 'photo:3', selected: false });                // photo retirée
    s = prepReducer(s, { type: 'SET_SECTION', id: 'highlights', enabled: false });              // section retirée
    expect(s.items['document:4'].mode).toBe('ZIP');

    // 3. Payload §17.2 de l'écran → génération.
    const body = buildGenerateBody(s, 'ZIP');
    const parsed = parseChoicesPayload('VENTE', JSON.parse(JSON.stringify(body.choices)));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const workDir = fs.mkdtempSync(path.join(dir, 'work-'));
    const r = await renderDossier({
      code: 'VENTE', source, choices: parsed.choices, today: TODAY, workDir, timeoutMs: 90_000,
      fetchToFile: async (key, _b, dest) => { if (!files[key]) return false; fs.copyFileSync(files[key], dest); return true; },
      meta: { reference: 'VBN-VENTE-TEST', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'Claire Martin' },
    });

    const text = await pdfText(r.pdf);
    // Intégrée au PDF (annexe) : le DPE, avec sa page source.
    expect(text).toContain('Diagnostic de performance énergétique');
    expect(text).toContain('CONTENU DPE');
    // Jointes au ZIP : listées, jamais intégrées.
    expect(text).not.toContain('CONTENU ACTE');
    expect(r.zipEntries.map((z) => z.path).sort()).toEqual(['documents/acte-de-vente-2019.pdf', 'documents/devis-cuisine.docx']);
    // Non cochée : absente partout (SEL-GEN-001).
    expect(text).not.toContain('Facture non retenue');
    expect(r.zipEntries.some((z) => z.path.includes('facture'))).toBe(false);
    // Photos : 4 pré-cochées moins la n° 3.
    expect(r.counts.photos).toBe(3);
    expect(r.plan.photos.map((p) => p.photo.id)).toEqual([1, 2, 4]);
    // Section désactivée et suivi non coché : absents.
    expect(text).not.toContain('Mise en valeur du bien');
    expect(text).not.toContain('Ravalement de façade');
    expect(r.partial).toBe(false);
  }, 120_000);
});
