/**
 * Carte #873 — aucune URL hors production ne doit être indexée.
 *
 *   C873-POL   politique pure (environnement × hôte), refus par défaut
 *   C873-MW    en-tête réellement posé par le middleware sur chaque catégorie
 *              de route publique de préproduction (connexion, inscription,
 *              récupération, route profonde, redirection, 401, fichiers,
 *              variantes d'URL, alias)
 *   C873-PROD  non-régression production : aucune directive ajoutée, contrôles
 *              d'accès inchangés, noindex légitimes de next.config conservés
 *   C873-CFG   matcher réel de Next.js (toutes routes sauf `_next/static`),
 *              pas de robots.txt bloquant ni de sitemap / canonical de préprod
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import * as pageStaticInfo from 'next/dist/build/analysis/get-page-static-info';
import { middleware, config, isInAccessControlScope, ACCESS_CONTROL_PREFIXES } from '@/middleware';
import {
  NOINDEX_DIRECTIVE, ROBOTS_HEADER, isNonProductionHost, normalizeHost, resolveSearchIndexing, effectiveRequestHost,
} from '@/lib/seo/search-indexing';
import { generateAccessToken } from '@/lib/jwt';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// Conversion RÉELLE des matchers du middleware par Next.js (non déclarée dans ses types publics).
const { getMiddlewareMatchers } = pageStaticInfo as unknown as {
  getMiddlewareMatchers: (matcher: string[], nextConfig: object) => Array<{ regexp: string }>;
};

const PREPROD_HOST = 'app.preprod.verebona.fr';
const PROD_HOST = 'app.verebona.fr';

function req(path: string, init: { host?: string; forwardedHost?: string; method?: string; cookie?: string; ua?: string } = {}) {
  const host = init.host ?? PREPROD_HOST;
  const headers: Record<string, string> = { host };
  if (init.forwardedHost) headers['x-forwarded-host'] = init.forwardedHost;
  if (init.cookie) headers.cookie = init.cookie;
  if (init.ua) headers['user-agent'] = init.ua;
  // Le proxy de l'hébergeur transmet la requête sur l'adresse interne du conteneur.
  return new NextRequest(`http://localhost:26057${path}`, { method: init.method ?? 'GET', headers });
}

let savedEnv: string | undefined;
beforeEach(() => { savedEnv = process.env.NEXT_PUBLIC_APP_ENV; });
afterEach(() => {
  if (savedEnv === undefined) delete process.env.NEXT_PUBLIC_APP_ENV;
  else process.env.NEXT_PUBLIC_APP_ENV = savedEnv;
});

describe('C873-POL — politique d’indexation (pure)', () => {
  it('seule la production, sur un hôte de production, est indexable', () => {
    for (const env of ['production', 'prod', ' PRODUCTION ']) {
      for (const host of [PROD_HOST, 'verebona.app', 'www.verebona.fr', 'app.verebona.fr:443', undefined, null]) {
        const p = resolveSearchIndexing({ appEnv: env, host });
        expect(p.indexable, `${env} ${host}`).toBe(true);
        expect(p.directive).toBeNull();
      }
    }
  });

  it('préproduction, recette, staging, local : noindex, nofollow quel que soit l’hôte', () => {
    for (const env of ['preprod', 'preproduction', 'staging', 'local', 'dev', 'development', 'test']) {
      for (const host of [PREPROD_HOST, PROD_HOST, 'verebona.app', undefined]) {
        const p = resolveSearchIndexing({ appEnv: env, host });
        expect(p.indexable, `${env} ${host}`).toBe(false);
        expect(p.directive).toBe('noindex, nofollow');
        expect(p.reason).toBe('environment_not_production');
      }
    }
  });

  it('environnement absent ou illisible : refus par défaut (noindex)', () => {
    for (const env of [undefined, null, '', '  ', 'prd', 'live', 'productionn']) {
      const p = resolveSearchIndexing({ appEnv: env, host: PROD_HOST });
      expect(p.indexable, String(env)).toBe(false);
      expect(p.reason).toBe('environment_unknown');
    }
  });

  it('un en-tête Host ne peut qu’ajouter le noindex : jamais rendre la préproduction indexable', () => {
    expect(resolveSearchIndexing({ appEnv: 'preprod', host: PROD_HOST }).indexable).toBe(false);
    // Artefact de production servi par erreur sur un hôte / alias hors production.
    for (const host of [
      PREPROD_HOST, 'preprod.verebona.fr', 'APP.PREPROD.VEREBONA.FR.', 'verebona-app-preprod.osc-fr1.scalingo.io',
      'verebona-app.osc-fr1.scalingo.io', 'verebona-public-preprod.osc-fr1.scalingo.io', 'recette.verebona.fr',
      'staging-app.verebona.fr', 'review-123.verebona.fr', 'localhost:3000', '127.0.0.1:3001', '[::1]:3000',
    ]) {
      const p = resolveSearchIndexing({ appEnv: 'production', host });
      expect(p.indexable, host).toBe(false);
      expect(p.reason, host).toBe('non_production_host');
    }
  });

  it('un mot qui contient seulement un marqueur n’est pas visé (pas de faux positif en production)', () => {
    for (const host of ['app.verebona.fr', 'www.verebona.fr', 'verebona.app', 'devis.verebona.fr', 'reviewers.example.com', 'testament.example.fr']) {
      expect(isNonProductionHost(host), host).toBe(false);
    }
  });

  it('normalisation de l’hôte et résolution comme la protection CSRF (X-Forwarded-Host, puis Host)', () => {
    expect(normalizeHost('App.Preprod.Verebona.fr:443, proxy')).toBe('app.preprod.verebona.fr');
    expect(normalizeHost('[::1]:3000')).toBe('::1');
    expect(normalizeHost('')).toBeNull();
    expect(effectiveRequestHost(new Headers({ host: 'interne', 'x-forwarded-host': PROD_HOST }))).toBe(PROD_HOST);
    expect(effectiveRequestHost(new Headers({ host: PREPROD_HOST }))).toBe(PREPROD_HOST);
    expect(effectiveRequestHost(new Headers())).toBeNull();
  });
});

describe('C873-MW — préproduction : toute réponse porte X-Robots-Tag: noindex, nofollow', () => {
  beforeEach(() => { process.env.NEXT_PUBLIC_APP_ENV = 'preprod'; });

  const ROUTES_PUBLIQUES = [
    '/login', '/login?returnUrl=%2Faccueil', '/login/', '/LOGIN', '/signup', '/signup?ref=ABC',
    '/forgot-password', '/reset-password?token=x', '/recuperation', '/verify-email?token=x', '/verification',
    '/connexion-sociale', '/securiser-mon-compte', '/', '/cgvu', '/cguv', '/retractation', '/transmission/abc',
    '/duo/join', '/r/CODE', '/ressources/guide', '/aide/x', '/desinscription', '/route/inconnue/404',
    // Fichiers de `public/` et optimiseur d'images (indexables par Google Images).
    '/og-image.png', '/logo-animation.html', '/pdf.worker.min.mjs', '/pwa/icon-192.png', '/manifest.json',
    '/robots.txt', '/sitemap.xml', '/_next/image?url=%2Fog-image.png&w=256&q=75',
    // API publiques et JSON.
    '/api/health', '/api/manifest', '/api/billing/catalog', '/api/legal/cgvu/current',
  ];

  it('pages, variantes d’URL, fichiers et API publiques', async () => {
    for (const path of ROUTES_PUBLIQUES) {
      const res = await middleware(req(path));
      expect(res.headers.get(ROBOTS_HEADER), path).toBe(NOINDEX_DIRECTIVE);
    }
  });

  it('route profonde sans session : redirection vers /login, elle aussi en noindex', async () => {
    for (const path of ['/accueil', '/documents?drawer=12', '/assets/42/equipements', '/mon-compte/securite']) {
      const res = await middleware(req(path));
      expect(res.status, path).toBe(307);
      expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
      expect(res.headers.get(ROBOTS_HEADER), path).toBe(NOINDEX_DIRECTIVE);
    }
  });

  it('route profonde avec session (rechargement SPA) : servie, en noindex', async () => {
    const t = await generateAccessToken({
      id: 1, email: 'a@b.fr', role: 'USER' as never, planType: 'STANDARD' as never,
      status: 'ACTIVE' as never, currentAccountId: 9, hasActiveAccount: true,
    });
    const res = await middleware(req('/accueil', { cookie: `access_token=${t}` }));
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get(ROBOTS_HEADER)).toBe(NOINDEX_DIRECTIVE);
  });

  it('refus de l’API (401) : statut et corps inchangés, en noindex', async () => {
    const res = await middleware(req('/api/assets'));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('MISSING_TOKEN');
    expect(res.headers.get(ROBOTS_HEADER)).toBe(NOINDEX_DIRECTIVE);
  });

  it('alias de l’hébergeur et accès direct par l’adresse interne : noindex', async () => {
    for (const host of ['verebona-app-preprod.osc-fr1.scalingo.io', 'localhost:26057', PROD_HOST]) {
      expect((await middleware(req('/login', { host }))).headers.get(ROBOTS_HEADER), host).toBe(NOINDEX_DIRECTIVE);
    }
  });

  it('environnement absent : noindex (refus par défaut)', async () => {
    delete process.env.NEXT_PUBLIC_APP_ENV;
    expect((await middleware(req('/login', { host: PROD_HOST }))).headers.get(ROBOTS_HEADER)).toBe(NOINDEX_DIRECTIVE);
  });
});

describe('C873-PROD — production : aucune régression', () => {
  beforeEach(() => { process.env.NEXT_PUBLIC_APP_ENV = 'production'; });

  it('hôte public : aucune directive ajoutée, sur aucune catégorie de route', async () => {
    for (const path of ['/login', '/signup', '/', '/cgvu', '/ressources/guide', '/og-image.png', '/api/health', '/accueil', '/api/assets']) {
      for (const h of [{ host: PROD_HOST }, { host: 'interne:26057', forwardedHost: PROD_HOST }]) {
        const res = await middleware(req(path, h));
        expect(res.headers.get(ROBOTS_HEADER), `${path} ${JSON.stringify(h)}`).toBeNull();
      }
    }
  });

  it('contrôles d’accès inchangés (redirection, 401, passage, commerce natif)', async () => {
    const accueil = await middleware(req('/accueil', { host: PROD_HOST }));
    expect(accueil.status).toBe(307);
    expect(accueil.headers.get('location')).toContain('/login?returnUrl=%2Faccueil');
    expect((await middleware(req('/api/assets', { host: PROD_HOST }))).status).toBe(401);
    expect((await middleware(req('/login', { host: PROD_HOST }))).headers.get('x-middleware-next')).toBe('1');
    const natif = await middleware(req('/abonnement', { host: PROD_HOST, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 VerebonaApp/1.4.0 (52; prod)' }));
    expect(natif.status).toBe(307);
  });

  it('alias technique de la production (*.scalingo.io) : doublon, noindex', async () => {
    const res = await middleware(req('/login', { host: 'verebona-app.osc-fr1.scalingo.io' }));
    expect(res.headers.get(ROBOTS_HEADER)).toBe(NOINDEX_DIRECTIVE);
  });

  it('noindex légitimes des routes privées de next.config conservés (/api/auth, /verify-email)', async () => {
    const nextConfig = (await import('../../../../next.config.mjs')).default as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    const rules = await nextConfig.headers();
    const robots = rules.filter((r) => r.headers.some((h) => h.key.toLowerCase() === 'x-robots-tag'));
    expect(robots.map((r) => r.source).sort()).toEqual(['/api/auth/(.*)', '/verify-email']);
    // Aucune règle globale de next.config (figée au build, sans hôte) ne pose de noindex.
    for (const r of rules.filter((x) => x.source === '/(.*)')) {
      expect(r.headers.some((h) => h.key.toLowerCase() === 'x-robots-tag')).toBe(false);
    }
  });
});

describe('C873-CFG — configuration', () => {
  const matchers = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
  const couvert = (p: string) => matchers.some((r) => r.test(p));

  it('matcher réel de Next.js : toutes les routes, sauf les fragments de build /_next/static', () => {
    for (const p of ['/', '/login', '/signup', '/accueil', '/accueil/x', '/api/health', '/api/assets/1', '/og-image.png', '/pwa/a.png', '/_next/image', '/route/inconnue']) {
      expect(couvert(p), p).toBe(true);
    }
    for (const p of ['/_next/static/chunks/app.js', '/_next/static/css/a.css']) expect(couvert(p), p).toBe(false);
  });

  it('contrôles d’accès : exactement le périmètre de l’ancien matcher', () => {
    expect([...ACCESS_CONTROL_PREFIXES].sort()).toEqual([
      '/abonnement', '/accueil', '/agenda', '/api', '/assets', '/compte-en-suppression', '/dashboard',
      '/documents', '/fournisseurs', '/mon-compte', '/retractation',
    ]);
    for (const p of ['/api', '/api/x', '/accueil', '/mon-compte/offres', '/retractation']) expect(isInAccessControlScope(p), p).toBe(true);
    for (const p of ['/', '/login', '/apiary', '/accueillir', '/pwa/a.png', '/duos', '/r/x']) expect(isInAccessControlScope(p), p).toBe(false);
  });

  it('pas de robots.txt bloquant ni de sitemap / référence SEO vers la préproduction', () => {
    expect(existsSync(join(ROOT, 'public/robots.txt'))).toBe(false);
    for (const f of ['robots.ts', 'robots.txt', 'sitemap.ts', 'sitemap.xml']) expect(existsSync(join(ROOT, 'src/app', f)), f).toBe(false);
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const n of readdirSync(join(ROOT, d))) {
        const p = `${d}/${n}`;
        if (n === '__tests__' || n === 'test') continue;
        if (statSync(join(ROOT, p)).isDirectory()) parcourir(p);
        else if (/\.(ts|tsx)$/.test(n)) fichiers.push(p);
      }
    };
    parcourir('src/app');
    for (const f of fichiers) {
      const s = read(f);
      // Métadonnées SEO (canonical, alternates / hreflang) pointant vers un hôte de préproduction.
      expect(/(canonical|alternates|hreflang)[^\n]*preprod/i.test(s), f).toBe(false);
    }
  });

  it('aucune page servie ne déclare « index, follow » (pas de directive contradictoire)', () => {
    // Le seul gabarit qui le contient (rendu figé d'une version légale) n'est appelé par aucune route.
    const usages: string[] = [];
    const parcourir = (d: string) => {
      for (const n of readdirSync(join(ROOT, d))) {
        const p = `${d}/${n}`;
        if (n === '__tests__' || n === 'test') continue;
        if (statSync(join(ROOT, p)).isDirectory()) parcourir(p);
        else if (/\.(ts|tsx)$/.test(n) && read(p).includes('renderLegalVersionHtml(') && !p.endsWith('legal-html.renderer.ts')) usages.push(p);
      }
    };
    parcourir('src');
    expect(usages).toEqual([]);
  });
});
