/**
 * Lot 111O — P0 « inscription bloquée : CGUV en cours de publication ».
 * Base PostgreSQL réelle, vraies routes, et un FAUX SITE PUBLIC servi en HTTP
 * réel sur 127.0.0.1 (aucune injection de `fetch` : la chaîne lit le site
 * exactement comme en préproduction — statuts, en-têtes, redirections).
 *
 * État de départ = préproduction du 05/11 : version en vigueur de
 * l'application 2026-07-30-v1 (archive APP_LEGACY jamais republiée par le
 * site), site public lot 108 qui publie 2026-10-30-v1.
 *
 *   L111O-E2E-01  chaque cause candidate bloque l'inscription (classique,
 *                 Google / Apple, invitation Duo, parrainage) avec son motif
 *                 exact — site de production sans la version (404), page HTML,
 *                 401, redirection vers la production, manifeste construit pour
 *                 une autre origine (artefact du lot 108), empreinte fausse,
 *                 texte protégé, délai, réseau (ECONNREFUSED réel) — sans aucun compte créé ;
 *                 carte BO « CGUV publiées » : URL lue, statut HTTP, motif
 *  L111O-E2E-02  reprise : le site corrigé, la SIMPLE relecture du formulaire
 *                 (`/api/legal/cguv/current`) relance la lecture : version
 *                 2026-10-30-v1 vérifiée, liens publics exacts, no-store ;
 *                 inscription classique (avec parrainage) → preuve complète
 *                 (code, permalien, empreinte, date, contexte) ; ancienne
 *                 version refusée (aucune substitution) ; Google / Apple admis
 *  L111O-E2E-03  après bascule : site de nouveau en panne → la version vérifiée
 *                 reste servie (jamais 2026-07-30-v1), preuves antérieures
 *                 intactes ; « Relire maintenant » (BO) relit et diagnostique
 */
import { createHash } from 'crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const ORIGIN = 'http://localhost:3000';
const LEGACY = '2026-07-30-v1';
const V1030 = '2026-10-30-v1';
const LEGACY_HTML = '<!doctype html><html lang="fr"><meta charset="utf-8"><title>CGUV 2026-07-30-v1</title><p>Archive de l’application</p></html>';
const TEXT_1030 = '<!doctype html><html lang="fr"><meta charset="utf-8"><title>CGUV 2026-10-30-v1</title><p>Texte figé 2026-10-30-v1</p></html>\n';
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

type Mode =
  | 'ok' | 'prod-404' | 'html' | '401' | 'redirect-prod' | 'origin-prod' | 'sha-wrong' | 'text-401' | 'timeout';

/* ── Faux site public (HTTP réel) ───────────────────────────────────────── */
// `fetch` réel capturé à la collecte : le harnais interdit tout appel réseau
// (setup.ts) ; seul le faux site public local est rendu joignable ci-dessous.
const realFetch = globalThis.fetch;
let mode: Mode = 'ok';
let SITE = '';
const server = http.createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  const manifest = (origin: string) => JSON.stringify({
    schema: 'verebona-legal-cguv-versions-v1', document: 'CGUV', generatedAt: '2026-11-05T13:11:46.727Z', current: V1030,
    versions: [{
      code: V1030, permalink: `${origin}/legal/cguv/versions/${V1030}`, textUrl: `${origin}/legal/cguv/versions/${V1030}.html`,
      sha256: sha(TEXT_1030), publishedAt: '2026-10-30T09:00:00Z', effectiveAt: '2026-11-04T23:00:00Z', requiresReacceptance: true,
      title: 'Conditions générales d’utilisation et de vente',
    }],
  });
  if (path === '/legal/cguv/versions.json') {
    if (mode === 'timeout') return; // ne répond jamais
    if (mode === 'prod-404') { res.writeHead(404); return res.end(); }
    if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>Verebona</title><div id="app"></div>'); }
    if (mode === '401') { res.writeHead(401, { 'www-authenticate': 'Basic realm="preprod"' }); return res.end('Authentication required'); }
    if (mode === 'redirect-prod') { res.writeHead(301, { location: 'https://www.verebona.fr/legal/cguv/versions.json' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' });
    return res.end(mode === 'origin-prod' ? manifest('https://www.verebona.fr') : manifest(SITE));
  }
  if (path === `/legal/cguv/versions/${V1030}.html`) {
    if (mode === 'text-401') { res.writeHead(401); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(mode === 'sha-wrong' ? `${TEXT_1030}<!-- modifié -->` : TEXT_1030);
  }
  res.writeHead(404); res.end();
});

function req(path: string, init: { body?: unknown; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN, ...(init.headers ?? {}) };
  headers['x-forwarded-for'] = `84.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.7`;
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
type Json = Record<string, any>;

scenario('L111O', 'Inscription bloquée « CGUV en cours de publication » : diagnostic, reprise, preuve', ({ sql }) => {
  const saved = { ...process.env };
  const KEYS = ['NEXT_PUBLIC_PUBLIC_SITE_URL', 'NEXT_PUBLIC_APP_ENV', 'APP_URL', 'LEGAL_MANIFEST_ON_DEMAND_INTERVAL_MS', 'LEGAL_MANIFEST_ON_DEMAND_WAIT_MS', 'LEGAL_MANIFEST_TIMEOUT_MS', 'LEGAL_CGUV_MANIFEST_URL', 'LEGAL_PUBLIC_V2', 'NEXT_PUBLIC_LEGAL_PUBLIC_V2'];
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    SITE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const k of ['LEGAL_CGUV_MANIFEST_URL', 'LEGAL_PUBLIC_V2', 'NEXT_PUBLIC_LEGAL_PUBLIC_V2']) delete process.env[k];
    Object.assign(process.env, {
      NEXT_PUBLIC_PUBLIC_SITE_URL: SITE, NEXT_PUBLIC_APP_ENV: 'preprod', APP_URL: ORIGIN,
      // Relecture à la demande sans intervalle (chaque relecture du formulaire relit le site), attente large.
      LEGAL_MANIFEST_ON_DEMAND_INTERVAL_MS: '0', LEGAL_MANIFEST_ON_DEMAND_WAIT_MS: '15000', LEGAL_MANIFEST_TIMEOUT_MS: '800',
    });
    await sql`INSERT INTO legal_document_versions (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key, requires_reacceptance)
      VALUES ('CGVU', ${LEGACY}, 'archive', 'CURRENT', 'e2e', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', ${LEGACY_HTML}, ${sha(LEGACY_HTML)}, ${`/cgvu/versions/${LEGACY}`}, ${`legal/${LEGACY}.html`}, false)
      ON CONFLICT DO NOTHING`;
  });
  beforeEach(() => {
    const guarded = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = String((input as { url?: string })?.url ?? input);
      // Faux site public et port local fermé (cas « réseau ») seulement.
      return SITE && (url.startsWith(`${SITE}/`) || url.startsWith('http://127.0.0.1:9/')) ? realFetch(url, init) : guarded(input as never, init);
    }) as typeof fetch;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  async function current() {
    const { GET } = await import('@/app/api/legal/cguv/current/route');
    const r = await GET();
    return { status: r.status, cache: r.headers.get('cache-control'), body: (await r.json()) as Json };
  }
  async function signup(body: Json) {
    const { POST } = await import('@/app/api/users/route');
    const email = `${uid('l111o')}@test.invalid`;
    const r = await POST(req('/api/users', { body: { email, password: 'NouveauMdp1!x', username: 'Lou', acceptedTerms: true, ...body } }));
    return { status: r.status, body: (await r.json()) as Json, email };
  }
  const lastRead = async () => (await sql<Json[]>`SELECT last_read, last_status, manifest_url FROM legal_manifest_sync_state WHERE document_type = 'CGVU'`)[0];
  const usersWith = async (email: string) => sql`SELECT 1 FROM users WHERE email = ${email}`;

  it('L111O-E2E-01 — chaque cause bloque l’inscription avec son motif exact (aucun compte, aucune substitution)', async () => {
    const { resetCguvOnDemandForTests, getCguvPublicationReport } = await import('@/services/legal/cguv-publication-diagnostic');
    const { termsVersionAcceptable } = await import('@/lib/auth/oauth/social-signup');
    const cases: Array<[Mode, string, number | null, string]> = [
      ['prod-404', 'MANIFEST_HTTP_NOT_FOUND', 404, 'MANIFEST_HTTP_NOT_FOUND'],
      ['html', 'MANIFEST_NOT_JSON', 200, 'MANIFEST_NOT_JSON'],
      ['401', 'MANIFEST_HTTP_UNAUTHORIZED', 401, 'MANIFEST_HTTP_UNAUTHORIZED'],
      ['redirect-prod', 'MANIFEST_REDIRECT_FOREIGN', 301, 'MANIFEST_REDIRECT_FOREIGN'],
      ['origin-prod', 'MANIFEST_ORIGIN_MISMATCH', 200, 'MANIFEST_ORIGIN_MISMATCH'],
      ['sha-wrong', '', 200, 'EXPECTED_VERSION_REFUSED'],
      ['text-401', '', 200, 'EXPECTED_VERSION_REFUSED'],
      ['timeout', 'MANIFEST_TIMEOUT', null, 'MANIFEST_TIMEOUT'],
    ];
    for (const [m, reason, http, diag] of cases) {
      mode = m;
      resetCguvOnDemandForTests();
      const c = await current();
      // Version bloquée : présentée telle quelle (2026-07-30-v1), sans permalien, jamais une autre.
      expect([c.status, c.body.versionCode, c.body.publicText, c.body.permalinkUrl, c.cache], m).toEqual([200, LEGACY, 'NOT_ON_PUBLIC_SITE', null, 'no-store']);
      const st = await lastRead();
      expect(st.last_read.httpStatus, m).toBe(http);
      expect(st.last_read.reason, m).toBe(reason || null);
      expect(st.last_read.url, m).toBe(`${SITE}/legal/cguv/versions.json`);
      const report = await getCguvPublicationReport();
      expect([report.signupOpen, report.diagnosis.code], m).toEqual([false, diag]);
      if (m === 'origin-prod') {
        expect(st.last_read.foreignOrigins).toEqual(['https://www.verebona.fr']);
        expect(st.last_read.versions).toEqual([V1030]);
        expect(report.diagnosis.action).toContain(`VITE_PUBLIC_SITE_URL=${SITE}`);
      }
      if (m === 'redirect-prod') expect(st.last_read.location).toBe('https://www.verebona.fr/legal/cguv/versions.json');
      if (m === 'sha-wrong') expect(report.state.anomalies.map((a) => a.kind)).toContain('HASH_MISMATCH');
      if (m === 'text-401') expect(report.state.anomalies.find((a) => a.code === V1030)?.detail).toContain('401');

      // Inscription classique, avec parrainage, invitation Duo : même refus explicite, aucun compte.
      for (const extra of [{ termsVersion: LEGACY }, { termsVersion: LEGACY, referralCode: 'CODE12' }, { termsVersion: LEGACY, inviteToken: 'jeton-duo-e2e' }, {}]) {
        const s = await signup(extra);
        expect([s.status, s.body.code], `${m} ${JSON.stringify(extra)}`).toEqual([503, 'CGUV_PUBLIC_TEXT_UNAVAILABLE']);
        expect(s.body.error).not.toMatch(/en cours de publication/);
        expect(await usersWith(s.email)).toHaveLength(0);
      }
      // Google / Apple : même contrôle.
      expect(await termsVersionAcceptable(LEGACY), m).toBe(false);
    }
    // Réseau : site injoignable (port local fermé, ECONNREFUSED réel).
    process.env.LEGAL_CGUV_MANIFEST_URL = 'http://127.0.0.1:9/legal/cguv/versions.json';
    resetCguvOnDemandForTests();
    expect((await current()).body.publicText).toBe('NOT_ON_PUBLIC_SITE');
    const net = (await lastRead()).last_read;
    expect([net.reason, net.httpStatus, net.url]).toEqual(['MANIFEST_NETWORK', null, 'http://127.0.0.1:9/legal/cguv/versions.json']);
    expect(net.error).toMatch(/ECONNREFUSED|fetch failed/);
    expect((await getCguvPublicationReport()).config.manifestUrlSource).toBe('LEGAL_CGUV_MANIFEST_URL');
    delete process.env.LEGAL_CGUV_MANIFEST_URL;

    expect(await sql`SELECT 1 FROM legal_acceptances`).toHaveLength(0);
  }, 120_000);

  let proofId: number | null = null;
  it('L111O-E2E-02 — reprise par simple relecture du formulaire : 2026-10-30-v1 vérifiée, preuve complète, ancienne version refusée', async () => {
    const { resetCguvOnDemandForTests } = await import('@/services/legal/cguv-publication-diagnostic');
    mode = 'ok';
    resetCguvOnDemandForTests();
    const c = await current();
    expect(c.cache).toBe('no-store');
    expect(c.body).toMatchObject({
      versionCode: V1030, publicText: 'VERIFIED', permalinkUrl: `${SITE}/legal/cguv/versions/${V1030}`, sha256: sha(TEXT_1030),
      linksMode: 'v2', legalLinks: { confidentialite: `${SITE}/legal/confidentialite`, cguv: `${SITE}/legal/cguv` },
    });
    expect((await lastRead()).last_read).toMatchObject({ reason: null, httpStatus: 200, manifestCurrent: V1030, appCurrent: V1030, expectedVerified: true, versions: [V1030] });

    // Aucune substitution : la version bloquée présentée avant reste refusée.
    expect((await signup({ termsVersion: LEGACY })).body.code).toBe('CGUV_PUBLIC_TEXT_UNAVAILABLE');

    // Inscription classique avec un code de parrainage (inconnu : sans effet sur le contrôle juridique).
    const s = await signup({ termsVersion: V1030, referralCode: 'CODE12' });
    expect(s.status).toBe(201);
    const [p] = await sql<Json[]>`SELECT la.* FROM legal_acceptances la JOIN users u ON u.id = la.user_id WHERE u.email = ${s.email}`;
    expect(p).toMatchObject({
      version_code: V1030, permalink_url: `${SITE}/legal/cguv/versions/${V1030}`, text_sha256: sha(TEXT_1030),
      acceptance_context: 'ACCOUNT_CREATION', proof_status: 'COMPLETE',
    });
    expect(Number.isNaN(new Date(p.accepted_at).getTime())).toBe(false);
    proofId = p.id;
    // Essai démarré normalement (7 jours, sans carte).
    const [acc] = await sql<Json[]>`SELECT a.id FROM accounts a JOIN users u ON u.id = a.owner_user_id WHERE u.email = ${s.email}`;
    expect(acc).toBeTruthy();

    // Google / Apple : la version vérifiée est acceptable, l'ancienne ne l'est jamais.
    const { termsVersionAcceptable } = await import('@/lib/auth/oauth/social-signup');
    expect([await termsVersionAcceptable(V1030), await termsVersionAcceptable(LEGACY)]).toEqual([true, false]);
  }, 60_000);

  it('L111O-E2E-03 — après bascule : panne du site → 2026-10-30-v1 reste servie ; « Relire maintenant » diagnostique', async () => {
    const { resetCguvOnDemandForTests, resyncCguvNow } = await import('@/services/legal/cguv-publication-diagnostic');
    mode = 'origin-prod';
    resetCguvOnDemandForTests();
    const c = await current();
    // Version vérifiée : aucune relecture à la demande, jamais l'ancienne version.
    expect([c.body.versionCode, c.body.publicText]).toEqual([V1030, 'VERIFIED']);
    const report = await resyncCguvNow(null);
    expect(report.resync?.status).toBe('invalid');
    expect(report.lastRead?.reason).toBe('MANIFEST_ORIGIN_MISMATCH');
    // Dernier état fiable conservé : inscriptions ouvertes, diagnostic « ouvert ».
    expect([report.signupOpen, report.diagnosis.code, report.app.currentVersionCode]).toEqual([true, 'SIGNUP_OPEN', V1030]);
    expect(report.cache.currentVersionCached).toBe(false);
    expect((await signup({ termsVersion: V1030 })).status).toBe(201);
    // Preuve antérieure intacte.
    const [p] = await sql<Json[]>`SELECT version_code, text_sha256 FROM legal_acceptances WHERE id = ${proofId}`;
    expect(p).toEqual({ version_code: V1030, text_sha256: sha(TEXT_1030) });
    mode = 'ok';
  }, 60_000);
});
