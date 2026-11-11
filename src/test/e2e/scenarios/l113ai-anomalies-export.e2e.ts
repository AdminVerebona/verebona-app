/**
 * Lot 113AI (Trello #733) — anomalies du BO copiables / exportables pour une
 * analyse externe, sur PostgreSQL 16 réel, par les VRAIES routes (garde
 * administrateur réelle : seule la lecture du cookie de session est simulée).
 *
 *   L113AI-E2E-01  export JSON : liste filtrée COMPLÈTE au-delà d'une page, même ordre que
 *                  l'écran (toutes pages concaténées), schéma versionné, en-têtes, nom daté
 *   L113AI-E2E-02  export CSV : une ligne par anomalie, BOM, séparateur, nom daté ; filtre
 *                  « résolues » et tri « compte » respectés
 *   L113AI-E2E-03  flux par curseur : plusieurs lots (mémoire bornée), connexion rendue
 *   L113AI-E2E-04  « Copier la page » : exactement les lignes de la page affichée
 *   L113AI-E2E-05  « Copier » une anomalie : champs utiles, occurrences, JSON unitaire
 *   L113AI-E2E-06  droits : non-admin 403 (même réponse que l'anomalie existe ou non),
 *                  session expirée 401, paramètres inconnus 400, anomalie inconnue 404
 *   L113AI-E2E-07  aucune donnée personnelle ni secret dans aucune sortie
 *   L113AI-E2E-08  journal d'audit ANOMALY_EXPORT : qui, quand, filtres, nombre, issue
 */
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scenario } from '../scenario';

type Json = Record<string, any>;

scenario('L113AI', 'BO — anomalies de Supervision copiables / exportables (#733)', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '', expired: false };
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  let listExport: Route;
  let oneExport: Route;
  const req = (url: string) => new NextRequest(`http://app.test${url}`, { headers: { origin: 'http://app.test', host: 'app.test' } });
  const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) });
  const as = (u: { id: number; email: string }, role: string) => { session.userId = u.id; session.role = role; session.email = u.email; session.expired = false; };
  const jour = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  const TAG = `l113ai-${randomUUID().slice(0, 8)}`;
  const ACCOUNT_NAME = `Famille Témoin ${TAG}`;
  const OWNER_EMAIL = `titulaire.${TAG}@exemple-perso.fr`;
  const SECRET = `sk_live_${randomUUID().replace(/-/g, '')}`;
  const DOC_TEXT = `Bail signé par Madame Témoin ${TAG}`;
  const N_OPEN = 60;
  const N_RESOLVED = 30;
  let admin: { id: number; email: string };
  let user: { id: number; email: string };
  let accountId = 0;
  let ownerId = 0;
  let detailId = 0;
  let debut = '';
  let base = '';

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    base = (await import('@/lib/app-url')).getAppBaseUrl(req('/admin'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => {
      if (session.expired) throw new Error('INVALID_TOKEN');
      return { userId: session.userId, role: session.role, email: session.email } as never;
    });
    listExport = (await import('@/app/api/admin/anomalies/export/route')).GET as Route;
    oneExport = (await import('@/app/api/admin/anomalies/[id]/export/route')).GET as Route;
    const a = await make.user({ role: 'ADMIN' });
    const u = await make.user();
    admin = { id: a.id, email: a.email };
    user = { id: u.id, email: u.email };
    const owner = await make.user({ email: OWNER_EMAIL });
    ownerId = owner.id;
    const acc = await make.account({ owner, name: ACCOUNT_NAME });
    accountId = acc.id;

    // Anomalies réelles (signalement applicatif) : consolidation + historique des occurrences.
    const { reportAnomaly, buildFingerprint } = await import('@/services/admin/anomaly.service');
    const fp = buildFingerprint('other', 'coherence', TAG, 'detail');
    for (let i = 0; i < 3; i++) {
      detailId = (await reportAnomaly({
        domain: 'other', fingerprint: fp, title: `Cohérence COH-DOC-TARGETS ${TAG}`, accountId, userId: ownerId,
        detail: { checkId: 'COH-DOC-TARGETS', sqlstate: '23505', step: 'repair', attempt: i, error: `refus pour ${OWNER_EMAIL} (${SECRET})`, full_text: DOC_TEXT, accountName: ACCOUNT_NAME },
      }))!;
    }
    // Volume au-delà d'une page (25) : ouvertes et résolues, dates et comptes variés.
    for (let i = 0; i < N_OPEN - 1; i++) {
      await sql`INSERT INTO admin_anomalies (domain, fingerprint, title, status, account_id, user_id, technical_detail, occurrence_count, first_seen_at, last_seen_at)
        VALUES (${['ai', 'stripe', 'exports', 'communications'][i % 4]}, ${`${TAG}:open:${i}`}, ${`Anomalie ouverte ${i} ${TAG}`}, 'open',
                ${i % 3 === 0 ? accountId : null}, ${i % 5 === 0 ? ownerId : null},
                ${JSON.stringify({ code: `E${i}`, email: OWNER_EMAIL, excerpt: DOC_TEXT })}::jsonb, ${1 + (i % 4)},
                now() - make_interval(hours => ${200 + i}), now() - make_interval(mins => ${i * 7}))`;
    }
    for (let i = 0; i < N_RESOLVED; i++) {
      await sql`INSERT INTO admin_anomalies (domain, fingerprint, title, status, account_id, technical_detail, first_seen_at, last_seen_at, resolved_at, resolution_source, cause, corrective_action, internal_comment)
        VALUES ('backups', ${`${TAG}:resolved:${i}`}, ${`Anomalie résolue ${i} ${TAG}`}, 'resolved', ${i % 2 === 0 ? accountId : null},
                ${JSON.stringify({ code: `R${i}` })}::jsonb, now() - interval '30 days', now() - interval '20 days', now() - make_interval(hours => ${i}), 'manual',
                ${`cause signalée par ${OWNER_EMAIL}`}, 'relance', ${`commentaire interne ${TAG}`})`;
    }
    [{ t: debut }] = await sql<{ t: string }[]>`SELECT now()::text AS t`;
  });

  afterAll(() => { vi.restoreAllMocks(); });

  /** Ordre de l'écran : toutes les pages de la liste concaténées. */
  async function screenIds(status: 'open' | 'resolved', sort: string, dir: string): Promise<number[]> {
    const { listAnomalies } = await import('@/services/admin/anomaly.service');
    const ids: number[] = [];
    for (let page = 1; ; page++) {
      const l = await listAnomalies({ status, sort, dir, page });
      ids.push(...l.items.map((i) => i.id));
      if (page * l.pageSize >= l.total) break;
    }
    return ids;
  }

  const outputs: string[] = [];

  it('L113AI-E2E-01 — export JSON : liste complète (au-delà d’une page), ordre de l’écran, schéma versionné', async () => {
    as(admin, 'ADMIN');
    const r = await listExport(req('/api/admin/anomalies/export?status=open&sort=date&dir=desc&format=json'));
    expect(r.status, await r.clone().text()).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const name = `verebona-anomalies-ouvertes-${jour()}.json`;
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
    const text = await r.text();
    outputs.push(text);
    const doc = JSON.parse(text) as Json;
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_anomalies WHERE status = 'open'`;
    expect(n).toBeGreaterThanOrEqual(N_OPEN);
    expect(doc).toMatchObject({ format: 'verebona.bo-anomalies/1', schemaVersion: 1, total: n, exported: n, complete: true, timeZone: 'Europe/Paris' });
    expect(doc.filters).toEqual({ status: 'open', sort: 'date', dir: 'desc' });
    expect(Number(r.headers.get('x-anomalies-total'))).toBe(n);
    expect(doc.items.map((i: Json) => i.id)).toEqual(await screenIds('open', 'date', 'desc'));
    const one = doc.items.find((i: Json) => i.id === detailId);
    expect(one).toMatchObject({ code: 'COH-DOC-TARGETS', statut: 'ouverte', occurrences: 3, compte: { id: accountId }, utilisateur: { id: ownerId } });
    expect(one.contexteTechnique).toMatchObject({ sqlstate: '23505', etape: 'repair' });
    expect(one.premiereOccurrence.iso).toMatch(/Z$/);
    expect(one.premiereOccurrence.paris).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
    expect(one.lienBo).toBe(`${base}/admin/supervision/${detailId}`);
  });

  it('L113AI-E2E-02 — export CSV complet ; filtre « résolues » et tri « compte » respectés', async () => {
    as(admin, 'ADMIN');
    const r = await listExport(req('/api/admin/anomalies/export?status=resolved&sort=account&dir=asc&format=csv'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toContain(`filename="verebona-anomalies-resolues-${jour()}.csv"`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8').decode(bytes);
    outputs.push(text);
    const lines = text.split('\r\n').filter(Boolean);
    expect(lines[0].split(';').slice(0, 3)).toEqual(['id', 'code', 'gravite']);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_anomalies WHERE status = 'resolved'`;
    expect(n).toBeGreaterThanOrEqual(N_RESOLVED);
    expect(lines).toHaveLength(n + 1);
    expect(lines.slice(1).map((l) => Number(l.split(';')[0]))).toEqual(await screenIds('resolved', 'account', 'asc'));
    expect(text).toContain(';resolue;');
    expect(text).not.toContain(';ouverte;');
  });

  it('L113AI-E2E-03 — flux par curseur : plusieurs lots, connexion rendue', async () => {
    const { openAnomalyExportStream } = await import('@/services/admin/anomalies-export/service');
    const batches: number[] = [];
    let outcome: Json | null = null;
    const s = await openAnomalyExportStream({ status: 'open', sort: 'domain', dir: 'asc', format: 'json', page: 1 },
      { baseUrl: base, batchSize: 7, onBatch: (k) => batches.push(k), onDone: (o) => { outcome = o; } });
    const doc = JSON.parse(await new Response(s.body).text());
    expect(batches.length).toBeGreaterThan(Math.ceil(N_OPEN / 7));
    expect(Math.max(...batches)).toBe(7);
    expect(doc.items.map((i: Json) => i.id)).toEqual(await screenIds('open', 'domain', 'asc'));
    expect(outcome).toMatchObject({ complete: true, error: null });
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND query ILIKE '%vb_anomaly_export%'`;
    expect(n).toBe(0);
  });

  it('L113AI-E2E-04 — « Copier la page » : exactement la page affichée, en Markdown', async () => {
    as(admin, 'ADMIN');
    const r = await listExport(req('/api/admin/anomalies/export?status=open&sort=date&dir=desc&format=md&page=2'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBeNull();
    const md = await r.text();
    outputs.push(md);
    const { listAnomalies } = await import('@/services/admin/anomaly.service');
    const page2 = await listAnomalies({ status: 'open', sort: 'date', dir: 'desc', page: 2 });
    const rows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l)).map((l) => Number(l.split('|')[1]));
    expect(rows).toEqual(page2.items.map((i) => i.id));
    expect(md).toContain('# Anomalies du BO Verebona — anomalies ouvertes');
    expect(md).toContain(`Page 2 / ${Math.ceil(page2.total / page2.pageSize)}`);
  });

  it('L113AI-E2E-05 — « Copier » une anomalie : champs utiles et occurrences ; JSON unitaire', async () => {
    as(admin, 'ADMIN');
    const r = await oneExport(req(`/api/admin/anomalies/${detailId}/export?format=md`), ctx(detailId));
    expect(r.status).toBe(200);
    const md = await r.text();
    outputs.push(md);
    for (const t of [`## Anomalie #${detailId}`, '- Code : COH-DOC-TARGETS', '- Gravité : non définie', '- Statut : ouverte',
      `- Compte : #${accountId} (${base}/admin/accounts/${accountId})`, `- Utilisateur : #${ownerId}`, '- Occurrences : 3',
      '- SQLSTATE : 23505', '- Étape : repair', `- Lien BO : ${base}/admin/supervision/${detailId}`, '### Historique des occurrences (3 plus récente(s) sur 3)']) {
      expect(md).toContain(t);
    }
    const j = await oneExport(req(`/api/admin/anomalies/${detailId}/export?format=json&download=1`), ctx(detailId));
    expect(j.status).toBe(200);
    expect(j.headers.get('content-disposition')).toContain(`filename="verebona-anomalie-${detailId}-${jour()}.json"`);
    const text = await j.text();
    outputs.push(text);
    const doc = JSON.parse(text);
    expect(doc).toMatchObject({ format: 'verebona.bo-anomalies/1', total: 1, exported: 1, complete: true });
    expect(doc.items[0].historique).toHaveLength(3);
  });

  it('L113AI-E2E-06 — droits, anti-énumération, paramètres', async () => {
    as(user, 'USER');
    const r1 = await listExport(req('/api/admin/anomalies/export?format=json'));
    expect(r1.status).toBe(403);
    expect(r1.headers.get('content-disposition')).toBeNull();
    const existante = await oneExport(req(`/api/admin/anomalies/${detailId}/export`), ctx(detailId));
    const inconnue = await oneExport(req('/api/admin/anomalies/999999999/export'), ctx(999999999));
    expect(existante.status).toBe(403);
    expect(inconnue.status).toBe(403);
    const neutre = (t: string) => { const j = JSON.parse(t); delete j.requestId; delete j.timestamp; return j; };
    expect(neutre(await existante.text())).toEqual(neutre(await inconnue.text()));

    session.expired = true;
    const r401 = await listExport(req('/api/admin/anomalies/export?format=csv'));
    expect(r401.status).toBe(401);
    expect(r401.headers.get('content-disposition')).toBeNull();

    as(admin, 'ADMIN');
    for (const q of ['status=all', 'sort=email', 'format=xlsx', 'dir=up', 'format=md&page=0']) {
      const r = await listExport(req(`/api/admin/anomalies/export?${q}`));
      expect(r.status, q).toBe(400);
    }
    expect((await oneExport(req('/api/admin/anomalies/999999999/export'), ctx(999999999))).status).toBe(404);
    expect((await oneExport(req('/api/admin/anomalies/abc/export'), ctx('abc'))).status).toBe(400);
  });

  it('L113AI-E2E-07 — aucune donnée personnelle, aucun secret, aucun contenu de document', async () => {
    expect(outputs.length).toBeGreaterThanOrEqual(5);
    const { leaksSecretOrEmail } = await import('@/services/admin/diagnostics-export/model');
    for (const o of outputs) {
      expect(o).not.toContain(OWNER_EMAIL);
      expect(o).not.toContain(admin.email);
      expect(o).not.toContain(ACCOUNT_NAME);
      expect(o).not.toContain(SECRET);
      expect(o).not.toContain(DOC_TEXT);
      expect(o).not.toContain(`commentaire interne ${TAG}`);
      expect(leaksSecretOrEmail(o)).toBe(false);
    }
  });

  it('L113AI-E2E-08 — journal d’audit : qui, quand, filtres, nombre, issue', async () => {
    const rows = await sql<{ admin_user_id: number; result: string; target_id: number | null; details: string; timestamp: Date }[]>`
      SELECT admin_user_id, result, target_id, details, "timestamp" FROM admin_audit_log
       WHERE "timestamp" >= ${debut}::timestamptz AND action_type = 'ANOMALY_EXPORT' ORDER BY id`;
    const d = rows.map((r) => ({ ...r, x: JSON.parse(r.details) as Json }));
    const [{ open }] = await sql<{ open: number }[]>`SELECT count(*)::int AS open FROM admin_anomalies WHERE status = 'open'`;
    const [{ resolved }] = await sql<{ resolved: number }[]>`SELECT count(*)::int AS resolved FROM admin_anomalies WHERE status = 'resolved'`;
    expect(d.some((r) => r.admin_user_id === admin.id && r.result === 'SUCCESS' && r.x.format === 'json' && r.x.scope === 'liste'
      && r.x.filters.status === 'open' && r.x.filters.sort === 'date' && r.x.count === open && r.x.total === open && r.x.complete === true)).toBe(true);
    expect(d.some((r) => r.result === 'SUCCESS' && r.x.format === 'csv' && r.x.filters.status === 'resolved' && r.x.filters.sort === 'account' && r.x.count === resolved)).toBe(true);
    expect(d.some((r) => r.result === 'SUCCESS' && r.x.format === 'md' && r.x.scope === 'page' && r.x.page === 2 && r.x.count === 25)).toBe(true);
    expect(d.some((r) => r.result === 'SUCCESS' && r.x.scope === 'anomalie' && r.target_id === detailId)).toBe(true);
    expect(d.some((r) => r.result === 'FAILURE' && r.x.code === 'INVALID_STATUS')).toBe(true);
    expect(d.some((r) => r.result === 'FAILURE' && r.x.code === 'NOT_FOUND' && r.target_id === 999999999)).toBe(true);
    // Aucun refus de garde (non-admin) n'écrit au nom de l'utilisateur : pas de ligne pour lui.
    expect(d.some((r) => r.admin_user_id === user.id)).toBe(false);
    expect(JSON.stringify(d.map((r) => r.x))).not.toContain(OWNER_EMAIL);
  });
});
