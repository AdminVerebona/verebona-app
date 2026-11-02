/**
 * Lot 102B — site public = source juridique unique, preuves d'acceptation,
 * réacceptation des CGUV, demande de démarrage immédiat — base PostgreSQL
 * réelle (migration 0910), vraies routes, vraies tables.
 *
 *   L102B-E2E-00  site public pas encore livré : liens de repli, information (pas incident),
 *                 aucune réacceptation, preuve « en attente du site public » (archive)
 *   L102B-E2E-01  manifeste : import, version courante, idempotence, état
 *   L102B-E2E-02  manifeste modifié côté site : rien n'est réécrit, écart signalé
 *   L102B-E2E-03  manifeste en panne : dernier état connu, alerte Supervision, aucun blocage
 *   L102B-E2E-04  version substantielle : écritures bloquées, lecture permise, acceptation, déblocage
 *   L102B-E2E-05  version NON substantielle : aucun blocage
 *   L102B-E2E-06  preuve complète à l'inscription (version, permalien, empreinte, date, contexte, canal)
 *   L102B-E2E-07  redirections /cgvu, /cguv, /api/legal/cgvu/… ; archive historique
 *   L102B-E2E-08  preuves existantes : HISTORIQUE, rien d'inventé (migration rejouée)
 *   L102B-E2E-09  démarrage immédiat : preuve, rattachement unique à l'abonnement
 *   L102B-E2E-10  décision « substantielle » figée par la base
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { scenario } from '../scenario';
import { uid } from '../factories';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const SITE = 'https://site-e2e.verebona.test';
const sha = (c: string) => c.repeat(64).slice(0, 64);

function req(path: string, init: { body?: unknown; cookie?: string; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  headers['x-forwarded-for'] = `82.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.9`;
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const cookieOf = (res: Response, name: string) =>
  (res as unknown as { cookies: { get(n: string): { value: string } | undefined } }).cookies.get(name)?.value;

interface V { code: string; requiresReacceptance: boolean; publishedAt: string; sha256?: string; changeSummary?: string }
function manifestBody(current: string, versions: V[]) {
  return JSON.stringify({
    schema: 'verebona-legal-cguv-versions-v1', document: 'CGUV', generatedAt: new Date().toISOString(), current,
    versions: versions.map((v) => ({
      code: v.code, permalink: `${SITE}/legal/cguv/versions/${v.code}`, sha256: v.sha256 ?? sha('a'),
      publishedAt: v.publishedAt, requiresReacceptance: v.requiresReacceptance, changeSummary: v.changeSummary,
    })),
  });
}
const serve = (body: string, status = 200) => async () => new Response(body, { status, headers: { 'content-type': 'application/json' } });

scenario('L102B', 'Source juridique unique (site public) et preuves d’acceptation', ({ sql, make }) => {
  const saved = { site: process.env.NEXT_PUBLIC_PUBLIC_SITE_URL, app: process.env.APP_URL };
  beforeAll(() => {
    process.env.NEXT_PUBLIC_PUBLIC_SITE_URL = SITE;
    process.env.APP_URL = ORIGIN;
  });
  afterAll(() => {
    if (saved.site === undefined) delete process.env.NEXT_PUBLIC_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_PUBLIC_SITE_URL = saved.site;
    if (saved.app === undefined) delete process.env.APP_URL; else process.env.APP_URL = saved.app;
  });

  // Codes propres à ce fichier (base dédiée) — dates passées : versions en vigueur.
  const OLD = '2025-01-10-v1';
  const SUBST = '2025-02-10-v1';
  const MINOR = '2025-03-10-v1';

  async function sync(body: string, status = 200) {
    const { syncCguvManifest } = await import('@/services/legal/cguv-referential.service');
    return syncCguvManifest({ trigger: 'manual', fetchImpl: serve(body, status), env: { NEXT_PUBLIC_PUBLIC_SITE_URL: SITE } });
  }
  async function clearCaches() {
    const { serverCacheClear } = await import('@/lib/server-cache');
    serverCacheClear();
  }
  async function compte() {
    const email = `${uid('l102b')}@test.invalid`;
    const owner = await make.user({ email });
    const hash = await bcrypt.hash(PASSWORD, 4);
    await sql`UPDATE users SET password_hash = ${hash}, is_active = true, status = 'ACTIVE', first_name = 'Lea' WHERE id = ${owner.id}`;
    await make.account({ owner });
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req('/api/auth/login', { body: { email, password: PASSWORD } }));
    expect(res.status).toBe(200);
    return { id: owner.id, email, cookie: `access_token=${cookieOf(res, 'access_token')}` };
  }
  async function accepter(userId: number, code: string) {
    const { recordAcceptance } = await import('@/services/legal/legal-acceptances.service');
    return recordAcceptance({ userId, versionCode: code, context: 'ACCOUNT_CREATION', channel: 'WEB' });
  }
  async function ecritureRefusee(cookie: string): Promise<string | null> {
    const { SessionService } = await import('@/lib/session-service');
    try {
      await SessionService.getSession(req('/api/assets', { cookie, method: 'POST' }));
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  it('L102B-E2E-00 site public pas encore livré : liens sur les adresses actuelles, information Supervision (pas incident), aucune réacceptation, preuve « en attente du site public »', async () => {
    const LEGACY = '2024-05-01-v1';
    // Dernière version historique publiée par l'application (archive), même décidée « substantielle ».
    await sql`INSERT INTO legal_document_versions (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key, requires_reacceptance)
      VALUES ('CGVU', ${LEGACY}, 'archive', 'CURRENT', 'e2e', '2024-05-01T00:00:00Z', '2024-05-01T00:00:00Z', '<p>archive</p>', ${sha('9')}, ${`/cgvu/versions/${LEGACY}`}, ${`legal/${LEGACY}.html`}, true)`;
    await clearCaches();

    const r = await sync('', 404);
    expect(r.status).toBe('awaiting_public_site');
    const [st] = await sql<{ last_status: string; last_success_at: Date | null }[]>`SELECT last_status, last_success_at FROM legal_manifest_sync_state WHERE document_type = 'CGVU'`;
    expect(st).toEqual({ last_status: 'awaiting_public_site', last_success_at: null });
    const [info] = await sql<{ status: string; title: string }[]>`SELECT status, title FROM admin_anomalies WHERE fingerprint = 'other:legal-manifest:awaiting-site' ORDER BY id DESC LIMIT 1`;
    expect(info.status).toBe('open');
    expect(info.title).toMatch(/^Information/);
    expect(await sql`SELECT 1 FROM admin_anomalies WHERE fingerprint = 'other:legal-manifest:unavailable' AND status = 'open'`).toHaveLength(0);

    // Liens : adresses ACTUELLES du site (elles existent), jamais /legal/… avant livraison.
    const { GET: links } = await import('@/app/api/legal/links/route');
    expect(await (await links()).json()).toEqual({ mode: 'legacy', links: {
      mentionsLegales: `${SITE}/mentions-legales`, cguv: `${SITE}/cgu`, confidentialite: `${SITE}/confidentialite`,
      sousTraitants: `${SITE}/confidentialite`, parrainage: `${SITE}/cgu`,
    } });
    const { GET: cgvu } = await import('@/app/cgvu/route');
    expect((await cgvu()).headers.get('location')).toBe(`${SITE}/cgu`);
    const ctx = (version: string) => ({ params: Promise.resolve({ version }) });
    const { GET: page } = await import('@/app/cguv/versions/[version]/route');
    expect((await page(new Request(`${ORIGIN}/x`), ctx('2023-01-01-v1'))).status).toBe(404); // jamais un lien vers une page du site qui n'existe pas encore

    // Aucune réacceptation exigée, même pour une archive « substantielle ».
    const u = await compte();
    expect(await ecritureRefusee(u.cookie)).toBeNull();

    // Inscription : version courante connue, permalien d'archive, statut « en attente du site public ».
    const { POST } = await import('@/app/api/users/route');
    const email = `${uid('l102b-att')}@test.invalid`;
    expect((await POST(req('/api/users', { body: { email, password: 'NouveauMdp1!x', firstName: 'Ana', lastName: 'Attente', acceptedTerms: true, termsVersion: LEGACY } }))).status).toBe(201);
    const [p] = await sql<{ version_code: string; permalink_url: string; text_sha256: string; proof_status: string }[]>`
      SELECT la.version_code, la.permalink_url, la.text_sha256, la.proof_status FROM legal_acceptances la JOIN users us ON us.id = la.user_id WHERE us.email = ${email}`;
    expect(p).toEqual({ version_code: LEGACY, permalink_url: `${ORIGIN}/cguv/versions/${LEGACY}`, text_sha256: sha('9'), proof_status: 'EN_ATTENTE_SITE_PUBLIC' });
    // Le permalien d'archive répond (aucun 404).
    expect((await page(new Request(`${ORIGIN}/x`), ctx(LEGACY))).status).toBe(200);
  });

  it('L102B-E2E-01 manifeste : versions importées sans texte, version courante désignée, état enregistré ; relu = rien de nouveau', async () => {
    const r = await sync(manifestBody(OLD, [{ code: OLD, requiresReacceptance: false, publishedAt: '2025-01-10T08:00:00Z' }]));
    expect(r.status).toBe('ok');
    expect(r.imported).toEqual([OLD]);
    expect(r.current).toBe(OLD);
    const [v] = await sql<{ status: string; source: string; html_content: string | null; permalink: string; sha256: string; requires_reacceptance: boolean }[]>`
      SELECT status, source, html_content, permalink, sha256, requires_reacceptance FROM legal_document_versions WHERE version_code = ${OLD}`;
    expect(v).toEqual({ status: 'CURRENT', source: 'PUBLIC_SITE', html_content: null, permalink: `${SITE}/legal/cguv/versions/${OLD}`, sha256: sha('a'), requires_reacceptance: false });
    const again = await sync(manifestBody(OLD, [{ code: OLD, requiresReacceptance: false, publishedAt: '2025-01-10T08:00:00Z' }]));
    expect(again).toMatchObject({ status: 'ok', imported: [], anomalies: [] });
    const [st] = await sql<{ last_status: string; consecutive_failures: number; current_version_code: string; manifest_sha256: string }[]>`
      SELECT last_status, consecutive_failures, current_version_code, manifest_sha256 FROM legal_manifest_sync_state WHERE document_type = 'CGVU'`;
    expect(st).toMatchObject({ last_status: 'ok', consecutive_failures: 0, current_version_code: OLD });
    expect(st.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Site livré : l'information se résout, les liens basculent sur /legal/….
    const [info] = await sql<{ status: string }[]>`SELECT status FROM admin_anomalies WHERE fingerprint = 'other:legal-manifest:awaiting-site' ORDER BY id DESC LIMIT 1`;
    expect(info.status).toBe('resolved');
    const { GET: links } = await import('@/app/api/legal/links/route');
    expect((await (await links()).json()).links.cguv).toBe(`${SITE}/legal/cguv`);
  });

  it('L102B-E2E-02 version modifiée côté site (empreinte, décision) : valeurs enregistrées conservées, écart signalé (Supervision)', async () => {
    const r = await sync(manifestBody(OLD, [{ code: OLD, requiresReacceptance: true, publishedAt: '2025-01-10T08:00:00Z', sha256: sha('e') }]));
    expect(r.status).toBe('ok_with_anomalies');
    expect(r.anomalies.map((a) => a.kind)).toEqual(['VERSION_CHANGED_ON_SITE']);
    const [v] = await sql<{ sha256: string; requires_reacceptance: boolean }[]>`SELECT sha256, requires_reacceptance FROM legal_document_versions WHERE version_code = ${OLD}`;
    expect(v).toEqual({ sha256: sha('a'), requires_reacceptance: false });
    const [an] = await sql<{ status: string }[]>`SELECT status FROM admin_anomalies WHERE fingerprint = 'other:legal-manifest:anomaly' ORDER BY id DESC LIMIT 1`;
    expect(an?.status).toBe('open');
    // Retour à la normale : écart résolu automatiquement.
    await sync(manifestBody(OLD, [{ code: OLD, requiresReacceptance: false, publishedAt: '2025-01-10T08:00:00Z' }]));
    const [an2] = await sql<{ status: string }[]>`SELECT status FROM admin_anomalies WHERE fingerprint = 'other:legal-manifest:anomaly' ORDER BY id DESC LIMIT 1`;
    expect(an2?.status).toBe('resolved');
  });

  it('L102B-E2E-03 manifeste en panne : dernier état connu servi, alerte Supervision au seuil, inscription et écritures non bloquées', async () => {
    const r1 = await sync('', 503);
    expect(r1).toMatchObject({ status: 'unavailable', current: OLD, lastKnown: { current: OLD } });
    const r2 = await sync('{ pas du json');
    expect(r2.status).toBe('invalid');
    const [st] = await sql<{ last_status: string; consecutive_failures: number; last_success_at: Date | null }[]>`
      SELECT last_status, consecutive_failures, last_success_at FROM legal_manifest_sync_state WHERE document_type = 'CGVU'`;
    expect(st.last_status).toBe('invalid');
    expect(st.consecutive_failures).toBe(2);
    expect(st.last_success_at).not.toBeNull();
    const [an] = await sql<{ status: string; title: string }[]>`SELECT status, title FROM admin_anomalies WHERE fingerprint = 'other:legal-manifest:unavailable' ORDER BY id DESC LIMIT 1`;
    expect(an).toMatchObject({ status: 'open' });
    const { getPublicCurrentCguv } = await import('@/services/legal/cguv-referential.service');
    expect((await getPublicCurrentCguv())?.versionCode).toBe(OLD);
    // Aucun blocage abusif.
    const u = await compte();
    await accepter(u.id, OLD);
    await clearCaches();
    expect(await ecritureRefusee(u.cookie)).toBeNull();
    // Retour du manifeste : alerte résolue.
    await sync(manifestBody(OLD, [{ code: OLD, requiresReacceptance: false, publishedAt: '2025-01-10T08:00:00Z' }]));
    const [an2] = await sql<{ status: string }[]>`SELECT status FROM admin_anomalies WHERE fingerprint = 'other:legal-manifest:unavailable' ORDER BY id DESC LIMIT 1`;
    expect(an2.status).toBe('resolved');
  });

  it('L102B-E2E-04 version substantielle non acceptée : écritures refusées (code clair), lecture et export permis, écran signalé ; acceptation explicite → preuve complète et déblocage', async () => {
    const u = await compte();
    await accepter(u.id, OLD);
    await sync(manifestBody(SUBST, [
      { code: OLD, requiresReacceptance: false, publishedAt: '2025-01-10T08:00:00Z' },
      { code: SUBST, requiresReacceptance: true, publishedAt: '2025-02-10T08:00:00Z', sha256: sha('b'), changeSummary: 'Résumé en mots simples.' },
    ]));
    await clearCaches();

    expect(await ecritureRefusee(u.cookie)).toBe('CGUV_REACCEPTANCE_REQUIRED');
    // Réponse HTTP d'une vraie route d'écriture : 403 et code stable.
    const { PUT } = await import('@/app/api/users/me/route');
    const put = await PUT(req('/api/users/me', { cookie: u.cookie, method: 'PUT', body: { firstName: 'X', lastName: 'Y' } }));
    expect(put.status).toBe(403);
    expect((await put.json()).code).toBe('CGUV_REACCEPTANCE_REQUIRED');

    const { SessionService } = await import('@/lib/session-service');
    // Lecture, export RGPD, déconnexion : permis.
    await expect(SessionService.getSession(req('/api/assets', { cookie: u.cookie, method: 'GET' }))).resolves.toMatchObject({ userId: u.id });
    await expect(SessionService.getSession(req('/api/users/me/gdpr-export', { cookie: u.cookie, method: 'POST' }))).resolves.toMatchObject({ userId: u.id });
    await expect(SessionService.getSession(req('/api/auth/logout', { cookie: u.cookie, method: 'POST' }))).resolves.toMatchObject({ userId: u.id });

    // L'état servi à la coquille (écran dédié).
    const { GET: me } = await import('@/app/api/users/me/route');
    const meBody = await (await me(req('/api/users/me', { cookie: u.cookie, method: 'GET', headers: { 'x-verebona-fresh': '1' } }))).json();
    expect(meBody.legalReacceptance).toMatchObject({ required: true, versionCode: SUBST, substantialVersionCode: SUBST, changeSummary: 'Résumé en mots simples.', permalinkUrl: `${SITE}/legal/cguv/versions/${SUBST}` });

    // Acceptation d'une version qui n'est pas celle en vigueur : 409, rien d'enregistré.
    const { POST: accept } = await import('@/app/api/me/legal/cguv/accept/route');
    const bad = await accept(req('/api/me/legal/cguv/accept', { cookie: u.cookie, body: { versionCode: OLD } }));
    expect(bad.status).toBe(409);
    expect((await bad.json()).current.versionCode).toBe(SUBST);

    // Acceptation explicite depuis l'application mobile.
    const ok = await accept(req('/api/me/legal/cguv/accept', { cookie: u.cookie, body: { versionCode: SUBST }, headers: { 'x-verebona-client': 'IOS', 'x-verebona-app-version': '1.4.0' } }));
    expect(ok.status).toBe(200);
    const [p] = await sql<{ version_code: string; permalink_url: string; text_sha256: string; acceptance_context: string; channel: string; proof_status: string; accepted_at: Date }[]>`
      SELECT version_code, permalink_url, text_sha256, acceptance_context, channel, proof_status, accepted_at
        FROM legal_acceptances WHERE user_id = ${u.id} AND acceptance_context = 'VERSION_UPDATE'`;
    expect(p).toMatchObject({ version_code: SUBST, permalink_url: `${SITE}/legal/cguv/versions/${SUBST}`, text_sha256: sha('b'), acceptance_context: 'VERSION_UPDATE', channel: 'IOS', proof_status: 'COMPLETE' });
    expect(Number.isNaN(new Date(p.accepted_at).getTime())).toBe(false);

    expect(await ecritureRefusee(u.cookie)).toBeNull();
    // Rejeu (double clic) : une seule preuve.
    await accept(req('/api/me/legal/cguv/accept', { cookie: u.cookie, body: { versionCode: SUBST } }));
    expect(await sql`SELECT 1 FROM legal_acceptances WHERE user_id = ${u.id} AND acceptance_context = 'VERSION_UPDATE'`).toHaveLength(1);
  });

  it('L102B-E2E-05 version suivante NON substantielle : aucune réacceptation pour qui a accepté la substantielle ; qui ne l’a pas acceptée reste bloqué jusqu’à accepter la version en vigueur', async () => {
    const a = await compte();
    await accepter(a.id, SUBST);
    const b = await compte();
    await accepter(b.id, OLD);
    await sync(manifestBody(MINOR, [
      { code: OLD, requiresReacceptance: false, publishedAt: '2025-01-10T08:00:00Z' },
      { code: SUBST, requiresReacceptance: true, publishedAt: '2025-02-10T08:00:00Z', sha256: sha('b'), changeSummary: 'Résumé en mots simples.' },
      { code: MINOR, requiresReacceptance: false, publishedAt: '2025-03-10T08:00:00Z', sha256: sha('c') },
    ]));
    await clearCaches();
    expect(await ecritureRefusee(a.cookie)).toBeNull();
    expect(await ecritureRefusee(b.cookie)).toBe('CGUV_REACCEPTANCE_REQUIRED');
    const { acceptCurrentCguv } = await import('@/services/legal/cguv-reacceptance.service');
    expect((await acceptCurrentCguv({ userId: b.id, presentedVersionCode: MINOR, channel: 'WEB' })).ok).toBe(true);
    expect(await ecritureRefusee(b.cookie)).toBeNull();
  });

  it('L102B-E2E-06 inscription : preuve complète (version présentée, permalien public, empreinte, date, contexte, canal)', async () => {
    const { POST } = await import('@/app/api/users/route');
    const email = `${uid('l102b-ins')}@test.invalid`;
    const res = await POST(req('/api/users', { body: { email, password: 'NouveauMdp1!x', firstName: 'Nina', lastName: 'Neuve', acceptedTerms: true, termsVersion: MINOR }, headers: { 'user-agent': 'Mozilla/5.0 VerebonaApp/1.4.0' } }));
    expect(res.status).toBe(201);
    const [p] = await sql<{ version_code: string; permalink_url: string; text_sha256: string; acceptance_context: string; channel: string; proof_status: string }[]>`
      SELECT la.version_code, la.permalink_url, la.text_sha256, la.acceptance_context, la.channel, la.proof_status
        FROM legal_acceptances la JOIN users u ON u.id = la.user_id WHERE u.email = ${email}`;
    expect(p).toEqual({ version_code: MINOR, permalink_url: `${SITE}/legal/cguv/versions/${MINOR}`, text_sha256: sha('c'), acceptance_context: 'ACCOUNT_CREATION', channel: 'MOBILE', proof_status: 'COMPLETE' });
    // Métadonnées publiques (sans texte) servies au formulaire.
    const { GET } = await import('@/app/api/legal/cguv/current/route');
    const cur = await (await GET()).json();
    expect(cur).toMatchObject({ versionCode: MINOR, permalinkUrl: `${SITE}/legal/cguv/versions/${MINOR}`, sha256: sha('c'), publicUrl: `${SITE}/legal/cguv` });
    expect(JSON.stringify(cur)).not.toMatch(/<p|<h\d/);
  });

  it('L102B-E2E-07 redirections : /cgvu, /cguv, /api/legal/cgvu/current → URL publique ; version → son permalien ; archive APP_LEGACY servie telle quelle ; code invalide → 404', async () => {
    const loc = (r: Response) => r.headers.get('location');
    for (const mod of ['@/app/cgvu/route', '@/app/cguv/route', '@/app/api/legal/cgvu/current/route']) {
      const { GET } = await import(mod) as { GET: () => Promise<Response> };
      const r = await GET();
      expect(r.status, mod).toBe(307);
      expect(loc(r), mod).toBe(`${SITE}/legal/cguv`);
    }
    const ctx = (version: string) => ({ params: Promise.resolve({ version }) });
    const { GET: page } = await import('@/app/cgvu/versions/[version]/route');
    const r1 = await page(new Request(`${ORIGIN}/cgvu/versions/${SUBST}`), ctx(SUBST));
    expect([r1.status, loc(r1)]).toEqual([307, `${SITE}/legal/cguv/versions/${SUBST}`]);
    const { GET: api } = await import('@/app/api/legal/cgvu/versions/[version]/route');
    const r2 = await api(new Request(`${ORIGIN}/x`), ctx('2024-12-01-v3'));
    expect([r2.status, loc(r2)]).toEqual([307, `${SITE}/legal/cguv/versions/2024-12-01-v3`]);
    const r3 = await api(new Request(`${ORIGIN}/x`), ctx('pas-un-code'));
    expect(r3.status).toBe(404);

    // Archive d'une version publiée par l'ancienne mécanique : consultable, octets figés, marquée.
    const legacy = '2024-06-01-v1';
    const html = '<!doctype html><p>archive figée</p>';
    await sql`INSERT INTO legal_document_versions (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key)
      VALUES ('CGVU', ${legacy}, 'archive', 'ARCHIVED', 'e2e', now() - interval '200 days', now() - interval '200 days', ${html}, ${sha('d')}, ${`/cgvu/versions/${legacy}`}, ${`legal/${legacy}.html`})`;
    const { GET: cguvPage } = await import('@/app/cguv/versions/[version]/route');
    const r4 = await cguvPage(new Request(`${ORIGIN}/cguv/versions/${legacy}`), ctx(legacy));
    expect(r4.status).toBe(200);
    expect(r4.headers.get('x-legal-source')).toBe('archive-historique');
    expect(await r4.text()).toBe(html);
    // Le site la republie : l'application y renvoie désormais (correspondance publique figée une fois).
    await sync(manifestBody(MINOR, [
      { code: legacy, requiresReacceptance: false, publishedAt: '2024-06-01T00:00:00Z', sha256: sha('d') },
      { code: OLD, requiresReacceptance: false, publishedAt: '2025-01-10T08:00:00Z' },
      { code: SUBST, requiresReacceptance: true, publishedAt: '2025-02-10T08:00:00Z', sha256: sha('b'), changeSummary: 'Résumé en mots simples.' },
      { code: MINOR, requiresReacceptance: false, publishedAt: '2025-03-10T08:00:00Z', sha256: sha('c') },
    ]));
    const r5 = await cguvPage(new Request(`${ORIGIN}/cguv/versions/${legacy}`), ctx(legacy));
    expect([r5.status, loc(r5)]).toEqual([307, `${SITE}/legal/cguv/versions/${legacy}`]);
  });

  it('L102B-E2E-08 preuves antérieures : marquées HISTORIQUE avec leur code, sans empreinte inventée (migration 0910 rejouée, idempotente) ; toujours consultables', async () => {
    const u = await make.user({ email: `${uid('l102b-h')}@test.invalid` });
    const [v] = await sql<{ id: string }[]>`SELECT id FROM legal_document_versions WHERE version_code = '2024-06-01-v1'`;
    // Preuve « d'avant » : colonnes 102B absentes (simulées par leurs valeurs par défaut).
    await sql`INSERT INTO legal_acceptances (user_id, legal_document_version_id, accepted_at, acceptance_context) VALUES (${u.id}, ${v.id}, now() - interval '100 days', 'ACCOUNT_CREATION')`;
    await sql.unsafe(readFileSync(join(process.cwd(), 'src/db/migrations/0910_l102b_source_juridique_publique.sql'), 'utf8'));
    const [p] = await sql<{ proof_status: string; version_code: string; text_sha256: string | null; permalink_url: string | null }[]>`
      SELECT proof_status, version_code, text_sha256, permalink_url FROM legal_acceptances WHERE user_id = ${u.id}`;
    expect(p).toEqual({ proof_status: 'HISTORIQUE', version_code: '2024-06-01-v1', text_sha256: null, permalink_url: null });
    const { listUserAcceptances } = await import('@/services/legal/legal-acceptances.service');
    const [mine] = await listUserAcceptances(u.id);
    expect(mine).toMatchObject({ proofStatus: 'HISTORIQUE', textSha256: null, permalinkUrl: `${SITE}/legal/cguv/versions/2024-06-01-v1` });
    // Une preuve HISTORIQUE n'est pas « complétée » après coup.
    await expect(sql`UPDATE legal_acceptances SET proof_status = 'COMPLETE' WHERE user_id = ${u.id}`).rejects.toThrow(/non modifiable/);
  });

  it('L102B-E2E-09 démarrage immédiat : preuve (version, permalien, empreinte, date, offre, canal) puis rattachement UNIQUE à l’abonnement Stripe', async () => {
    const u = await compte();
    const { recordImmediateStartRequest, linkImmediateStartRequest } = await import('@/services/legal/immediate-start.service');
    const r = await recordImmediateStartRequest({ userId: u.id, planCode: 'premium', billingPeriod: 'yearly', channel: 'WEB' });
    expect(r.ok).toBe(true);
    const [p] = await sql<{ version_code: string; permalink_url: string; text_sha256: string; offer_code: string; channel: string; subscription_reference: string | null }[]>`
      SELECT version_code, permalink_url, text_sha256, offer_code, channel, subscription_reference FROM legal_acceptances
       WHERE user_id = ${u.id} AND acceptance_context = 'IMMEDIATE_START_REQUEST'`;
    expect(p).toEqual({ version_code: MINOR, permalink_url: `${SITE}/legal/cguv/versions/${MINOR}`, text_sha256: sha('c'), offer_code: 'premium:yearly', channel: 'WEB', subscription_reference: null });
    expect(await linkImmediateStartRequest({ userId: u.id, subscriptionId: null, stripeSubscriptionId: 'sub_e2e_1' })).not.toBeNull();
    const [linked] = await sql<{ subscription_reference: string }[]>`SELECT subscription_reference FROM legal_acceptances WHERE user_id = ${u.id} AND acceptance_context = 'IMMEDIATE_START_REQUEST'`;
    expect(linked.subscription_reference).toBe('sub_e2e_1');
    // Déjà rattachée : plus rien à rattacher ; changement interdit par la base.
    expect(await linkImmediateStartRequest({ userId: u.id, subscriptionId: null, stripeSubscriptionId: 'sub_autre' })).toBeNull();
    await expect(sql`UPDATE legal_acceptances SET subscription_reference = 'sub_autre' WHERE user_id = ${u.id} AND acceptance_context = 'IMMEDIATE_START_REQUEST'`).rejects.toThrow(/non modifiable/);
    // Une demande n'est pas une acceptation des CGUV pour la réacceptation.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM legal_acceptances WHERE user_id = ${u.id} AND acceptance_context <> 'IMMEDIATE_START_REQUEST'`;
    expect(n).toBe(0);
  });

  it('L102B-E2E-10 décision « substantielle », permalien et empreinte figés par la base pour une version publiée', async () => {
    await expect(sql`UPDATE legal_document_versions SET requires_reacceptance = false WHERE version_code = ${SUBST}`).rejects.toThrow(/fige/);
    await expect(sql`UPDATE legal_document_versions SET sha256 = ${sha('f')} WHERE version_code = ${MINOR}`).rejects.toThrow(/fige/);
    await expect(sql`UPDATE legal_document_versions SET public_permalink = 'https://x' WHERE version_code = '2024-06-01-v1'`).rejects.toThrow(/fige/);
    await expect(sql`DELETE FROM legal_document_versions WHERE version_code = ${OLD}`).rejects.toThrow(/suppression interdite/);
  });
});
