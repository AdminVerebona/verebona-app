/**
 * Lot 104A — finitions légales côté application (ticket « légal — finition »),
 * base PostgreSQL réelle, vraies routes, vrai moteur de suppression. Aucun
 * réseau : site public et production simulés par `fetchImpl` injecté.
 *
 *   L104A-E2E-00  P0-B raccord : repli avant le manifeste, bascule automatique
 *                 avec un manifeste conforme au contrat (archive 2026-07-30-v1
 *                 reprise octet pour octet), permaliens historiques, preuves
 *                 complètes (version, permalien, empreinte, date, contexte, canal)
 *   L104A-E2E-01  P1-C : textUrl absent / réseau / 404 / SHA faux → version
 *                 refusée, dernier état fiable conservé, écart Supervision + BO +
 *                 journal ; texte conforme → importée ; preuves intactes
 *   L104A-E2E-02  P1-D : archive APP_LEGACY identique / modifiée / absente /
 *                 reprise après correction
 *   L104A-E2E-03  P1-E : invalidation des caches (publication, acceptation),
 *                 non substantielle sans blocage, contrôle impossible (état
 *                 inconnu) → 503 + exemptions + Supervision, retour à la normale
 *   L104A-E2E-F1  P1-F : politique prudente (import refusé sans propagation
 *                 vérifiée, alerte tant qu'une copie est présente)
 *   L104A-E2E-F2  P1-F : route production (404 hors production, 503 sans clé,
 *                 401 sans signature, page signée sans donnée personnelle)
 *   L104A-E2E-F3  P1-F : rétractation J+90 en production → compte copié purgé
 *                 (identifiants locaux DIFFÉRENTS), objets S3 en file, idempotent
 *   L104A-E2E-F4  P1-F : suppression volontaire → utilisateur copié retrouvé par
 *                 son adresse (empreinte), adresse réutilisée après copie protégée
 *   L104A-E2E-F5  P1-F : échec puis reprise ; compte réapparu après restauration ;
 *                 clés différentes / réponse altérée → refus ; réimport idempotent
 */
import { createHash } from 'crypto';
import { NextRequest } from 'next/server';
import bcrypt from 'bcrypt';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { uid } from '../factories';

const PASSWORD = 'MotDePasseE2e1!';
const ORIGIN = 'http://localhost:3000';
const SITE = 'https://site-e2e-104a.verebona.test';
const PROD = 'https://prod-e2e-104a.verebona.test';
const KEY = 'cle-partagee-e2e-104a-0123456789abcdef';

/* ── Site public simulé ─────────────────────────────────────────────────── */

const TEXTS = new Map<string, string>();
const textOf = (label: string) => `<!doctype html><meta charset="utf-8"><title>CGUV</title><p>CGUV — texte figé ${label}</p>\n`;
const sha = (label: string) => {
  const t = textOf(label);
  const h = createHash('sha256').update(t, 'utf8').digest('hex');
  TEXTS.set(h, t);
  return h;
};
const shaOfText = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

interface V { code: string; requiresReacceptance?: boolean; publishedAt: string; sha256: string; textUrl?: string | null; changeSummary?: string }
function manifest(current: string, versions: V[]) {
  return JSON.stringify({
    schema: 'verebona-legal-cguv-versions-v1', document: 'CGUV', generatedAt: new Date().toISOString(), current,
    versions: versions.map((v) => ({
      code: v.code, permalink: `${SITE}/legal/cguv/versions/${v.code}`,
      ...(v.textUrl === null ? {} : { textUrl: v.textUrl ?? `${SITE}/legal/cguv/versions/${v.code}.html` }),
      sha256: v.sha256, publishedAt: v.publishedAt, requiresReacceptance: v.requiresReacceptance ?? false, changeSummary: v.changeSummary,
    })),
  });
}
/** Octets réellement servis par URL de texte figé (défaut : le texte dont l'empreinte est annoncée). */
const served = new Map<string, 'down' | 404 | string>();
function site(body: string) {
  return async (url: string) => {
    if (url.endsWith('.html')) {
      const o = served.get(url);
      if (o === 'down') throw new Error('connect ECONNREFUSED');
      if (o === 404) return new Response('', { status: 404 });
      if (typeof o === 'string') return new Response(o, { status: 200 });
      const v = (JSON.parse(body) as { versions: Array<{ textUrl?: string; sha256: string }> }).versions.find((x) => x.textUrl === url);
      const t = v ? TEXTS.get(v.sha256) : undefined;
      return t ? new Response(t, { status: 200 }) : new Response('', { status: 404 });
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function req(path: string, init: { body?: unknown; cookie?: string; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN, ...(init.headers ?? {}) };
  if (init.cookie) headers.cookie = init.cookie;
  headers['x-forwarded-for'] = `83.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.4`;
  return new NextRequest(`${ORIGIN}${path}`, { method: init.method ?? 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const cookieOf = (res: Response, name: string) =>
  (res as unknown as { cookies: { get(n: string): { value: string } | undefined } }).cookies.get(name)?.value;

type Json = Record<string, any>;

scenario('L104A', 'Finitions légales : CGUV vérifiées, réacceptation fiable, suppressions propagées aux copies', ({ sql, make }) => {
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.NEXT_PUBLIC_PUBLIC_SITE_URL = SITE;
    process.env.APP_URL = ORIGIN;
  });
  afterAll(() => {
    for (const k of ['NEXT_PUBLIC_PUBLIC_SITE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_ENV', 'PRODUCTION_DELETION_SIGNAL_KEY', 'PRODUCTION_DELETION_SIGNAL_URL']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  const LEGACY = '2026-07-30-v1';
  const LEGACY_HTML = '<!doctype html><html lang="fr"><meta charset="utf-8"><title>CGUV 2026-07-30-v1</title><p>Archive figée acceptée</p></html>';
  const V1030 = '2026-10-30-v1';
  const X1 = '2026-10-31-v1';
  const SUBST = '2026-11-01-v1';
  const MINOR = '2026-11-02-v1';
  const base: V[] = [];

  async function sync(body: string) {
    const { syncCguvManifest } = await import('@/services/legal/cguv-referential.service');
    return syncCguvManifest({ trigger: 'manual', fetchImpl: site(body) as never, env: { NEXT_PUBLIC_PUBLIC_SITE_URL: SITE } });
  }
  async function clearCaches() {
    const { serverCacheClear } = await import('@/lib/server-cache');
    serverCacheClear();
  }
  async function compte() {
    const email = `${uid('l104a')}@test.invalid`;
    const owner = await make.user({ email });
    const hash = await bcrypt.hash(PASSWORD, 4);
    await sql`UPDATE users SET password_hash = ${hash}, is_active = true, status = 'ACTIVE', first_name = 'Lou' WHERE id = ${owner.id}`;
    await make.account({ owner });
    const { POST } = await import('@/app/api/auth/login/route');
    const res = await POST(req('/api/auth/login', { body: { email, password: PASSWORD } }));
    expect(res.status).toBe(200);
    return { id: owner.id, email, cookie: `access_token=${cookieOf(res, 'access_token')}` };
  }
  async function ecriture(cookie: string, path = '/api/assets', method = 'POST'): Promise<string | null> {
    const { SessionService } = await import('@/lib/session-service');
    try { await SessionService.getSession(req(path, { cookie, method })); return null; } catch (e) { return (e as Error).message; }
  }
  const proofs = async () => sql<Json[]>`SELECT * FROM legal_acceptances ORDER BY id`;
  const anomaly = async (fp: string) => (await sql<Json[]>`SELECT status, title, technical_detail FROM admin_anomalies WHERE fingerprint = ${fp} ORDER BY id DESC LIMIT 1`)[0];

  it('L104A-E2E-00 P0-B — repli avant le manifeste ; manifeste conforme au contrat : bascule automatique, archive 2026-07-30-v1 reprise octet pour octet, preuves complètes', async () => {
    await sql`INSERT INTO legal_document_versions (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key, requires_reacceptance)
      VALUES ('CGVU', ${LEGACY}, 'archive', 'CURRENT', 'e2e', '2026-07-30T00:00:00Z', '2026-07-30T00:00:00Z', ${LEGACY_HTML}, ${shaOfText(LEGACY_HTML)}, ${`/cgvu/versions/${LEGACY}`}, ${`legal/${LEGACY}.html`}, false)`;
    await clearCaches();
    const { GET: links } = await import('@/app/api/legal/links/route');
    expect((await (await links()).json()).links.cguv).toBe(`${SITE}/cgu`);

    // Lot 108L : pendant le repli, la version présentée (archive de l'application)
    // n'est pas consultable sur le site public → inscription REFUSÉE (état
    // explicite, aucune acceptation non opposable), reprise après livraison.
    const { POST } = await import('@/app/api/users/route');
    const e1 = `${uid('l104a-rep')}@test.invalid`;
    const r1 = await POST(req('/api/users', { body: { email: e1, password: 'NouveauMdp1!x', firstName: 'Ana', lastName: 'Repli', acceptedTerms: true, termsVersion: LEGACY } }));
    expect([r1.status, (await r1.json()).code]).toEqual([503, 'CGUV_PUBLIC_TEXT_UNAVAILABLE']);
    expect(await sql`SELECT 1 FROM legal_acceptances la JOIN users u ON u.id = la.user_id WHERE u.email = ${e1}`).toHaveLength(0);
    // Preuve « en attente du site public » enregistrée AVANT le lot 108L (règle 102B) : elle ne sera jamais réécrite.
    const ancien = await compte();
    const [lv] = await sql<Json[]>`SELECT id FROM legal_document_versions WHERE version_code = ${LEGACY}`;
    const [p1] = await sql<Json[]>`INSERT INTO legal_acceptances (user_id, legal_document_version_id, accepted_at, acceptance_context, version_code, permalink_url, text_sha256, proof_status, channel, created_at)
      VALUES (${ancien.id}, ${lv.id}, now(), 'ACCOUNT_CREATION', ${LEGACY}, ${`${ORIGIN}/cguv/versions/${LEGACY}`}, ${shaOfText(LEGACY_HTML)}, 'EN_ATTENTE_SITE_PUBLIC', 'WEB', now()) RETURNING *`;

    // Le site publie (contrat § 4.3) : archive reprise octet pour octet + version en vigueur.
    TEXTS.set(shaOfText(LEGACY_HTML), LEGACY_HTML);
    base.push(
      { code: LEGACY, publishedAt: '2026-07-30T00:00:00Z', sha256: shaOfText(LEGACY_HTML) },
      { code: V1030, publishedAt: '2026-10-30T08:00:00Z', sha256: sha(V1030) },
    );
    const r = await sync(manifest(V1030, base));
    expect(r).toMatchObject({ status: 'ok', imported: [V1030], linkedLegacy: [LEGACY], refused: [], current: V1030 });
    await clearCaches();
    expect((await (await links()).json()).links).toMatchObject({ cguv: `${SITE}/legal/cguv`, sousTraitants: `${SITE}/legal/sous-traitants`, parrainage: `${SITE}/legal/parrainage` });
    // Permalien historique : renvoie à la version EXACTE sur le site (jamais à la courante).
    const ctx = (version: string) => ({ params: Promise.resolve({ version }) });
    const { GET: page } = await import('@/app/cguv/versions/[version]/route');
    const h = await page(new Request(`${ORIGIN}/x`), ctx(LEGACY));
    expect([h.status, h.headers.get('location')]).toEqual([307, `${SITE}/legal/cguv/versions/${LEGACY}`]);

    // Nouvelle inscription (mobile) : preuve complète sur la version publique.
    const e2 = `${uid('l104a-pub')}@test.invalid`;
    expect((await POST(req('/api/users', { body: { email: e2, password: 'NouveauMdp1!x', firstName: 'Noa', lastName: 'Public', acceptedTerms: true, termsVersion: V1030 }, headers: { 'x-verebona-client': 'ANDROID' } }))).status).toBe(201);
    const [p2] = await sql<Json[]>`SELECT la.* FROM legal_acceptances la JOIN users u ON u.id = la.user_id WHERE u.email = ${e2}`;
    expect(p2).toMatchObject({ version_code: V1030, permalink_url: `${SITE}/legal/cguv/versions/${V1030}`, text_sha256: sha(V1030), proof_status: 'COMPLETE', acceptance_context: 'ACCOUNT_CREATION' });
    expect(['ANDROID', 'MOBILE', 'WEB']).toContain(p2.channel);
    expect(Number.isNaN(new Date(p2.accepted_at).getTime())).toBe(false);
    // La preuve du repli n'est pas modifiée.
    const [p1bis] = await sql<Json[]>`SELECT * FROM legal_acceptances WHERE id = ${p1.id}`;
    expect(p1bis).toEqual(p1);
  });

  it('L104A-E2E-01 P1-C — textUrl absent, réseau, 404, SHA faux : version refusée, dernier état fiable conservé, écart Supervision + BO + journal ; texte conforme : importée', async () => {
    const before = await proofs();
    const x1 = { code: X1, publishedAt: '2026-10-31T08:00:00Z', sha256: sha(X1) };
    const cases: Array<[string, V, () => void, string]> = [
      ['absent', { ...x1, textUrl: null }, () => undefined, 'TEXT_URL_MISSING'],
      ['réseau', x1, () => served.set(`${SITE}/legal/cguv/versions/${X1}.html`, 'down'), 'TEXT_UNAVAILABLE'],
      ['404', x1, () => served.set(`${SITE}/legal/cguv/versions/${X1}.html`, 404), 'TEXT_UNAVAILABLE'],
      ['sha', x1, () => served.set(`${SITE}/legal/cguv/versions/${X1}.html`, `${textOf(X1)}<!-- injecté -->`), 'HASH_MISMATCH'],
    ];
    for (const [label, v, arrange, kind] of cases) {
      served.clear();
      arrange();
      const r = await sync(manifest(X1, [...base, v]));
      expect(r.status, label).toBe('ok_with_anomalies');
      expect(r.refused, label).toEqual([X1]);
      expect(r.current, label).toBe(V1030);
      expect(r.anomalies.map((a) => a.kind), label).toEqual(expect.arrayContaining([kind, 'CURRENT_NOT_VERIFIED']));
      expect((await sql`SELECT 1 FROM legal_document_versions WHERE version_code = ${X1}`).length, label).toBe(0);
    }
    const an = await anomaly('other:legal-manifest:anomaly');
    expect(an.status).toBe('open');
    expect(an.title).toMatch(/refusée/);
    // BO › CGUV : écarts de la dernière lecture.
    const { getManifestSyncState } = await import('@/services/legal/cguv-referential.service');
    expect((await getManifestSyncState()).anomalies.map((a) => a.kind)).toContain('HASH_MISMATCH');
    // Journal juridique, sans secret.
    const audits = await sql<Json[]>`SELECT details, result FROM legal_audit_log WHERE action = 'MANIFEST_ANOMALY' AND version_code = ${X1} ORDER BY id`;
    expect(audits.map((a) => String(a.details).split(' : ')[0])).toEqual(expect.arrayContaining(['TEXT_URL_MISSING', 'TEXT_UNAVAILABLE', 'HASH_MISMATCH', 'CURRENT_NOT_VERIFIED']));
    expect(audits.every((a) => a.result === 'failure' && !String(a.details).includes(KEY))).toBe(true);

    // Correction côté site : importée, en vigueur, écart résolu.
    served.clear();
    base.push(x1);
    const ok = await sync(manifest(X1, base));
    expect(ok).toMatchObject({ status: 'ok', imported: [X1], refused: [], current: X1 });
    expect((await anomaly('other:legal-manifest:anomaly')).status).toBe('resolved');
    // Preuves existantes intactes.
    expect(await proofs()).toEqual(before);
  });

  it('L104A-E2E-02 P1-D — archive APP_LEGACY : modifiée / empreinte différente / absente → non rattachée, archive servie ; reprise après correction', async () => {
    const OLD = '2024-06-01-v1';
    const html = '<!doctype html><p>archive 2024</p>';
    await sql`INSERT INTO legal_document_versions (document_type, version_code, title, status, change_summary, published_at, effective_at, html_content, sha256, permalink, html_storage_key)
      VALUES ('CGVU', ${OLD}, 'archive', 'ARCHIVED', 'e2e', '2024-06-01T00:00:00Z', '2024-06-01T00:00:00Z', ${html}, ${shaOfText(html)}, ${`/cgvu/versions/${OLD}`}, ${`legal/${OLD}.html`})`;
    TEXTS.set(shaOfText(html), html);
    const url = `${SITE}/legal/cguv/versions/${OLD}.html`;
    const { GET: page } = await import('@/app/cguv/versions/[version]/route');
    const archiveServie = async () => {
      const r = await page(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ version: OLD }) });
      return r.status === 200 && r.headers.get('x-legal-source') === 'archive-historique' && (await r.text()) === html;
    };

    const tries: Array<[string, string, () => void]> = [
      ['fichier modifié', shaOfText(html), () => served.set(url, '<!doctype html><p>archive 2024 régénérée</p>')],
      ['empreinte différente', shaOfText('<!doctype html><p>autre</p>'), () => served.set(url, '<!doctype html><p>autre</p>')],
      ['fichier absent', shaOfText(html), () => served.set(url, 404)],
    ];
    for (const [label, publicSha, arrange] of tries) {
      served.clear();
      arrange();
      const r = await sync(manifest(X1, [{ code: OLD, publishedAt: '2024-06-01T00:00:00Z', sha256: publicSha }, ...base]));
      expect(r.linkedLegacy, label).toEqual([]);
      expect(r.anomalies.find((a) => a.code === OLD)?.kind, label).toBe('LEGACY_LINK_REFUSED');
      const [row] = await sql<Json[]>`SELECT public_permalink, public_sha256 FROM legal_document_versions WHERE version_code = ${OLD}`;
      expect(row, label).toEqual({ public_permalink: null, public_sha256: null });
      expect(await archiveServie(), label).toBe(true);
    }
    // Correction : le site sert les octets d'origine → rattachée, permalien public.
    served.clear();
    base.unshift({ code: OLD, publishedAt: '2024-06-01T00:00:00Z', sha256: shaOfText(html) });
    const r = await sync(manifest(X1, base));
    expect(r.linkedLegacy).toEqual([OLD]);
    const r2 = await page(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ version: OLD }) });
    expect([r2.status, r2.headers.get('location')]).toEqual([307, `${SITE}/legal/cguv/versions/${OLD}`]);
  });

  it('L104A-E2E-03 P1-E — caches invalidés à la publication et à l’acceptation ; non substantielle sans blocage ; contrôle impossible → 503, exemptions, Supervision ; retour à la normale', async () => {
    const u = await compte();
    const { recordAcceptance } = await import('@/services/legal/legal-acceptances.service');
    await recordAcceptance({ userId: u.id, versionCode: X1, context: 'ACCOUNT_CREATION', channel: 'WEB' });
    await clearCaches();
    expect(await ecriture(u.cookie)).toBeNull(); // « non requis » mis en cache

    // Publication d'une version substantielle : aucune attente du cache.
    base.push({ code: SUBST, publishedAt: '2026-11-01T08:00:00Z', sha256: sha(SUBST), requiresReacceptance: true, changeSummary: 'Résumé en mots simples.' });
    expect((await sync(manifest(SUBST, base))).current).toBe(SUBST);
    expect(await ecriture(u.cookie)).toBe('CGUV_REACCEPTANCE_REQUIRED');

    // Acceptation explicite : déblocage immédiat.
    const { POST: accept } = await import('@/app/api/me/legal/cguv/accept/route');
    expect((await accept(req('/api/me/legal/cguv/accept', { cookie: u.cookie, body: { versionCode: SUBST } }))).status).toBe(200);
    expect(await ecriture(u.cookie)).toBeNull();

    // Version suivante NON substantielle : toujours aucun blocage.
    base.push({ code: MINOR, publishedAt: '2026-11-02T00:00:00Z', sha256: sha(MINOR) });
    expect((await sync(manifest(MINOR, base))).current).toBe(MINOR);
    expect(await ecriture(u.cookie)).toBeNull();
    const w = await compte();
    expect(await ecriture(w.cookie)).toBe('CGUV_REACCEPTANCE_REQUIRED');

    // État inconnu : version substantielle due mais plus aucune version en vigueur à présenter.
    const [cur] = await sql<Json[]>`SELECT id FROM legal_document_versions WHERE document_type = 'CGVU' AND status = 'CURRENT'`;
    await sql`UPDATE legal_document_versions SET status = 'ARCHIVED' WHERE id = ${cur.id}`;
    await clearCaches();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await ecriture(w.cookie)).toBe('CGUV_CHECK_UNAVAILABLE');
    const { PUT, GET: me } = await import('@/app/api/users/me/route');
    const put = await PUT(req('/api/users/me', { cookie: w.cookie, method: 'PUT', body: { firstName: 'X', lastName: 'Y' } }));
    expect(put.status).toBe(503);
    expect(await put.json()).toMatchObject({ code: 'CGUV_CHECK_UNAVAILABLE' });
    // Accès indispensables préservés.
    for (const [path, method] of [['/api/assets', 'GET'], ['/api/users/me/gdpr-export', 'POST'], ['/api/auth/logout', 'POST'], ['/api/me/legal/cguv/accept', 'POST'],
      ['/api/users/me/deletion', 'DELETE'], ['/api/billing/cancel-subscription', 'POST'], ['/api/withdrawal/request', 'POST']] as const) {
      expect(await ecriture(w.cookie, path, method), `${method} ${path}`).toBeNull();
    }
    const meBody = await (await me(req('/api/users/me', { cookie: w.cookie, method: 'GET', headers: { 'x-verebona-fresh': '1' } }))).json();
    expect(meBody.legalReacceptance).toMatchObject({ required: false, status: 'unavailable' });
    const { flushReacceptanceSupervision } = await import('@/services/legal/cguv-reacceptance.service');
    await flushReacceptanceSupervision();
    expect((await anomaly('other:legal-reacceptance:unavailable')).status).toBe('open');
    err.mockRestore();

    // Retour à la normale : le site publie une nouvelle version en vigueur (une version archivée ne
    // redevient jamais courante) ; la réacceptation redevient la règle, l'alerte se résout.
    base.push({ code: '2026-11-02-v2', publishedAt: '2026-11-02T00:30:00Z', sha256: sha('2026-11-02-v2') });
    expect((await sync(manifest('2026-11-02-v2', base))).current).toBe('2026-11-02-v2');
    await clearCaches();
    expect(await ecriture(w.cookie)).toBe('CGUV_REACCEPTANCE_REQUIRED');
    await flushReacceptanceSupervision();
    expect((await anomaly('other:legal-reacceptance:unavailable')).status).toBe('resolved');
  });

  /* ── P1-F : suppressions de production → copies en préproduction ──────── */

  const PREPROD_ENV = { NEXT_PUBLIC_APP_ENV: 'preprod', PRODUCTION_DELETION_SIGNAL_KEY: KEY, PRODUCTION_DELETION_SIGNAL_URL: PROD };
  const PROD_ENV = { NEXT_PUBLIC_APP_ENV: 'production', PRODUCTION_DELETION_SIGNAL_KEY: KEY };
  /** La production simulée : la vraie route de service, sur la même base (registre 102A). */
  const production = (env: Record<string, string> = PROD_ENV, tamper = false) => async (url: string, init?: RequestInit) => {
    const { serveDeletionSignals } = await import('@/services/admin/production-copies/deletion-propagation.service');
    const h = new Headers(init?.headers as HeadersInit);
    const r = await serveDeletionSignals({ method: 'GET', url, headers: h, env });
    return new Response(tamper ? r.body.replace('"entries":[', '"entries":[ ') : r.body, { status: r.status, headers: r.headers });
  };
  async function propagation(opts: { fetchImpl?: ReturnType<typeof production>; env?: Record<string, string>; deps?: never } = {}) {
    const { syncProductionDeletionSignals } = await import('@/services/admin/production-copies/deletion-propagation.service');
    return syncProductionDeletionSignals({ env: opts.env ?? PREPROD_ENV, fetchImpl: (opts.fetchImpl ?? production()) as never, deps: opts.deps, trigger: 'e2e' });
  }
  async function copie(accountIds: number[], snapshotAt: string) {
    const [c] = await sql<Json[]>`
      INSERT INTO production_data_copies (origin, source_environment, target_environment, backup_id, status, reason, responsible_email, authorized_at, imported_at, expires_at, account_ids, source_snapshot_at)
      VALUES ('restore_point', 'production', 'preprod', ${uid('pt')}, 'active', 'Copie e2e L104A', 'e2e@test.invalid', now(), now(), now() + interval '30 days', ${JSON.stringify(accountIds)}::jsonb, ${snapshotAt})
      RETURNING id`;
    return Number(c.id);
  }
  async function signals() {
    return import('@/services/admin/production-copies/deletion-signals');
  }
  /** Suppression RÉELLE en « production » par le moteur existant (registre 102A écrit par lui). */
  async function supprimerEnProduction(accountId: number, userId: number, reason: 'WITHDRAWAL' | 'VOLUNTARY') {
    process.env.PRODUCTION_DELETION_SIGNAL_KEY = KEY; // le moteur calcule les empreintes d'adresse
    if (reason === 'VOLUNTARY') await sql`UPDATE users SET status = 'PENDING_DELETION' WHERE id = ${userId}`;
    const { scheduleDeletion, executeScheduledDeletion } = await import('@/services/account/scheduled-deletion.service');
    const s = await scheduleDeletion({ accountId, userId, reason, origin: 'system', confirmedAt: new Date(), delayDays: 0 });
    const r = await executeScheduledDeletion(s.id, { now: new Date() });
    expect(r.status).toBe('executed');
  }

  it('L104A-E2E-F1 P1-F — politique prudente : import refusé tant que la propagation n’est pas configurée et vérifiée ; alerte tant qu’une copie est présente', async () => {
    process.env.NEXT_PUBLIC_APP_ENV = 'preprod';
    delete process.env.PRODUCTION_DELETION_SIGNAL_KEY;
    delete process.env.PRODUCTION_DELETION_SIGNAL_URL;
    const admin = await make.user({ role: 'ADMIN' });
    const svc = await import('@/services/admin/production-copies/production-copies.service');
    await expect(svc.authorizeRestoreImport({ backupId: '00000000-0000-4000-8000-000000000104', reason: 'Analyse incident L104A', admin, manifestEnvironment: 'production' }))
      .rejects.toMatchObject({ code: 'DELETION_PROPAGATION_NOT_READY' });
    const acc = await make.account();
    const id = await copie([acc.id], new Date(Date.now() - 3_600_000).toISOString());
    const r = await propagation({ env: { NEXT_PUBLIC_APP_ENV: 'preprod' } });
    expect(r.status).toBe('not_configured');
    expect(r.issues.map((i) => i.code)).toEqual(['NOT_CONFIGURED']);
    expect((await anomaly('other:production-copy:deletion-propagation')).status).toBe('open');
    expect(await svc.guardRestoreOrigin('production', 'pt-x')).toMatchObject({ allowed: false });
    await sql`UPDATE production_data_copies SET status = 'closed', closed_at = now(), close_reason = 'e2e' WHERE id = ${id}`;
  });

  it('L104A-E2E-F2 P1-F — route production : 404 hors production, 503 sans clé, 401 sans signature ; page signée, empreintes seulement', async () => {
    const { serveDeletionSignals } = await import('@/services/admin/production-copies/deletion-propagation.service');
    const { DELETION_SIGNAL_PATH, signRequest, DELETION_SIGNAL_HEADERS } = await signals();
    const url = `${PROD}${DELETION_SIGNAL_PATH}?limit=500`;
    const none = new Headers();
    expect((await serveDeletionSignals({ method: 'GET', url, headers: none, env: { NEXT_PUBLIC_APP_ENV: 'preprod', PRODUCTION_DELETION_SIGNAL_KEY: KEY } })).status).toBe(404);
    expect((await serveDeletionSignals({ method: 'GET', url, headers: none, env: { NEXT_PUBLIC_APP_ENV: 'production' } })).status).toBe(503);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await serveDeletionSignals({ method: 'GET', url, headers: none, env: PROD_ENV })).status).toBe(401);
    warn.mockRestore();
    // Une suppression réelle en production, puis lecture signée.
    const acc = await make.account();
    await sql`UPDATE users SET email = ${`${uid('prod')}@exemple.fr`} WHERE id = ${acc.ownerUserId}`;
    const [{ email }] = await sql<Json[]>`SELECT email FROM users WHERE id = ${acc.ownerUserId}`;
    await supprimerEnProduction(acc.id, acc.ownerUserId, 'WITHDRAWAL');
    const [reg] = await sql<Json[]>`SELECT signal_contacts FROM account_deletion_registry ORDER BY id DESC LIMIT 1`;
    expect(reg.signal_contacts).toHaveLength(1); // empreinte de l'adresse, jamais l'adresse
    const ts = String(Date.now());
    const h = new Headers({ [DELETION_SIGNAL_HEADERS.timestamp]: ts, [DELETION_SIGNAL_HEADERS.signature]: signRequest(KEY, 'GET', DELETION_SIGNAL_PATH, { limit: '500' }, ts) });
    const r = await serveDeletionSignals({ method: 'GET', url, headers: h, env: PROD_ENV });
    expect(r.status).toBe(200);
    expect(r.headers[DELETION_SIGNAL_HEADERS.signature]).toMatch(/^[0-9a-f]{64}$/);
    const page = JSON.parse(r.body);
    expect(page).toMatchObject({ schema: 'verebona-deletion-signals-v1', environment: 'production' });
    expect(page.entries.length).toBeGreaterThan(0);
    expect(r.body).not.toContain(email);
    expect(r.body).not.toContain('@');
    expect(r.body).not.toMatch(/userIds|accountIds|reason/);
    expect(r.body).not.toContain(KEY);
  });

  it('L104A-E2E-F3 P1-F — rétractation J+90 en production : le compte copié (identifiants locaux DIFFÉRENTS) est purgé par le moteur existant, objets S3 en file ; aucune double suppression', async () => {
    Object.assign(process.env, PREPROD_ENV);
    const { accountIdFingerprint, userIdFingerprint, emailFingerprint } = await signals();
    // Production : compte X.
    const x = await make.account();
    const [{ email: xEmail }] = await sql<Json[]>`SELECT email FROM users WHERE id = ${x.ownerUserId}`;
    // Préproduction : la copie a importé X sous des identifiants LOCAUX différents (Y) — correspondance enregistrée à l'import.
    const y = await make.account();
    const file = await make.assetFile(y);
    const z = await make.account(); // compte copié non supprimé en production
    const copyId = await copie([y.id, z.id], new Date(Date.now() - 86_400_000).toISOString());
    await sql`INSERT INTO production_copy_subjects (copy_id, subject_kind, target_id, id_fingerprints) VALUES
      (${copyId}, 'account', ${y.id}, ${[accountIdFingerprint(KEY, x.id)]}::text[]),
      (${copyId}, 'account', ${z.id}, ${[accountIdFingerprint(KEY, 999_999)]}::text[])`;
    await sql`INSERT INTO production_copy_subjects (copy_id, subject_kind, target_id, id_fingerprints, contact_fingerprints) VALUES
      (${copyId}, 'user', ${y.ownerUserId}, ${[userIdFingerprint(KEY, x.ownerUserId)]}::text[], ${[emailFingerprint(KEY, xEmail)!]}::text[])`;
    await sql`UPDATE production_data_copies SET subjects_captured_at = now() WHERE id = ${copyId}`;

    await supprimerEnProduction(x.id, x.ownerUserId, 'WITHDRAWAL');
    const blobsAvant = (await sql<Json[]>`SELECT count(*)::int AS n FROM pending_blob_deletions WHERE storage_path LIKE ${`e2e/${y.id}/%`}`)[0].n;

    const r = await propagation();
    expect(r.status).toBe('ok');
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(r.failed).toBe(0);
    expect((await sql`SELECT 1 FROM accounts WHERE id = ${y.id}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM users WHERE id = ${y.ownerUserId}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM accounts WHERE id = ${z.id}`).length).toBe(1);
    expect((await sql`SELECT 1 FROM asset_files WHERE id = ${file.id}`).length).toBe(0);
    const blobsApres = (await sql<Json[]>`SELECT count(*)::int AS n FROM pending_blob_deletions WHERE storage_path LIKE ${`e2e/${y.id}/%`}`)[0].n;
    expect(blobsApres).toBeGreaterThan(blobsAvant);
    const subjects = await sql<Json[]>`SELECT subject_kind, target_id, status, id_fingerprints, contact_fingerprints, matched_signal_ref FROM production_copy_subjects WHERE copy_id = ${copyId} ORDER BY id`;
    expect(subjects.find((s) => s.target_id === y.id)).toMatchObject({ status: 'purged', id_fingerprints: [], contact_fingerprints: [] });
    expect(subjects.find((s) => s.target_id === y.id)!.matched_signal_ref).toMatch(/^r\d+$/);
    expect(subjects.find((s) => s.target_id === z.id)).toMatchObject({ status: 'present' });
    // Trace locale : le registre de la préproduction permet de rejouer après une restauration.
    const reg = (await sql<Json[]>`SELECT count(*)::int AS n FROM account_deletion_registry WHERE ${y.id} = ANY(account_ids)`)[0].n;
    expect(reg).toBe(1);
    // Propagation vérifiée : l'import peut être autorisé.
    const { deletionPropagationReadiness } = await import('@/services/admin/production-copies/deletion-propagation.service');
    expect((await deletionPropagationReadiness({ env: PREPROD_ENV })).ready).toBe(true);
    // Rejouée : rien de plus.
    const again = await propagation();
    expect(again).toMatchObject({ purged: 0, repurged: 0, failed: 0 });
    expect((await sql<Json[]>`SELECT count(*)::int AS n FROM account_deletion_registry WHERE ${y.id} = ANY(account_ids)`)[0].n).toBe(1);
    expect((await anomaly('other:production-copy:deletion-propagation')).status).toBe('resolved');
  });

  it('L104A-E2E-F4 P1-F — suppression volontaire : utilisateur copié retrouvé par l’empreinte de son adresse ; une adresse réutilisée après la copie n’est pas confondue', async () => {
    const { emailFingerprint, userIdFingerprint } = await signals();
    const v = await make.account();
    const vEmail = `${uid('vol')}@exemple.fr`;
    await sql`UPDATE users SET email = ${vEmail} WHERE id = ${v.ownerUserId}`;
    // Copie A (avant la suppression) : utilisateur copié W, identifiant source inconnu ici, adresse identique.
    const w = await make.account();
    const before = await copie([w.id], new Date(Date.now() - 86_400_000).toISOString());
    await sql`INSERT INTO production_copy_subjects (copy_id, subject_kind, target_id, id_fingerprints, contact_fingerprints)
              VALUES (${before}, 'user', ${w.ownerUserId}, ${[userIdFingerprint(KEY, 888_888)]}::text[], ${[emailFingerprint(KEY, vEmail)!]}::text[])`;
    await supprimerEnProduction(v.id, v.ownerUserId, 'VOLUNTARY');
    // Copie B (APRÈS la suppression) : même adresse, réinscrite depuis → ne doit pas être purgée.
    const n = await make.account();
    const after = await copie([n.id], new Date(Date.now() + 60_000).toISOString());
    await sql`INSERT INTO production_copy_subjects (copy_id, subject_kind, target_id, id_fingerprints, contact_fingerprints)
              VALUES (${after}, 'user', ${n.ownerUserId}, ${[userIdFingerprint(KEY, 777_777)]}::text[], ${[emailFingerprint(KEY, vEmail)!]}::text[])`;
    const r = await propagation();
    expect(r.failed).toBe(0);
    expect((await sql`SELECT 1 FROM users WHERE id = ${w.ownerUserId}`).length).toBe(0);
    expect((await sql`SELECT 1 FROM users WHERE id = ${n.ownerUserId}`).length).toBe(1);
  });

  it('L104A-E2E-F5 P1-F — échec puis reprise ; compte réapparu après restauration purgé de nouveau ; clés différentes ou réponse altérée refusées ; réimport idempotent', async () => {
    const { accountIdFingerprint } = await signals();
    const x = await make.account();
    const rAcc = await make.account();
    const copyId = await copie([rAcc.id], new Date(Date.now() - 86_400_000).toISOString());
    await sql`INSERT INTO production_copy_subjects (copy_id, subject_kind, target_id, id_fingerprints) VALUES (${copyId}, 'account', ${rAcc.id}, ${[accountIdFingerprint(KEY, x.id)]}::text[])`;
    await supprimerEnProduction(x.id, x.ownerUserId, 'WITHDRAWAL');

    // Panne du moteur au premier passage : échec tracé, anomalie ouverte.
    const fail = await propagation({ deps: { purge: async () => ({ failed: 'PANNE_SIMULEE' }) } as never });
    expect(fail.failed).toBe(1);
    expect(fail.issues.map((i) => i.code)).toContain('PURGE_FAILED');
    expect((await anomaly('other:production-copy:deletion-propagation')).status).toBe('open');
    const [st] = await sql<Json[]>`SELECT status, attempts, last_error FROM production_copy_subjects WHERE target_id = ${rAcc.id} AND copy_id = ${copyId}`;
    expect(st).toMatchObject({ status: 'failed', attempts: 1, last_error: 'PANNE_SIMULEE' });
    // Reprise : purgé, anomalie résolue.
    const ok = await propagation();
    expect(ok.failed).toBe(0);
    expect((await sql`SELECT 1 FROM accounts WHERE id = ${rAcc.id}`).length).toBe(0);
    expect((await anomaly('other:production-copy:deletion-propagation')).status).toBe('resolved');

    // Restauration d'une sauvegarde antérieure de la préproduction : un compte purgé « réapparaît ».
    const back = await make.account();
    await sql`INSERT INTO production_copy_subjects (copy_id, subject_kind, target_id, status, purged_at) VALUES (${copyId}, 'account', ${back.id}, 'purged', now() - interval '1 day')`;
    const re = await propagation();
    expect(re.repurged).toBe(1);
    expect((await sql`SELECT 1 FROM accounts WHERE id = ${back.id}`).length).toBe(0);

    // Clés différentes : 401, aucune purge, propagation plus « vérifiée ».
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = await propagation({ env: { ...PREPROD_ENV, PRODUCTION_DELETION_SIGNAL_KEY: 'une-autre-cle-de-32-caracteres-au-moins' } });
    warn.mockRestore();
    expect(bad).toMatchObject({ status: 'unavailable', error: 'HTTP 401 SIGNATURE_REFUSED' });
    const { deletionPropagationReadiness } = await import('@/services/admin/production-copies/deletion-propagation.service');
    expect(await deletionPropagationReadiness({ env: PREPROD_ENV })).toMatchObject({ ready: false, code: 'FAILING' });
    // Réponse altérée en chemin : refusée.
    const tampered = await propagation({ fetchImpl: production(PROD_ENV, true) });
    expect(tampered).toMatchObject({ status: 'invalid' });
    expect(tampered.error).toMatch(/non authentifiée/);

    // Réimport (rafraîchissement) : inventaire idempotent.
    const { captureCopySubjects } = await import('@/services/admin/production-copies/deletion-propagation.service');
    const k = await make.account();
    const c2 = await copie([k.id], new Date().toISOString());
    expect(await captureCopySubjects(c2, { env: PREPROD_ENV })).toBe(2); // le compte et son titulaire
    expect(await captureCopySubjects(c2, { env: PREPROD_ENV })).toBe(0);
    await propagation();
  });
});
