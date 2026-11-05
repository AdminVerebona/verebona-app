/**
 * Lot 111O — P0 « inscription bloquée : CGUV en cours de publication ».
 *
 *   L111O-01  manifeste du lot 108 (construit pour https://www.verebona.fr)
 *             servi par la préproduction : refusé en bloc, motif
 *             MANIFEST_ORIGIN_MISMATCH + origine étrangère nommée — cause
 *             reproduite avec l'artefact réel
 *   L111O-02  chaque cause candidate a son motif stable et son statut HTTP :
 *             401, 404, 500, HTML (SPA), redirection vers une autre origine
 *             (non suivie), redirection de même origine (suivie), réseau,
 *             délai
 *   L111O-03  texte figé : 401 et redirection → refus nommés (plus de
 *             « fetch failed »)
 *   L111O-04  configuration effective : source de l'URL (défaut PRODUCTION
 *             signalé en préproduction), variables par nom
 *   L111O-05  diagnostic : ouvert / origine / 404 + lecture de la production /
 *             version publiée mais texte refusé / jamais lu
 *   L111O-06  formulaire : vue bloquée sans permalien ni substitution, délais
 *             de relecture croissants et bornés
 *   L111O-07  lot 110 hors de cause : /api/legal/cguv/current passe le
 *             middleware sans session (aucune garde MFA / CSRF sur un GET public)
 *   L111O-08  mise en page : version et liens SOUS le libellé (plus de `Label`
 *             en flex), encart seulement en blocage, texte sans cause supposée
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { fetchCguvManifest, verifyTextBytes } from '../cguv-manifest';
import { cguvChainConfig, diagnoseCguvPublication, type DiagnoseInput } from '../cguv-publication-diagnostic';
import type { ManifestLastRead } from '../cguv-referential.service';
import { nextCguvRecheckDelayMs, toCurrentCguvView, CGUV_RECHECK_DELAYS_MS } from '@/components/legal/useCurrentCguv';
import { CGUV_PUBLIC_TEXT_NOTICE } from '@/components/legal/CguvPublicTextNotice';
import { CGUV_PUBLIC_TEXT_UNAVAILABLE_MESSAGE } from '../legal-acceptances.service';

const PREPROD = 'https://preprod.verebona.fr';
const ENV = { NEXT_PUBLIC_PUBLIC_SITE_URL: PREPROD, NEXT_PUBLIC_APP_ENV: 'preprod' };

/** Copie EXACTE du manifeste produit par le build du site public du lot 108 (`npm run build`, `.env.production`). */
const LOT108_MANIFEST = JSON.stringify({
  schema: 'verebona-legal-cguv-versions-v1',
  document: 'CGUV',
  generatedAt: '2026-11-05T13:11:46.727Z',
  current: '2026-10-30-v1',
  versions: [{
    code: '2026-10-30-v1',
    permalink: 'https://www.verebona.fr/legal/cguv/versions/2026-10-30-v1',
    textUrl: 'https://www.verebona.fr/legal/cguv/versions/2026-10-30-v1.html',
    sha256: 'f57a64847c32e1f715dd77439c47d480099b1cd2d4005ae973497b051bbb3240',
    publishedAt: '2026-10-30T09:00:00Z',
    effectiveAt: '2026-11-04T23:00:00Z',
    requiresReacceptance: true,
    title: 'Conditions générales d’utilisation et de vente',
    changeSummary: 'Nouvelle version des conditions générales d’utilisation et de vente (2026-10-30-v1), qui remplace la version du 30 juillet 2026.',
  }],
});
const manifestFor = (origin: string) => LOT108_MANIFEST.replaceAll('https://www.verebona.fr', origin);

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
const respond = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(status === 204 || (status >= 300 && status < 400) ? null : body, { status, headers });

describe('L111O-01 — manifeste construit pour la production, servi par la préproduction', () => {
  it('refusé en bloc : MANIFEST_ORIGIN_MISMATCH, origine étrangère et versions nommées', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const r = await fetchCguvManifest({ env: ENV, fetchImpl: async (_u, init) => { seen.push(init); return respond(LOT108_MANIFEST, 200, { 'content-type': 'application/json' }); } });
    expect(r).toMatchObject({
      ok: false, kind: 'invalid', reason: 'MANIFEST_ORIGIN_MISMATCH', httpStatus: 200,
      url: `${PREPROD}/legal/cguv/versions.json`, foreignOrigins: ['https://www.verebona.fr'],
      codes: ['2026-10-30-v1'], manifestCurrent: '2026-10-30-v1',
    });
    expect(seen[0]).toMatchObject({ cache: 'no-store', redirect: 'manual' });
  });

  it('le même manifeste construit pour la préproduction est accepté (contrôle positif)', async () => {
    const r = await fetchCguvManifest({ env: ENV, fetchImpl: async () => respond(manifestFor(PREPROD)) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.current).toBe('2026-10-30-v1');
  });

  it('application SANS NEXT_PUBLIC_PUBLIC_SITE_URL : lit le site de production (défaut), où la version est absente', async () => {
    const urls: string[] = [];
    const r = await fetchCguvManifest({ env: { NEXT_PUBLIC_APP_ENV: 'preprod' }, fetchImpl: async (u) => { urls.push(u); return respond('', 404); } });
    expect(urls).toEqual(['https://www.verebona.fr/legal/cguv/versions.json']);
    expect(r).toMatchObject({ ok: false, reason: 'MANIFEST_HTTP_NOT_FOUND', httpStatus: 404, error: 'HTTP 404' });
  });
});

describe('L111O-02 — un motif stable par cause candidate', () => {
  const cases: Array<[string, Route, Record<string, unknown>]> = [
    ['401 (site protégé sans exemption)', () => respond('Authentication required', 401), { reason: 'MANIFEST_HTTP_UNAUTHORIZED', httpStatus: 401, kind: 'unavailable' }],
    ['403', () => respond('', 403), { reason: 'MANIFEST_HTTP_UNAUTHORIZED', httpStatus: 403 }],
    ['500', () => respond('', 500), { reason: 'MANIFEST_HTTP_ERROR', httpStatus: 500, error: 'HTTP 500' }],
    ['page HTML (coquille SPA d’un site antérieur)', () => respond('<!doctype html><title>Verebona</title>', 200, { 'content-type': 'text/html; charset=utf-8' }), { reason: 'MANIFEST_NOT_JSON', httpStatus: 200, kind: 'invalid' }],
    ['schéma faux', () => respond(JSON.stringify({ schema: 'x' })), { reason: 'MANIFEST_SCHEMA_INVALID', kind: 'invalid' }],
    ['redirection vers la production', () => respond('', 301, { location: 'https://www.verebona.fr/legal/cguv/versions.json' }), { reason: 'MANIFEST_REDIRECT_FOREIGN', httpStatus: 301, location: 'https://www.verebona.fr/legal/cguv/versions.json' }],
    ['réseau', () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, { reason: 'MANIFEST_NETWORK', httpStatus: null }],
  ];
  for (const [label, route, expected] of cases) {
    it(label, async () => {
      const r = await fetchCguvManifest({ env: ENV, fetchImpl: async (u, i) => route(u, i) });
      expect(r).toMatchObject({ ok: false, ...expected });
    });
  }

  it('erreur réseau : la cause système est conservée (ENOTFOUND)', async () => {
    const r = await fetchCguvManifest({ env: ENV, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
    expect(!r.ok && r.error).toContain('ENOTFOUND');
  });

  it('délai dépassé', async () => {
    const r = await fetchCguvManifest({
      env: { ...ENV, LEGAL_MANIFEST_TIMEOUT_MS: '30' },
      fetchImpl: (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    expect(r).toMatchObject({ ok: false, reason: 'MANIFEST_TIMEOUT', httpStatus: null });
  });

  it('redirection de même origine : suivie (au plus 3), adresse finale conservée', async () => {
    const urls: string[] = [];
    const r = await fetchCguvManifest({
      env: ENV,
      fetchImpl: async (u) => {
        urls.push(u);
        return u.endsWith('/versions.json') ? respond('', 308, { location: '/legal/cguv/versions.json?v=2' }) : respond(manifestFor(PREPROD));
      },
    });
    expect(r).toMatchObject({ ok: true, httpStatus: 200, finalUrl: `${PREPROD}/legal/cguv/versions.json?v=2` });
    expect(urls).toHaveLength(2);
    const loop = await fetchCguvManifest({ env: ENV, fetchImpl: async () => respond('', 302, { location: '/legal/cguv/versions.json' }) });
    expect(loop).toMatchObject({ ok: false, reason: 'MANIFEST_REDIRECT_LOOP' });
  });
});

describe('L111O-03 — texte figé : refus nommés', () => {
  const SHA = 'f57a64847c32e1f715dd77439c47d480099b1cd2d4005ae973497b051bbb3240';
  it('401 → HTTP_UNAUTHORIZED ; redirection → HTTP_REDIRECT (destination nommée) ; jamais accepté', async () => {
    const url = `${PREPROD}/legal/cguv/versions/2026-10-30-v1.html`;
    expect(await verifyTextBytes(url, SHA, { fetchImpl: async () => respond('', 401) })).toMatchObject({ ok: false, reason: 'HTTP_UNAUTHORIZED' });
    const red = await verifyTextBytes(url, SHA, { fetchImpl: async () => respond('', 301, { location: 'https://www.verebona.fr/legal/cguv/versions/2026-10-30-v1.html' }) });
    expect(red).toMatchObject({ ok: false, reason: 'HTTP_REDIRECT' });
    expect(!red.ok && red.detail).toContain('https://www.verebona.fr/legal/cguv/versions/2026-10-30-v1.html');
    expect(await verifyTextBytes(url, SHA, { fetchImpl: async () => respond('autre texte') })).toMatchObject({ ok: false, reason: 'SHA_MISMATCH' });
  });
});

describe('L111O-04 — configuration effective', () => {
  it('source de l’URL et variables par nom', () => {
    expect(cguvChainConfig({ NEXT_PUBLIC_APP_ENV: 'preprod' })).toMatchObject({
      manifestUrl: 'https://www.verebona.fr/legal/cguv/versions.json', manifestUrlSource: 'default_production', siteBaseFromDefault: true, environment: 'preprod',
    });
    const c = cguvChainConfig({ ...ENV, LEGAL_CGUV_MANIFEST_URL: 'https://x.example/m.json', LEGAL_PUBLIC_V2: 'on' });
    expect(c).toMatchObject({ manifestUrl: 'https://x.example/m.json', manifestUrlSource: 'LEGAL_CGUV_MANIFEST_URL', siteBase: PREPROD });
    expect(c.variables.map((v) => v.name)).toEqual(['NEXT_PUBLIC_PUBLIC_SITE_URL', 'LEGAL_CGUV_MANIFEST_URL', 'LEGAL_PUBLIC_EXTRA_ORIGINS', 'LEGAL_PUBLIC_V2', 'NEXT_PUBLIC_LEGAL_PUBLIC_V2', 'NEXT_PUBLIC_APP_ENV']);
    expect(c.variables.find((v) => v.name === 'LEGAL_PUBLIC_EXTRA_ORIGINS')).toEqual({ name: 'LEGAL_PUBLIC_EXTRA_ORIGINS', set: false, value: null });
  });
});

describe('L111O-05 — diagnostic', () => {
  const read = (p: Partial<ManifestLastRead>): ManifestLastRead => ({
    at: '2026-11-05T13:00:00.000Z', trigger: 'schedule', url: `${PREPROD}/legal/cguv/versions.json`, finalUrl: null, httpStatus: 200, reason: null, error: null,
    location: null, foreignOrigins: [], versions: [], manifestCurrent: null, appCurrent: '2026-07-30-v1', expectedVerified: false, refused: [], durationMs: 10, ...p,
  });
  const base = (p: Partial<DiagnoseInput>): DiagnoseInput => ({
    config: cguvChainConfig(ENV),
    lastRead: null,
    state: { lastStatus: 'invalid', lastError: null, anomalies: [], manifestUrl: `${PREPROD}/legal/cguv/versions.json` },
    app: { currentVersionCode: '2026-07-30-v1', publicText: 'NOT_ON_PUBLIC_SITE' },
    ...p,
  });

  it('cause principale : manifeste construit pour la production', () => {
    const d = diagnoseCguvPublication(base({ lastRead: read({ reason: 'MANIFEST_ORIGIN_MISMATCH', foreignOrigins: ['https://www.verebona.fr'], versions: ['2026-10-30-v1'], manifestCurrent: '2026-10-30-v1' }) }));
    expect(d.code).toBe('MANIFEST_ORIGIN_MISMATCH');
    expect(d.detail).toContain('https://www.verebona.fr');
    expect(d.action).toContain(`VITE_PUBLIC_SITE_URL=${PREPROD}`);
  });

  it('variable absente : 404 de la production + avertissement « lit le site de PRODUCTION »', () => {
    const d = diagnoseCguvPublication(base({
      config: cguvChainConfig({ NEXT_PUBLIC_APP_ENV: 'preprod' }),
      lastRead: read({ url: 'https://www.verebona.fr/legal/cguv/versions.json', httpStatus: 404, reason: 'MANIFEST_HTTP_NOT_FOUND', error: 'HTTP 404' }),
    }));
    expect(d.code).toBe('MANIFEST_HTTP_NOT_FOUND');
    expect(d.detail).toContain('PRODUCTION');
    expect(d.detail).toContain('NEXT_PUBLIC_PUBLIC_SITE_URL absente');
  });

  it('manifeste lu, version publiée mais texte refusé (empreinte)', () => {
    const d = diagnoseCguvPublication(base({
      lastRead: read({ versions: ['2026-10-30-v1'], manifestCurrent: '2026-10-30-v1', refused: ['2026-10-30-v1'] }),
      state: { lastStatus: 'ok_with_anomalies', lastError: null, manifestUrl: null, anomalies: [{ kind: 'HASH_MISMATCH', code: '2026-10-30-v1', detail: 'octets différents' }] },
    }));
    expect(d.code).toBe('EXPECTED_VERSION_REFUSED');
    expect(d.detail).toContain('HASH_MISMATCH');
  });

  it('inscriptions ouvertes ; jamais lu', () => {
    expect(diagnoseCguvPublication(base({ app: { currentVersionCode: '2026-10-30-v1', publicText: 'VERIFIED' } })).code).toBe('SIGNUP_OPEN');
    expect(diagnoseCguvPublication(base({ state: { lastStatus: 'never', lastError: null, anomalies: [], manifestUrl: null } })).code).toBe('NEVER_READ');
  });
});

describe('L111O-06 — formulaire : blocage sans substitution, reprise bornée', () => {
  it('version bloquée : aucun permalien ; version vérifiée : permalien et Confidentialité du serveur', () => {
    expect(toCurrentCguvView({ versionCode: '2026-07-30-v1', publicText: 'NOT_ON_PUBLIC_SITE', permalinkUrl: null })).toEqual({ versionCode: '2026-07-30-v1', permalink: null, available: false, confidentialite: null });
    expect(toCurrentCguvView({
      versionCode: '2026-10-30-v1', publicText: 'VERIFIED', permalinkUrl: `${PREPROD}/legal/cguv/versions/2026-10-30-v1`,
      legalLinks: { confidentialite: `${PREPROD}/legal/confidentialite` },
    })).toEqual({ versionCode: '2026-10-30-v1', permalink: `${PREPROD}/legal/cguv/versions/2026-10-30-v1`, available: true, confidentialite: `${PREPROD}/legal/confidentialite` });
    expect(toCurrentCguvView({ error: 'x' })).toBeNull();
  });
  it('délais croissants, plafonnés à 5 min', () => {
    expect([0, 1, 2, 3, 4, 9].map(nextCguvRecheckDelayMs)).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000]);
    expect(Math.max(...CGUV_RECHECK_DELAYS_MS)).toBe(300_000);
  });
});

describe('L111O-07 — lot 110 hors de cause (middleware)', () => {
  it('GET /api/legal/cguv/current et /api/legal/links passent sans session ni en-tête', async () => {
    const { middleware } = await import('@/middleware');
    for (const p of ['/api/legal/cguv/current', '/api/legal/links']) {
      const res = await middleware(new NextRequest(`http://localhost:3000${p}`, { method: 'GET' }));
      expect(res.headers.get('x-middleware-next'), p).toBe('1');
    }
  });
});

describe('L111O-08 — mise en page et textes', () => {
  const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
  it('bloc de consentement partagé : libellé en <label> bloc, version + liens dessous, encart en blocage seulement', () => {
    const c = src('src/components/legal/CguvConsent.tsx');
    expect(c).not.toMatch(/from '@\/components\/ui\/label'/);
    expect(c).toMatch(/<label[\s\S]*?className=\{`block /);
    expect(c).toContain('{blocked && <CguvPublicTextNotice');
    expect(c).toContain('data-testid="cguv-consent-privacy"');
    for (const f of ['src/app/(auth)/signup/SignupForm.tsx', 'src/app/(auth)/connexion-sociale/page.tsx']) {
      const s = src(f);
      expect(s, f).toContain('<CguvConsent');
      expect(s, f).toContain('useCurrentCguv()');
      expect(s, f).toContain("'CGUV_PUBLIC_TEXT_UNAVAILABLE'");
      expect(s, f).not.toContain('<CguvPublicTextNotice');
    }
  });
  it('aucun texte ne suppose la cause (« en cours de publication » retiré)', () => {
    for (const t of [CGUV_PUBLIC_TEXT_NOTICE, CGUV_PUBLIC_TEXT_UNAVAILABLE_MESSAGE]) {
      expect(t).not.toMatch(/en cours de publication|mise en ligne/);
      expect(t).toMatch(/vérifiée?s? sur le site Verebona/);
    }
  });
});
