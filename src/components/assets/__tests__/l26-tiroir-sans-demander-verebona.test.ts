/**
 * Lot 26 — point 9 : le tiroir d'un document n'a plus de bouton
 * « Demander à Verebona » sous le badge de type (capture du 06/10).
 *
 * L26-9-AC1 : aucun bouton « Demander à Verebona » dans le tiroir, ni
 *             l'ouverture de l'assistant qu'il déclenchait.
 * L26-9-AC2 : le badge de type reste affiché sous le titre.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(__dirname, '..', 'DocumentDrawer.tsx'), 'utf8');

describe('tiroir document', () => {
  it('L26-9-AC1 : plus de bouton « Demander à Verebona »', () => {
    expect(src).not.toMatch(/Demander à Verebona/);
    expect(src).not.toMatch(/verebona:open/);
    expect(src).not.toMatch(/VerebonaMascot/);
  });

  it('L26-9-AC2 : le badge de type reste sous le titre', () => {
    expect(src).toMatch(/<\/SheetTitle>\s*<Badge variant="outline" className="mt-1\.5 text-xs">\{typeLabel\}<\/Badge>/);
  });
});
