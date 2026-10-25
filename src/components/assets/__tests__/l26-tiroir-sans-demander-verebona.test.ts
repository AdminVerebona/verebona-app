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

  it('L26-9-AC2 → L89B : plus de pastille de type sous le titre ; le Type reste dans « Informations »', () => {
    // Lot 89B (demande PO 25/10) : pastille retirée de l'en-tête (doublon de la ligne « Type »).
    expect(src).not.toMatch(/<DocumentTypeBadge/);
    expect(src).toMatch(/\{rubricTypeLabels\(fullData\)\.type\}/);
  });
});
