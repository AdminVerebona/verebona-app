/**
 * Lot 107G — Diagnostics BO DURABLES (ticket P0/P1 « réparer les échecs et
 * garantir un ZIP global exhaustif »), sur PostgreSQL 16 réel, par les VRAIES
 * routes BO (garde `requireAdmin` réelle : seule la lecture du cookie de
 * session est simulée) et le VRAI worker (`drainDiagnosticJobs`) ; stockage
 * OVH S3 SIMULÉ en mémoire (envois en plusieurs parties, lecture en flux,
 * pannes injectables).
 *
 *   · E01 demande : 202 immédiat, AUCUNE génération dans la requête (ligne
 *     QUEUED, rien dans le stockage) ; double clic / même clé → même travail ;
 *   · E02 génération globale : COMPLETE, chaque fichier stocké relu =
 *     empreinte du manifeste = index d'intégrité ; ZIP téléchargé lisible ;
 *     manifeste PAR TABLE ; couverture de TOUTES les tables de la base ;
 *   · E03 crash simulé (processus arrêté, bail expiré) : reprise sur un
 *     nouvel instantané, fichiers de la tentative morte supprimés, preuve de
 *     l'endroit de l'arrêt conservée ; tentatives épuisées → FAILED explicite ;
 *   · E04 historique pendant un export lourd : liste rapide et légère (même
 *     avec une ancienne ligne à bilan de plusieurs Mo), progression visible ;
 *   · E05 échec du stockage → nouvelle tentative puis FAILED explicite,
 *     jamais COMPLETE, aucun fichier laissé ;
 *   · E06 validation finale en échec (taille stockée divergente) → FAILED
 *     VALIDATION_FAILED, jamais un faux COMPLETE ;
 *   · E07 filtre compte ⊂ global (même moteur) ;
 *   · E08 Relancer sans double demande (parenté), Annuler ;
 *   · E09 sécurité : non-admin refusé partout, journal, aucun secret ;
 *   · E10 ancien moteur : génération synchrone retirée (410) ; ancienne
 *     ligne RUNNING close en LEGACY_HTTP_INTERRUPTED ; santé du moteur.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

type Json = Record<string, any>;

const s3 = vi.hoisted(() => {
  const objects = new Map<string, { body: Buffer; modified: Date }>();
  const uploads = new Map<string, { key: string; parts: Buffer[] }>();
  const faults = {
    /** Clé dont l'envoi échoue. */
    failUpload: null as null | ((key: string) => boolean),
    /** Clé dont la taille rendue par HeadObject est fausse. */
    wrongHead: null as null | ((key: string) => boolean),
    /** Délai par commande d'envoi (ms) : export « lourd ». */
    delayMs: 0,
  };
  let n = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const client = {
    async send(c: { constructor: { name: string }; input: Record<string, any> }) {
      const i = c.input;
      switch (c.constructor.name) {
        case 'CreateMultipartUploadCommand': {
          if (faults.delayMs) await wait(faults.delayMs);
          if (faults.failUpload?.(i.Key)) throw Object.assign(new Error('ServiceUnavailable (simulé)'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
          const id = `u${++n}`; uploads.set(id, { key: i.Key, parts: [] }); return { UploadId: id };
        }
        case 'UploadPartCommand': {
          if (faults.delayMs) await wait(faults.delayMs);
          const u = uploads.get(i.UploadId)!;
          if (faults.failUpload?.(u.key)) throw Object.assign(new Error('ServiceUnavailable (simulé)'), { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } });
          u.parts[i.PartNumber - 1] = Buffer.from(i.Body); return { ETag: `e${i.PartNumber}` };
        }
        case 'CompleteMultipartUploadCommand': {
          const u = uploads.get(i.UploadId)!;
          objects.set(i.Key, { body: Buffer.concat(u.parts), modified: new Date() });
          uploads.delete(i.UploadId);
          return {};
        }
        case 'AbortMultipartUploadCommand': uploads.delete(i.UploadId); return {};
        case 'PutObjectCommand': objects.set(i.Key, { body: Buffer.from(i.Body), modified: new Date() }); return {};
        case 'HeadObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
          return { ContentLength: o.body.length + (faults.wrongHead?.(i.Key) ? 1 : 0) };
        }
        case 'ListObjectsV2Command':
          return { Contents: [...objects.entries()].filter(([k]) => k.startsWith(i.Prefix ?? '')).sort(([a], [b]) => a.localeCompare(b)).map(([Key, o]) => ({ Key, LastModified: o.modified, Size: o.body.length })), IsTruncated: false };
        case 'GetObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
          const { Readable } = await import('node:stream');
          const chunks: Buffer[] = [];
          for (let k = 0; k < o.body.length; k += 65_536) chunks.push(o.body.subarray(k, k + 65_536));
          const r = Readable.from(chunks, { objectMode: false }) as unknown as Record<string, unknown>;
          r.transformToString = async () => o.body.toString('utf8');
          r.transformToByteArray = async () => new Uint8Array(o.body);
          return { Body: r };
        }
        case 'DeleteObjectsCommand': for (const x of i.Delete.Objects) objects.delete(x.Key); return {};
        default: throw new Error(`commande S3 non simulée : ${c.constructor.name}`);
      }
    },
  };
  return { objects, client, faults };
});

vi.mock('@/lib/s3-config', async (orig) => ({
  ...(await orig<typeof import('@/lib/s3-config')>()),
  isS3Configured: () => true,
  getS3Bucket: () => 'bucket-e2e',
  getS3Client: () => s3.client,
}));
vi.mock('@/services/exports/v12/storage', async (orig) => ({
  ...(await orig<typeof import('@/services/exports/v12/storage')>()),
  shortLivedDownloadUrl: async (key: string, fileName: string) => `https://s3.e2e.invalid/${key}?nom=${encodeURIComponent(fileName)}`,
}));

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const SECRET_HASH = 'HASH-SECRET-L107G-$2b$10$abcdefghijklmnopqrst';

scenario('L107G', 'Diagnostics BO durables : file, reprise, historique léger, validation, ZIP global', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  afterAll(() => { vi.restoreAllMocks(); });
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  const routes = {} as Record<'jobsPOST' | 'jobsGET' | 'detail' | 'retry' | 'cancel' | 'download' | 'health' | 'gensGET' | 'legacyGET', Route>;
  const req = (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => new NextRequest(`http://app.test${url}`, {
    method: init?.method ?? 'GET', headers: { 'content-type': 'application/json', origin: 'http://app.test', host: 'app.test', ...(init?.headers ?? {}) },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let admin: { id: number; email: string };
  let A: AccountRow & { owner: { id: number; email: string } };
  let B: AccountRow;
  const ids: Record<string, number> = {};
  const asAdmin = () => { session.userId = admin.id; session.role = 'ADMIN'; session.email = admin.email; };
  const storage = { client: s3.client as never, bucket: 'bucket-e2e' };

  async function demander(body: Json, key?: string): Promise<{ status: number; json: Json }> {
    asAdmin();
    const res = await routes.jobsPOST(req('/api/admin/diagnostics/jobs', { method: 'POST', body, headers: key ? { 'idempotency-key': key } : {} }));
    return { status: res.status, json: await res.json() as Json };
  }
  async function drain(jobId: string, extra: Json = {}) {
    const { drainDiagnosticJobs } = await import('@/services/admin/diagnostic-jobs/worker');
    return drainDiagnosticJobs({ onlyId: jobId, storage, workerId: `e2e-worker:${process.pid}:${Math.random().toString(36).slice(2, 8)}`, heartbeatMs: 200, ...extra });
  }
  const ligne = async (id: string) => (await sql<Json[]>`SELECT * FROM admin_export_generations WHERE id = ${id}::uuid`)[0];
  /** Motif lisible d'un statut inattendu : erreur et sections non complètes. */
  const pourquoi = (l: Json) => `${String(l.error)} — ${JSON.stringify((l.sections as Json[] ?? []).filter((x) => x.status !== 'COMPLETE' && x.status !== 'NOT_APPLICABLE'))}`;
  const objetsDe = (id: string) => [...s3.objects.keys()].filter((k) => k.startsWith(`admin-exports/diagnostics/${id}/`));
  async function zipDe(jobId: string): Promise<Record<string, string>> {
    asAdmin();
    const res = await routes.download(req(`/api/admin/diagnostics/jobs/${jobId}/download`), ctx(jobId));
    expect(res.status, await res.clone().text().catch(() => '')).toBe(200);
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const files: Record<string, string> = {};
    for (const [name, f] of Object.entries(z.files)) if (!f.dir) files[name] = await f.async('string');
    for (const [name, c] of Object.entries(files)) if (name.endsWith('.json')) expect(() => JSON.parse(c), name).not.toThrow();
    return files;
  }

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    const jobs = await import('@/app/api/admin/diagnostics/jobs/route');
    routes.jobsPOST = jobs.POST as Route;
    routes.jobsGET = jobs.GET as Route;
    routes.detail = (await import('@/app/api/admin/diagnostics/jobs/[id]/route')).GET as Route;
    routes.retry = (await import('@/app/api/admin/diagnostics/jobs/[id]/retry/route')).POST as Route;
    routes.cancel = (await import('@/app/api/admin/diagnostics/jobs/[id]/cancel/route')).POST as Route;
    routes.download = (await import('@/app/api/admin/diagnostics/jobs/[id]/download/route')).GET as Route;
    routes.health = (await import('@/app/api/admin/diagnostics/jobs/health/route')).GET as Route;
    routes.gensGET = (await import('@/app/api/admin/diagnostics/generations/route')).GET as Route;
    routes.legacyGET = (await import('@/app/api/admin/diagnostics/route')).GET as Route;

    const u = await make.user({ role: 'ADMIN' });
    admin = { id: u.id, email: u.email };
    A = await make.account({ plan: 'premium', name: 'Compte A L107G' }) as typeof A;
    B = await make.account({ plan: 'premium', name: 'Compte B L107G' });
    await sql`UPDATE users SET password_hash = ${SECRET_HASH} WHERE id = ${A.owner.id}`;
    ids.maison = (await make.asset(A, { category: 'IMMOBILIER', name: 'Maison L107G', purchasePriceCents: 30_000_000, purchaseDate: '2019-06-14' })).id;
    ids.voiture = (await make.asset(B, { category: 'VEHICULE', name: 'Voiture L107G' })).id;
    ids.facture = (await make.assetFile(A, { assetId: ids.maison })).id;
    ids.fileB = (await make.assetFile(B, { assetId: ids.voiture })).id;
    // Volume : 1 300 décisions T3 (fichier découpé en parties de 500 lignes dans les tests de découpage).
    const run = (await sql<{ id: number }[]>`INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, status) VALUES (${A.id}, ${ids.maison}, 'scheduled', 'completed') RETURNING id`)[0].id;
    await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids)
              SELECT ${run}, ${A.id}, ${ids.maison}, 'champ_' || (g % 40), 'keep', 'R' || g, 'certain', true, '[]'::jsonb FROM generate_series(1, 1300) g`;
    ids.op = (await sql<{ id: number }[]>`INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, realized_date)
      VALUES (${A.id}, 'ACQUISITION', 'REALIZED', 'Acquisition L107G', 'Notaire', '2019-06-14') RETURNING id::int AS id`)[0].id;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority) VALUES (${A.id}, ${ids.op}, ${ids.maison}, 'PRIMARY', 'STRUCTURED')`;
    await sql`INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, target_asset_id, label)
              VALUES (${A.id}, ${ids.op}, 'REALIZED_COST', 30000000, 'EUR', ${ids.maison}, 'Prix d’acquisition')`;
    await make.agendaItem(A, { title: 'Entretien chaudière L107G', startDate: '2027-03-10', assetIds: [ids.maison] });
  }, 300_000);

  // ══ E01 ═════════════════════════════════════════════════════════════════
  let jobCompte = '';
  it('L107G-E01 — demande : 202 immédiat, rien généré dans la requête ; double clic et même clé → même travail', async () => {
    const t0 = Date.now();
    const r1 = await demander({ scope: 'account', id: A.id }, 'cle-e2e-l107g-0001');
    expect(r1.status, JSON.stringify(r1.json)).toBe(202);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r1.json).toMatchObject({ status: 'QUEUED', duplicate: false });
    jobCompte = String(r1.json.jobId);
    const l = await ligne(jobCompte);
    expect(l).toMatchObject({ kind: 'TECH_DIAGNOSTIC', mode: 'job', status: 'QUEUED', phase: 'EN_FILE', attempt: 0, max_attempts: 3 });
    expect(objetsDe(jobCompte), 'aucune génération dans la requête HTTP').toEqual([]);
    // Double clic (sans clé) : demande identique en file → même travail.
    const r2 = await demander({ scope: 'account', id: A.id });
    expect(r2.json).toMatchObject({ jobId: jobCompte, duplicate: true });
    // Requête rejouée avec la même clé : même travail.
    const r3 = await demander({ scope: 'account', id: A.id }, 'cle-e2e-l107g-0001');
    expect(r3.json).toMatchObject({ jobId: jobCompte, duplicate: true });
    // Paramètre invalide : 400, rien enregistré.
    const avant = (await sql`SELECT count(*)::int AS n FROM admin_export_generations WHERE mode = 'job'`)[0].n;
    expect((await demander({ scope: 'asset' })).status).toBe(400);
    expect((await sql`SELECT count(*)::int AS n FROM admin_export_generations WHERE mode = 'job'`)[0].n).toBe(avant);
    // Journal : la demande est tracée.
    const j = await sql`SELECT result, details FROM admin_audit_log WHERE action_type = 'TECH_DIAGNOSTIC_JOB' AND admin_user_id = ${admin.id} ORDER BY id`;
    expect(j.length).toBeGreaterThanOrEqual(3);
  });

  // ══ E02 ═════════════════════════════════════════════════════════════════
  let G: Record<string, string> = {};
  let jobGlobal = '';
  it('L107G-E02 — global : COMPLETE validé, empreintes stockées = manifeste = index, ZIP lisible, manifeste par table, toutes les tables couvertes', async () => {
    const r = await demander({ scope: 'global' });
    expect(r.status).toBe(202);
    jobGlobal = String(r.json.jobId);
    const [status] = await drain(jobGlobal, { partRows: 500 });
    const l = await ligne(jobGlobal);
    expect(status, pourquoi(l)).toBe('COMPLETE');
    expect(l).toMatchObject({ status: 'COMPLETE', phase: 'TERMINE', attempt: 1, error_code: null });
    expect(l.expires_at).toBeTruthy();
    expect(String(l.storage_prefix)).toBe(`admin-exports/diagnostics/${jobGlobal}/a1/`);
    const prog = l.progress as Json;
    expect(prog.filesDone).toBe(prog.filesPlanned);
    expect(prog.peakRssMb).toBeGreaterThan(0);
    const log = l.attempts_log as Json[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ attempt: 1, outcome: 'COMPLETE' });

    // Index d'intégrité : chaque fichier stocké relu (décompressé) = taille et SHA-256 déclarés.
    const prefix = String(l.storage_prefix);
    const index = JSON.parse(gunzipSync(s3.objects.get(`${prefix}integrite.json.gz`)!.body).toString('utf8')) as Json;
    expect(index).toMatchObject({ jobId: jobGlobal, attempt: 1, status: 'COMPLETE' });
    for (const f of index.files as Json[]) {
      const buf = gunzipSync(s3.objects.get(`${prefix}${f.path}.gz`)!.body);
      expect(buf.length, f.path).toBe(f.bytes);
      expect(sha(buf), f.path).toBe(f.sha256);
      expect(s3.objects.get(`${prefix}${f.path}.gz`)!.body.length, f.path).toBe(f.compressedBytes);
    }

    G = await zipDe(jobGlobal);
    const m = JSON.parse(G['manifeste.json']) as Json;
    expect(m.status, JSON.stringify(m.warnings)).toBe('COMPLETE');
    expect(m.generationId).toBe(jobGlobal);
    expect(m.snapshot.isolation).toBe('REPEATABLE READ, READ ONLY');
    // Empreinte de chaque fichier du manifeste = contenu du ZIP ; tout fichier du ZIP est déclaré.
    for (const f of m.files as Json[]) {
      expect(G[f.path], `${f.path} absent du ZIP`).toBeDefined();
      if (f.sha256) expect(sha(G[f.path]), f.path).toBe(f.sha256);
    }
    const sums = G['SHA256SUMS.txt'].trim().split('\n').map((x) => x.split('  '));
    for (const [h, p] of sums) expect(sha(G[p]), p).toBe(h);
    expect(Object.keys(G).sort()).toEqual([...new Set([...(m.files as Json[]).map((f) => f.path), 'integrite.json', 'SHA256SUMS.txt'])].sort());
    // Découpage en parties (500 lignes) : toutes présentes, attendu = exporté par partie.
    const parts = Object.keys(G).filter((p) => /reconciliation_decisions\.part-\d{4}\.json$/.test(p));
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.flatMap((p) => JSON.parse(G[p]) as Json[]).filter((x) => x.account_id === A.id)).toHaveLength(1300);

    // Manifeste PAR TABLE : attendu / exporté / écart / statut / empreintes, exclusions motivées.
    const parTable = m.parTable as Json[];
    const dec = parTable.find((t) => t.table === 'reconciliation_decisions')!;
    expect(dec).toMatchObject({ role: 'EXPORTED', statut: 'COMPLETE', ecart: 0 });
    expect(dec.attendu).toBe(dec.exporte);
    expect(dec.sha256.length).toBe(dec.fichiers.length);
    const exclues = parTable.filter((t) => t.role === 'EXCLUDED');
    expect(exclues.length).toBeGreaterThan(0);
    for (const x of exclues) expect(String(x.motif).length, x.table).toBeGreaterThan(5);
    // Global : aucune table « hors filtre » ; TOUTE table de la base est exportée ou exclue avec motif.
    expect(parTable.filter((t) => t.role === 'NOT_APPLICABLE')).toEqual([]);
    const enBase = (await sql<{ t: string }[]>`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).map((x) => x.t);
    const vues = new Set(parTable.map((t) => t.table));
    expect(enBase.filter((t) => !vues.has(t)), 'tables de la base absentes du manifeste par table').toEqual([]);
    const couv = JSON.parse(G['couverture/tables.json']) as Json;
    for (const c of couv.couvertes as Json[]) expect(c.fichier).toBe(`donnees/${c.section}/${c.table}.json`);
    // Aucun secret.
    expect(Object.values(G).join('\n')).not.toContain(SECRET_HASH);

    // Détail : bilan par section léger, rapport synthétique stocké.
    asAdmin();
    const d = await (await routes.detail(req(`/api/admin/diagnostics/jobs/${jobGlobal}?report=1`), ctx(jobGlobal))).json() as Json;
    expect(d.downloadable).toBe(true);
    expect(d.progressPercent).toBe(100);
    expect(d.report).toBe(G['rapport.txt']);
    expect((d.job.sections as Json[]).length).toBeGreaterThan(5);
    // Un fichier seul : URL signée courte, chemin de l'index seulement.
    const one = await routes.download(req(`/api/admin/diagnostics/jobs/${jobGlobal}/download?path=manifeste.json`), ctx(jobGlobal));
    expect(one.status).toBe(302);
    expect(one.headers.get('location')).toContain(`${prefix}manifeste.json.gz`);
    expect((await routes.download(req(`/api/admin/diagnostics/jobs/${jobGlobal}/download?path=../secret`), ctx(jobGlobal))).status).toBe(400);
  }, 600_000);

  // ══ E03 ═════════════════════════════════════════════════════════════════
  it('L107G-E03 — crash simulé : bail expiré → reprise (nouvel instantané, fichiers morts supprimés, preuve conservée) ; tentatives épuisées → FAILED explicite', async () => {
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    // Le travail E01 est pris par un worker qui « meurt » au milieu de l'extraction.
    const pris = await repo.claimNextDiagnosticJob('worker-mort:4242:abcd1234', 'c0ffee12', { onlyId: jobCompte });
    expect(pris).toMatchObject({ id: jobCompte, status: 'RUNNING', attempt: 1 });
    await repo.setDiagnosticPhase(jobCompte, 'worker-mort:4242:abcd1234', 'EXTRACTION', {
      filesPlanned: 300, filesDone: 42, rows: 1000, bytes: 1, compressedBytes: 1, current: 'donnees/decisions/reconciliation_decisions.json', rssMb: 1810, peakRssMb: 1870, heapUsedMb: 1500, memoryLimitMb: 2048, updatedAt: new Date().toISOString(),
    });
    s3.objects.set(`admin-exports/diagnostics/${jobCompte}/a1/donnees/partiel.json.gz`, { body: Buffer.from('partiel'), modified: new Date() });
    // Processus arrêté : plus aucun renouvellement, le bail expire.
    await sql`UPDATE admin_export_generations SET locked_until = now() - interval '1 second' WHERE id = ${jobCompte}::uuid`;

    // Observabilité sans diagnostic : la santé signale l'orphelin.
    asAdmin();
    const h = await (await routes.health(req('/api/admin/diagnostics/jobs/health'))).json() as Json;
    expect(h.alerts.join('\n')).toMatch(new RegExp(`WORKER_LOST : diagnostic ${jobCompte.slice(0, 8)}`));
    expect(h.queue.running.find((x: Json) => x.id === jobCompte)).toMatchObject({ leaseExpired: true, phase: 'EXTRACTION', worker: 'worker-mort:4242' });

    const rec = await repo.recoverDiagnosticJobs();
    expect(rec.requeued).toContain(jobCompte);
    let l = await ligne(jobCompte);
    expect(l).toMatchObject({ status: 'QUEUED', error_code: 'WORKER_LOST', error_phase: 'EXTRACTION', locked_by: null });
    expect(String(l.error)).toMatch(/mémoire 1810 Mo \(pic 1870 Mo\)/);
    expect((l.attempts_log as Json[])[0]).toMatchObject({ attempt: 1, outcome: 'LOST', worker: 'worker-mort:4242:abcd1234', commit: 'c0ffee12', lastProgress: { current: 'donnees/decisions/reconciliation_decisions.json', rssMb: 1810 } });
    expect(new Date(String(l.next_attempt_at)).getTime()).toBeGreaterThan(Date.now());
    // Pas avant l'échéance de la nouvelle tentative…
    expect(await drain(jobCompte)).toEqual([]);
    await sql`UPDATE admin_export_generations SET next_attempt_at = now() WHERE id = ${jobCompte}::uuid`;
    const [st] = await drain(jobCompte, { partRows: 500 });
    l = await ligne(jobCompte);
    expect(st, pourquoi(l)).toBe('COMPLETE');
    expect(l).toMatchObject({ status: 'COMPLETE', attempt: 2, error_code: null });
    expect(objetsDe(jobCompte).some((k) => k.includes('/a1/')), 'fichiers de la tentative morte supprimés').toBe(false);
    expect((l.attempts_log as Json[]).map((a) => a.outcome)).toEqual(['LOST', 'COMPLETE']);

    // Tentatives épuisées : FAILED explicite, jamais RUNNING à vie.
    const r = await demander({ scope: 'asset', id: ids.maison });
    const id = String(r.json.jobId);
    await sql`UPDATE admin_export_generations SET max_attempts = 1 WHERE id = ${id}::uuid`;
    await repo.claimNextDiagnosticJob('worker-mort:4243:abcd', null, { onlyId: id });
    // Lot 111C : la génération a DÉMARRÉ (instantané ouvert, extraction) — un arrêt avant
    // l'ouverture de l'instantané rend désormais la tentative (voir L111C-E08).
    await repo.setDiagnosticPhase(id, 'worker-mort:4243:abcd', 'EXTRACTION');
    await sql`UPDATE admin_export_generations SET locked_until = now() - interval '1 second' WHERE id = ${id}::uuid`;
    expect((await repo.recoverDiagnosticJobs()).failed).toContain(id);
    expect(await ligne(id)).toMatchObject({ status: 'FAILED', error_code: 'WORKER_LOST_MAX_ATTEMPTS', locked_by: null });
    asAdmin();
    expect((await routes.download(req(`/api/admin/diagnostics/jobs/${id}/download`), ctx(id))).status).toBe(409);
  }, 600_000);

  // ══ E04 ═════════════════════════════════════════════════════════════════
  it('L107G-E04 — historique pendant un export lourd : rapide, léger (sans colonnes lourdes), progression visible', async () => {
    // Ancienne génération à bilan énorme (≈ 6 Mo de sections) : ne doit plus alourdir la liste.
    const big = JSON.stringify(Array.from({ length: 20_000 }, (_, k) => ({ path: `donnees/x/table_${k}.part-0001.json`, description: 'x'.repeat(250), status: 'COMPLETE', sha256: 'f'.repeat(64) })));
    await sql`INSERT INTO admin_export_generations (id, kind, mode, admin_user_id, status, sections, finished_at, started_at)
              VALUES (gen_random_uuid(), 'TECH_DIAGNOSTIC', 'zip', ${admin.id}, 'COMPLETE', ${big}::jsonb, now(), now() - interval '1 minute')`;
    const r = await demander({ scope: 'account', id: B.id });
    const id = String(r.json.jobId);
    s3.faults.delayMs = 15;
    const enCours = drain(id, { partRows: 500 });
    try {
      // Attendre la phase d'extraction (le worker tourne).
      for (let k = 0; k < 400; k++) {
        const l = await ligne(id);
        if (l.status === 'RUNNING' && (l.progress as Json | null)?.filesDone > 2) break;
        await new Promise((x) => setTimeout(x, 50));
      }
      asAdmin();
      const t0 = Date.now();
      const res = await routes.gensGET(req('/api/admin/diagnostics/generations?page=1&pageSize=10'));
      const dt = Date.now() - t0;
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(dt, 'liste servie pendant l’export lourd').toBeLessThan(3_000);
      expect(text.length, 'liste légère : aucune colonne lourde').toBeLessThan(100_000);
      const body = JSON.parse(text) as Json;
      const me = (body.items as Json[]).find((x) => x.id === id)!;
      expect(me).toMatchObject({ status: 'RUNNING', mode: 'job', attempt: 1, maxAttempts: 3, leaseExpired: false });
      expect(me.progress.filesDone).toBeGreaterThan(0);
      expect(me.phase).toBeTruthy();
      expect(me.sections).toEqual([]);
      // Liste des diagnostics (même source, filtrable).
      const lj = await (await routes.jobsGET(req('/api/admin/diagnostics/jobs?status=RUNNING'))).json() as Json;
      expect((lj.items as Json[]).map((x) => x.id)).toContain(id);
    } finally {
      s3.faults.delayMs = 0;
      await enCours;
    }
    expect((await ligne(id)).status).toBe('COMPLETE');
  }, 600_000);

  // ══ E05 ═════════════════════════════════════════════════════════════════
  let jobEchec = '';
  it('L107G-E05 — échec du stockage : nouvelle tentative programmée puis FAILED explicite, jamais COMPLETE, aucun fichier laissé', async () => {
    const r = await demander({ scope: 'document', id: ids.facture });
    jobEchec = String(r.json.jobId);
    s3.faults.failUpload = (key) => key.includes(jobEchec) && key.includes('/donnees/');
    try {
      const [s1] = await drain(jobEchec);
      expect(s1).toBe('QUEUED');
      let l = await ligne(jobEchec);
      expect(l).toMatchObject({ status: 'QUEUED', error_code: 'STORAGE_UPLOAD_FAILED', attempt: 1 });
      expect(String(l.error)).toMatch(/nouvelle tentative programmée \(1\/3\)/);
      expect(objetsDe(jobEchec)).toEqual([]);
      await sql`UPDATE admin_export_generations SET max_attempts = 2, next_attempt_at = now() WHERE id = ${jobEchec}::uuid`;
      const [s2] = await drain(jobEchec);
      expect(s2).toBe('FAILED');
      l = await ligne(jobEchec);
      expect(l).toMatchObject({ status: 'FAILED', error_code: 'STORAGE_UPLOAD_FAILED', attempt: 2, phase: 'TERMINE' });
      expect(l.error_phase).toBeTruthy();
      expect(String(l.error)).not.toMatch(/@|Bearer|X-Amz-Signature/);
      expect((l.attempts_log as Json[]).map((a) => a.outcome)).toEqual(['RETRY', 'FAILED']);
      expect(objetsDe(jobEchec)).toEqual([]);
    } finally {
      s3.faults.failUpload = null;
    }
  }, 600_000);

  // ══ E06 ═════════════════════════════════════════════════════════════════
  it('L107G-E06 — validation finale en échec (taille stockée divergente) : FAILED VALIDATION_FAILED, jamais un faux COMPLETE', async () => {
    const r = await demander({ scope: 'operation', id: ids.op });
    const id = String(r.json.jobId);
    s3.faults.wrongHead = (key) => key.includes(id) && key.endsWith('rapport.txt.gz');
    try {
      const [st] = await drain(id);
      expect(st).toBe('FAILED');
      const l = await ligne(id);
      expect(l).toMatchObject({ status: 'FAILED', error_code: 'VALIDATION_FAILED', error_phase: 'VALIDATION' });
      expect(String(l.error)).toMatch(/rapport\.txt : taille stockée/);
      expect(objetsDe(id)).toEqual([]);
    } finally {
      s3.faults.wrongHead = null;
    }
  }, 600_000);

  // ══ E07 ═════════════════════════════════════════════════════════════════
  it('L107G-E07 — filtre compte ⊂ global (même moteur, archives durables)', async () => {
    const { filteredIncludedInGlobal } = await import('@/services/admin/diagnostics-export/inclusion');
    const F = await zipDe(jobCompte);
    expect(filteredIncludedInGlobal(F, G)).toEqual([]);
    const fm = JSON.parse(F['manifeste.json']) as Json;
    expect(fm.request).toMatchObject({ scope: 'account', id: A.id });
    // Aucune ligne du compte B dans le filtre compte A.
    const accs = (JSON.parse(F[Object.keys(F).find((p) => /^donnees\/[a-z-]+\/accounts\.json$/.test(p))!]) as Json[]).map((x) => x.id);
    expect(accs).toEqual([A.id]);
  }, 600_000);

  // ══ E08 ═════════════════════════════════════════════════════════════════
  it('L107G-E08 — Relancer sans double demande (parenté conservée) ; Annuler', async () => {
    asAdmin();
    const r1 = await routes.retry(req(`/api/admin/diagnostics/jobs/${jobEchec}/retry`, { method: 'POST' }), ctx(jobEchec));
    expect(r1.status).toBe(202);
    const b1 = await r1.json() as Json;
    expect(b1).toMatchObject({ parentId: jobEchec, duplicate: false, status: 'QUEUED' });
    const r2 = await (await routes.retry(req(`/api/admin/diagnostics/jobs/${jobEchec}/retry`, { method: 'POST' }), ctx(jobEchec))).json() as Json;
    expect(r2).toMatchObject({ jobId: b1.jobId, duplicate: true });
    expect(await ligne(String(b1.jobId))).toMatchObject({ parent_id: jobEchec, status: 'QUEUED' });
    // Un travail actif ne se relance pas.
    expect((await routes.retry(req(`/api/admin/diagnostics/jobs/${b1.jobId}/retry`, { method: 'POST' }), ctx(String(b1.jobId)))).status).toBe(409);
    // Annuler un travail en file : CANCELLED immédiat ; deuxième annulation : 409.
    const c = await routes.cancel(req(`/api/admin/diagnostics/jobs/${b1.jobId}/cancel`, { method: 'POST' }), ctx(String(b1.jobId)));
    expect(await c.json()).toMatchObject({ outcome: 'CANCELLED' });
    expect(await ligne(String(b1.jobId))).toMatchObject({ status: 'CANCELLED', error_code: 'CANCELLED' });
    expect((await routes.cancel(req(`/api/admin/diagnostics/jobs/${b1.jobId}/cancel`, { method: 'POST' }), ctx(String(b1.jobId)))).status).toBe(409);
    // Annuler pendant la génération : le worker s'arrête, fichiers supprimés, CANCELLED.
    const r = await demander({ scope: 'account', id: B.id, reinforced: false });
    const id = String(r.json.jobId);
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    await sql`UPDATE admin_export_generations SET cancel_requested = false WHERE id = ${id}::uuid`;
    s3.faults.delayMs = 10;
    const p = drain(id);
    for (let k = 0; k < 400 && (await ligne(id)).status !== 'RUNNING'; k++) await new Promise((x) => setTimeout(x, 25));
    expect(await repo.cancelDiagnosticJob(id)).toBe('REQUESTED');
    const [st] = await p;
    s3.faults.delayMs = 0;
    expect(st).toBe('CANCELLED');
    expect(await ligne(id)).toMatchObject({ status: 'CANCELLED', error_code: 'CANCELLED' });
    expect(objetsDe(id)).toEqual([]);
  }, 600_000);

  // ══ E09 ═════════════════════════════════════════════════════════════════
  it('L107G-E09 — sécurité : non-administrateur refusé partout ; téléchargements journalisés', async () => {
    const u = await make.user({ role: 'USER' });
    session.userId = u.id; session.role = 'USER'; session.email = u.email;
    const refus = [
      await routes.jobsPOST(req('/api/admin/diagnostics/jobs', { method: 'POST', body: { scope: 'global' } })),
      await routes.jobsGET(req('/api/admin/diagnostics/jobs')),
      await routes.detail(req(`/api/admin/diagnostics/jobs/${jobGlobal}`), ctx(jobGlobal)),
      await routes.retry(req(`/api/admin/diagnostics/jobs/${jobGlobal}/retry`, { method: 'POST' }), ctx(jobGlobal)),
      await routes.cancel(req(`/api/admin/diagnostics/jobs/${jobGlobal}/cancel`, { method: 'POST' }), ctx(jobGlobal)),
      await routes.download(req(`/api/admin/diagnostics/jobs/${jobGlobal}/download`), ctx(jobGlobal)),
      await routes.health(req('/api/admin/diagnostics/jobs/health')),
      await routes.gensGET(req('/api/admin/diagnostics/generations')),
    ];
    for (const r of refus) expect(r.status).toBe(403);
    const dl = await sql`SELECT result, details FROM admin_audit_log WHERE action_type = 'TECH_DIAGNOSTIC_DOWNLOAD' AND admin_user_id = ${admin.id}`;
    expect(dl.length).toBeGreaterThanOrEqual(2);
  });

  // ══ E10 ═════════════════════════════════════════════════════════════════
  it('L107G-E10 — ancien moteur : génération synchrone retirée (410) ; ancienne ligne RUNNING → LEGACY_HTTP_INTERRUPTED persisté ; santé du moteur', async () => {
    asAdmin();
    const avant = (await sql`SELECT count(*)::int AS n FROM admin_export_generations`)[0].n;
    const res = await routes.legacyGET(req('/api/admin/diagnostics?scope=global&format=zip'));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'SYNC_GENERATION_DISABLED' });
    expect((await sql`SELECT count(*)::int AS n FROM admin_export_generations`)[0].n).toBe(avant);

    // Cas du 02/11 : ligne synchrone (compte #13) jamais close, processus arrêté.
    const legacy = (await sql<{ id: string }[]>`
      INSERT INTO admin_export_generations (id, kind, mode, admin_user_id, target_type, target_id, target_account_id, status, started_at)
      VALUES (gen_random_uuid(), 'TECH_DIAGNOSTIC', 'consultation', ${admin.id}, 'account', 13, 13, 'RUNNING', now() - interval '3 hours') RETURNING id::text AS id`)[0].id;
    const liste = await (await routes.gensGET(req('/api/admin/diagnostics/generations?kind=TECH_DIAGNOSTIC&pageSize=100'))).json() as Json;
    const vu = (liste.items as Json[]).find((x) => x.id === legacy)!;
    expect(vu).toMatchObject({ status: 'FAILED', interrupted: true, errorCode: 'LEGACY_HTTP_INTERRUPTED' });
    expect(vu.error).toMatch(/processus arrêté avant la fin.*requête HTTP/);
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    expect((await repo.recoverDiagnosticJobs()).legacy).toContain(legacy);
    expect(await ligne(legacy)).toMatchObject({ status: 'FAILED', error_code: 'LEGACY_HTTP_INTERRUPTED' });

    const h = await (await routes.health(req('/api/admin/diagnostics/jobs/health'))).json() as Json;
    expect(h.queue.migrationApplied).toBe(true);
    expect(h.storageConfigured).toBe(true);
    expect(h.process.rssMb).toBeGreaterThan(0);
    expect(h.build).toHaveProperty('commit');
    const codes = (h.queue.recentFailures as Json[]).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['LEGACY_HTTP_INTERRUPTED', 'VALIDATION_FAILED', 'STORAGE_UPLOAD_FAILED']));
    expect(JSON.stringify(h)).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });
});
