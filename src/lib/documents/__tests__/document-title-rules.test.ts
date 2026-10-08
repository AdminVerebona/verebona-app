/**
 * Lot 33C — règles du titre métier (détection générique, ordre d'affichage).
 */
import { describe, expect, it } from 'vitest';
import { displayDocumentTitle, isValidBusinessTitle, technicalTitleSqlPredicate, TECHNICAL_WORDS } from '../document-title-rules';
import { documentTitle } from '@/services/exports/v12/data/documents';

const UUID_PDF = '5be5a3ca-38cf-47fc-942c-3386ea8e846b.pdf';

describe('isValidBusinessTitle — détection générique des noms techniques', () => {
  it('TITLE-AC9 — le cas observé « 5be5a3ca-…-3386ea8e846b.pdf » n’est pas un titre métier (avec ou sans extension, casse, tirets)', () => {
    expect(isValidBusinessTitle(UUID_PDF)).toBe(false);
    expect(isValidBusinessTitle('5be5a3ca-38cf-47fc-942c-3386ea8e846b')).toBe(false);
    expect(isValidBusinessTitle('5BE5A3CA38CF47FC942C3386EA8E846B.PDF')).toBe(false);
    expect(isValidBusinessTitle(` ${UUID_PDF} `)).toBe(false);
    expect(isValidBusinessTitle('5be5a3ca-38cf-47fc-942c-3386ea8e846b (1).pdf')).toBe(false);
  });

  it.each([
    [null], [undefined], [''], ['   '],
    ['upload_12345.pdf'], ['tmp_98765.pdf'], ['temp-1.pdf'], ['upload12345.heic'],
    ['d41d8cd98f00b204e9800998ecf8427e'], ['e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.pdf'],
    ['aB3dE5fG7hI9jK1lM3nO5pQ'],
    ['verebona/u_42/a_123/f_789/1700000000000_facture.pdf'], ['1700000000000_facture-electricite.pdf'],
    ['IMG_20240418_123456.jpg'], ['IMG-20240418-WA0001.jpeg'], ['PXL_20240418_101010123.jpg'], ['DSC_0042.JPG'],
    ['Document (1).pdf'], ['document.pdf'], ['scan.pdf'], ['image.png'], ['blob'], ['Sans titre.docx'], ['untitled'],
    ['téléchargement (2).pdf'], ['20240418_101010.pdf'], ['12345'],
  ])('« %s » est un nom technique', (t) => {
    expect(isValidBusinessTitle(t as string | null | undefined)).toBe(false);
  });

  it.each([
    ["Certificat d'immatriculation CUPRA LEON E-HYBRID180"], ['Facture EDF — 12 mai 2026'], ['Document avril 2024'],
    ['Facture'], ['EDF'], ['Facture EDF mars.pdf'], ['Scan carte grise'], ['Photo cuisine'], ['Contrat 2024-1187'], ['Факт'],
  ])('« %s » est un titre métier', (t) => {
    expect(isValidBusinessTitle(t)).toBe(true);
  });

  it('identifiants techniques du document (clé objet, identifiant public) refusés comme titre', () => {
    expect(isValidBusinessTitle('e2e/12/f.pdf', { s3Key: 'e2e/12/f.pdf' })).toBe(false);
    expect(isValidBusinessTitle('Facture garage', { s3Key: 'e2e/12/f.pdf' })).toBe(true);
  });

  it('préfiltre SQL : mêmes mots techniques que la règle JS', () => {
    const sql = technicalTitleSqlPredicate('f.retained_title');
    for (const w of TECHNICAL_WORDS) expect(sql).toContain(w);
    expect(sql).toContain('unaccent(lower(');
  });
});

describe('displayDocumentTitle — TITLE-AC8 : titre métier → nom original exploitable → nom technique', () => {
  it('titre métier présent : affiché à la place du nom technique', () => {
    expect(displayDocumentTitle({ retainedTitle: 'Carte grise Cupra', originalFilename: UUID_PDF })).toBe('Carte grise Cupra');
  });
  it('titre technique, nom original exploitable : le nom original passe devant', () => {
    expect(displayDocumentTitle({ retainedTitle: UUID_PDF, originalFilename: 'Carte grise.pdf' })).toBe('Carte grise.pdf');
  });
  it('lien web : son titre avant le nom technique', () => {
    expect(displayDocumentTitle({ retainedTitle: null, webLinkTitle: 'Notice en ligne', originalFilename: null })).toBe('Notice en ligne');
  });
  it('rien d’exploitable : le nom technique en dernier recours, puis le repli', () => {
    expect(displayDocumentTitle({ retainedTitle: UUID_PDF, originalFilename: UUID_PDF })).toBe(UUID_PDF);
    expect(displayDocumentTitle({ retainedTitle: null, originalFilename: null }, 'Document')).toBe('Document');
  });
  it('exports v12 : même priorité (titre métier, sinon nom original sans extension)', () => {
    expect(documentTitle({ id: 1, retainedTitle: 'Carte grise Cupra', originalFilename: UUID_PDF })).toBe('Carte grise Cupra');
    expect(documentTitle({ id: 1, retainedTitle: UUID_PDF, originalFilename: 'Carte grise.pdf' })).toBe('Carte grise');
    expect(documentTitle({ id: 1, retainedTitle: null, originalFilename: 'Facture EDF.pdf' })).toBe('Facture EDF');
    expect(documentTitle({ id: 7, retainedTitle: null, originalFilename: null })).toBe('Document 7');
  });
});
