/**
 * Contraste — aucune teinte claire sans variante. WCAG 2.1 AA.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DU JAUNE PÂLE SUR BLANC, MESURÉ À 1,25:1
 *
 * Le code employait des teintes Tailwind écrites à la main — `text-amber-200`,
 * `text-red-300`, `text-emerald-200`. Ces valeurs sont pensées pour un fond
 * SOMBRE. Sur blanc, elles tombent très en dessous du seuil de 4,5:1 : le
 * texte est visible, pas lisible.
 *
 * 72 occurrences dans 21 fichiers étaient dans ce cas.
 *
 * Les variables sémantiques portent le RÔLE — avertissement, danger, succès —
 * et chaque thème leur donne la valeur qui convient.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf-8');

/** Contraste WCAG entre deux couleurs hexadécimales. */
function contraste(a: string, b: string): number {
  const lum = (h: string) => {
    const v = h.replace('#', '');
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('les couleurs sémantiques atteignent le seuil AA', () => {
  /** Valeur d'une variable dans un bloc de thème donné. */
  function valeur(nom: string, apres: string): string {
    const bloc = CSS.slice(CSS.indexOf(apres));
    const m = bloc.match(new RegExp(`--${nom}:\\s*(#[0-9A-Fa-f]{6})`));
    expect(m, `${nom} introuvable après « ${apres} »`).not.toBeNull();
    return m![1];
  }

  const roles = ['text-warning', 'text-warning-soft', 'text-danger', 'text-danger-soft',
                 'text-success', 'text-success-soft', 'text-info', 'text-info-soft'];

  for (const role of roles) {
    it(`${role} : lisible sur fond clair`, () => {
      // 4,5:1 est le seuil AA pour le texte courant.
      expect(contraste(valeur(role, 'data-theme="beige"'), '#FFFFFF'))
        .toBeGreaterThanOrEqual(4.5);
    });

    it(`${role} : lisible sur fond sombre`, () => {
      expect(contraste(valeur(role, ':root'), '#020617'))
        .toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('plus aucune teinte claire écrite à la main', () => {
  function composants(dossier: string, trouves: string[] = []): string[] {
    for (const e of readdirSync(dossier)) {
      const p = join(dossier, e);
      if (statSync(p).isDirectory()) composants(p, trouves);
      else if (e.endsWith('.tsx')) trouves.push(p);
    }
    return trouves;
  }

  it('aucun text-{couleur}-{100,200,300} sans variante sombre', () => {
    // Une teinte 100/200/300 sans `dark:` est illisible dans l'un des deux
    // modes — lequel dépend seulement du thème actif.
    const motif = /text-(amber|yellow|red|rose|emerald|green|blue|sky)-(100|200|300)\b/;
    const fautifs: string[] = [];

    for (const p of composants(join(process.cwd(), 'src'))) {
      const lignes = readFileSync(p, 'utf-8').split('\n');
      lignes.forEach((l, i) => {
        if (motif.test(l) && !l.includes('dark:')) {
          fautifs.push(`${p.replace(process.cwd() + '/', '')}:${i + 1}`);
        }
      });
    }

    expect(fautifs, `teintes illisibles :\n  ${fautifs.join('\n  ')}`).toEqual([]);
  });
});
