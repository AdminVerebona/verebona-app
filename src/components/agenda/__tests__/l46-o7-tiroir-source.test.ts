/**
 * Lot 46 — O7 : tiroir d'un événement d'agenda projeté (desktop ET mobile —
 * un seul composant `AgendaItemDrawer`, feuille pleine largeur sur mobile,
 * 520 px sur desktop). La source est accessible par les documents (liens
 * existants) ; lot 83D (V-Q1, CDC v5 §15.2, E13) : plus de lien « Voir le
 * sinistre » ni de `highlight=claims` (rubrique retirée) ; jamais le mot
 * « Opération » (P09). La suppression reste celle d'aujourd'hui (même
 * bouton, même route), la mémorisation est côté serveur.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');

describe('O7-UI-01 — tiroir d’un événement projeté (desktop et mobile)', () => {
  const tiroir = lire('components/agenda/AgendaItemDrawer.tsx');

  it('lot 83D (V-Q1) : plus de lien « Voir le sinistre » ni de rubrique Sinistres (navigation générique du tiroir)', () => {
    expect(tiroir).not.toContain('claimSource');
    expect(tiroir).not.toContain('highlight=claims');
    expect(tiroir).not.toContain('Voir le sinistre');
  });

  it('les documents sources restent affichés par la rubrique Documents existante (liens du tiroir)', () => {
    expect(tiroir).toContain('item.fileLinks.map((l) => {');
  });

  it('un seul composant pour les deux affichages : feuille pleine largeur sur mobile', () => {
    expect(tiroir).toContain('className="w-full sm:max-w-[520px]');
  });

  it('jamais le mot « Opération » dans le texte affiché du tiroir', () => {
    const jsxTexte = tiroir.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(jsxTexte).not.toMatch(/>[^<{]*Op[ée]ration[^<{]*</);
  });

  it('suppression : même route, l’auteur est transmis pour mémoriser la suppression (F-146)', () => {
    const route = lire('app/api/agenda/[id]/route.ts');
    expect(route).toContain('await deleteAgendaItem(id, accountId, session.userId ?? null);');
  });
});
