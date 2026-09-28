/** Titres de documents différenciants — règle R9 du prompt T1 et filet de sécurité. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isReferenceOnlyTitle, refineDocumentTitle } from '../document-title';
import { EXTRACT_SOURCE_PROMPT_VERSION } from '../prompt-version';

describe('titre réduit à une référence', () => {
  it.each(['Facture N° 2024-1187', 'Facture n°FA000123', 'FACTURE 12345', 'Facture', 'IMG_2031.jpg', 'scan.pdf', 'Devis #D-778', ''])(
    '« %s » ne distingue pas le document', (t) => { expect(isReferenceOnlyTitle(t)).toBe(true); },
  );
  it.each(['Facture Béquille draisienne', 'Facture Vélo Jean Fourche', 'Contrat d’assurance Clio', 'Facture Pneus Clio — mars 2026'])(
    '« %s » est un bon titre', (t) => { expect(isReferenceOnlyTitle(t)).toBe(false); },
  );
});

describe('reconstruction', () => {
  it('garde un titre déjà différenciant', () => {
    expect(refineDocumentTitle('Facture Béquille draisienne', { subjects: ['Autre'] })).toBe('Facture Béquille draisienne');
  });
  it('remplace un numéro par l’objet concerné', () => {
    expect(refineDocumentTitle('Facture N° 2024-1187', { subjects: ['Béquille draisienne'], supplier: 'Décathlon' }))
      .toBe('Facture Béquille draisienne');
  });
  it('à défaut d’objet, le fournisseur ; à défaut, le mois', () => {
    expect(refineDocumentTitle('Facture N° 88', { subjects: [], supplier: 'Vélo Jean' })).toBe('Facture Vélo Jean');
    expect(refineDocumentTitle('FA-2026-03', { typeCode: 'invoice', documentDate: '2026-03-14' })).toBe('Facture mars 2026');
  });
  it('n’invente rien sans élément : le titre du modèle est conservé', () => {
    expect(refineDocumentTitle('Facture N° 88', {})).toBe('Facture N° 88');
  });
});

describe('prompt T1 v5', () => {
  it('est la version active et porte la règle de titre', () => {
    expect(EXTRACT_SOURCE_PROMPT_VERSION).toBe('extract_source_v5');
    const p = readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/extract_source_v5.txt'), 'utf-8');
    expect(p).toMatch(/R9 — TITRE : NATUREL ET DIFFÉRENCIANT/);
    expect(p).toMatch(/Facture Béquille draisienne/);
    expect(p).toMatch(/INTERDIT comme titre : un numéro/);
    for (const v of ['{{ASSET_CONTEXT}}', '{{EXISTING_TITLES}}', '{{EXTRACTED_CONTENT}}', '{{EXPECTED_FIELDS}}', '{{SOURCE_KIND}}']) {
      expect(p, v).toContain(v);
    }
  });
});
