/**
 * Carte 801 — « Accueil desktop : le premier cran de molette ne déclenche pas
 * le défilement » (remontée du 16/11/2026 ; accueil et biens KO, mes documents
 * OK d'après le retour du 24/11).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE RACINE
 *
 * CSS Overflow 3 § 3 : quand l'un des deux axes est déclaré `hidden`, `auto`
 * ou `scroll` et que l'autre reste `visible`, **cet autre axe est calculé en
 * `auto`**. Déclarer `overflow-x-hidden` ou `overflow-x-auto` SEUL transforme
 * donc la boîte en conteneur de défilement VERTICAL.
 *
 * Mesuré dans Chrome avec de vrais événements molette (voir le test
 * `c801-defilement-premier-cran-navigateur.test.ts`) : dès que cette boîte a
 * un reste vertical d'UN SEUL pixel — arrondi sous-pixel, bordure, marge
 * basse, élément positionné —, le geste molette s'accroche à elle, le premier
 * cran y est consommé de façon invisible, et seul le cran suivant se propage
 * à `#main-scroll-container`. L'écran paraît figé au premier cran.
 *
 *   overflow:hidden (2 axes)            → y calculé `hidden`  → ne capte rien
 *   overflow-x:hidden SEUL   + reste    → y calculé `auto`    → CAPTE le cran
 *   overflow-x:auto   SEUL   + reste    → y calculé `auto`    → CAPTE le cran
 *   overflow-x:clip   SEUL              → y reste `visible`   → ne capte rien
 *   overflow-x:* + overflow-y:* déclaré → y déclaré           → ne capte rien
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE TENUE PAR CE TEST
 *
 * Dans les arbres de composants rendus par l'accueil et par la page des
 * biens, aucune chaîne de classes ne déclare `overflow-x-auto`,
 * `overflow-x-hidden` ou `overflow-x-scroll` sans déclarer AUSSI l'axe
 * vertical. Deux façons de se conformer :
 *   · un conteneur qui ne fait que rogner        → `overflow-x-clip` ;
 *   · un conteneur à défilement horizontal seul  → + `overflow-y-hidden`.
 *
 * `vb-no-scrollbar` et `scrollbar-hide` ne comptent pas : elles masquent la
 * barre (`scrollbar-width`, `::-webkit-scrollbar`) sans toucher à `overflow`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');
const lire = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/**
 * Fichiers rendus par l'accueil et par la page des biens (coquille comprise),
 * y compris les blocs montés mais fermés : un tiroir ouvert capte le cran
 * exactement de la même façon.
 */
const SOUS_SURVEILLANCE = [
  'src/app/(dashboard)/accueil/page.tsx',
  'src/app/(dashboard)/assets/page.tsx',
  'src/components/DashboardLayout.tsx',
  'src/components/home/HomeBlocks.tsx',
  'src/components/home/MascotSpeaks.tsx',
  'src/components/shell/AppSidebar.tsx',
  'src/components/verebona/space/AnswerBlocks.tsx',
  'src/components/verebona/space/VerebonaField.tsx',
  'src/components/verebona/space/SpaceContent.tsx',
  'src/components/ui/sheet.tsx',
  'src/components/ui/dialog.tsx',
  'src/components/ui/dropdown-menu.tsx',
  'src/components/ui/select.tsx',
];

const AXE_X_DEFILANT = /\boverflow-x-(auto|hidden|scroll)\b/;
const AXE_Y_DECLARE = /\boverflow-y-(auto|hidden|scroll|clip|visible)\b/;
/** `overflow-auto`, `overflow-hidden`, `overflow-clip`, `overflow-scroll` : les deux axes d'un coup. */
const DEUX_AXES = /\boverflow-(auto|hidden|clip|scroll|visible)\b/;

/** Littéraux de chaîne du fichier (apostrophes, guillemets, gabarits). */
export function chainesDeClasses(source: string): string[] {
  return source.match(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g) ?? [];
}

/** Chaînes qui déclarent l'axe horizontal défilant sans déclarer l'axe vertical. */
export function conteneursCaptantLeCran(source: string): string[] {
  return chainesDeClasses(source).filter(
    (c) => AXE_X_DEFILANT.test(c) && !AXE_Y_DECLARE.test(c) && !DEUX_AXES.test(c),
  );
}

describe('carte 801 — le premier cran de molette défile la page', () => {
  it('C801-1 — la fonction de détection reconnaît chaque forme', () => {
    expect(conteneursCaptantLeCran('className="flex overflow-x-auto px-1"')).toHaveLength(1);
    expect(conteneursCaptantLeCran('className="w-full overflow-x-hidden"')).toHaveLength(1);
    expect(conteneursCaptantLeCran('className="overflow-x-scroll"')).toHaveLength(1);
    // Conformes : axe vertical déclaré, ou rognage sans conteneur de défilement.
    expect(conteneursCaptantLeCran('className="overflow-x-auto overflow-y-hidden"')).toEqual([]);
    expect(conteneursCaptantLeCran('className="overflow-y-auto overflow-x-hidden"')).toEqual([]);
    expect(conteneursCaptantLeCran('className="max-w-full overflow-x-clip"')).toEqual([]);
    expect(conteneursCaptantLeCran('className="rounded-xl overflow-hidden h-64"')).toEqual([]);
    // Masquer la barre de défilement ne déclare pas l'axe vertical.
    expect(conteneursCaptantLeCran('className="overflow-x-auto vb-no-scrollbar"')).toHaveLength(1);
  });

  it.each(SOUS_SURVEILLANCE)(
    'C801-2 — %s ne laisse aucun conteneur capter le premier cran',
    (fichier) => {
      expect(conteneursCaptantLeCran(lire(fichier))).toEqual([]);
    },
  );

  it('C801-3 — la zone principale de la coquille déclare ses DEUX axes', () => {
    const src = lire('src/components/DashboardLayout.tsx');
    const ligne = src.split('\n').find((l) => l.includes('id="main-scroll-container"')) ?? '';
    expect(ligne).toContain('overflow-y-auto');
    expect(ligne).toContain('overflow-x-hidden');
  });

  it('C801-4 — le contenu de la page des biens rogne sans devenir défilable', () => {
    const src = lire('src/app/(dashboard)/assets/page.tsx');
    expect(src).toContain('space-y-6 w-full max-w-full overflow-x-clip');
    expect(src).not.toContain('space-y-6 w-full max-w-full overflow-x-hidden');
  });

  it('C801-5 — les carrousels de l’accueil ne défilent qu’à l’horizontale', () => {
    const src = lire('src/components/home/HomeBlocks.tsx');
    expect(src).toContain('overflow-x-auto overflow-y-hidden');
  });
});
