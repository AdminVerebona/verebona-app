/** Titres de documents différenciants — règle R9 du prompt T1 et filet de sécurité. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isReferenceOnlyTitle, planBusinessTitle, type TitleContext } from '../document-title';

/** Lot 87D : l'ancien `refineDocumentTitle` (compatibilité 33C, sans appelant) est retiré — même règle via le moteur. */
const refineDocumentTitle = (t: string | null, ctx: TitleContext) => planBusinessTitle(t, ctx).title ?? (t?.trim() || null);

describe('titre réduit à une référence', () => {
  it.each(['Facture N° 2024-1187', 'Facture n°FA000123', 'FACTURE 12345', 'Facture', 'IMG_2031.jpg', 'scan.pdf', 'Devis #D-778', ''])(
    '« %s » ne distingue pas le document', (t) => { expect(isReferenceOnlyTitle(t)).toBe(true); },
  );
  it.each(['Facture Béquille draisienne', 'Facture Vélo Jean Fourche', 'Contrat d’assurance Clio', 'Facture Pneus Clio — mars 2026'])(
    '« %s » est un bon titre', (t) => { expect(isReferenceOnlyTitle(t)).toBe(false); },
  );
});

// Lot 34E (moteur de titre v2) : le fournisseur et la date sont des
// discriminants utiles ajoutés au sujet. Lot 87D (règles v3) : séparateur
// unique « — », date du document donnée AU JOUR (jamais un mois déduit).
describe('reconstruction', () => {
  it('garde un titre déjà différenciant', () => {
    expect(refineDocumentTitle('Facture Béquille draisienne', { subjects: ['Autre'] })).toBe('Facture Béquille draisienne');
  });
  it('remplace un numéro par l’objet concerné', () => {
    expect(refineDocumentTitle('Facture N° 2024-1187', { subjects: ['Béquille draisienne'], supplier: 'Décathlon' }))
      .toBe('Facture Béquille draisienne Décathlon');
  });
  it('à défaut d’objet, le fournisseur ; à défaut, la date du document au jour', () => {
    expect(refineDocumentTitle('Facture N° 88', { subjects: [], supplier: 'Vélo Jean' })).toBe('Facture Vélo Jean');
    expect(refineDocumentTitle('FA-2026-03', { typeCode: 'invoice', documentDate: '2026-03-14' })).toBe('Facture — 14 mars 2026');
  });
  it('n’invente rien sans élément : le titre du modèle est conservé', () => {
    expect(refineDocumentTitle('Facture N° 88', {})).toBe('Facture N° 88');
  });
});

describe('prompt maître T1 (lot 16b-3 : seul moteur)', () => {
  it('porte la règle de titre naturel et différenciant (U17, ex-R9)', () => {
    const p = readFileSync(join(process.cwd(), 'src/services/ai/prompts/source-analysis/t1_master_v1.txt'), 'utf-8');
    expect(p).toMatch(/U17 — TITRE UTILISATEUR/);
    expect(p).toMatch(/« <Type> <ce qu’il concerne> »/);
    expect(p).toMatch(/Jamais le nom du fichier ou un numéro seul/);
    expect(p).toContain('{{EXISTING_TITLES}}');
  });
});
