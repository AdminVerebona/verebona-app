/**
 * Lot 61 — extract brut déterministe (ticket T1 §3, §8).
 *
 * T1-GEM-06 : PDF de plusieurs pages extrait INTÉGRALEMENT (toutes les pages,
 *             annexes et pieds de page), valeurs exactes, traçabilité par page.
 * T1-GEM-07 : page scannée (image seule) signalée explicitement (OCR requis),
 *             jamais présentée comme extraite ; PDF illisible → FAILED.
 * T1-GEM-08 : troncature (bornes) explicite, jamais COMPLETE.
 *
 * Vrais PDF produits par pdf-lib, lus par pdf.js (aucun simulacre du moteur).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractRawText, rawPageMarker } from '../extract';

// PNG 1×1 (page « scannée » : image seule, aucune couche texte).
const PNG_1PX = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const LIGNES: string[][] = [
  ['FACTURE N° FA-2026-0098', 'Date de facture : 14/09/2026', 'Fournisseur : EDF SA - SIRET 552 081 317 00014'],
  ['Consommation : 4 512 kWh', 'Montant HT : 812,16 EUR', 'TVA 20 % : 162,43 EUR', 'Total TTC : 974,59 EUR'],
  ['ANNEXE 1 - Conditions', 'Echeance : 30/09/2026', 'Pied de page : EDF - page 3/4'],
];

let multi: Uint8Array;
let avecScan: Uint8Array;

beforeAll(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lignes of LIGNES) {
    const page = doc.addPage([595, 842]);
    lignes.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 24, size: 12, font }));
  }
  const img = await doc.embedPng(PNG_1PX);
  doc.addPage([595, 842]).drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  avecScan = await doc.save();

  const d2 = await PDFDocument.create();
  const f2 = await d2.embedFont(StandardFonts.Helvetica);
  for (const lignes of LIGNES) {
    const page = d2.addPage([595, 842]);
    lignes.forEach((l, i) => page.drawText(l, { x: 50, y: 780 - i * 24, size: 12, font: f2 }));
  }
  multi = await d2.save();
}, 60_000);

describe('T1-GEM-06 — PDF de plusieurs pages extrait intégralement', () => {
  it('T1-GEM-06 : toutes les pages, toutes les lignes, valeurs exactes, ordre et marques de page', async () => {
    const ex = await extractRawText({ bytes: multi, mimeType: 'application/pdf' });
    expect(ex).toMatchObject({ method: 'PDF_TEXT_LAYER', status: 'COMPLETE', pageCount: 3, pagesWithText: 3, pagesWithoutText: [], truncated: false, error: null });
    for (const l of LIGNES.flat()) expect(ex.fullText).toContain(l);
    // Ordre des pages et marques lues par la vérification de couverture.
    const i1 = ex.fullText!.indexOf(rawPageMarker(1));
    const i2 = ex.fullText!.indexOf(rawPageMarker(2));
    const i3 = ex.fullText!.indexOf(rawPageMarker(3));
    expect(i1).toBe(0);
    expect(i1 < i2 && i2 < i3).toBe(true);
    // Traçabilité par page : chaque tranche [start, end[ contient le texte de SA page.
    ex.pages.forEach((p, k) => {
      const tranche = ex.fullText!.slice(p.start, p.end);
      for (const l of LIGNES[k]) expect(tranche).toContain(l);
      expect(p).toMatchObject({ page: k + 1, hasText: true, chars: tranche.length });
    });
  });

  it('T1-GEM-06 : extraction déterministe — deux lectures identiques', async () => {
    const a = await extractRawText({ bytes: multi, mimeType: 'application/pdf' });
    const b = await extractRawText({ bytes: multi, mimeType: 'application/pdf' });
    expect(b.fullText).toBe(a.fullText);
    expect(b.pages).toEqual(a.pages);
  });
});

describe('T1-GEM-07 — pages scannées et documents illisibles signalés', () => {
  it('T1-GEM-07 : page image seule → listée sans texte, PARTIAL_OCR_REQUIRED (OCR par le modèle), jamais COMPLETE', async () => {
    const ex = await extractRawText({ bytes: avecScan, mimeType: 'application/pdf' });
    expect(ex).toMatchObject({ status: 'PARTIAL_OCR_REQUIRED', pageCount: 4, pagesWithText: 3, pagesWithoutText: [4] });
    expect(ex.pages[3]).toMatchObject({ page: 4, hasText: false, chars: 0 });
    for (const l of LIGNES.flat()) expect(ex.fullText).toContain(l);
  });

  it('T1-GEM-07 : image seule → OCR_REQUIRED ; PDF corrompu → FAILED avec motif ; type non pris en charge → NOT_SUPPORTED', async () => {
    expect(await extractRawText({ bytes: PNG_1PX, mimeType: 'image/png' })).toMatchObject({ status: 'OCR_REQUIRED', method: 'NONE', pagesWithoutText: [1] });
    const ko = await extractRawText({ bytes: new TextEncoder().encode('%PDF-1.7\nceci n’est pas un PDF'), mimeType: 'application/pdf' });
    expect(ko.status).toBe('FAILED');
    expect(ko.error).toMatch(/PDF illisible/);
    expect(ko.fullText).toBeNull();
    expect(await extractRawText({ bytes: new Uint8Array([1, 2]), mimeType: 'application/vnd.ms-excel' })).toMatchObject({ status: 'NOT_SUPPORTED' });
  });

  it('T1-GEM-07 : texte brut (Unicode, NFD conservé tel quel) → COMPLETE', async () => {
    const t = 'Facture électricité\nMontant : 12,50 €'.normalize('NFD');
    const ex = await extractRawText({ bytes: new TextEncoder().encode(t), mimeType: 'text/plain; charset=utf-8' });
    expect(ex).toMatchObject({ method: 'PLAIN_TEXT', status: 'COMPLETE', fullText: t });
  });
});

describe('T1-GEM-08 — troncature explicite, jamais silencieuse', () => {
  it('T1-GEM-08 : borne de pages → TRUNCATED avec motif (pages non extraites nommées)', async () => {
    const ex = await extractRawText({ bytes: multi, mimeType: 'application/pdf' }, { maxPages: 2, maxChars: 1_000_000 });
    expect(ex).toMatchObject({ status: 'TRUNCATED', truncated: true, pageCount: 3 });
    expect(ex.truncationReason).toMatch(/pages 3 à 3 non extraites/);
    expect(ex.pages).toHaveLength(2);
  });

  it('T1-GEM-08 : borne de durée → TRUNCATED, pages restantes nommées', async () => {
    const ex = await extractRawText({ bytes: multi, mimeType: 'application/pdf' }, { maxPages: 100, maxChars: 1_000_000, maxMs: -1 /* borne déjà dépassée après la page 1 */ });
    expect(ex.status).toBe('TRUNCATED');
    expect(ex.truncationReason).toMatch(/lecture bornée .* pages 2 à 3 non extraites/);
    expect(ex.pages).toHaveLength(1);
  });

  it('T1-GEM-08 : borne de caractères → TRUNCATED, arrêt à une frontière de page', async () => {
    const ex = await extractRawText({ bytes: multi, mimeType: 'application/pdf' }, { maxPages: 100, maxChars: 150 });
    expect(ex.status).toBe('TRUNCATED');
    expect(ex.truncationReason).toMatch(/borné à 150 caractères/);
    expect(ex.fullText!.length).toBeLessThanOrEqual(150);
  });
});
