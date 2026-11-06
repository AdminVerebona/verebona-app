/**
 * Lot 111Q — diagnostic CIBLÉ en file (ticket P1 du 05/11/2026 : « account #13
 * · renforcé » f191d635… EN FILE 4 min 12 s puis 6 min 21 s, 0/3, aucun
 * worker), sur PostgreSQL 16 réel, par les VRAIES routes BO (seule la lecture
 * du cookie de session est simulée), le VRAI worker (`drainDiagnosticJobs`,
 * voie principale et voie ciblée) et le VRAI superviseur ; stockage OVH S3
 * SIMULÉ en mémoire.
 *
 *   M01 mesure sur un jeu représentatif (compte : biens, documents, décisions,
 *       traces IA avec sorties modèle) — temps en file, exécution, total,
 *       durées par étape, taille du ZIP, fichiers, complétude (renforcé) ;
 *   Q01 ciblé standard puis renforcé, worker sain : pris au premier tour (voie
 *       commune), temps en file / exécution / total séparés, catégorie,
 *       profilage par étape, journaux corrélables, ZIP renforcé valide ;
 *   Q02 diagnostic global ACTIF, ANNULÉ en cours d'arrêt, BLOQUÉ (bail vivant
 *       sans progrès), ORPHELIN (bail expiré), TERMINÉ : aucun ne bloque un
 *       ciblé (voie réservée), capacité bornée (G + T), priorité aux ciblés ;
 *   Q03 worker absent puis relancé : raison lisible, alerte, 0 tentative,
 *       reprise automatique sans doublon, alerte résolue ; worker désactivé ;
 *   Q04 double clic / rejeu / nouvelle action identique / global demandé
 *       entre-temps / annulation en file et en cours / perte de bail / relance :
 *       idempotence, aucun remplacement des ciblés, aucun ZIP après annulation ;
 *   Q05 lecture du détail : garde administrateur inchangée (401 sans session,
 *       403 non administrateur), l'état du travail ne dépend pas des lectures.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import { workerHeadline } from '@/services/admin/diagnostic-jobs/wait';

type Json = Record<string, any>;

const s3 = vi.hoisted(() => {
  const objects = new Map<string, { body: Buffer; modified: Date }>();
  const uploads = new Map<string, { key: string; parts: Buffer[] }>();
  let n = 0;
  const client = {
    async send(c: { constructor: { name: string }; input: Record<string, any> }) {
      const i = c.input;
      switch (c.constructor.name) {
        case 'CreateMultipartUploadCommand': { const id = `u${++n}`; uploads.set(id, { key: i.Key, parts: [] }); return { UploadId: id }; }
        case 'UploadPartCommand': { const u = uploads.get(i.UploadId)!; u.parts[i.PartNumber - 1] = Buffer.from(i.Body); return { ETag: `e${i.PartNumber}` }; }
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
  return { objects, uploads, client };
});

vi.mock('@/lib/s3-config', async (orig) => ({
  ...(await orig<typeof import('@/lib/s3-config')>()),
  isS3Configured: () => true,
  getS3Bucket: () => 'bucket-e2e',
  getS3Client: () => s3.client,
}));

/** Nombre de traces IA du jeu représentatif (sorties modèle jointes au renforcé). */
const TRACES = 40;

scenario('L111Q', 'Diagnostic ciblé : prise en charge, voie réservée, métriques, profilage, session BO', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  afterAll(() => { vi.restoreAllMocks(); delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS; });
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  const routes = {} as Record<'jobsPOST' | 'detail' | 'cancel' | 'retry' | 'download' | 'health', Route>;
  const req = (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => new NextRequest(`http://app.test${url}`, {
    method: init?.method ?? 'GET', headers: { 'content-type': 'application/json', origin: 'http://app.test', host: 'app.test', ...(init?.headers ?? {}) },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let admin: { id: number; email: string };
  let A: AccountRow;
  const storage = { client: s3.client as never, bucket: 'bucket-e2e' };
  const as = (a: { id: number; email: string }) => { session.userId = a.id; session.role = 'ADMIN'; session.email = a.email; };
  let k = 0;
  const key = () => `cle-l111q-${Date.now()}-${++k}`;

  async function demander(body: Json, opts: { key?: string | null } = {}): Promise<{ status: number; json: Json }> {
    as(admin);
    const idem = opts.key === undefined ? key() : opts.key;
    const res = await routes.jobsPOST(req('/api/admin/diagnostics/jobs', { method: 'POST', body, headers: idem ? { 'idempotency-key': idem } : {} }));
    return { status: res.status, json: await res.json() as Json };
  }
  const ligne = async (id: string) => (await sql<Json[]>`SELECT * FROM admin_export_generations WHERE id = ${id}::uuid`)[0];
  const workerId = () => `e2e-111q:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  const viderFile = async () => { await sql`UPDATE admin_export_generations SET status = 'CANCELLED', locked_until = NULL, locked_by = NULL WHERE mode = 'job' AND status IN ('QUEUED', 'RUNNING')`; };

  beforeAll(async () => {
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    routes.jobsPOST = (await import('@/app/api/admin/diagnostics/jobs/route')).POST as Route;
    routes.detail = (await import('@/app/api/admin/diagnostics/jobs/[id]/route')).GET as Route;
    routes.cancel = (await import('@/app/api/admin/diagnostics/jobs/[id]/cancel/route')).POST as Route;
    routes.retry = (await import('@/app/api/admin/diagnostics/jobs/[id]/retry/route')).POST as Route;
    routes.download = (await import('@/app/api/admin/diagnostics/jobs/[id]/download/route')).GET as Route;
    routes.health = (await import('@/app/api/admin/diagnostics/jobs/health/route')).GET as Route;
    const u = await make.user({ role: 'ADMIN' });
    admin = { id: u.id, email: u.email };
    process.env.AI_MODEL_OUTPUT_ADMIN_IDS = String(admin.id);
    // ── Jeu représentatif d'un compte (diagnostic « compte · renforcé ») ──
    A = await make.account({ plan: 'premium', name: 'Compte L111Q' });
    const assets: number[] = [];
    for (let i = 0; i < 3; i++) assets.push((await make.asset(A, { category: i ? 'VEHICULE' : 'IMMOBILIER', name: `Bien L111Q ${i}` })).id);
    const files: number[] = [];
    for (let i = 0; i < 30; i++) files.push((await make.assetFile(A, { assetId: assets[i % 3] })).id);
    for (const [i, f] of files.entries()) {
      const ext = (await sql<{ id: number }[]>`
        INSERT INTO document_extractions (account_id, file_id, amount_cents, currency, document_date, supplier_name, full_text, provider, model, prompt_version, operation_trace_id)
        VALUES (${A.id}, ${f}, ${10_000 + i * 100}, 'EUR', '2026-03-02', ${`Fournisseur ${i % 7}`}, ${`TEXTE ${'x'.repeat(2000)}`}, 'gemini', 'gemini-2.5-pro', 't1_analyze_document@v5', ${`tr-l111q-${i % TRACES}`})
        RETURNING id`)[0].id;
      await sql`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_number, value_unit, raw_value, confidence, excerpt, status, provider, model, prompt_version)
                SELECT ${A.id}, ${f}, ${ext}, 'k' || g, 'k' || g, 'Libellé ' || g, g * 10, 'EUR', g::text, 'certain', 'extrait ' || g, 'active', 'gemini', 'gemini-2.5-pro', 't1_analyze_document@v5'
                  FROM generate_series(1, 8) g`;
    }
    const run = (await sql<{ id: number }[]>`INSERT INTO reconciliation_runs (account_id, asset_id, triggered_by, status) VALUES (${A.id}, ${assets[0]}, 'scheduled', 'completed') RETURNING id`)[0].id;
    await sql`INSERT INTO reconciliation_decisions (run_id, account_id, asset_id, field_key, action, reason_code, confidence, deterministic, evidence_ids)
              SELECT ${run}, ${A.id}, ${assets[0]}, 'champ_' || (g % 40), 'keep', 'R' || g, 'certain', true, '[]'::jsonb FROM generate_series(1, 3000) g`;
    for (let t = 0; t < TRACES; t++) {
      const usage = (await sql<{ id: number }[]>`
        INSERT INTO ai_usage_event (account_id, asset_file_id, operation_type, provider, model, status, input_tokens, output_tokens, metadata, operation_code, environment)
        VALUES (${A.id}, ${files[t % files.length]}, 'extraction', 'gemini', 'gemini-2.5-pro', 'success', 1200, 300, ${JSON.stringify({ traceId: `tr-l111q-${t}` })}::jsonb, 't1.analyze', 'test')
        RETURNING id`)[0].id;
      await sql`INSERT INTO ai_execution_reports (account_id, treatment, scope, trace_ids, file_id, asset_id, status, entry_count)
                VALUES (${A.id}, 'T1', 'DOCUMENT', ${[`tr-l111q-${t}`]}, ${files[t % files.length]}, ${assets[t % 3]}, 'SUCCESS', 1)`;
      await sql`INSERT INTO ai_call_diagnostics (trace_id, usage_event_id, call_index, account_id, operation_code, model, outcome, source_ids, raw_output, parsed_output, output_chars, contract_version)
                VALUES (${`tr-l111q-${t}`}, ${usage}, 0, ${A.id}, 't1.analyze', 'gemini-2.5-pro', 'SUCCEEDED', ${[files[t % files.length]]}, ${`{"sortie": "${'s'.repeat(6000)}", "t": ${t}}`},
                        ${JSON.stringify({ t })}::jsonb, 6020, 5)`;
    }
  }, 600_000);

  /** Exécute un diagnostic de bout en bout et mesure (temps, étapes, ZIP). */
  async function mesurer(body: Json): Promise<Json> {
    await viderFile();
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await sql`INSERT INTO diagnostic_worker_heartbeats (instance_id, process_type, placement, state, started_at, seen_at, last_tick_at, last_tick_ok_at, interval_ms)
              VALUES ('web-1:100:mesure01', 'web', 'web', 'STARTED', now() - interval '1 hour', now(), now(), now(), 10000)`;
    const phases: Array<{ phase: string; at: number }> = [];
    const orig = console.info;
    const spy = vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => {
      const m = /^\[diagnostic-job\] (\{.*\})$/.exec(String(a[0]));
      if (m) { try { const e = JSON.parse(m[1]); if (e.event === 'phase') phases.push({ phase: e.phase, at: Date.now() }); } catch { /* ignoré */ } }
      else orig(...a);
    });
    try {
      const t0 = Date.now();
      const r = await demander(body);
      expect(r.status).toBe(202);
      const id = String(r.json.jobId);
      const { drainDiagnosticJobs } = await import('@/services/admin/diagnostic-jobs/worker');
      const t1 = Date.now();
      const [st] = await drainDiagnosticJobs({ onlyId: id, storage, workerId: workerId() });
      const t2 = Date.now();
      const l = await ligne(id);
      expect(st, String(l.error)).toMatch(/^(COMPLETE|PARTIAL)$/);
      as(admin);
      const res = await routes.download(req(`/api/admin/diagnostics/jobs/${id}/download`), ctx(id));
      const zipBuf = Buffer.from(await res.arrayBuffer());
      const z = await JSZip.loadAsync(zipBuf);
      const manifeste = JSON.parse(await z.file('manifeste.json')!.async('string')) as Json;
      const parPhase: Record<string, number> = {};
      const debut = t1;
      for (let i = 0; i < phases.length; i++) parPhase[phases[i].phase] = (parPhase[phases[i].phase] ?? 0) + ((phases[i + 1]?.at ?? t2) - phases[i].at);
      parPhase.PLANIFICATION = (phases[0]?.at ?? t2) - debut;
      return {
        id, status: st, demandeMs: t1 - t0, executionMs: t2 - t1, zipBytes: zipBuf.length, fichiers: Object.keys(z.files).length,
        lignes: (manifeste.files as Json[]).reduce((n, f) => n + (f.count ?? 0), 0), statutManifeste: manifeste.status,
        sortiesModele: z.file('ia/sorties-modele.json') ? (JSON.parse(await z.file('ia/sorties-modele.json')!.async('string')) as Json[]).length : null,
        parPhase, ligne: l, zip: z, manifeste,
      };
    } finally {
      spy.mockRestore();
    }
  }

  // ══ M01 ═════════════════════════════════════════════════════════════════
  it('L111Q-M01 — mesure : compte standard et renforcé (temps, étapes, ZIP, complétude, sorties IA jointes)', async () => {
    const out: Json[] = [];
    // Premier passage : chauffe (chargement des modules du moteur), non mesuré.
    await mesurer({ scope: 'account', id: A.id, reinforced: false });
    for (const reinforced of [false, true, false, true]) {
      const m = await mesurer({ scope: 'account', id: A.id, reinforced });
      if (reinforced) {
        // Restriction d'accès existante (DIAG_LIMITS.modelOutputTraces, inchangée) : jointes jusqu'à la borne, le reste DÉCLARÉ (jamais silencieux).
        const { DIAG_LIMITS } = await import('@/services/admin/diagnostics-export/model');
        expect(m.sortiesModele).toBe(Math.min(TRACES, DIAG_LIMITS.modelOutputTraces));
        if (TRACES > DIAG_LIMITS.modelOutputTraces) expect((m.manifeste.truncations as string[]).join('\n')).toContain(`ia/sorties-modele.json : ${DIAG_LIMITS.modelOutputTraces} trace(s) jointe(s) sur ${TRACES}`);
      }
      out.push({ reinforced, status: m.status, executionMs: m.executionMs, zipKo: Math.round(m.zipBytes / 1024), fichiers: m.fichiers, lignes: m.lignes, statutManifeste: m.statutManifeste, sortiesModele: m.sortiesModele, parPhase: m.parPhase, timings: m.ligne.phase_timings ?? null });
    }
    console.warn(`[L111Q-M01] ${JSON.stringify(out)}`);
  }, 600_000);
  // ── Outils des cas Q ─────────────────────────────────────────────────────
  const detail = async (id: string) => { as(admin); return await (await routes.detail(req(`/api/admin/diagnostics/jobs/${id}`), ctx(id))).json() as Json; };
  async function battement(p: Json) {
    await sql`INSERT INTO diagnostic_worker_heartbeats (instance_id, process_type, placement, state, disabled_reason, started_at, seen_at, last_tick_at, last_tick_ok_at, wait_reason, interval_ms,
                current_job_id, lane_job_id, lane_wait_reason, lane_capacity)
              VALUES (${p.id}, 'web', ${p.placement ?? 'web'}, ${p.state ?? 'STARTED'}, ${p.disabledReason ?? null}, now() - interval '1 hour', ${p.seenAt ?? new Date().toISOString()}::timestamptz,
                      ${p.lastTickAt === undefined ? new Date().toISOString() : p.lastTickAt}::timestamptz, now(), ${p.waitReason ?? 'NO_ELIGIBLE_JOB'}, 10000,
                      ${p.currentJobId ?? null}::uuid, ${p.laneJobId ?? null}::uuid, ${p.laneWaitReason ?? null}, ${p.laneCapacity === undefined ? 1 : p.laneCapacity})
              ON CONFLICT (instance_id) DO UPDATE SET state = EXCLUDED.state, disabled_reason = EXCLUDED.disabled_reason, placement = EXCLUDED.placement, seen_at = EXCLUDED.seen_at,
                last_tick_at = EXCLUDED.last_tick_at, wait_reason = EXCLUDED.wait_reason, current_job_id = EXCLUDED.current_job_id, lane_job_id = EXCLUDED.lane_job_id,
                lane_wait_reason = EXCLUDED.lane_wait_reason, lane_capacity = EXCLUDED.lane_capacity`;
  }
  const anomalies = async () => sql<Json[]>`SELECT fingerprint, status FROM admin_anomalies WHERE fingerprint LIKE 'other:diagnostic-jobs:queue-stalled:%' AND status = 'open'`;
  async function drain(extra: Json = {}) {
    const { drainDiagnosticJobs } = await import('@/services/admin/diagnostic-jobs/worker');
    return drainDiagnosticJobs({ storage, workerId: workerId(), heartbeatMs: 200, cancelPollMs: 100, ...extra });
  }
  /** Diagnostic global « en cours » tenu par un autre processus (bail vivant, aucun progrès). */
  async function globalEnCours(opts: Json = {}): Promise<string> {
    const g = String((await demander({ scope: 'global' })).json.jobId);
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    const job = await repo.claimNextDiagnosticJob('e2e-global:1:glob', null, { onlyId: g });
    expect(job?.id).toBe(g);
    await repo.setDiagnosticPhase(g, 'e2e-global:1:glob', 'EXTRACTION');
    if (opts.lockedUntil) await sql`UPDATE admin_export_generations SET locked_until = ${opts.lockedUntil}::timestamptz WHERE id = ${g}::uuid`;
    return g;
  }
  const preuveZip = async (id: string) => {
    as(admin);
    const res = await routes.download(req(`/api/admin/diagnostics/jobs/${id}/download`), ctx(id));
    expect(res.status).toBe(200);
    const z = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const manifeste = JSON.parse(await z.file('manifeste.json')!.async('string')) as Json;
    const sums = (await z.file('SHA256SUMS.txt')!.async('string')).trim().split('\n').map((l) => l.split(/\s+/));
    const { createHash } = await import('node:crypto');
    for (const [h, path] of sums.slice(0, 40)) expect(createHash('sha256').update(await z.file(path)!.async('nodebuffer')).digest('hex'), path).toBe(h);
    return { z, manifeste };
  };

  // ══ Q01 ═════════════════════════════════════════════════════════════════
  it('L111Q-Q01 — ciblé standard puis renforcé : pris au premier tour, métriques séparées, profilage, journaux corrélables, ZIP renforcé valide', async () => {
    await viderFile();
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await battement({ id: 'web-1:10:sain0001' });
    const logs: Json[] = [];
    const orig = console.info;
    const spy = vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => {
      const m = /^\[diagnostic-job\] (\{.*\})$/.exec(String(a[0]));
      if (m) { try { logs.push(JSON.parse(m[1])); } catch { /* ignoré */ } } else orig(...a);
    });
    try {
      for (const reinforced of [false, true]) {
        const r = await demander({ scope: 'account', id: A.id, reinforced });
        expect(r.status).toBe(202);
        const id = String(r.json.jobId);
        expect(r.json).toMatchObject({ status: 'QUEUED', duplicate: false, replaced: [] });
        expect(r.json.wait).toMatchObject({ reason: 'PICKUP_PENDING' });
        const d0 = await detail(id);
        expect(d0.category).toEqual({ code: 'EN_FILE', label: 'En file' });
        expect(d0.metrics).toMatchObject({ started: false, executionMs: null });
        expect(d0.workerView).toMatchObject({ instance: 'web-1:10', alive: true });
        // Un tour normal du worker (voie commune, sans `onlyId`).
        const [st] = await drain();
        expect(st).toMatch(/^(COMPLETE|PARTIAL)$/);
        const l = await ligne(id);
        expect(l).toMatchObject({ attempt: 1, lane: 'main' });
        expect(l.first_run_started_at).toBeTruthy();
        const d = await detail(id);
        expect(d.category).toEqual({ code: 'TERMINE', label: 'Terminé' });
        expect(d.metrics.started).toBe(true);
        expect(d.metrics.queueWaitMs).toBeLessThan(60_000);
        expect(d.metrics.executionMs).toBeGreaterThan(0);
        expect(d.metrics.totalElapsedMs).toBeGreaterThanOrEqual(d.metrics.executionMs);
        expect(d.timings).toMatchObject({ schema: 'verebona.bo.diagnostic-profilage/1', attempt: 1, lane: 'main', final: { status: st } });
        expect(Object.keys(d.timings.phases)).toEqual(expect.arrayContaining(['NETTOYAGE', 'INSTANTANE', 'INVENTAIRE', 'EXTRACTION', 'VALIDATION', 'PUBLICATION']));
        expect(d.timings.slowestFiles.length).toBeGreaterThan(0);
        const { z, manifeste } = await preuveZip(id);
        expect(manifeste.request).toMatchObject({ scope: 'account', id: A.id, reinforced });
        expect(Object.keys(z.files).includes('ia/sorties-modele.json')).toBe(reinforced);
        // Journaux corrélables : travail, demande, périmètre, worker, version, étape.
        const claimed = logs.find((x) => x.event === 'claimed' && x.jobId === id)!;
        expect(claimed).toMatchObject({ requestId: l.request_id, scope: 'account', targetId: A.id, reinforced, lane: 'main' });
        const published = logs.find((x) => x.event === 'published' && x.jobId === id)!;
        expect(published).toMatchObject({ requestId: l.request_id, scope: 'account', targetId: A.id, attempt: 1, lane: 'main' });
        expect(published).toHaveProperty('commit');
        expect(published).toHaveProperty('version');
        expect(published.queueWaitMs).toBeGreaterThanOrEqual(0);
        expect(published.phases.EXTRACTION).toBeGreaterThanOrEqual(0);
        expect(logs.some((x) => x.event === 'phase' && x.jobId === id && x.requestId === l.request_id && typeof x.previousMs === 'number')).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  }, 600_000);

  // ══ Q02 ═════════════════════════════════════════════════════════════════
  it('L111Q-Q02 — global actif / annulé / bloqué / orphelin / terminé : jamais de blocage des ciblés ; capacité bornée ; priorité aux ciblés', async () => {
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    const sup = await import('@/services/admin/diagnostic-jobs/supervision');
    await sql`DELETE FROM diagnostic_worker_heartbeats`;

    // 1. Global ACTIF sur la voie commune : le ciblé part sur la voie réservée, pendant que le global tourne.
    await viderFile();
    const g = await globalEnCours();
    await battement({ id: 'web-1:20:occupe01', currentJobId: g, waitReason: 'PROCESSING' });
    const c1 = String((await demander({ scope: 'account', id: A.id, reinforced: true })).json.jobId);
    const w1 = (await sup.diagnosticJobWait(c1))!;
    expect(w1.diagnosis.reason, 'un global en cours ne fait plus attendre un ciblé').toBe('PICKUP_PENDING');
    // La voie réservée ne prend JAMAIS un global.
    expect(await repo.claimNextDiagnosticJobDetailed('e2e-v:1:v', null, { lane: 'targeted', onlyId: g })).toMatchObject({ job: null });
    const [st1] = await drain({ lane: 'targeted' });
    expect(st1).toMatch(/^(COMPLETE|PARTIAL)$/);
    expect(await ligne(c1)).toMatchObject({ lane: 'targeted', attempt: 1 });
    expect((await ligne(g)).status, 'le global continue, intact').toBe('RUNNING');

    // 2. Capacité : global + ciblé en cours (G + T = 2) → un troisième attend, raison et référence affichées.
    const c2 = String((await demander({ scope: 'account', id: A.id })).json.jobId);
    await repo.claimNextDiagnosticJob('e2e-c2:1:c2', null, { onlyId: c2, lane: 'targeted' });
    const u = await make.user();
    const c3 = String((await demander({ scope: 'user', id: u.id })).json.jobId);
    expect(await repo.claimNextDiagnosticJobDetailed('e2e-c3:1:c3', null, { onlyId: c3, lane: 'targeted' })).toMatchObject({ job: null, blocked: 'TARGETED_SLOT_BUSY' });
    expect(await repo.claimNextDiagnosticJobDetailed('e2e-c3:1:c3', null, { onlyId: c3 })).toMatchObject({ job: null, blocked: 'GLOBAL_SLOT_BUSY' });
    expect((await sup.diagnosticJobWait(c3))!.diagnosis).toMatchObject({ reason: 'OTHER_DIAGNOSTIC_RUNNING', blockingJobId: c2 });
    expect((await detail(c3)).category.label).toBe('Attente de ressource');
    expect((await ligne(c3)).attempt).toBe(0);
    await sql`UPDATE admin_export_generations SET status = 'CANCELLED', locked_by = NULL, locked_until = NULL WHERE id = ${c2}::uuid`;

    // 3. Global ANNULÉ (annulation demandée, arrêt en cours, bail vivant) : le ciblé c3 part quand même.
    await repo.cancelDiagnosticJob(g, admin.id);
    expect((await ligne(g))).toMatchObject({ status: 'RUNNING', cancel_requested: true });
    expect((await sup.diagnosticJobWait(c3))!.diagnosis.reason).not.toBe('STOPPING_REPLACED');
    expect((await drain({ lane: 'targeted' }))[0]).toMatch(/^(COMPLETE|PARTIAL)$/);
    await viderFile();

    // 4. Global BLOQUÉ (bail vivant, plus aucun progrès) remplacé : le nouveau global attend, le ciblé non.
    const g2 = await globalEnCours();
    const g3 = String((await demander({ scope: 'global' })).json.jobId);
    expect((await ligne(g2)).cancel_requested).toBe(true);
    const c4 = String((await demander({ scope: 'document', id: 999_999_001 })).json.jobId);
    expect(await repo.claimNextDiagnosticJobDetailed('e2e-w:1:w', null, { onlyId: g3 })).toMatchObject({ job: null, blocked: 'GLOBAL_DIAGNOSTIC_STOPPING' });
    const pris = await repo.claimNextDiagnosticJob('e2e-w:2:w', null, { lane: 'targeted' });
    expect(pris?.id, 'le ciblé passe devant, le global en arrêt n’occupe pas la voie réservée').toBe(c4);
    await viderFile();

    // 5. Global ORPHELIN (processus mort, bail expiré) : rattrapé, le ciblé part sur la voie commune.
    const g4 = await globalEnCours({ lockedUntil: new Date(Date.now() - 1000).toISOString() });
    const c5 = String((await demander({ scope: 'account', id: A.id })).json.jobId);
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await battement({ id: 'web-1:21:libre001' });
    expect((await sup.diagnosticJobWait(c5))!.diagnosis.reason).toBe('PICKUP_PENDING');
    const [st5] = await drain();
    // Priorité aux ciblés : le ciblé est pris avant le global remis en file.
    expect(st5).toMatch(/^(COMPLETE|PARTIAL)$/);
    expect((await ligne(c5)).status).toMatch(/^(COMPLETE|PARTIAL)$/);
    expect((await ligne(g4)).status).toBe('QUEUED');
    await viderFile();

    // 6. Global TERMINÉ : rien ne retient le ciblé ; priorité aux ciblés sur un global plus ancien en file.
    const gq = String((await demander({ scope: 'global' })).json.jobId);
    const c6 = String((await demander({ scope: 'account', id: A.id })).json.jobId);
    const first = await repo.claimNextDiagnosticJob('e2e-p:1:p', null);
    expect(first?.id, 'le ciblé, plus récent, passe avant le global en file').toBe(c6);
    expect((await ligne(gq)).status).toBe('QUEUED');
    await viderFile();
  }, 600_000);

  // ══ Q03 ═════════════════════════════════════════════════════════════════
  it('L111Q-Q03 — worker absent puis relancé : raison lisible, alerte, 0 tentative, reprise sans doublon, alerte résolue ; worker désactivé', async () => {
    await viderFile();
    const sup = await import('@/services/admin/diagnostic-jobs/supervision');
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await sql`UPDATE admin_anomalies SET status = 'resolved', resolved_at = now() WHERE fingerprint LIKE 'other:diagnostic-jobs:%' AND status = 'open'`;
    // Worker désactivé (DIAG_JOB_WORKER_DISABLED=true, cause candidate du 05/11) : dit dès la demande.
    await battement({ id: 'web-1:30:off00001', state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED', lastTickAt: null });
    const r = await demander({ scope: 'account', id: A.id, reinforced: true });
    const id = String(r.json.jobId);
    expect(r.json.wait).toMatchObject({ reason: 'WORKER_DISABLED' });
    const d = await detail(id);
    expect(d.category).toEqual({ code: 'WORKER_INDISPONIBLE', label: 'Worker indisponible' });
    expect(d.statusLabel).toBe('En attente — worker désactivé (DIAG_JOB_WORKER_DISABLED)');
    // Lot 113K (#699, recette KO du 06/11) : plus jamais « Worker disponible » pour un processus désactivé.
    expect(d.workerView).toMatchObject({ state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED', aliveWorkers: 0 });
    expect(workerHeadline(d.workerView, d.job.status)).toEqual({ code: 'DISABLED', label: 'Worker désactivé (DIAG_JOB_WORKER_DISABLED)', problem: true });
    // Alerte immédiate (superviseur lancé par la demande, en tâche de fond) : attendue avant la suite.
    const t0 = Date.now();
    while (!(await anomalies()).some((x) => x.fingerprint.endsWith(':worker_disabled')) && Date.now() - t0 < 10_000) await new Promise((res) => setTimeout(res, 50));
    expect((await anomalies()).map((x) => x.fingerprint)).toContain('other:diagnostic-jobs:queue-stalled:worker_disabled');
    // Worker absent (aucun processus vivant) depuis 6 min 21 s : alerte, toujours 0 tentative.
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await sql`UPDATE admin_export_generations SET started_at = now() - interval '381 seconds' WHERE id = ${id}::uuid`;
    const s1 = await sup.superviseDiagnosticQueue();
    expect(s1.alerted).toContain('WORKER_UNAVAILABLE');
    expect((await anomalies()).map((a) => a.fingerprint)).toContain('other:diagnostic-jobs:queue-stalled:worker_unavailable');
    expect(await ligne(id)).toMatchObject({ attempt: 0, wait_reason: 'WORKER_UNAVAILABLE' });
    const dq = await detail(id);
    expect(dq.metrics).toMatchObject({ started: false, executionMs: null });
    expect(dq.metrics.queueWaitMs).toBeGreaterThanOrEqual(380_000);
    // Worker relancé : reprise automatique, une seule exécution, alerte résolue.
    await battement({ id: 'web-1:31:retour01' });
    const dr = await detail(id);
    expect(workerHeadline(dr.workerView, dr.job.status).code, 'worker rétabli : disponible').toBe('AVAILABLE');
    const outs = await drain({ maxJobs: 3 });
    expect(outs).toHaveLength(1);
    expect(outs[0]).toMatch(/^(COMPLETE|PARTIAL)$/);
    expect(await ligne(id)).toMatchObject({ attempt: 1 });
    expect((await sup.superviseDiagnosticQueue()).alerted).toEqual([]);
    expect(await anomalies()).toEqual([]);
    const fin = await detail(id);
    expect(fin.metrics.queueWaitMs, 'temps en file conservé après démarrage').toBeGreaterThanOrEqual(380_000);
    expect(fin.metrics.executionMs).toBeLessThan(fin.metrics.queueWaitMs);
  }, 600_000);

  // ══ Q04 ═════════════════════════════════════════════════════════════════
  it('L111Q-Q04 — double clic / rejeu / nouvelle action / global entre-temps / annulation / perte de bail / relance', async () => {
    await viderFile();
    const repo = await import('@/services/admin/diagnostic-jobs/repository');
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await battement({ id: 'web-1:40:sain0004' });
    const cle = key();
    const a = await demander({ scope: 'account', id: A.id, reinforced: true }, { key: cle });
    const id = String(a.json.jobId);
    // Double clic / rejeu réseau (même clé) puis nouvelle action identique (nouvelle clé) : même travail, jamais remplacé.
    expect((await demander({ scope: 'account', id: A.id, reinforced: true }, { key: cle })).json).toMatchObject({ jobId: id, duplicate: true, replaced: [] });
    expect((await demander({ scope: 'account', id: A.id, reinforced: true })).json).toMatchObject({ jobId: id, duplicate: true, replaced: [] });
    // Un global demandé entre-temps (règle 111C de remplacement) ne touche pas le ciblé.
    const gl = await demander({ scope: 'global' });
    expect(gl.json.replaced).toEqual([]);
    expect(await ligne(id)).toMatchObject({ status: 'QUEUED', cancel_requested: false, replaced_by: null });
    await repo.cancelDiagnosticJob(String(gl.json.jobId), admin.id);
    // Annulation en file : CANCELLED immédiat, 0 tentative ; nouvelle demande identique = nouveau travail.
    as(admin);
    expect((await (await routes.cancel(req(`/api/admin/diagnostics/jobs/${id}/cancel`, { method: 'POST' }), ctx(id))).json() as Json)).toMatchObject({ outcome: expect.stringMatching(/CANCELLED/) });
    expect(await ligne(id)).toMatchObject({ status: 'CANCELLED', attempt: 0, error_code: 'CANCELLED' });
    expect((await detail(id)).category.label).toBe('Annulé');
    const b = String((await demander({ scope: 'account', id: A.id, reinforced: true })).json.jobId);
    expect(b).not.toBe(id);
    // Annulation PENDANT la génération (avant publication) : aucun ZIP publié, fichiers supprimés.
    const job = (await repo.claimNextDiagnosticJob('e2e-run:1:run', null, { onlyId: b }))!;
    await repo.setDiagnosticPhase(b, 'e2e-run:1:run', 'PUBLICATION');
    await repo.cancelDiagnosticJob(b, admin.id);
    const outcome = { status: 'COMPLETE' as const, snapshotAt: null, pgSnapshot: null, rowsExpected: 0, rowsExported: 0, batches: 0, bytes: 0, files: 0, sections: [], warning: null, fileName: 'x.zip', progress: { filesPlanned: 1, filesDone: 1, rows: 0, bytes: 0, compressedBytes: 0, current: null, rssMb: 1, peakRssMb: 1, heapUsedMb: 1, memoryLimitMb: null, updatedAt: new Date().toISOString() }, storagePrefix: `admin-exports/diagnostics/${b}/a1/` };
    await expect(repo.publishDiagnosticJob(job, 'e2e-run:1:run', outcome)).rejects.toMatchObject({ diagCode: 'CANCELLED' });
    expect(await repo.failDiagnosticAttempt(job, 'e2e-run:1:run', { code: 'GENERATION_FAILED', phase: 'PUBLICATION', message: 'x', transient: false, progress: null, cancelled: true })).toBe('CANCELLED');
    expect((await ligne(b))).toMatchObject({ status: 'CANCELLED', error_code: 'CANCELLED' });
    as(admin);
    expect((await routes.download(req(`/api/admin/diagnostics/jobs/${b}/download`), ctx(b))).status).not.toBe(200);
    // Perte de bail avant l'instantané : tentative rendue ; reprise : une seule exécution, attempt 1.
    const c = String((await demander({ scope: 'account', id: A.id })).json.jobId);
    await repo.claimNextDiagnosticJob('e2e-mort:1:dead', null, { onlyId: c });
    await sql`UPDATE admin_export_generations SET locked_until = now() - interval '1 second' WHERE id = ${c}::uuid`;
    const [st] = await drain();
    expect(st).toMatch(/^(COMPLETE|PARTIAL)$/);
    const lc = await ligne(c);
    expect(lc.attempt).toBe(1);
    expect((lc.attempts_log as Json[]).map((x) => x.outcome)).toEqual(['LOST_BEFORE_START', st]);
    // Relance (double clic) : un seul enfant.
    as(admin);
    const r1 = await (await routes.retry(req(`/api/admin/diagnostics/jobs/${c}/retry`, { method: 'POST' }), ctx(c))).json() as Json;
    const r2 = await (await routes.retry(req(`/api/admin/diagnostics/jobs/${c}/retry`, { method: 'POST' }), ctx(c))).json() as Json;
    expect(r2.jobId).toBe(r1.jobId);
    await viderFile();
  }, 600_000);

  // ══ Q05 ═════════════════════════════════════════════════════════════════
  it('L111Q-Q05 — lecture du détail : garde administrateur inchangée ; état du travail indépendant des lectures', async () => {
    await viderFile();
    const id = String((await demander({ scope: 'account', id: A.id })).json.jobId);
    const avant = await ligne(id);
    // Sans session (cookie absent) : la garde répond 401, aucun détail exposé.
    const { SessionService } = await import('@/lib/session-service');
    vi.mocked(SessionService.getSession).mockImplementationOnce(async () => { throw new Error('AUTH_REQUIRED'); });
    const sansSession = await routes.detail(req(`/api/admin/diagnostics/jobs/${id}`), ctx(id));
    expect(sansSession.status).toBe(401);
    expect(JSON.stringify(await sansSession.json())).not.toContain(id);
    const u = await make.user();
    session.userId = u.id; session.role = 'USER'; session.email = u.email;
    const nonAdmin = await routes.detail(req(`/api/admin/diagnostics/jobs/${id}`), ctx(id));
    expect(nonAdmin.status).toBe(403);
    expect(JSON.stringify(await nonAdmin.json())).not.toContain(id);
    for (let i = 0; i < 5; i++) await detail(id);
    const apres = await ligne(id);
    expect({ status: apres.status, attempt: apres.attempt, locked_by: apres.locked_by }).toEqual({ status: avant.status, attempt: avant.attempt, locked_by: avant.locked_by });
    const d = await detail(id);
    expect(Date.parse(d.readAt)).toBeGreaterThan(Date.now() - 60_000);
    await viderFile();
  });

  // ══ L113K ═══════════════════════════════════════════════════════════════
  it('L113K — libellé du worker d’une demande en file : désactivé, processus sans worker, hors ligne, disponible (jamais « disponible » à tort)', async () => {
    await viderFile();
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    const r = await demander({ scope: 'account', id: A.id, reinforced: true });
    const id = String(r.json.jobId);
    const vue = async () => { const d = await detail(id); expect(d.job.status).toBe('QUEUED'); return { d, h: workerHeadline(d.workerView, d.job.status) }; };
    // Processus web sans worker (BACKGROUND_JOBS_PROCESS=worker) : « Processus sans worker ».
    await battement({ id: 'web-1:40:nowk0001', state: 'NOT_THIS_PROCESS', lastTickAt: null });
    expect((await vue()).h).toMatchObject({ code: 'NO_WORKER_IN_PROCESS', problem: true });
    // Processus désactivé, vu juste avant : reste désactivé (cas de la préproduction du 06/11).
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await battement({ id: 'app-preprod-web-1:23:off00001', state: 'DISABLED', disabledReason: 'DIAG_JOB_WORKER_DISABLED', lastTickAt: null });
    const des = await vue();
    expect(des.d.workerView).toMatchObject({ instance: 'app-preprod-web-1:23', state: 'DISABLED', aliveWorkers: 0 });
    expect(des.h.label).toBe('Worker désactivé (DIAG_JOB_WORKER_DISABLED)');
    // Worker démarré mais battement périmé (> 90 s) : « hors ligne ».
    await sql`DELETE FROM diagnostic_worker_heartbeats`;
    await battement({ id: 'web-1:41:vieux001', seenAt: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect((await vue()).h).toMatchObject({ code: 'OFFLINE', problem: true });
    // Worker démarré et vivant : seul cas « Worker disponible ».
    await battement({ id: 'web-1:42:sain0001' });
    const ok = await vue();
    expect(ok.d.workerView).toMatchObject({ instance: 'web-1:42', state: 'STARTED', alive: true, aliveWorkers: 1 });
    expect(ok.h).toEqual({ code: 'AVAILABLE', label: 'Worker disponible', problem: false });
    // Et la demande part : aucune attente injustifiée une fois le worker disponible.
    const [st] = await drain();
    expect(st).toMatch(/^(COMPLETE|PARTIAL)$/);
    expect(await ligne(id)).toMatchObject({ attempt: 1 });
  }, 600_000);
});
