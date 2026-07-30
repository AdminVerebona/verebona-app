/**
 * Contrat de consultation documentaire — CDC 5 §8.3.
 *
 * Les fonctions testées ici sont celles que deux implémentations dupliqueraient
 * inévitablement — résolution de format, de titre, pagination. Les figer dans
 * un module unique est ce qui empêche la page globale et l'onglet d'un bien
 * d'afficher deux vérités.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveFormat,
  resolveTitle,
  isPreviewable,
  normalizePagination,
  normalizeSort,
  normalizeDirection,
  TO_CLASSIFY_GROUP,
} from '@/services/documents/document-query.contract';

describe('familles de format', () => {
  it('reconnaît un PDF', () => {
    expect(resolveFormat('facture.pdf', 'application/pdf')).toBe('pdf');
  });

  it('reconnaît les images courantes, y compris HEIC', () => {
    for (const name of ['photo.jpg', 'photo.JPEG', 'scan.png', 'img.heic', 'plan.tiff']) {
      expect(resolveFormat(name, 'image/x')).toBe('image');
    }
  });

  it('reconnaît les bureautiques', () => {
    expect(resolveFormat('contrat.docx', null)).toBe('word');
    expect(resolveFormat('charges.xlsx', null)).toBe('excel');
    expect(resolveFormat('releve.csv', null)).toBe('excel');
  });

  it('reconnaît un lien web à son type MIME', () => {
    expect(resolveFormat(null, 'text/html')).toBe('web');
  });

  it('range l’inconnu dans « autre » plutôt que d’échouer', () => {
    expect(resolveFormat('archive.zip', null)).toBe('autre');
    expect(resolveFormat('sans-extension', 'application/octet-stream')).toBe('autre');
  });

  it('ignore la casse de l’extension', () => {
    expect(resolveFormat('FACTURE.PDF', null)).toBe('pdf');
  });
});

describe('titre affiché', () => {
  const empty = {
    retainedTitle: null, webLinkTitle: null, originalFilename: null, fileName: null,
  };

  it('privilégie le titre retenu', () => {
    expect(resolveTitle({ ...empty, retainedTitle: 'Facture EDF mars', fileName: 'scan01.pdf' }))
      .toBe('Facture EDF mars');
  });

  it('retombe sur le titre du lien web', () => {
    expect(resolveTitle({ ...empty, webLinkTitle: 'Annonce SeLoger' })).toBe('Annonce SeLoger');
  });

  it('retombe sur le nom d’origine, puis sur le nom stocké', () => {
    expect(resolveTitle({ ...empty, originalFilename: 'devis.pdf' })).toBe('devis.pdf');
    expect(resolveTitle({ ...empty, fileName: 'a1b2c3.pdf' })).toBe('a1b2c3.pdf');
  });

  it('ignore les valeurs vides ou blanches', () => {
    // Un titre réduit à des espaces afficherait une ligne vide, illisible.
    expect(resolveTitle({ ...empty, retainedTitle: '   ', originalFilename: 'devis.pdf' }))
      .toBe('devis.pdf');
  });

  it('ne rend jamais une chaîne vide', () => {
    expect(resolveTitle(empty)).toBe('Document sans titre');
  });
});

describe('prévisualisation', () => {
  it('accepte PDF et images', () => {
    expect(isPreviewable('application/pdf')).toBe(true);
    expect(isPreviewable('image/png')).toBe(true);
  });

  it('refuse le reste', () => {
    expect(isPreviewable('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toBe(false);
    expect(isPreviewable(null)).toBe(false);
  });
});

describe('pagination et tri (§8.3)', () => {
  it('applique une taille de page par défaut', () => {
    expect(normalizePagination(undefined)).toBe(20);
    expect(normalizePagination(0)).toBe(20);
    expect(normalizePagination(-5)).toBe(20);
  });

  it('plafonne la taille de page', () => {
    // Le §1.3 signale des quotas jusqu'à 225 documents : sans plafond, un
    // appelant pourrait demander tout un compte en une requête.
    expect(normalizePagination(500)).toBe(100);
    expect(normalizePagination(50)).toBe(50);
  });

  it('trie par createdAt décroissant par défaut', () => {
    expect(normalizeSort(undefined)).toBe('createdAt');
    expect(normalizeDirection(undefined)).toBe('desc');
  });

  it('n’accepte que les tris prévus', () => {
    expect(normalizeSort('documentDate')).toBe('documentDate');
    expect(normalizeSort('title')).toBe('title');
    expect(normalizeSort('DROP TABLE')).toBe('createdAt');
  });

  it('n’accepte que les deux sens', () => {
    expect(normalizeDirection('asc')).toBe('asc');
    expect(normalizeDirection('ASC')).toBe('desc');
    expect(normalizeDirection('random')).toBe('desc');
  });
});

describe('groupe « À classer »', () => {
  it('porte un identifiant qui ne peut pas être un code de catégorie', () => {
    // §2.2 : « À classer ne fait pas partie du référentiel des catégories ».
    // Les codes de catégorie sont validés par /^[A-Z][A-Z0-9_]{2,49}$/ :
    // les tirets bas encadrants rendent la collision impossible.
    expect(TO_CLASSIFY_GROUP).toBe('__TO_CLASSIFY__');
    expect(/^[A-Z][A-Z0-9_]{2,49}$/.test(TO_CLASSIFY_GROUP)).toBe(false);
  });
});
