#!/usr/bin/env node
/**
 * #851 — Mesure de performance d'affichage (production locale, sans réseau).
 *
 * Prérequis (voir docs/exploitation/audit-performance-851.md § Reproduire) :
 *   1. base JETABLE peuplée par `scripts/perf-audit-851-seed.ts` sur un serveur
 *      PostgreSQL local chargé avec `pg_stat_statements` ;
 *   2. `next build` puis `next start` pointé sur cette base (traitements de fond
 *      confiés à un autre processus : BACKGROUND_JOBS_PROCESS=worker,
 *      DIAG_JOB_PROCESS=diagworker — sinon leurs requêtes se mêlent aux mesures).
 *
 *   PERF_BASE_URL=http://localhost:3851 \
 *   PERF_DB_URL=postgres://postgres:postgres@127.0.0.1:5433/verebona_perf851 \
 *   CHROME_PATH=/usr/bin/google-chrome \
 *     node scripts/perf-audit-851.mjs [--repetitions 5] [--sortie /tmp/perf-851.json] [--sans-navigateur]
 *
 * Pour chaque API : temps jusqu'au premier octet (médiane et max de N appels,
 * en-tête `x-verebona-fresh: 1` pour contourner le cache serveur de 30 s),
 * taille de la réponse, nombre de requêtes SQL et temps SQL d'UN appel
 * (`pg_stat_statements` remis à zéro juste avant), requête SQL la plus chère.
 * Pour chaque page (navigateur Chrome sans interface, playwright-core) : appels
 * /api/* émis au chargement, durée jusqu'au repos du réseau, octets JS/JSON
 * transférés, appels répétés dans les 20 s suivantes (scrutation).
 *
 * Aucune écriture applicative : uniquement des GET (et la connexion).
 */
import postgres from 'postgres';
import { writeFileSync } from 'node:fs';

const BASE = process.env.PERF_BASE_URL ?? 'http://localhost:3851';
const DB_URL = process.env.PERF_DB_URL ?? 'postgres://postgres:postgres@127.0.0.1:5433/verebona_perf851';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
const EMAIL = process.env.PERF_EMAIL ?? 'perf851@test.invalid';
const ADMIN_EMAIL = process.env.PERF_ADMIN_EMAIL ?? 'perf851-admin@test.invalid';
const PASSWORD = process.env.PERF_PASSWORD ?? 'Perf851-audit!';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const REPS = Number(opt('repetitions', '5'));
const SORTIE = opt('sortie', '/tmp/perf-851.json');
const SANS_NAVIGATEUR = argv.includes('--sans-navigateur');
const FILTRE = opt('filtre', '');

const host = new URL(DB_URL).hostname;
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
  console.error('[perf-851] base non locale refusée'); process.exit(2);
}
const sql = postgres(DB_URL, { max: 1, onnotice: () => undefined });

async function connexion(email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!r.ok) throw new Error(`connexion ${email} : HTTP ${r.status} ${await r.text()}`);
  const cookies = r.headers.getSetCookie().map((c) => c.split(';')[0]);
  return cookies.join('; ');
}

async function appel(cookie, url) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}${url}`, { headers: { cookie, 'x-verebona-fresh': '1', accept: 'application/json' } });
  const reader = r.body.getReader();
  let premier = null; let octets = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (premier === null) premier = performance.now() - t0;
    if (done) break;
    octets += value.byteLength;
  }
  return { status: r.status, ttfbMs: premier, totalMs: performance.now() - t0, octets };
}

async function sqlDe(cookie, url) {
  await sql`SELECT pg_stat_statements_reset()`;
  const r = await appel(cookie, url);
  // Laisse les écritures sans attente (journaux, traces) se terminer.
  await new Promise((res) => setTimeout(res, 150));
  // `toplevel` : requêtes envoyées par l'application seulement (pas celles
  // exécutées à l'intérieur des fonctions PL/pgSQL et déclencheurs).
  const lignes = await sql`
    SELECT calls::int AS calls, total_exec_time AS ms, rows::int AS rows, query
      FROM pg_stat_statements
     WHERE toplevel AND query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE 'SELECT 1%'
     ORDER BY total_exec_time DESC`;
  const requetes = lignes.reduce((s, l) => s + l.calls, 0);
  const tempsSql = lignes.reduce((s, l) => s + l.ms, 0);
  const top = lignes[0] ? { ms: Math.round(lignes[0].ms * 10) / 10, calls: lignes[0].calls, rows: lignes[0].rows,
    sql: lignes[0].query.replace(/\s+/g, ' ').slice(0, 240) } : null;
  const repetees = lignes.filter((l) => l.calls >= 10).map((l) => ({ calls: l.calls, sql: l.query.replace(/\s+/g, ' ').slice(0, 160) }));
  return { ...r, requetes, distinctes: lignes.length, tempsSqlMs: Math.round(tempsSql * 10) / 10, top, repetees };
}

const mediane = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function mesurerApi(cookie, url) {
  await appel(cookie, url); // chauffe : chargement du module de la route
  const runs = [];
  for (let i = 0; i < REPS; i += 1) runs.push(await appel(cookie, url));
  const s = await sqlDe(cookie, url);
  return {
    url, status: s.status, octets: s.octets,
    ttfbMedMs: Math.round(mediane(runs.map((r) => r.ttfbMs))), ttfbMaxMs: Math.round(Math.max(...runs.map((r) => r.ttfbMs))),
    totalMedMs: Math.round(mediane(runs.map((r) => r.totalMs))),
    requetesSql: s.requetes, requetesDistinctes: s.distinctes, tempsSqlMs: s.tempsSqlMs, top: s.top, repetees: s.repetees,
  };
}

async function contexte() {
  const [u] = await sql`SELECT u.id AS "userId", m.account_id AS "accountId" FROM users u
    JOIN account_memberships m ON m.user_id = u.id AND m.role = 'owner' WHERE u.email = ${EMAIL}`;
  const [gros] = await sql`
    SELECT a.id, count(f.id)::int AS n FROM assets a LEFT JOIN asset_files f ON f.asset_id = a.id
     WHERE a.account_id = ${u.accountId} AND a.category = 'IMMOBILIER' GROUP BY a.id ORDER BY n DESC, a.id LIMIT 1`;
  const [veh] = await sql`SELECT id FROM assets WHERE account_id = ${u.accountId} AND category = 'VEHICULE' ORDER BY id LIMIT 1`;
  const [doc] = await sql`SELECT id FROM asset_files WHERE account_id = ${u.accountId} AND asset_id = ${gros.id} ORDER BY id DESC LIMIT 1`;
  const [eq] = await sql`SELECT id FROM equipments WHERE asset_id = ${gros.id} ORDER BY id LIMIT 1`;
  const [sup] = await sql`SELECT id FROM suppliers WHERE account_id = ${u.accountId} ORDER BY id LIMIT 1`;
  const [op] = await sql`SELECT id FROM business_operations WHERE account_id = ${u.accountId} ORDER BY id LIMIT 1`;
  return { ...u, assetId: gros.id, assetDocs: gros.n, vehiculeId: veh.id, docId: doc.id, equipmentId: eq.id, supplierId: sup.id, operationId: op.id };
}

function apisUtilisateur(c) {
  const a = c.assetId;
  return [
    '/api/users/me', '/api/billing/me', '/api/home/summary', '/api/to-process', '/api/v2/to-process', '/api/v2/to-process?count=1',
    '/api/assets?limit=100', '/api/assets?limit=100&includeArchived=true', `/api/assets?id=${a}`, `/api/assets/${a}/overview`,
    `/api/assets/${a}/equipments`, `/api/assets/${a}/substructures`, `/api/assets/${a}/tco`, `/api/assets/${a}/valuations`,
    `/api/assets/${a}/exports?limit=3`, `/api/assets/${a}/transmission`,
    `/api/files?assetId=${a}&uploadStatus=COMPLETED&limit=500`,
    '/api/agenda', `/api/agenda?assetId=${a}`, '/api/agenda?view=list',
    '/api/v2/documents', `/api/v2/documents?assetId=${a}`, '/api/v2/documents?count=1&q=document',
    `/api/files/${c.docId}`, `/api/documents/${c.docId}/targets`, `/api/documents/${c.docId}/agenda-liens`,
    '/api/suppliers', `/api/suppliers/${c.supplierId}`, '/api/search?q=document', `/api/equipments/${c.equipmentId}/agenda`,
    '/api/agenda?period=all', '/api/suggestions', '/api/home/mascot', '/api/analysis/queue-status', '/api/notifications?limit=20',
    '/api/verebona/conversations', '/api/billing/trial-status', `/api/documents/${c.docId}/evenements-reference`,
    `/api/agenda?fileId=${c.docId}&period=all`, '/api/v2/to-process?order=priority',
    '/api/v2/documents?sort=added&direction=desc&grouped=1&limit=50',
  ];
}

function pagesUtilisateur(c) {
  return ['/accueil', '/assets', `/assets/${c.assetId}`, `/assets/${c.assetId}?tab=documents`, `/assets/${c.assetId}?tab=agenda`,
    `/assets/${c.assetId}?tab=operations`, `/assets/${c.assetId}?tab=tco`, '/agenda', '/accueil/a-traiter', '/documents',
    `/documents/${c.docId}`, '/fournisseurs'];
}
const PAGES_ADMIN = ['/admin', '/admin/accounts', '/admin/users', '/admin/operations', '/admin/supervision', '/admin/exploitation', '/admin/ai-queue'];

async function mesurerPages(cookie, pages) {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox'] });
  const out = [];
  try {
    // `x-verebona-fresh: 1` : chaque page est mesurée cache serveur contourné
    // (pire cas : première visite, ou juste après une modification).
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { 'x-verebona-fresh': '1' } });
    const u = new URL(BASE);
    await ctx.addCookies(cookie.split('; ').map((kv) => { const [name, ...v] = kv.split('='); return { name, value: v.join('='), domain: u.hostname, path: '/' }; }));
    for (const path of pages) {
      const page = await ctx.newPage();
      const reqs = new Map();
      let jsOctets = 0; let jsonOctets = 0;
      page.on('request', (r) => { reqs.set(r, { url: r.url(), t0: performance.now() }); });
      page.on('requestfinished', async (r) => {
        const e = reqs.get(r); if (!e) return;
        e.ms = performance.now() - e.t0;
        try { const rep = await r.response(); e.octets = rep ? (await rep.body()).byteLength : 0; } catch { e.octets = 0; }
        if (/\.js(\?|$)/.test(e.url)) jsOctets += e.octets;
        if (e.url.includes('/api/')) jsonOctets += e.octets;
      });
      const t0 = performance.now();
      let erreur = null;
      try { await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60_000 }); } catch (e) { erreur = String(e.message).slice(0, 120); }
      const reposMs = Math.round(performance.now() - t0);
      const api = [...reqs.values()].filter((e) => e.url.includes('/api/'));
      const lot = api.map((e) => ({ url: e.url.replace(BASE, ''), ms: Math.round(e.ms ?? -1), octets: e.octets ?? 0, debutMs: Math.round(e.t0 - t0) }));
      const avant = api.length;
      await page.waitForTimeout(20_000);
      const apres = [...reqs.values()].filter((e) => e.url.includes('/api/')).slice(avant).map((e) => e.url.replace(BASE, ''));
      const debuts = lot.map((x) => x.debutMs);
      out.push({ page: path, reposMs, erreur, appelsApi: lot.length, premierApiMs: Math.min(...debuts), dernierApiMs: Math.max(...debuts), jsKo: Math.round(jsOctets / 1024), jsonKo: Math.round(jsonOctets / 1024),
        plusLent: lot.sort((x, y) => y.ms - x.ms).slice(0, 4), scrutation20s: apres });
      console.log(`[page] ${path} repos=${reposMs} ms api=${lot.length} (départs ${Math.min(...debuts)}→${Math.max(...debuts)} ms) lent=${lot[0]?.url ?? '—'}:${lot[0]?.ms ?? 0}ms json=${Math.round(jsonOctets / 1024)} Ko js=${Math.round(jsOctets / 1024)} Ko +20s:${apres.length}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return out;
}

function apisAdmin(c) {
  return ['/api/admin/accounts', `/api/admin/accounts/${c.accountId}`, '/api/admin/users', `/api/admin/users/${c.userId}`,
    '/api/admin/operations', '/api/admin/anomalies', '/api/admin/dashboard', '/api/admin/ops/health'];
}

async function main() {
  const c = await contexte();
  console.log('[perf-851] contexte', JSON.stringify(c));
  const cookie = await connexion(EMAIL);
  const resultats = { date: new Date().toISOString(), contexte: c, repetitions: REPS, apis: [], pages: [], apisAdmin: [], pagesAdmin: [] };
  for (const url of apisUtilisateur(c).filter((u) => u.includes(FILTRE))) {
    const m = await mesurerApi(cookie, url);
    resultats.apis.push(m);
    console.log(`[api] ${url} ${m.status} ttfb=${m.ttfbMedMs}/${m.ttfbMaxMs} ms ${Math.round(m.octets / 1024)} Ko sql=${m.requetesSql} (${m.tempsSqlMs} ms) top=${m.top?.ms ?? 0} ms`);
  }
  const admin = await connexion(ADMIN_EMAIL).catch((e) => { console.warn('[perf-851] admin :', e.message); return null; });
  if (admin) {
    for (const url of apisAdmin(c).filter((u) => u.includes(FILTRE))) {
      const m = await mesurerApi(admin, url);
      resultats.apisAdmin.push(m);
      console.log(`[api-bo] ${url} ${m.status} ttfb=${m.ttfbMedMs}/${m.ttfbMaxMs} ms ${Math.round(m.octets / 1024)} Ko sql=${m.requetesSql} (${m.tempsSqlMs} ms)`);
    }
  }
  if (!SANS_NAVIGATEUR) {
    resultats.pages = await mesurerPages(cookie, pagesUtilisateur(c).filter((u) => u.includes(FILTRE)));
    if (admin) resultats.pagesAdmin = await mesurerPages(admin, PAGES_ADMIN.filter((u) => u.includes(FILTRE)));
  }
  writeFileSync(SORTIE, JSON.stringify(resultats, null, 2));
  console.log(`[perf-851] résultats : ${SORTIE}`);
}

main().then(() => sql.end({ timeout: 5 })).then(() => process.exit(0))
  .catch(async (e) => { console.error(e); await sql.end({ timeout: 5 }).catch(() => undefined); process.exit(1); });
