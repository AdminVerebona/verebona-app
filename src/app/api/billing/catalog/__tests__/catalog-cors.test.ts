/**
 * Lot 36B — CORS du catalogue public lu par la vitrine.
 *
 * Avant : comparaison stricte `Origin === NEXT_PUBLIC_PUBLIC_SITE_URL` →
 * vitrine en `www.` / apex, majuscule, slash final ou domaine Scalingo :
 * réponse bloquée par le navigateur, « Tarif indisponible », aucune trace.
 */
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/billing/price-catalog.service', () => ({
  presentationTtlSeconds: () => 60,
  getPublicCatalog: async () => ({ catalog_version: 'cv_x', verified_at: null, status: 'ok', purchasable: true, offers: [{ plan_code: 'standard' }], plans: [], reason: null, unavailable: [] }),
}));

import { GET } from '../route';
import { __resetRefusedOriginsForTests, allowedCatalogOrigins, matchCatalogOrigin, normalizeOrigin, refusedOrigins } from '@/lib/billing/catalog-cors';

const call = (origin?: string) => GET(new NextRequest('https://app.preprod.verebona.fr/api/billing/catalog', { headers: origin ? { origin } : {} }));

beforeEach(() => {
  __resetRefusedOriginsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('origines tolérées (sans jamais ouvrir à toute origine)', () => {
  it('AC-cors-1 — www ↔ apex, slash final, casse, http→https', () => {
    const allowed = allowedCatalogOrigins('https://preprod.verebona.fr/', {} as NodeJS.ProcessEnv);
    expect(allowed).toEqual(expect.arrayContaining(['https://preprod.verebona.fr', 'https://www.preprod.verebona.fr']));
    expect(matchCatalogOrigin('https://WWW.preprod.verebona.fr', allowed)).toBe('https://WWW.preprod.verebona.fr');
    expect(matchCatalogOrigin('https://evil.example', allowed)).toBeNull();
    expect(matchCatalogOrigin('https://preprod.verebona.fr.evil.example', allowed)).toBeNull();
    expect(matchCatalogOrigin('http://preprod.verebona.fr', allowed)).toBeNull();
    expect(allowedCatalogOrigins('http://localhost:3000', {} as NodeJS.ProcessEnv)).toEqual(['http://localhost:3000', 'https://localhost:3000']);
    expect(normalizeOrigin('www.verebona.fr')).toBe('https://www.verebona.fr');
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull();
  });

  it('AC-cors-2 — valeur lue à l’exécution (variable modifiée après le build) et PUBLIC_SITE_EXTRA_ORIGINS', () => {
    const allowed = allowedCatalogOrigins('https://ancienne.example', {
      NEXT_PUBLIC_PUBLIC_SITE_URL: 'https://preprod.verebona.fr',
      PUBLIC_SITE_EXTRA_ORIGINS: 'https://verebona-public-preprod.osc-fr1.scalingo.io, ',
    } as unknown as NodeJS.ProcessEnv);
    expect(allowed).toEqual(expect.arrayContaining(['https://ancienne.example', 'https://preprod.verebona.fr', 'https://verebona-public-preprod.osc-fr1.scalingo.io']));
  });
});

describe('route GET /api/billing/catalog', () => {
  it('AC-cors-3 — vitrine en www. alors que la variable vise l’apex : réponse lisible (ACAO = origine reçue, Vary: Origin)', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_SITE_URL', 'https://verebona.fr/');
    const res = await call('https://www.verebona.fr');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.verebona.fr');
    expect(res.headers.get('vary')).toMatch(/Origin/);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('AC-cors-4 — origine étrangère : aucun en-tête CORS, refus journalisé UNE fois et visible au BO', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_SITE_URL', 'https://www.verebona.fr');
    const res = await call('https://autre.example');
    await call('https://autre.example');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(refusedOrigins()).toEqual([expect.objectContaining({ origin: 'https://autre.example', count: 2 })]);
  });

  it('même origine que l’application ou sans Origin : rien à faire, rien de journalisé', async () => {
    vi.stubEnv('NEXT_PUBLIC_PUBLIC_SITE_URL', 'https://www.verebona.fr');
    await call('https://app.preprod.verebona.fr');
    await call();
    expect(refusedOrigins()).toEqual([]);
  });
});
