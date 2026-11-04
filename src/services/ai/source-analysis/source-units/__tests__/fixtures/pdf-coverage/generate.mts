/**
 * Lot 109K (COR-01) — génération REPRODUCTIBLE des PDF de recette de la
 * vérification de couverture (aucune donnée réelle : textes synthétiques).
 *
 *   texte-simple.pdf   2 pages, police standard (Helvetica, chaînes lisibles par la sonde)
 *   police-cid.pdf     2 pages, polices composites CID / Identity-H (sortie Chromium), tableau page 1
 *   scanne.pdf         2 pages, image seule (texte rendu en pixels, aucune couche texte)
 *   hybride.pdf        page 1 texte CID + page 2 scannée
 *   forme-xobject.pdf  1 page dont le texte est posé dans une forme (XObject) — sonde aveugle
 *
 * Usage : CHROMIUM_EXECUTABLE_PATH=/chemin/chrome npx tsx <ce fichier>
 * (Chromium requis pour police-cid.pdf et hybride.pdf ; les autres : pdf-lib + sharp).
 * Dates de création neutralisées : sortie stable d'une génération à l'autre (pdf-lib).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import sharp from 'sharp';

const ICI = dirname(fileURLToPath(import.meta.url));
const FIXE = new Date('2026-01-01T00:00:00Z');

export const PAGE1 = [
  'Devis numero DV-2026-0042',
  'Entreprise Exemple Charpente, douze rue des Artisans, Lyon',
  'Client : Madame Exemple, maison principale',
  'Traitement preventif des charpentes et solives',
  'Deplacement et installation du chantier',
  'Total HT 733,33 EUR, TVA 146,67 EUR, Total TTC 880,00 EUR',
];
export const PAGE2 = [
  'Conditions generales de vente',
  'Validite du devis trois mois a compter de son emission',
  'Acompte de trente pourcent exigible a la commande',
  'Garantie decennale souscrite aupres d un assureur mutualiste',
  'Reglement par virement bancaire sous quinze jours',
];

const fige = (d: PDFDocument) => { d.setCreationDate(FIXE); d.setModificationDate(FIXE); d.setProducer('verebona-fixtures'); d.setCreator('verebona-fixtures'); };

async function texteSimple(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const lignes of [PAGE1, PAGE2]) {
    const p = d.addPage([595, 842]);
    lignes.forEach((l, i) => p.drawText(l, { x: 50, y: 780 - i * 24, size: 12, font: f }));
  }
  fige(d);
  return d.save({ useObjectStreams: false });
}

async function pngDe(lignes: string[]): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754"><rect width="100%" height="100%" fill="white"/>${
    lignes.map((l, i) => `<text x="80" y="${160 + i * 60}" font-family="DejaVu Sans" font-size="34" fill="black">${l}</text>`).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

async function scanne(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (const lignes of [PAGE1, PAGE2]) {
    const img = await d.embedPng(await pngDe(lignes));
    const p = d.addPage([595, 842]);
    p.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  }
  fige(d);
  return d.save({ useObjectStreams: false });
}

function chromium(html: string): Uint8Array {
  const exe = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (!exe) throw new Error('CHROMIUM_EXECUTABLE_PATH requis pour les polices composites');
  const dir = mkdtempSync(join(tmpdir(), 'l109k-'));
  writeFileSync(join(dir, 'doc.html'), html);
  execFileSync(exe, ['--headless', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${join(dir, 'doc.pdf')}`, `file://${join(dir, 'doc.html')}`], { stdio: 'ignore', timeout: 60_000 });
  return new Uint8Array(readFileSync(join(dir, 'doc.pdf')));
}

async function normalise(bytes: Uint8Array): Promise<Uint8Array> {
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  fige(d);
  return d.save({ useObjectStreams: false });
}

async function policeCid(): Promise<Uint8Array> {
  const html = `<html><body style="font-family: 'DejaVu Sans'; font-size: 13px">
    <h2>${PAGE1[0]}</h2><p>${PAGE1[1]}</p><p>${PAGE1[2]}</p>
    <table border="1" cellpadding="4"><tr><th>Designation</th><th>Montant</th></tr>
      <tr><td>${PAGE1[3]}</td><td>650,00 EUR</td></tr><tr><td>${PAGE1[4]}</td><td>83,33 EUR</td></tr></table>
    <p>${PAGE1[5]}</p>
    <div style="page-break-before: always"></div><h2>${PAGE2[0]}</h2>${PAGE2.slice(1).map((l) => `<p>${l}</p>`).join('')}
  </body></html>`;
  return normalise(chromium(html));
}

async function hybride(cid: Uint8Array, scan: Uint8Array): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const a = await PDFDocument.load(cid);
  const b = await PDFDocument.load(scan);
  const [p1] = await d.copyPages(a, [0]);
  const [p2] = await d.copyPages(b, [1]);
  d.addPage(p1); d.addPage(p2);
  fige(d);
  return d.save({ useObjectStreams: false });
}

async function formeXObject(): Promise<Uint8Array> {
  const src = await PDFDocument.load(await texteSimple());
  const d = await PDFDocument.create();
  const [forme] = await d.embedPages([src.getPage(0)]);
  const p = d.addPage([595, 842]);
  p.drawPage(forme, { x: 0, y: 0 });
  fige(d);
  return d.save({ useObjectStreams: false });
}

const cid = await policeCid();
const scan = await scanne();
const sorties: Record<string, Uint8Array> = {
  'texte-simple.pdf': await texteSimple(),
  'police-cid.pdf': cid,
  'scanne.pdf': scan,
  'hybride.pdf': await hybride(cid, scan),
  'forme-xobject.pdf': await formeXObject(),
};
for (const [n, b] of Object.entries(sorties)) {
  writeFileSync(join(ICI, n), b);
  console.log(`${n} : ${b.length} octets`);
}
