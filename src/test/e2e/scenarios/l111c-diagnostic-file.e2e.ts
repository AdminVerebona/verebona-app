/**
 * Lot 111C — diagnostic global bloqué en file (ticket P1 du 04/11/2026,
 * demande c229c2fd… QUEUED 2 h, 0/3), sur PostgreSQL 16 réel, par les VRAIES
 * routes BO (seule la lecture du cookie de session est simulée), le VRAI
 * worker (`drainDiagnosticJobs`) et le VRAI superviseur ; stockage OVH S3
 * SIMULÉ en mémoire (envois en plusieurs parties, envois incomplets listables,
 * délais injectables).
 *
 *   E01 nouvelle demande quand la précédente est QUEUED : CANCELLED,
 *       REPLACED_BY_NEW_REQUEST, référence, initiateur, dernière étape ;
 *       mêmes paramètres + nouvelle action = remplacement ; rejeu (même clé)
 *       = même demande, aucun remplacement ; statuts BO explicites ;
 *   E02 standard ↔ renforcé ; diagnostic ciblé en file jamais touché ;
 *   E03 deux administrateurs simultanés : un seul global éligible ;
 *   E04 remplacement pendant l'EXTRACTION (requête SQL bloquée) : requête
 *       interrompue, CANCELLED en quelques secondes, aucun fichier ; la
 *       nouvelle ne démarre pas avant la libération du bail, puis COMPLETE et
 *       ZIP téléchargeable et exploitable ;
 *   E05 remplacement pendant les ENVOIS : arrêt, objets et envois OVH
 *       incomplets supprimés, archive finalisée antérieure conservée ;
 *   E06 publication tardive interdite (annulation, bail repris ailleurs) ;
 *   E07 redémarrage / perte de bail : demande remplacée jamais requeued,
 *       fichiers purgés ; arrêt avant l'instantané = tentative non décomptée ;
 *   E08 worker absent puis rétabli, désactivé (affiché dès la création +
 *       alerte), BACKGROUND_JOBS_PROCESS=worker sans conteneur, admission
 *       mémoire, autre diagnostic ciblé en cours ; reprise automatique et
 *       résolution des alertes ; jamais de tentative décomptée sans démarrage ;
 *   E09 santé : battements de toutes les instances, raisons d'attente.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

type Json = Record<string, any>;

const s3 = vi.hoisted(() => {
  const objects = new Map<string, { body: Buffer; modified: Date }>();
  const uploads = new Map<string, { key: string; parts: Buffer[] }>();
  const faults = { delayMs: 0, delayKey: null as null | ((key: string) => boolean) };
  let n = 0;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const client = {
    async send(c: { constructor: { name: string }; input: Record<string, any> }) {
      const i = c.input;
      const slow = async (key: string) => { if (faults.delayMs && (!faults.delayKey || faults.delayKey(key))) await wait(faults.delayMs); };
      switch (c.constructor.name) {
        case 'CreateMultipartUploadCommand': { await slow(i.Key); const id = `u${++n}`; uploads.set(id, { key: i.Key, parts: [] }); return { UploadId: id }; }
        case 'UploadPartCommand': { const u = uploads.get(i.UploadId)!; await slow(u.key); u.parts[i.PartNumber - 1] = Buffer.from(i.Body); return { ETag: `e${i.PartNumber}` }; }
        case 'CompleteMultipartUploadCommand': { const u = uploads.get(i.UploadId)!; objects.set(i.Key, { body: Buffer.concat(u.parts), modified: new Date() }); uploads.delete(i.UploadId); return {}; }
        case 'AbortMultipartUploadCommand': uploads.delete(i.UploadId); return {};
        case 'ListMultipartUploadsCommand':
          return { Uploads: [...uploads.entries()].filter(([, u]) => u.key.startsWith(i.Prefix ?? '')).map(([UploadId, u]) => ({ Key: u.key, UploadId })), IsTruncated: false };
        case 'PutObjectCommand': objects.set(i.Key, { body: Buffer.from(i.Body), modified: new Date() }); return {};
        case 'HeadObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
          return { ContentLength: o.body.length };
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
  return { objects, uploads, client, faults };
});

vi.mock('@/lib/s3-config', async (orig) => ({
  ...(await orig<typeof import('@/lib/s3-config')>()),
  isS3Configured: () => true,
  getS3Bucket: () => 'bucket-e2e',
  getS3Client: () => s3.client,
}));

scenario('L111C', 'Diagnostic global : remplacement, arrêt coopératif, supervision persistante du worker', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  afterAll(() => { vi.restoreAllMocks(); });
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  const routes = {} as Record<'jobsPOST' | 'detail' | 'cancel' | 'download' | 'health' | 'gensGET', Route>;
  const req = (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => new NextRequest(`http://app.test${url}`, {
    method: init?.method ?? 'GET', headers: { 'content-type': 'application/json', origin: 'http://app.test', host: 'app.test', ...(init?.headers ?? {}) },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let admin: { id: number; email: string };
  let admin2: { id: number; email: string };
  let A: AccountRow;
  const storage = { client: s3.client as never, bucket: 'bucket-e2e' };
  const as = (a: { id: number; email: string }) => { session.userId = a.id; session.role = 'ADMIN'; session.email = a.email; };
  let k = 0;
  const key = () => `cle-l111c-${Date.now()}-${++k}`;

  async function demander(body: Json, opts: { key?: string | null; who?: { id: number; email: string } } = {}): Promise<{ status: number; json: Json }> {
    as(opts.who ?? admin);
    const idem = opts.key === undefined ? key() : opts.key;
    const res = await routes.jobsPOST(req('/api/admin/diagnostics/jobs', { method: 'POST', body, headers: idem ? { 'idempotency-key': idem } : {} }));
    return { status: res.status, json: await res.json() as Json };
  }
  const ligne = async (id: string) => (await sql<Json[]>`SELECT * FROM admin_export_generations WHERE id = ${id}::uuid`)[0];
  const objetsDe = (id: string) => [...s3.objects.keys()].filter((x) => x.startsWith(`admin-exports/diagnostics/${id}/`));
  const envoisDe = (id: string) => [...s3.uploads.values()].filter((u) => u.key.startsWith(`admin-exports/diagnostics/${id}/`));
  const workerId = () => `e2e-111c:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  async function drain(jobId: string, extra: Json = {}) {
    const { drainDiagnosticJobs } = await import('@/services/admin/diagnostic-jobs/worker');
    return drainDiagnosticJobs({ onlyId: jobId, storage, workerId: workerId(), heartbeatMs: 200, cancelPollMs: 100, ...extra });
  }
  const detail = async (id: string) => { as(admin); return await (await routes.detail(req(`/api/admin/diagnostics/jobs/${id}`), ctx(id))).json() as Json; };
  const until = async (cond: () => Promise<boolean>, ms = 60_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 50)); }
    return false;
  };
  /** Clôt toute demande active (isolation entre cas). */
  const viderFile = async () => { await sql`UPDATE admin_export_generations SET status = 'CANCELLED', locked_until = NULL, locked_by = NULL WHERE mode = 'job' AND status IN ('QUEUED', 'RUNNING')`; };
  /** Battement d'un processus simulé (état persisté lu par le superviseur). */
  async function battement(p: Json) {
    await sql`INSERT INTO diagnostic_worker_heartbeats (instance_id, process_type, placement, state, disabled_reason, started_at, seen_at, last_tick_at, last_tick_ok_at, wait_reason, last_error, last_error_at, interval_ms)
              VALUES (${p.id}, ${p.process ?? 'web'}, ${p.placement ?? 'web'}, ${p.state}, ${p.disabledReason ?? null}, now() - interval '1 hour', ${p.seenAt ?? new Date().toISOString()}::timestamptz,
                      ${p.lastTickAt === undefined ? new Date().toISOString() : p.lastTickAt}::timestamptz, ${p.lastTickOkAt === undefined ? new Date().toISOString() : p.lastTickOkAt}::timestamptz,
                      ${p.waitReason ?? null}, ${p.lastError ?? null}, ${p.lastErrorAt ?? null}::timestamptz, 10000)
              ON CONFLICT (instance_id) DO UPDATE SET state = EXCLUDED.state, disabled_reason = EXCLUDED.disabled_reason, placement = EXCLUDED.placement, seen_at = EXCLUDED.seen_at,
                last_tick_at = EXCLUDED.last_tick_at, last_tick_ok_at = EXCLUDED.last_tick_ok_at, wait_reason = EXCLUDED.wait_reason, last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at`;
  }
  const anomalies = async () => sql<Json[]>`SELECT fingerprint, status, title, technical_detail AS detail FROM admin_anomalies WHERE fingerprint LIKE 'other:diagnostic-jobs:queue-stalled:%' ORDER BY id`;

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    const jobs = await import('@/app/api/admin/diagnostics/jobs/route');
    routes.jobsPOST = jobs.POST as Route;
    routes.detail = (await import('@/app/api/admin/diagnostics/jobs/[id]/route')).GET as Route;
    routes.cancel = (await import('@/app/api/admin/diagnostics/jobs/[id]/cancel/route')).POST as Route;
    routes.download = (await import('@/app/api/admin/diagnostics/jobs/[id]/download/route')).GET as Route;
    routes.health = (await import('@/app/api/admin/diagnostics/jobs/health/route')).GET as Route;
    routes.gensGET = (await import('@/app/api/admin/diagnostics/generations/route')).GET as Route;
    const u = await make.user({ role: 'ADMIN' });
    admin = { id: u.id, email: u.email };
    const u2 = await make.user({ role: 'ADMIN' });
    admin2 = { id: u2.id, email: u2.email };
    A = await make.account({ plan: 'premium', name: 'Compte A L111C' });
    const asset = (await make.asset(A, { category: 'IMMOBILIER', name: 'Maison L111C' })).id;
    const run = (await sql<{ id: number }[]>`INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, status) VALUES (${A.id}, ${asset}, 'scheduled', 'completed') RETURNING id`)[0].id;
    await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids)
              SELECT ${run}, ${A.id}, ${asset}, 'champ_' || (g % 40), 'keep', 'R' || g, 'certain', true, '[]'::jsonb FROM generate_series(1, 1200) g`;
  }, 300_000);

  beforeEach(async () => {
    s3.faults.delayMs = 0; s3.faults.delayKey = null;
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    // Un worker sain par défaut (les cas « worker absent » le retirent).
    await battement({ id: 'web-1:100:sain0001', state: 'STARTED', waitReason: 'NO_ELIGIBLE_JOB' });
  });

  // ══ E01 ═════════════════════════════════════════════════════════════════
  it('L111C-E01 — demande QUEUED remplacée (motif, référence, initiateur, étape) ; mêmes paramètres = remplacement ; rejeu = même demande', async () => {
    await viderFile();
    const r1 = await demander({ scope: 'global', reinforced: true });
    expect(r1.status, JSON.stringify(r1.json)).toBe(202);
    const j1 = String(r1.json.jobId);
    expect(r1.json).toMatchObject({ status: 'QUEUED', duplicate: false, replaced: [] });
    // Nouvelle action explicite, paramètres IDENTIQUES, autre administrateur : remplacement.
    const cle2 = key();
    const r2 = await demander({ scope: 'global', reinforced: true }, { key: cle2, who: admin2 });
    const j2 = String(r2.json.jobId);
    expect(j2).not.toBe(j1);
    expect(r2.json).toMatchObject({ duplicate: false, replaced: [{ id: j1, previousStatus: 'QUEUED', outcome: 'CANCELLED', phase: 'EN_FILE' }] });
    const l1 = await ligne(j1);
    expect(l1).toMatchObject({ status: 'CANCELLED', error_code: 'REPLACED_BY_NEW_REQUEST', cancel_reason: 'REPLACED_BY_NEW_REQUEST', replaced_by: j2, cancel_requested_by: admin2.id, error_phase: 'EN_FILE', attempt: 0 });
    expect(l1.cancel_requested_at).toBeTruthy();
    expect(String(l1.error)).toContain(j2);
    // Rejeu réseau / double clic (même clé) : même demande, rien de remplacé.
    const r3 = await demander({ scope: 'global', reinforced: true }, { key: cle2, who: admin2 });
    expect(r3.json).toMatchObject({ jobId: j2, duplicate: true, replaced: [] });
    expect((await ligne(j2)).status).toBe('QUEUED');
    // Sans clé (appel direct) : nouvelle action → remplacement.
    const r4 = await demander({ scope: 'global', reinforced: true }, { key: null });
    expect(r4.json.replaced.map((x: Json) => x.id)).toEqual([j2]);
    // Statuts BO explicites, nouvelle demande sélectionnable.
    const d1 = await detail(j1);
    expect(d1.statusLabel).toBe(`Annulé — remplacé par la demande ${j2.slice(0, 8)}`);
    expect(d1.job).toMatchObject({ replacedBy: j2, cancelReason: 'REPLACED_BY_NEW_REQUEST' });
    const d4 = await detail(String(r4.json.jobId));
    expect(d4.statusLabel).toMatch(/^En attente — /);
    as(admin);
    const list = await (await routes.gensGET(req('/api/admin/diagnostics/generations?kind=TECH_DIAGNOSTIC&pageSize=20'))).json() as Json;
    expect((list.items as Json[]).find((x) => x.id === j2)?.statusLabel).toBe(`Annulé — remplacé par la demande ${String(r4.json.jobId).slice(0, 8)}`);
    const journal = await sql<Json[]>`SELECT details::jsonb AS details FROM admin_audit_log WHERE action_type = 'TECH_DIAGNOSTIC_JOB' AND (details::jsonb->>'jobId') = ${j2} AND (details::jsonb->>'duplicate') = 'false' ORDER BY id`;
    expect(journal[0].details.replaced).toEqual([{ id: j1, from: 'QUEUED', outcome: 'CANCELLED' }]);
  });

  // ══ E02 ═════════════════════════════════════════════════════════════════
  it('L111C-E02 — standard ↔ renforcé remplacés ; diagnostics ciblés jamais touchés', async () => {
    await viderFile();
    const cible = String((await demander({ scope: 'account', id: A.id })).json.jobId);
    const std = String((await demander({ scope: 'global' })).json.jobId);
    const ren = await demander({ scope: 'global', reinforced: true });
    expect(ren.json.replaced.map((x: Json) => x.id)).toEqual([std]);
    const std2 = await demander({ scope: 'global' });
    expect(std2.json.replaced.map((x: Json) => x.id)).toEqual([String(ren.json.jobId)]);
    expect(await ligne(cible)).toMatchObject({ status: 'QUEUED', cancel_requested: false, replaced_by: null });
    // Ciblé identique : toujours dédoublonné (règle du lot 107G inchangée).
    expect((await demander({ scope: 'account', id: A.id })).json).toMatchObject({ jobId: cible, duplicate: true });
  });

  // ══ E03 ═════════════════════════════════════════════════════════════════
  it('L111C-E03 — deux administrateurs simultanés : un seul diagnostic global éligible', async () => {
    await viderFile();
    const [a, b] = await Promise.all([demander({ scope: 'global' }, { who: admin }), demander({ scope: 'global', reinforced: true }, { who: admin2 })]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const actifs = await sql<Json[]>`SELECT id::text, status FROM admin_export_generations WHERE mode = 'job' AND status IN ('QUEUED', 'RUNNING') AND NOT cancel_requested AND target_type = 'global'`;
    expect(actifs).toHaveLength(1);
    const perdant = actifs[0].id === a.json.jobId ? String(b.json.jobId) : String(a.json.jobId);
    expect(await ligne(perdant)).toMatchObject({ status: 'CANCELLED', error_code: 'REPLACED_BY_NEW_REQUEST', replaced_by: actifs[0].id });
  });

  // ══ E04 ═════════════════════════════════════════════════════════════════
  it('L111C-E04 — remplacement pendant l’EXTRACTION : requête SQL interrompue, CANCELLED, bail libéré avant la nouvelle, puis COMPLETE et ZIP exploitable', async () => {
    await viderFile();
    const ancien = String((await demander({ scope: 'global' })).json.jobId);
    // Une transaction concurrente verrouille une table : la lecture de l'instantané attend (requête « longue »).
    const lockConn = await (sql as unknown as { reserve: () => Promise<any> }).reserve();
    await lockConn.unsafe('BEGIN');
    await lockConn.unsafe('LOCK TABLE reconciliation_decisions IN ACCESS EXCLUSIVE MODE');
    const p = drain(ancien, { partRows: 500 });
    let nouveau = '';
    try {
      const bloque = await until(async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%reconciliation_decisions%' AND pid <> pg_backend_pid()`).length > 0, 120_000);
      expect(bloque, 'la lecture du diagnostic attend le verrou').toBe(true);
      expect((await ligne(ancien)).status).toBe('RUNNING');
      const t0 = Date.now();
      const r = await demander({ scope: 'global', reinforced: true });
      nouveau = String(r.json.jobId);
      expect(r.json.replaced).toEqual([expect.objectContaining({ id: ancien, previousStatus: 'RUNNING', outcome: 'CANCEL_REQUESTED' })]);
      expect(r.json.wait).toMatchObject({ reason: 'STOPPING_REPLACED', blockingJobId: ancien });
      expect((await detail(ancien)).statusLabel).toBe(`Annulation demandée — remplacé par la demande ${nouveau.slice(0, 8)}`);
      // Tant que l'ancien tient son bail, la nouvelle n'est pas prise (aucune exécution concurrente).
      const repo = await import('@/services/admin/diagnostic-jobs/repository');
      if ((await ligne(ancien)).status === 'RUNNING') {
        expect(await repo.claimNextDiagnosticJobDetailed('e2e-intrus:1:x', null, { onlyId: nouveau })).toMatchObject({ job: null, blocked: 'GLOBAL_DIAGNOSTIC_STOPPING' });
      }
      const [st] = await p;
      expect(st).toBe('CANCELLED');
      expect(Date.now() - t0, 'arrêt effectif en quelques secondes, sans attendre le verrou ni le bail').toBeLessThan(15_000);
    } finally {
      await lockConn.unsafe('ROLLBACK').catch(() => undefined);
      lockConn.release();
      await p.catch(() => undefined);
    }
    const l = await ligne(ancien);
    expect(l).toMatchObject({ status: 'CANCELLED', error_code: 'REPLACED_BY_NEW_REQUEST', replaced_by: nouveau, locked_by: null, locked_until: null });
    expect(l.error_phase).toBeTruthy();
    expect((l.attempts_log as Json[]).at(-1)).toMatchObject({ outcome: 'CANCELLED', errorCode: 'REPLACED_BY_NEW_REQUEST' });
    expect(objetsDe(ancien)).toEqual([]);
    expect(envoisDe(ancien)).toEqual([]);
    // Bail libéré : la nouvelle demande part et publie une archive complète, téléchargeable et lisible.
    const [st2] = await drain(nouveau, { partRows: 500 });
    const ln = await ligne(nouveau);
    expect(st2, String(ln.error)).toMatch(/^(COMPLETE|PARTIAL)$/);
    expect(ln.attempt).toBe(1);
    as(admin);
    const res = await routes.download(req(`/api/admin/diagnostics/jobs/${nouveau}/download`), ctx(nouveau));
    expect(res.status).toBe(200);
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const manifeste = JSON.parse(await z.file('manifeste.json')!.async('string')) as Json;
    expect(manifeste.generationId).toBe(nouveau);
    expect(manifeste.request).toMatchObject({ scope: 'global', reinforced: true });
    expect(Object.keys(z.files).some((f) => /reconciliation_decisions\.part-\d{4}\.json$/.test(f))).toBe(true);
  }, 600_000);

  // ══ E05 ═════════════════════════════════════════════════════════════════
  it('L111C-E05 — remplacement pendant les ENVOIS : arrêt, objets et envois OVH incomplets supprimés ; archive finalisée antérieure conservée', async () => {
    await viderFile();
    // Archive finalisée (historique) : jamais touchée par un remplacement.
    const fini = String((await demander({ scope: 'account', id: A.id })).json.jobId);
    expect((await drain(fini))[0]).toBe('COMPLETE');
    const archive = objetsDe(fini).length;
    expect(archive).toBeGreaterThan(0);
    const ancien = String((await demander({ scope: 'global' })).json.jobId);
    s3.faults.delayMs = 40;
    s3.faults.delayKey = (x) => x.includes(ancien);
    const p = drain(ancien, { partRows: 500 });
    expect(await until(async () => { const l = await ligne(ancien); return l.status === 'RUNNING' && (l.progress as Json | null)?.filesDone > 3; }, 120_000)).toBe(true);
    const nouveau = String((await demander({ scope: 'global' })).json.jobId);
    const [st] = await p;
    s3.faults.delayMs = 0;
    expect(st).toBe('CANCELLED');
    expect(await ligne(ancien)).toMatchObject({ status: 'CANCELLED', error_code: 'REPLACED_BY_NEW_REQUEST', replaced_by: nouveau });
    expect(objetsDe(ancien)).toEqual([]);
    expect(envoisDe(ancien), 'aucun envoi en plusieurs parties laissé incomplet').toEqual([]);
    expect(objetsDe(fini)).toHaveLength(archive);
    expect(await ligne(fini)).toMatchObject({ status: 'COMPLETE', cancel_requested: false });
  }, 600_000);

  // ══ E06 ═════════════════════════════════════════════════════════════════
  it('L111C-E06 — publication tardive interdite : annulée → rien publié ; bail repris ailleurs → rien écrit', async () => {
    await viderFile();
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    const st = await import('@/services/admin/diagnostic-jobs/state');
    const ancien = String((await demander({ scope: 'global' })).json.jobId);
    const job = (await repo.claimNextDiagnosticJob('e2e-vieux:1:aaaa', null, { onlyId: ancien }))!;
    await repo.setDiagnosticPhase(ancien, 'e2e-vieux:1:aaaa', 'PUBLICATION');
    await demander({ scope: 'global' });
    const outcome = { status: 'COMPLETE' as const, snapshotAt: null, pgSnapshot: null, rowsExpected: 0, rowsExported: 0, batches: 0, bytes: 0, files: 0, sections: [], warning: null, fileName: 'x.zip', progress: { filesPlanned: 1, filesDone: 1, rows: 0, bytes: 0, compressedBytes: 0, current: null, rssMb: 1, peakRssMb: 1, heapUsedMb: 1, memoryLimitMb: null, updatedAt: new Date().toISOString() }, storagePrefix: `admin-exports/diagnostics/${ancien}/a1/` };
    await expect(repo.publishDiagnosticJob(job, 'e2e-vieux:1:aaaa', outcome)).rejects.toMatchObject({ diagCode: 'CANCELLED' });
    expect((await ligne(ancien)).status).toBe('RUNNING');
    // Étape suivante du vieux worker : refusée aussi (annulation lue sans attendre le bail).
    await expect(repo.setDiagnosticPhase(ancien, 'e2e-vieux:1:aaaa', 'TERMINE')).rejects.toBeInstanceOf(st.DiagJobError);
    expect(await repo.failDiagnosticAttempt(job, 'e2e-vieux:1:aaaa', { code: 'READ_TIMEOUT', phase: 'PUBLICATION', message: 'x', transient: true, progress: null })).toBe('CANCELLED');
    expect(await ligne(ancien)).toMatchObject({ status: 'CANCELLED', error_code: 'REPLACED_BY_NEW_REQUEST' });
    // Bail repris par un autre worker : l'ancien ne publie rien.
    await viderFile();
    const autre = String((await demander({ scope: 'account', id: A.id }, { key: key() })).json.jobId);
    const j2 = (await repo.claimNextDiagnosticJob('e2e-a:1:a', null, { onlyId: autre }))!;
    await sql`UPDATE admin_export_generations SET locked_by = 'e2e-b:2:b' WHERE id = ${autre}::uuid`;
    await expect(repo.publishDiagnosticJob(j2, 'e2e-a:1:a', { ...outcome, storagePrefix: `admin-exports/diagnostics/${autre}/a1/` })).rejects.toBeInstanceOf(repo.DiagLeaseLostError);
    expect((await ligne(autre)).status).toBe('RUNNING');
  });

  // ══ E07 ═════════════════════════════════════════════════════════════════
  it('L111C-E07 — redémarrage / perte de bail : demande remplacée jamais reprise, fichiers purgés ; arrêt avant l’instantané non décompté', async () => {
    await viderFile();
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    const ancien = String((await demander({ scope: 'global' })).json.jobId);
    await repo.claimNextDiagnosticJob('e2e-mort:1:dead', null, { onlyId: ancien });
    await repo.setDiagnosticPhase(ancien, 'e2e-mort:1:dead', 'EXTRACTION');
    s3.objects.set(`admin-exports/diagnostics/${ancien}/a1/donnees/partiel.json.gz`, { body: Buffer.from('x'), modified: new Date() });
    s3.uploads.set('u-orphelin', { key: `admin-exports/diagnostics/${ancien}/a1/donnees/incomplet.json.gz`, parts: [] });
    const nouveau = String((await demander({ scope: 'global' })).json.jobId);
    // Le processus meurt pendant l'arrêt coopératif : bail expiré.
    await sql`UPDATE admin_export_generations SET locked_until = now() - interval '1 second' WHERE id = ${ancien}::uuid`;
    const outs = await drain(nouveau, { partRows: 500 });
    expect(outs[0]).toMatch(/^(COMPLETE|PARTIAL)$/);
    expect(await ligne(ancien)).toMatchObject({ status: 'CANCELLED', error_code: 'REPLACED_BY_NEW_REQUEST', attempt: 1 });
    expect(objetsDe(ancien)).toEqual([]);
    expect(envoisDe(ancien)).toEqual([]);
    // Arrêt AVANT l'ouverture de l'instantané : tentative rendue (jamais de tentative décomptée sans démarrage).
    const cible = String((await demander({ scope: 'account', id: A.id }, { key: key() })).json.jobId);
    await repo.claimNextDiagnosticJob('e2e-mort:2:dead', null, { onlyId: cible });
    expect((await ligne(cible)).attempt).toBe(1);
    await sql`UPDATE admin_export_generations SET locked_until = now() - interval '1 second' WHERE id = ${cible}::uuid`;
    expect((await repo.recoverDiagnosticJobs()).requeued).toContain(cible);
    const l = await ligne(cible);
    expect(l).toMatchObject({ status: 'QUEUED', attempt: 0, error_code: 'WORKER_LOST' });
    expect((l.attempts_log as Json[])[0]).toMatchObject({ outcome: 'LOST_BEFORE_START' });
    expect(new Date(String(l.next_attempt_at)).getTime()).toBeLessThanOrEqual(Date.now());
    expect(String(l.error)).toMatch(/tentative non décomptée/);
  }, 600_000);

  // ══ E08 ═════════════════════════════════════════════════════════════════
  it('L111C-E08 — worker absent / désactivé / sans conteneur / mémoire / autre diagnostic : raison affichée, alerte BO, reprise automatique, aucune tentative décomptée', async () => {
    await viderFile();
    const sup = await import('@/services/admin/diagnostic-jobs/supervision');
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await sql`UPDATE admin_anomalies SET status = 'resolved', resolved_at = now() WHERE fingerprint LIKE 'other:diagnostic-jobs:%' AND status = 'open'`;

    // 1. Worker désactivé (cas proposé au PO le 03/11) : affiché DÈS la création, alerte immédiate.
    await battement({ id: 'web-1:200:off00001', state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED', lastTickAt: null, lastTickOkAt: null });
    const r = await demander({ scope: 'global', reinforced: true });
    const job = String(r.json.jobId);
    expect(r.json.wait).toMatchObject({ reason: 'WORKER_DISABLED', label: 'En attente — worker désactivé (DIAG_JOB_WORKER_DISABLED)' });
    expect(r.json.wait.action).toMatch(/Scalingo › Environnement/);
    expect(await until(async () => (await anomalies()).some((a) => a.status === 'open' && a.fingerprint.endsWith(':worker_disabled')), 10_000)).toBe(true);
    expect((await detail(job)).statusLabel).toBe('En attente — worker désactivé (DIAG_JOB_WORKER_DISABLED)');
    expect(await ligne(job)).toMatchObject({ wait_reason: 'WORKER_DISABLED', attempt: 0 });

    // 2. BACKGROUND_JOBS_PROCESS=worker, conteneur worker à 0.
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await battement({ id: 'web-1:201:nothere1', state: 'NOT_THIS_PROCESS', placement: 'worker', lastTickAt: null, lastTickOkAt: null });
    expect((await sup.diagnosticJobWait(job))!.diagnosis).toMatchObject({ reason: 'NO_WORKER_CONTAINER', alert: true });

    // 3. Aucun worker (processus arrêté) : demande ancienne de 10 min → alerte « worker indisponible ».
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await sql`UPDATE admin_export_generations SET started_at = now() - interval '10 minutes' WHERE id = ${job}::uuid`;
    const s1 = await sup.superviseDiagnosticQueue();
    expect(s1.alerted).toEqual(['WORKER_UNAVAILABLE']);
    const ouvertes = (await anomalies()).filter((a) => a.status === 'open');
    expect(ouvertes.map((a) => a.fingerprint)).toEqual(['other:diagnostic-jobs:queue-stalled:worker_unavailable']);
    expect(ouvertes[0].detail).toMatchObject({ reason: 'WORKER_UNAVAILABLE', jobId: job });
    expect((await ligne(job)).stall_alerted_at).toBeTruthy();

    // 4. Admission mémoire refusée au dernier tour.
    await battement({ id: 'web-1:202:mem00001', state: 'STARTED', waitReason: 'MEMORY_ADMISSION' });
    expect((await sup.diagnosticJobWait(job))!.diagnosis.reason).toBe('MEMORY_ADMISSION');

    // 5. Autre diagnostic ciblé en cours (créneau global de 1) : la globale attend, le ciblé n'est pas touché.
    await battement({ id: 'web-1:202:mem00001', state: 'STARTED', waitReason: 'GLOBAL_SLOT_BUSY' });
    const cible = String((await demander({ scope: 'account', id: A.id }, { key: key() })).json.jobId);
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    await sql`UPDATE admin_export_generations SET started_at = now() - interval '20 minutes' WHERE id = ${cible}::uuid`;
    await repo.claimNextDiagnosticJob('e2e-occupe:1:busy', null, { onlyId: cible });
    const w = (await sup.diagnosticJobWait(job))!;
    expect(w.diagnosis).toMatchObject({ reason: 'OTHER_DIAGNOSTIC_RUNNING', blockingJobId: cible });
    expect(w.label).toBe(`En attente — autre diagnostic en cours (${cible.slice(0, 8)})`);
    expect(await repo.claimNextDiagnosticJobDetailed('e2e-w:1:w', null, { onlyId: job })).toMatchObject({ job: null, blocked: 'GLOBAL_SLOT_BUSY' });
    expect((await ligne(job)).attempt, 'aucune tentative décomptée tant que rien n’a démarré').toBe(0);
    await sql`UPDATE admin_export_generations SET status = 'CANCELLED', locked_by = NULL, locked_until = NULL WHERE id = ${cible}::uuid`;

    // 6. Worker rétabli : reprise automatique, alertes résolues.
    await battement({ id: 'web-1:202:mem00001', state: 'STARTED', waitReason: 'NO_ELIGIBLE_JOB' });
    const [st] = await drain(job, { partRows: 500 });
    expect(st).toMatch(/^(COMPLETE|PARTIAL)$/);
    expect(await ligne(job)).toMatchObject({ attempt: 1 });
    const s2 = await sup.superviseDiagnosticQueue();
    expect(s2.alerted).toEqual([]);
    expect((await anomalies()).filter((a) => a.status === 'open')).toEqual([]);
  }, 600_000);

  // ══ E09 ═════════════════════════════════════════════════════════════════
  it('L111C-E09 — santé : battements de TOUTES les instances (pas seulement celle qui répond) et raison d’attente', async () => {
    await viderFile();
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await battement({ id: 'web-1:300:off00002', state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED', lastTickAt: null, lastTickOkAt: null });
    await battement({ id: 'worker-1:301:dead0001', process: 'worker', placement: 'worker', state: 'STARTED', seenAt: new Date(Date.now() - 3_600_000).toISOString() });
    const job = String((await demander({ scope: 'global' })).json.jobId);
    as(admin);
    const h = await (await routes.health(req('/api/admin/diagnostics/jobs/health'))).json() as Json;
    expect(h.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({ instance: 'web-1:300', state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED', alive: true }),
      expect.objectContaining({ instance: 'worker-1:301', state: 'STARTED', alive: false }),
    ]));
    expect(h.waits).toEqual([expect.objectContaining({ jobId: job, reason: 'WORKER_DISABLED', alert: true })]);
    expect(h.alerts.join('\n')).toMatch(/NO_LIVE_WORKER/);
    expect(h.alerts.join('\n')).toMatch(/WORKER_DISABLED : worker désactivé sur web-1:300 \(DIAG_JOB_WORKER_DISABLED\)/);
    expect(h.alerts.join('\n')).toMatch(new RegExp(`QUEUE_STALLED \\(WORKER_DISABLED\\) : diagnostic ${job.slice(0, 8)}`));
    expect(JSON.stringify(h)).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
    // Battement écrit par le vrai code (processus de test) : ligne lisible, sans secret.
    const { writeDiagnosticBeat, listDiagnosticBeats } = await import('@/services/admin/diagnostic-jobs/supervision');
    expect(await writeDiagnosticBeat({ instanceId: 'e2e-proc:1:beat0001', state: 'STARTED', startedAt: new Date().toISOString(), lastError: 'échec postgres://u:motdepasse@h/db', lastErrorAt: new Date().toISOString() })).toBe(true);
    const mine = (await listDiagnosticBeats())!.find((b) => b.instanceId === 'e2e-proc:1:beat0001')!;
    expect(mine).toMatchObject({ state: 'STARTED' });
    expect(mine.lastError).not.toContain('motdepasse');
    // Rien de stocké pour une demande jamais démarrée.
    expect(objetsDe(job)).toEqual([]);
  });
});
