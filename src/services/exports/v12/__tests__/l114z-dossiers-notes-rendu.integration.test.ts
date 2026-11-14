/**
 * Lot 114Z (Trello #767, écart E03) — génération RÉELLE (Chromium) d'un dossier destiné à un
 * tiers, PDF puis ZIP, ouverts et inspectés : « Notes / Description » absente par défaut,
 * présente seulement si l'inclusion est cochée, jamais l'ancienne description masquée ou effacée.
 *
 *   L114Z-IT-01  vente : PDF sans inclusion → aucun texte ; avec inclusion → texte affiché une fois ;
 *   L114Z-IT-02  assurance (souscription) : PDF + ZIP ; le PDF contenu dans le ZIP est inspecté.
 *
 * Ignoré sans Chromium (même règle que `v12-render.integration.test.ts`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';
import { makeSource, doc, TODAY } from './fixtures/sources';
import type { DossierCode } from '@/services/exports/catalog';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && !process.env.CHROMIUM_EXECUTABLE_PATH && fs.existsSync('/opt/pw-browsers')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
}

const { chromiumAvailability, closeBrowser } = await import('../render/browser');
const pdfjsLisible = typeof (process as { getBuiltinModule?: unknown }).getBuiltinModule === 'function'
  || typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix !== 'undefined';
const disponibilite = process.env.EXPORTS_CHROMIUM_TESTS === '0'
  ? { ok: false as const, reason: 'désactivé (EXPORTS_CHROMIUM_TESTS=0)' }
  : !pdfjsLisible
    ? { ok: false as const, reason: `pdf.js illisible sous Node ${process.version} (≥ 20.16 requis)` }
    : await chromiumAvailability();
if (!disponibilite.ok) console.info(`[l114z-rendu] intégration Chromium ignorée : ${disponibilite.reason}`);

async function pdfText(bytes: Buffer | Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), useSystemFonts: false,
    standardFontDataUrl: path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/'),
  });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await pdf.destroy();
  return pages.join(' ').normalize('NFKC').replace(/[  ]/g, ' ').replace(/\s+/g, ' ');
}
const occurrences = (texte: string, motif: string) => texte.split(motif).length - 1;

const NOTE = 'Note corrigée ZANZIBAR114 par le vendeur';
const IA_MASQUEE = 'Ancienne description IA QUETZAL114 masquée';
const IA_VISIBLE = 'Description T1 visible MIRABELLE114';
const EFFACEE = 'Description effacée KUMQUAT114';
const VALEURS = new Map([
  [1, { notes: NOTE, description: IA_MASQUEE, notesUserOwned: true, descriptionSource: 'T1' }],
  [2, { notes: null, description: IA_VISIBLE, notesUserOwned: false, descriptionSource: 'T1' }],
  [3, { notes: null, description: EFFACEE, notesUserOwned: true, descriptionSource: 'T1' }],
]);

describe.skipIf(!disponibilite.ok)('L114Z-IT — dossiers tiers : PDF et ZIP réels, « Notes / Description » sur inclusion volontaire', () => {
  let dir: string;
  const files: Record<string, string> = {};

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l114z-it-'));
    for (const [cle, texte] of [['facture', 'FACTURE SOURCE'], ['dpe', 'DPE SOURCE'], ['garantie', 'GARANTIE SOURCE']] as const) {
      const src = await PDFDocument.create();
      const font = await src.embedFont(StandardFonts.Helvetica);
      src.addPage([595, 842]).drawText(texte, { x: 60, y: 760, size: 22, font });
      fs.writeFileSync(files[cle] = path.join(dir, `${cle}.pdf`), await src.save());
    }
    fs.writeFileSync(files.notice = path.join(dir, 'notice.docx'), 'contenu de la notice');
  }, 60_000);

  afterAll(async () => {
    await closeBrowser('fin des tests');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const generer = async (code: DossierCode, family: 'VEHICULE' | 'OBJET', inclure: boolean, format: 'PDF' | 'ZIP') => {
    const { renderDossier } = await import('../render/render-dossier');
    const { parseChoicesPayload, planSelection, includesNotesDescription } = await import('../data/choices');
    const { withNotesDescription } = await import('../data/source');
    let source = makeSource(family, code, {
      documents: [
        doc({ id: 1, kind: 'FACTURE', title: 'Facture achat', s3Key: 'facture' }),
        doc({ id: 2, kind: 'DPE', title: 'Diagnostic', s3Key: 'dpe' }),
        doc({ id: 3, kind: 'GARANTIE', title: 'Garantie', s3Key: 'garantie' }),
        ...(format === 'ZIP' ? [doc({ id: 4, kind: 'FACTURE', title: 'Notice', format: 'DOCX', integrable: false, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'notice.docx', s3Key: 'notice' })] : []),
      ],
      photos: [],
    });
    const parsed = parseChoicesPayload(code, {
      outputFormat: format,
      sections: [{ id: 'documents', enabled: true, items: source.documents.map((d) => ({ sourceType: 'document', sourceId: d.id, selected: true, mode: d.integrable ? 'PDF' : 'ZIP' })) }],
      ...(inclure ? { includeNotesDescription: true } : {}),
    });
    if (!parsed.ok) throw new Error('payload');
    // Même enchaînement que le job (`generation/job.ts`) : texte attaché seulement sur choix explicite.
    if (includesNotesDescription(parsed.choices)) {
      const retenues = new Set(planSelection(code, source, parsed.choices, TODAY).documents.map((pd) => pd.doc.id));
      source = { ...source, documents: withNotesDescription(source.documents, retenues, VALEURS) };
    }
    const workDir = fs.mkdtempSync(path.join(dir, 'work-'));
    const fetchToFile = async (key: string, _b: string | null, dest: string) => {
      if (!files[key]) return false;
      fs.copyFileSync(files[key], dest);
      return true;
    };
    const r = await renderDossier({
      code, source, choices: parsed.choices, today: TODAY, workDir, fetchToFile, timeoutMs: 90_000,
      meta: { reference: 'VBN-TEST-000114', generatedAt: '2026-09-28T09:14:00+02:00', preparedBy: 'Claire Martin' },
    });
    return { r, workDir };
  };

  it('L114Z-IT-01 — vente : PDF ouvert ; par défaut aucun texte, avec inclusion le texte affiché une fois', async () => {
    const sans = await pdfText((await generer('VENTE', 'VEHICULE', false, 'PDF')).r.pdf);
    expect(sans).toContain('Facture achat');
    for (const t of ['ZANZIBAR114', 'QUETZAL114', 'MIRABELLE114', 'KUMQUAT114', 'Notes / Description des documents']) expect(sans).not.toContain(t);

    const avec = await pdfText((await generer('VENTE', 'VEHICULE', true, 'PDF')).r.pdf);
    expect(avec).toContain('Notes / Description des documents');
    expect(occurrences(avec, 'ZANZIBAR114')).toBe(1);   // note corrigée
    expect(occurrences(avec, 'MIRABELLE114')).toBe(1);  // description T1 non modifiée
    expect(avec).not.toContain('QUETZAL114');            // ancienne description IA masquée par la note
    expect(avec).not.toContain('KUMQUAT114');            // description effacée volontairement
    // Les pièces d'origine gardent leur propre contenu.
    expect(avec).toContain('FACTURE SOURCE');
  }, 240_000);

  it('L114Z-IT-02 — assurance (souscription) : PDF + ZIP ; le PDF du ZIP est ouvert et inspecté', async () => {
    const { writeDossierZip } = await import('../zip');
    const lireZip = async (inclure: boolean) => {
      const { r, workDir } = await generer('ASSURANCE_SOUSCRIPTION', 'OBJET', inclure, 'ZIP');
      expect(r.zipEntries.length).toBeGreaterThan(0);
      const pdfName = `${r.fileBaseName}.pdf`;
      const pdfPath = path.join(workDir, pdfName);
      fs.writeFileSync(pdfPath, r.pdf);
      const dest = path.join(workDir, `${r.fileBaseName}.zip`);
      await writeDossierZip({ pdfPath, pdfName, entries: r.zipEntries, dest });
      const zip = await JSZip.loadAsync(fs.readFileSync(dest));
      const noms = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
      const texte = await pdfText(await zip.file(`pdf/${pdfName}`)!.async('uint8array'));
      // Aucun fichier auxiliaire (index, résumé, texte) n'est ajouté à l'archive.
      expect(noms.filter((n) => !n.startsWith('pdf/') && !n.startsWith('documents/'))).toEqual([]);
      const pieces = (await Promise.all(noms.filter((n) => n.startsWith('documents/')).map((n) => zip.file(n)!.async('string')))).join(' ');
      return { texte, noms, pieces };
    };
    const sans = await lireZip(false);
    for (const t of ['ZANZIBAR114', 'QUETZAL114', 'MIRABELLE114', 'KUMQUAT114']) { expect(sans.texte).not.toContain(t); expect(sans.pieces).not.toContain(t); }
    const avec = await lireZip(true);
    expect(avec.noms.some((n) => n.startsWith('documents/'))).toBe(true);
    expect(occurrences(avec.texte, 'ZANZIBAR114')).toBe(1);
    expect(occurrences(avec.texte, 'MIRABELLE114')).toBe(1);
    for (const t of ['QUETZAL114', 'KUMQUAT114']) { expect(avec.texte).not.toContain(t); expect(avec.pieces).not.toContain(t); }
    expect(avec.pieces).toContain('contenu de la notice');
  }, 300_000);
});
