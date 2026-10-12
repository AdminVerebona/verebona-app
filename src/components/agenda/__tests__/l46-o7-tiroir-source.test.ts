/**
 * Lot 46 — O7 : tiroir d'un événement d'agenda projeté (desktop ET mobile —
 * un seul composant `AgendaItemDrawer`, feuille pleine largeur sur mobile,
 * 520 px sur desktop). La source est accessible : documents (liens
 * existants) ou sinistre (rubrique Sinistres du bien) ; jamais le mot
 * « Opération » (P09). La suppression reste celle d'aujourd'hui (même
 * bouton, même route), la mémorisation est côté serveur.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const lire = (p: string) => readFileSync(resolve(__dirname, '..', '..', '..', p), 'utf8').replace(/\r\n?/g, '\n');

describe('O7-UI-01 — tiroir d’un événement projeté (desktop et mobile)', () => {
  const tiroir = lire('components/agenda/AgendaItemDrawer.tsx');

  it('un événement qui représente un sinistre propose « Voir le sinistre » vers la rubrique Sinistres du bien', () => {
    expect(tiroir).toContain('item.claimSource && (');
    expect(tiroir).toContain('href={`/assets/${item.claimSource.assetId}?tab=details&highlight=claims&claim=${item.claimSource.claimId}`}');
    expect(tiroir).toContain('Voir le sinistre');
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
