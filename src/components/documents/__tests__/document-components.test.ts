/**
 * Composants documentaires — critères UX/UI du CDC design §10.3.
 *
 * Les quatre critères D-01 à D-04 sont des invariants d'interface. Un test qui
 * lit le source paraît rustique, mais il fige des règles qu'une refonte bien
 * intentionnée effacerait sans s'en apercevoir — et qui portent la cohérence
 * de tout le chantier.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const VIEW = read('src/components/documents/DocumentsView.tsx');
const ACCORDION = read('src/components/documents/CategoryAccordion.tsx');
const DRAWER = read('src/components/documents/SortFilterDrawer.tsx');
const BROWSER = read('src/components/documents/useDocumentBrowser.ts');
const CARD = read('src/components/documents/DocumentCard.tsx');

describe('D-01 — aucun champ de recherche local', () => {
  it('la vue ne contient aucun champ de recherche', () => {
    expect(VIEW).not.toMatch(/type="search"/);
    expect(VIEW).not.toMatch(/placeholder="Recherch/i);
  });

  it('le drawer de filtres n’en propose pas non plus', () => {
    expect(DRAWER).not.toMatch(/type="search"/);
  });

  it('le crochet n’envoie pas de paramètre de recherche', () => {
    // Le contrat serveur l'accepte — la recherche globale existante s'en sert —
    // mais ces deux écrans ne doivent pas le proposer.
    expect(BROWSER).not.toMatch(/p\.set\('search'/);
  });
});

describe('D-02 — regroupement par catégorie', () => {
  it('la vue ne rend que des accordéons de catégorie', () => {
    expect(VIEW).toContain('CategoryAccordion');
    // Aucune vue « tous les documents en vrac » (§2, principe 1).
    expect(VIEW).not.toMatch(/documents\.map\(/);
  });
});

describe('D-03 — les catégories vides restent visibles', () => {
  it('l’accordéon rend une catégorie à 0 au lieu de la masquer', () => {
    expect(ACCORDION).not.toMatch(/count === 0[\s\S]{0,40}return null/);
    expect(ACCORDION).toContain('const empty = group.count === 0');
  });

  it('rend la catégorie vide inerte plutôt qu’absente', () => {
    expect(ACCORDION).toContain('disabled={empty}');
  });

  it('la vue ne filtre pas les groupes sur leur compteur', () => {
    expect(VIEW).not.toMatch(/groups\.filter\([^)]*count/);
  });
});

describe('D-04 — ordre imposé', () => {
  it('la vue n’applique aucun tri sur les groupes', () => {
    // L'ordre vient du serveur : « À classer » en tête par displayOrder = -1,
    // AUTRES_DOCUMENTS en dernier par 9999. Trier ici le casserait.
    expect(VIEW).not.toMatch(/groups[\s\S]{0,20}\.sort\(/);
  });
});

describe('tri et filtres non mémorisés (§7.1, §7.2)', () => {
  it('aucun stockage navigateur dans les composants', () => {
    // On cherche un APPEL, pas le mot : les commentaires expliquent justement
    // pourquoi ces API sont proscrites ici, et les interdire dans le texte
    // reviendrait à interdire de documenter la règle.
    for (const source of [VIEW, DRAWER, BROWSER, ACCORDION, CARD]) {
      expect(source).not.toMatch(/\b(localStorage|sessionStorage)\s*\./);
      expect(source).not.toMatch(/document\.cookie\s*=/);
    }
  });
});

describe('compteurs (§7.3)', () => {
  it('proviennent du serveur, jamais de la longueur affichée', () => {
    // `documents.length` plafonnerait le compteur à la taille de l'aperçu.
    expect(ACCORDION).toContain('{group.count}');
    expect(ACCORDION).not.toMatch(/\{group\.documents\.length\}/);
  });
});

describe('accessibilité (§9.2)', () => {
  it('le document est un vrai bouton, accessible au clavier', () => {
    expect(CARD).toContain('<button');
    expect(CARD).toContain('type="button"');
  });

  it('l’accordéon annonce son état aux lecteurs d’écran', () => {
    expect(ACCORDION).toContain('aria-expanded');
    expect(ACCORDION).toContain('aria-controls');
  });

  it('les éléments interactifs portent un anneau de focus visible', () => {
    for (const source of [CARD, ACCORDION, DRAWER]) {
      expect(source).toContain('focus-visible:ring');
    }
  });

  it('les icônes décoratives sont masquées aux lecteurs d’écran', () => {
    expect(CARD).toContain('aria-hidden');
    expect(ACCORDION).toContain('aria-hidden');
  });
});
