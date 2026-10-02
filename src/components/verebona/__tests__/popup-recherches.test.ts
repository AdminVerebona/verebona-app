/**
 * Champ Verebona simplifié (2 oct. 2026).
 *
 *  · pop-up : suggestions, PUIS les 3 dernières recherches (une ligne, la
 *    question seule) avec une corbeille ; une suppression fait remonter la 4e ;
 *  · chaque ouverture affiche cet accueil, jamais le dernier échange ;
 *  · plus de pouces ni de « Voir les sources » sous les réponses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_RECENT_SEARCHES, recentSearches } from '@/lib/verebona/space';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const fil = (id: number, title: string | null, messageCount = 2) => ({ id, title, messageCount });

describe('recentSearches', () => {
  const fils = [fil(5, 'Facture du vélo'), fil(4, 'Contrôle technique'), fil(3, 'Assurance  maison\n'), fil(2, 'Garantie lave-linge'), fil(1, 'Ancienne')];

  it('les 3 plus récentes, une ligne chacune (question seule)', () => {
    expect(MAX_RECENT_SEARCHES).toBe(3);
    expect(recentSearches(fils)).toEqual([
      { id: 5, title: 'Facture du vélo' },
      { id: 4, title: 'Contrôle technique' },
      { id: 3, title: 'Assurance maison' },
    ]);
  });

  it('une recherche supprimée laisse remonter la suivante, immédiatement', () => {
    expect(recentSearches(fils, new Set([4])).map((r) => r.id)).toEqual([5, 3, 2]);
    expect(recentSearches(fils, new Set([5, 4])).map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('ignore les fils vides ; titre de repli', () => {
    expect(recentSearches([fil(9, 'Vide', 0), fil(8, null), fil(7, '  ')])).toEqual([
      { id: 8, title: 'Demande sans titre' },
      { id: 7, title: 'Demande sans titre' },
    ]);
  });
});

describe('pop-up du champ', () => {
  const content = read('src/components/verebona/space/SpaceContent.tsx');
  const provider = read('src/components/verebona/space/VerebonaSpaceProvider.tsx');
  const field = read('src/components/verebona/space/VerebonaField.tsx');

  it('suggestions d’abord, recherches récentes ensuite, corbeille sans confirmation', () => {
    const initial = content.slice(content.indexOf('function InitialState('), content.indexOf('Échanges regroupés'));
    expect(initial.indexOf('api.suggestions.map')).toBeLessThan(initial.indexOf('api.recent.map'));
    expect(initial).toContain('onDelete={() => api.removeRecent(r.id)}');
    expect(initial).not.toContain('ConfirmDelete');
  });

  it('chaque ouverture revient à l’accueil ; une question depuis l’accueil ouvre une nouvelle recherche', () => {
    expect(provider).toMatch(/const open = useCallback\(\(\) => \{[^}]*setThreadShown\(false\);/);
    expect(provider).toMatch(/if \(!threadShownRef\.current && turnsCountRef\.current > 0\) await v\.newConversation\(\);/);
    expect(content).toContain('const turns = api?.showThread ? api.turns : [];');
  });

  it('le champ ne propose plus « Reprendre · n échanges »', () => {
    expect(field).not.toContain('resumeLabel(');
    expect(field).not.toContain('mobileFieldLabel(');
  });

  it('ni pouces ni sources sous les réponses', () => {
    expect(content).not.toMatch(/ThumbsUp|ThumbsDown|<VerebonaSources|<Feedback/);
    expect(content).toContain("filter((a) => a.type !== 'SHOW_SOURCES')");
  });
});
