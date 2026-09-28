/**
 * Accueil mis à jour après une action : une écriture réussie marque les
 * données comme modifiées, et l'accueil demande alors un résumé frais.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  isDataMutation,
  markAccountDataMutated,
  mutatedSince,
  resetDataFreshness,
} from '../data-freshness';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

beforeEach(() => resetDataFreshness());

describe('fraîcheur des données', () => {
  it('une modification postérieure au dernier chargement est détectée', () => {
    expect(mutatedSince(1_000)).toBe(false);
    markAccountDataMutated(2_000);
    expect(mutatedSince(1_000)).toBe(true);
    expect(mutatedSince(2_000)).toBe(false);
  });

  it('seules les écritures comptent, hors suivi et session', () => {
    expect(isDataMutation('POST', '/api/assets')).toBe(true);
    expect(isDataMutation('PATCH', '/api/v2/documents/abc/classification')).toBe(true);
    expect(isDataMutation('DELETE', '/api/agenda/12')).toBe(true);
    expect(isDataMutation('GET', '/api/assets')).toBe(false);
    expect(isDataMutation('POST', '/api/analytics/track')).toBe(false);
    expect(isDataMutation('POST', '/api/auth/refresh')).toBe(false);
  });
});

describe('câblage', () => {
  it('apiClient marque les écritures réussies', () => {
    expect(read('src/lib/api-client.ts')).toMatch(/if \(isDataMutation\(method, url\)\) \{\s*markAccountDataMutated\(\);/);
  });

  it('l’accueil n’utilise plus le cache client et demande un résumé frais', () => {
    const page = read('src/app/(dashboard)/accueil/page.tsx');
    expect(page).not.toMatch(/'\/api\/home\/summary',\s*\{\s*useCache: true/);
    expect(page).toContain('[FRESH_HEADER]');
  });

  it('le serveur ignore son cache quand un résumé frais est demandé', () => {
    const route = read('src/app/api/home/summary/route.ts');
    expect(route).toMatch(/wantsFresh \? null : serverCacheGet/);
  });
});
