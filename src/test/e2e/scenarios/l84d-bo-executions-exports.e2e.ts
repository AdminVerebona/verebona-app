/**
 * Lot 84D — CDC Pilotage IA V2, phase P3 « BO Exécutions & logs + exports »,
 * sur PostgreSQL 16 réel, par les VRAIES routes BO (garde administrateur
 * réelle : seule la lecture du cookie de session est simulée) ; stockage OVH
 * S3 SIMULÉ en mémoire (envois en plusieurs parties, lectures en flux).
 * Assertions limitées aux comptes et travaux créés par ce scénario.
 *
 *   L84D-E2E-MIG  migration 0692 idempotente : suivi des générations existant
 *                 réutilisé (kind AI_EXECUTIONS_EXPORT, resume_state), AUCUNE table
 *   L84D-E2E-01   R24 : cartes = liste = export (mêmes nombres, mêmes identifiants,
 *                 même règle temporelle) ; technique hors cartes
 *   L84D-E2E-02   R27 : plus de 500 exécutions exportées sans perte ni doublon
 *                 (parties, SHA-256, attendu = exporté), appels corrélés, volumes ZIP
 *                 fractionnés (index commun), fichiers JSONL et manifeste téléchargeables
 *   L84D-E2E-03   filtres : traitement, issue, nature, origine, période, compte
 *                 (liste et export identiques)
 *   L84D-E2E-04   droits : non-admin refusé partout ; admin hors AI_MODEL_OUTPUT_ADMIN_IDS
 *                 ne voit jamais les contenus (détail, export unitaire et groupé,
 *                 téléchargement, échanges) ; admin habilité les obtient
 *   L84D-E2E-05   R28 / R64 : export volumineux interrompu puis REPRIS (arrêt au point
 *                 de reprise ; processus disparu) — ni doublon ni perte, nouvelles
 *                 exécutions postérieures exclues, reprise tracée au manifeste
 *   L84D-E2E-06   détail (ce qui manque, causes, appels de tous les modèles, relance
 *                 EXISTANTE liée à l'exécution d'origine) et journalisation (consultation,
 *                 exports, téléchargements, relance, refus)
 *   L84D-E2E-07   collecteur 77C : T2 et T6 ajoutés (demandes, générations FORMULATE)
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';
import { runMigrationSql, type SqlRunner } from '@/db/migration-index';

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
        case 'UploadPartCommand': { uploads.get(i.UploadId)!.parts[i.PartNumber - 1] = Buffer.from(i.Body); return { ETag: `e${i.PartNumber}` }; }
        case 'CompleteMultipartUploadCommand': {
          const u = uploads.get(i.UploadId)!;
          objects.set(i.Key, { body: Buffer.concat(u.parts), modified: new Date() });
          uploads.delete(i.UploadId);
          return {};
        }
        case 'AbortMultipartUploadCommand': uploads.delete(i.UploadId); return {};
        case 'PutObjectCommand': objects.set(i.Key, { body: Buffer.from(i.Body), modified: new Date() }); return {};
        case 'ListObjectsV2Command':
          return { Contents: [...objects.entries()].filter(([k]) => k.startsWith(i.Prefix ?? '')).map(([Key, o]) => ({ Key, LastModified: o.modified, Size: o.body.length })), IsTruncated: false };
        case 'GetObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
          const { Readable } = await import('node:stream');
          const chunks: Buffer[] = [];
          for (let k = 0; k < o.body.length; k += 65_536) chunks.push(o.body.subarray(k, k + 65_536));
          const r = Readable.from(chunks, { objectMode: false }) as unknown as Record<string, unknown>;
          r.transformToString = async () => o.body.toString('utf8');
          return { Body: r };
        }
        case 'DeleteObjectsCommand': for (const x of i.Delete.Objects) objects.delete(x.Key); return {};
        default: throw new Error(`commande S3 non simulée : ${c.constructor.name}`);
      }
    },
  };
  return { objects, client };
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
const N_OK = 645;

scenario('L84D', 'BO Exécutions & logs et exports des exécutions IA (Pilotage IA V2 P3)', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  const R = {} as Record<'list' | 'detail' | 'unit' | 'exportsGET' | 'exportsPOST' | 'genGET' | 'genPOST' | 'download' | 'retry' | 'modelOutput', Route>;
  const req = (url: string, init?: { method?: string; body?: unknown }) => new NextRequest(`http://app.test${url}`, {
    method: init?.method ?? 'GET', headers: { 'content-type': 'application/json', origin: 'http://app.test', host: 'app.test' },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let adminOk: { id: number; email: string };
  let adminSans: { id: number; email: string };
  let user: { id: number; email: string };
  let C: { id: number; ownerUserId: number };
  let autre: { id: number };
  const ids: Record<string, string> = {};
  let okIds: string[] = [];
  let adminIdsAvant: string | undefined;
  const as = (u: { id: number; email: string }, role: string) => { session.userId = u.id; session.role = role; session.email = u.email; };

  const stored = (key: string) => {
    const o = s3.objects.get(key);
    if (!o) throw new Error(`objet absent : ${key}`);
    return key.endsWith('.gz') ? gunzipSync(o.body) : o.body;
  };
  const lines = (buf: Buffer) => buf.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json);
  const svc = () => import('@/services/ai/business-execution/export');

  /** Lance un export par la route, attend la tâche de fond, rend le manifeste stocké. */
  async function exporter(body: Json): Promise<{ id: string; m: Json; prefix: string }> {
    const res = await R.exportsPOST(req('/api/admin/ai/business-executions/exports', { method: 'POST', body }));
    expect(res.status, await res.clone().text()).toBe(202);
    const { generationId, storagePrefix } = await res.json() as { generationId: string; storagePrefix: string };
    await (await svc()).waitForExecutionsExport(generationId);
    return { id: generationId, m: JSON.parse(stored(`${storagePrefix}manifeste.json`).toString('utf8')) as Json, prefix: storagePrefix };
  }
  const execLines = (m: Json, prefix: string) => (m.files as Json[]).filter((f) => f.kind === 'executions').sort((a, b) => a.part - b.part).flatMap((f) => lines(stored(`${prefix}${f.path}`)));
  const callLines = (m: Json, prefix: string) => (m.files as Json[]).filter((f) => f.kind === 'appels').sort((a, b) => a.part - b.part).flatMap((f) => lines(stored(`${prefix}${f.path}`)));
  const liste = async (q: string) => {
    const r = await R.list(req(`/api/admin/ai/business-executions?${q}`));
    expect(r.status).toBe(200);
    return r.json() as Promise<{ cards: { failed: number; incomplete: number }; total: number; rows: Array<{ id: string; outcome: string }> }>;
  };
  /** Tous les identifiants de la liste (toutes les pages). */
  const tousLesIds = async (q: string) => {
    const out: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const b = await liste(`${q}&limit=200&offset=${offset}`);
      out.push(...b.rows.map((r) => r.id));
      if (offset + 200 >= b.total) return out;
    }
  };

  beforeAll(async () => {
    adminIdsAvant = process.env.AI_MODEL_OUTPUT_ADMIN_IDS;
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    R.list = (await import('@/app/api/admin/ai/business-executions/route')).GET as Route;
    R.detail = (await import('@/app/api/admin/ai/business-executions/[id]/route')).GET as Route;
    R.unit = (await import('@/app/api/admin/ai/business-executions/[id]/export/route')).GET as Route;
    const ex = await import('@/app/api/admin/ai/business-executions/exports/route');
    R.exportsGET = ex.GET as Route;
    R.exportsPOST = ex.POST as Route;
    const g = await import('@/app/api/admin/ai/business-executions/exports/[id]/route');
    R.genGET = g.GET as Route;
    R.genPOST = g.POST as Route;
    R.download = (await import('@/app/api/admin/ai/business-executions/exports/[id]/download/route')).GET as Route;
    R.retry = (await import('@/app/api/admin/ai/queue/jobs/[jobId]/retry/route')).POST as Route;
    R.modelOutput = (await import('@/app/api/admin/ai/executions/[id]/model-output/route')).POST as Route;

    const a = await make.user({ role: 'ADMIN' });
    const b = await make.user({ role: 'ADMIN' });
    const u = await make.user();
    adminOk = { id: a.id, email: a.email };
    adminSans = { id: b.id, email: b.email };
    user = { id: u.id, email: u.email };
    // Habilitation EXISTANTE (décision PO 15) : seul adminOk lit les contenus des échanges.
    process.env.AI_MODEL_OUTPUT_ADMIN_IDS = String(adminOk.id);
    C = await make.account();
    autre = await make.account();

    // ── Données : travaux T4 / T3 de MON compte (états natifs) ─────────────
    const job = async (treatment: string, o: { status: string; result?: string | null; lastError?: string | null; finished: string | null; origin?: string; target?: string; account?: number }) => {
      const [r] = await sql<{ id: number }[]>`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, origin, trigger_code, attempts,
          business_result, last_error, created_at, started_at, finished_at, available_at, payload)
        VALUES (${treatment}, ${o.account ?? C.id}, ${o.target ?? 'asset'}, ${String(Math.floor(Math.random() * 1e9))}, ${`l84d:${Math.random()}`}, ${o.status},
                ${o.origin ?? 'automatic'}, 'source_analyzed', 1, ${o.result ?? null}, ${o.lastError ?? null},
                now() - ${o.finished ?? '7 hours'}::interval - interval '10 minutes', now() - ${o.finished ?? '7 hours'}::interval - interval '10 minutes',
                ${o.finished === null ? null : sql`now() - ${o.finished}::interval`}, now() + interval '30 days', '{}'::jsonb)
        RETURNING id`;
      return `${treatment}:${r.id}`;
    };
    ids.f1 = await job('T4', { status: 'FAILED', lastError: 'T4_FAILED : candidat illisible', finished: '3 hours' });
    ids.f2 = await job('T4', { status: 'FAILED', lastError: 'erreur fournisseur définitive', finished: '2 days' });
    ids.f3 = await job('T4', { status: 'FAILED', lastError: 'tâche inexécutable', finished: '5 days' });
    ids.fAdmin = await job('T4', { status: 'FAILED', lastError: 'relance manuelle en échec', finished: '1 day', origin: 'manual' });
    ids.i1 = await job('T4', { status: 'FAILED', lastError: 'T4_INCOMPLETE : 1 décision manquante', finished: '4 hours' });
    ids.i2 = await job('T4', { status: 'FAILED', lastError: 'T4_PERSIST_PARTIAL : 1 écriture Agenda en échec', finished: '6 days' });
    ids.vieux = await job('T4', { status: 'DONE', result: 'APPLIED', finished: '10 days' });
    ids.attente = await job('T4', { status: 'PENDING', finished: null });
    ids.balayage = await job('T3', { status: 'FAILED', lastError: 'balayage interrompu', finished: '2 hours', target: 't3_sweep' });
    ids.autreCompte = await job('T4', { status: 'FAILED', lastError: 'autre compte', finished: '2 hours', account: autre.id });
    // Plus de 500 exécutions réussies, réparties sur six jours (tranches multiples).
    okIds = (await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, origin, trigger_code, attempts, business_result,
                                created_at, started_at, finished_at, available_at, payload)
      SELECT 'T4', ${C.id}, 'asset', g::text, 'l84d:ok:' || ${C.id} || ':' || g, 'DONE', 'automatic', 'source_analyzed', 1, 'APPLIED',
             now() - (g * 13 + 5) * interval '1 minute', now() - (g * 13 + 5) * interval '1 minute', now() - (g * 13) * interval '1 minute',
             now() + interval '30 days', '{}'::jsonb
        FROM generate_series(1, ${N_OK}) g RETURNING id`).map((r) => `T4:${r.id}`);
    // Deux appels (principal en échec, repli réussi) pour chaque exécution en échec et pour 600 réussies.
    const avecAppels = [ids.f1, ids.f2, ids.f3, ids.fAdmin, ids.i1, ids.i2, ...okIds.slice(0, 600)].map((x) => Number(x.split(':')[1]));
    await sql`
      INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, model_rank, is_billable, is_fallback, cost_micros, duration_ms,
                                  status, error_code, metadata, use_case_code, business_execution_id, job_id, created_at)
      SELECT j.account_id, 't4_classify_event', 't4_classify_event', 'fake', CASE WHEN k = 1 THEN 'm-principal' ELSE 'm-repli' END,
             CASE WHEN k = 1 THEN 'primary' ELSE 'fallback_1' END, true, k = 2, CASE WHEN k = 1 THEN NULL ELSE 10 END, 5,
             CASE WHEN k = 1 THEN 'error' ELSE 'success' END, CASE WHEN k = 1 THEN 'TIMEOUT' END,
             jsonb_build_object('traceId', 'l84d-' || j.id, 'callKind', 'analysis'), 'AGENDA_INTELLIGENCE', 'T4:' || j.id, j.id, coalesce(j.finished_at, now())
        FROM ai_job_queue j CROSS JOIN generate_series(1, 2) k WHERE j.id = ANY(${avecAppels})`;
    // Échange capturé du premier appel de f1 (contenu SENSIBLE de test).
    const [ev] = await sql<{ id: number }[]>`SELECT id FROM ai_usage_event WHERE business_execution_id = ${ids.f1} ORDER BY id LIMIT 1`;
    await sql`INSERT INTO ai_call_captures (trace_id, usage_event_id, call_index, call_kind, origin, account_id, operation_code, model, model_rank, capture_status,
                prompt_status, prompt_text, prompt_chars, prompt_sha256, response_status, response_raw, response_chars, response_sha256, variables, request_params, business_execution_id)
              VALUES (${`l84d-${ids.f1.split(':')[1]}`}, ${ev.id}, 0, 'analysis', 'gateway', ${C.id}, 't4_classify_event', 'm-principal', 'primary', 'CAPTURED',
                'CAPTURED', 'PROMPT-SECRET-CONTENU-L84D', 26, ${sha('PROMPT-SECRET-CONTENU-L84D')}, 'CAPTURED', 'REPONSE-SECRETE-L84D', 20, ${sha('REPONSE-SECRETE-L84D')},
                ${JSON.stringify({ texte: 'VARIABLE-SECRETE-L84D' })}::jsonb, ${JSON.stringify({ temperature: 0 })}::jsonb, ${ids.f1})`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (adminIdsAvant === undefined) delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS; else process.env.AI_MODEL_OUTPUT_ADMIN_IDS = adminIdsAvant;
    // Aucun travail de ce scénario ne survit au fichier.
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now() WHERE status IN ('PENDING', 'RUNNING') AND account_id IN (${C.id}, ${autre.id})`;
  });

  it('L84D-E2E-MIG — 0692 idempotente : suivi des générations existant réutilisé, aucune nouvelle table', async () => {
    const cnx = await sql.reserve();
    try {
      const runner: SqlRunner = { unsafe: (q, p) => cnx.unsafe(q, p as never) as unknown as Promise<unknown> };
      for (const f of (await readdir(join(process.cwd(), 'src/db/migrations'))).filter((x) => /^069[2-5]_l84d_/.test(x)).sort()) {
        const texte = await readFile(join(process.cwd(), 'src/db/migrations', f), 'utf-8');
        for (const passe of [1, 2]) await expect(runMigrationSql(runner, texte), `${f} passe ${passe}`).resolves.toBeDefined();
      }
    } finally {
      cnx.release();
    }
    const [c] = await sql<{ def: string }[]>`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'admin_export_generations_kind_chk'`;
    expect(c.def).toContain('AI_EXECUTIONS_EXPORT');
    expect(await sql`SELECT 1 FROM information_schema.columns WHERE table_name = 'admin_export_generations' AND column_name = 'resume_state'`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM information_schema.tables WHERE table_name LIKE '%export_request%' OR table_name LIKE 'ai_execution_export%'`).toHaveLength(0);
  });

  it('L84D-E2E-01 — R24 : cartes = liste filtrée = export (mêmes nombres, mêmes identifiants) ; technique hors cartes', async () => {
    as(adminOk, 'ADMIN');
    const b = await liste(`accountId=${C.id}`);
    expect(b.cards).toEqual({ failed: 4, incomplete: 2 });
    expect(b.total).toBe(N_OK + 6 + 1);
    const echecs = await tousLesIds(`accountId=${C.id}&outcome=FAILED`);
    const incompletes = await tousLesIds(`accountId=${C.id}&outcome=INCOMPLETE`);
    expect(echecs.sort()).toEqual([ids.f1, ids.f2, ids.f3, ids.fAdmin].sort());
    expect(incompletes.sort()).toEqual([ids.i1, ids.i2].sort());
    // Le balayage technique (en échec) n'entre pas dans la carte ; il est dans la vue technique.
    expect(echecs).not.toContain(ids.balayage);
    expect((await tousLesIds(`accountId=${C.id}&nature=TECHNICAL`))).toEqual([ids.balayage]);
    // Export avec les MÊMES paramètres que la carte « Échecs » : mêmes identifiants.
    const e = await exporter({ accountId: String(C.id), outcome: 'FAILED', nature: 'BUSINESS' });
    expect(e.m.status).toBe('COMPLETE');
    expect(execLines(e.m, e.prefix).map((x) => x.id).sort()).toEqual(echecs.sort());
    expect(e.m.totals.executions).toEqual({ expected: 4, exported: 4 });
    // Export de toute la vue métier : ses totaux de cartes = les cartes.
    const t = await exporter({ accountId: String(C.id) });
    expect(t.m.totals.cards).toEqual(b.cards);
    expect(t.m.totals.executions.exported).toBe(b.total);
    expect(t.m.period).toMatchObject({ timeZone: 'Europe/Paris', rule: expect.stringContaining('Europe/Paris') });
  });

  it('L84D-E2E-02 — R27 : plus de 500 exécutions exportées sans perte ni doublon, appels corrélés, volumes ZIP fractionnés', async () => {
    as(adminOk, 'ADMIN');
    const { parseJournalFilter } = await import('@/services/ai/business-execution/journal');
    const f = parseJournalFilter(new URLSearchParams(`accountId=${C.id}`));
    const { startExecutionsExport, waitForExecutionsExport } = await svc();
    const { generationId } = await startExecutionsExport({ id: adminOk.id }, f, { sensitive: false, partRows: 200, sliceMs: 6 * 3600_000, volumeMaxBytes: 2_000 });
    await waitForExecutionsExport(generationId);
    const prefix = `admin-exports/ia-executions/${generationId}/`;
    const m = JSON.parse(stored(`${prefix}manifeste.json`).toString('utf8')) as Json;
    expect(m.status).toBe('COMPLETE');
    const ex = execLines(m, prefix);
    const attendus = await tousLesIds(`accountId=${C.id}`);
    expect(ex).toHaveLength(attendus.length);
    expect(ex.length).toBeGreaterThan(500);
    expect(new Set(ex.map((x) => x.id)).size).toBe(ex.length);
    expect(ex.map((x) => x.id).sort()).toEqual(attendus.sort());
    expect(ex.find((x) => x.id === ids.attente)).toMatchObject({ outcome: 'NOT_FINAL', final: false });
    // Parties : attendu = exporté = lignes du fichier ; SHA-256 du contenu décompressé.
    const parts = (m.files as Json[]).filter((x) => x.kind === 'executions');
    expect(parts.length).toBeGreaterThanOrEqual(3);
    for (const p of m.files as Json[]) {
      if (p.kind === 'documentation') continue;
      const buf = stored(`${prefix}${p.path}`);
      expect(lines(buf), p.path).toHaveLength(p.exported);
      expect(p.exported).toBe(p.expected);
      expect(sha(buf), p.path).toBe(p.sha256);
    }
    // Appels : tous, rattachés à leur exécution (deux modèles par exécution, l'échec du principal conservé).
    const calls = callLines(m, prefix);
    expect(calls).toHaveLength(606 * 2);
    expect(m.totals.calls).toEqual({ expected: 1212, exported: 1212 });
    expect(new Set(calls.map((c) => c.id)).size).toBe(calls.length);
    const f1 = calls.filter((c) => c.businessExecutionId === ids.f1);
    expect(f1.map((c) => c.model).sort()).toEqual(['m-principal', 'm-repli']);
    expect(ex.find((x) => x.id === ids.f1)?.calls).toMatchObject({ calls: 2, failedCalls: 1, costMicros: null });
    // Volumes ZIP fractionnés : parties entières, manifeste et LISEZMOI dans chacun.
    expect(m.volumes.length).toBeGreaterThan(1);
    const union: string[] = [];
    for (const v of m.volumes as Json[]) {
      const r = await R.download(req(`/x?volume=${v.index}`), ctx(generationId));
      expect(r.status).toBe(200);
      const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
      const noms = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
      expect(noms).toContain('manifeste.json');
      expect(noms).toContain('LISEZMOI.txt');
      union.push(...noms.filter((n) => n.endsWith('.jsonl.gz')));
    }
    expect(union.sort()).toEqual((m.files as Json[]).filter((x) => x.kind !== 'documentation').map((x) => x.path).sort());
    // Fichier JSONL : URL signée de courte durée ; chemin hors manifeste refusé.
    const one = await R.download(req(`/x?path=${encodeURIComponent(parts[0].path)}`), ctx(generationId));
    expect(one.status).toBe(302);
    expect((await R.download(req('/x?path=../../autre/secret'), ctx(generationId))).status).toBe(400);
    const lisezmoi = stored(`${prefix}LISEZMOI.txt`).toString('utf8');
    expect(lisezmoi).toContain(`${ex.length} exécution(s) exportée(s) sur ${ex.length} attendue(s)`);
  });

  it('L84D-E2E-03 — filtres : traitement, issue, nature, origine, période, compte (liste = export)', async () => {
    as(adminOk, 'ADMIN');
    expect(await tousLesIds(`accountId=${C.id}&origin=ADMIN`)).toEqual([ids.fAdmin]);
    expect((await liste(`accountId=${C.id}&origin=ADMIN`)).cards).toEqual({ failed: 1, incomplete: 0 });
    expect(await tousLesIds(`accountId=${C.id}&treatment=T3&nature=TECHNICAL`)).toEqual([ids.balayage]);
    expect(await tousLesIds(`accountId=${C.id}&treatment=T3`)).toEqual([]);
    // Période (jours de Paris) : le travail terminé il y a dix jours n'entre que dans la fenêtre de 30 jours.
    expect(await tousLesIds(`accountId=${C.id}&outcome=SUCCEEDED&days=7`)).not.toContain(ids.vieux);
    expect(await tousLesIds(`accountId=${C.id}&outcome=SUCCEEDED&days=30`)).toContain(ids.vieux);
    const day = (msAgo: number) => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() - msAgo));
    const d = await tousLesIds(`accountId=${C.id}&outcome=FAILED&from=${day(3 * 86_400_000)}&to=${day(0)}`);
    expect(d).toEqual(expect.arrayContaining([ids.f1, ids.fAdmin]));
    expect(d).not.toContain(ids.f3);
    // Compte : l'échec de l'autre compte n'est jamais dans mes listes.
    expect(await tousLesIds(`accountId=${C.id}&nature=all`)).not.toContain(ids.autreCompte);
    expect(await tousLesIds(`accountId=${autre.id}`)).toEqual([ids.autreCompte]);
    const e = await exporter({ accountId: String(C.id), origin: 'ADMIN' });
    expect(execLines(e.m, e.prefix).map((x) => x.id)).toEqual([ids.fAdmin]);
    expect(e.m.perimeter).toMatchObject({ origin: 'ADMIN', accountId: C.id, nature: 'BUSINESS' });
  });

  it('L84D-E2E-04 — droits : non-admin refusé ; admin hors AI_MODEL_OUTPUT_ADMIN_IDS ne voit jamais les contenus', async () => {
    as(user, 'USER');
    for (const [r, args] of [
      [R.list, [req('/x')]], [R.detail, [req('/x'), ctx(ids.f1)]], [R.unit, [req('/x'), ctx(ids.f1)]], [R.exportsGET, [req('/x')]],
      [R.exportsPOST, [req('/x', { method: 'POST', body: {} })]], [R.genGET, [req('/x'), ctx('00000000-0000-0000-0000-000000000000')]],
      [R.download, [req('/x?path=manifeste.json'), ctx('00000000-0000-0000-0000-000000000000')]],
    ] as Array<[Route, [import('next/server').NextRequest, unknown?]]>) {
      expect([401, 403]).toContain((await r(...args)).status);
    }

    as(adminSans, 'ADMIN');
    const d = await (await R.detail(req('/x'), ctx(ids.f1))).json() as Json;
    expect(d.canReadContents).toBe(false);
    expect(JSON.stringify(d)).not.toContain('PROMPT-SECRET');
    const u = await R.unit(req('/x'), ctx(ids.f1));
    expect(u.status).toBe(200);
    const ut = await u.text();
    expect(ut).not.toMatch(/PROMPT-SECRET|REPONSE-SECRETE|VARIABLE-SECRETE/);
    expect(JSON.parse(ut).calls[0].echange.prompt).toMatchObject({ $etat: 'masque', longueur: 26, sha256: sha('PROMPT-SECRET-CONTENU-L84D') });
    expect((await R.unit(req('/x?contenus=1'), ctx(ids.f1))).status).toBe(403);
    expect((await R.exportsPOST(req('/x', { method: 'POST', body: { accountId: String(C.id), contenusSensibles: true } }))).status).toBe(403);
    const [call] = await sql<{ id: number }[]>`SELECT id FROM ai_usage_event WHERE business_execution_id = ${ids.f1} ORDER BY id LIMIT 1`;
    expect((await R.modelOutput(req('/x', { method: 'POST', body: {} }), ctx(String(call.id)))).status).toBe(403);
    // Un export groupé SANS contenus lancé par cet admin : aucun contenu dans les fichiers.
    const e = await exporter({ accountId: String(C.id), outcome: 'FAILED' });
    const appels = callLines(e.m, e.prefix);
    expect(JSON.stringify(appels)).not.toMatch(/PROMPT-SECRET|REPONSE-SECRETE|VARIABLE-SECRETE/);
    expect(appels.find((c) => c.id === call.id)?.echange).toMatchObject({ captureStatus: 'CAPTURED', prompt: { $etat: 'masque' } });

    // Administrateur habilité : contenus intégraux (export unitaire et groupé).
    as(adminOk, 'ADMIN');
    expect((await (await R.detail(req('/x'), ctx(ids.f1))).json() as Json).canReadContents).toBe(true);
    const ok = await (await R.unit(req('/x?contenus=1'), ctx(ids.f1))).json() as Json;
    expect(ok.calls.find((c: Json) => c.id === call.id).echange).toMatchObject({ prompt: 'PROMPT-SECRET-CONTENU-L84D', response: 'REPONSE-SECRETE-L84D', variables: { texte: 'VARIABLE-SECRETE-L84D' } });
    const s = await exporter({ accountId: String(C.id), outcome: 'FAILED', contenusSensibles: true });
    expect(JSON.stringify(callLines(s.m, s.prefix))).toContain('PROMPT-SECRET-CONTENU-L84D');
    // Droits REVÉRIFIÉS à la remise : l'admin non habilité ne télécharge pas l'export sensible.
    as(adminSans, 'ADMIN');
    expect((await R.download(req('/x?path=manifeste.json'), ctx(s.id))).status).toBe(403);
    expect((await R.download(req('/x?volume=1'), ctx(s.id))).status).toBe(403);
  });

  it('L84D-E2E-05 — R28 / R64 : export volumineux interrompu puis repris, sans doublon ni perte ; exécutions postérieures exclues', async () => {
    as(adminOk, 'ADMIN');
    const { parseJournalFilter } = await import('@/services/ai/business-execution/journal');
    const f = parseJournalFilter(new URLSearchParams(`accountId=${C.id}`));
    const attendus = (await tousLesIds(`accountId=${C.id}`)).sort();
    const { startExecutionsExport, waitForExecutionsExport } = await svc();
    // 1. Arrêt brutal juste après la première partie close (point de reprise écrit).
    let arrets = 0;
    const { generationId } = await startExecutionsExport({ id: adminOk.id }, f, {
      sensitive: false, partRows: 150, sliceMs: 6 * 3600_000,
      onCheckpoint: (st) => { if (!st.done && arrets++ === 0) throw new Error('processus arrêté (simulation)'); },
    });
    await waitForExecutionsExport(generationId);
    const prefix = `admin-exports/ia-executions/${generationId}/`;
    const g1 = await (await R.genGET(req('/x'), ctx(generationId))).json() as Json;
    expect(g1.generation.status).toBe('FAILED');
    expect(g1.generation.error).toMatch(/reprise possible/);
    expect(g1.resumable).toBe(true);
    expect(g1.resume.partsWritten).toBe(1);
    expect(s3.objects.has(`${prefix}manifeste.json`)).toBe(false);
    // Le téléchargement d'un export inachevé est refusé (jamais présenté comme complet).
    expect((await R.download(req('/x?path=manifeste.json'), ctx(generationId))).status).toBe(404);
    // 2. Pendant l'arrêt, de nouvelles exécutions apparaissent : elles n'entreront pas (lecture figée).
    const [neuf] = await sql<{ id: number }[]>`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, origin, trigger_code, attempts,
        business_result, created_at, started_at, finished_at, payload)
      VALUES ('T4', ${C.id}, 'asset', '1', ${`l84d:neuf:${Math.random()}`}, 'DONE', 'automatic', 'source_analyzed', 1, 'APPLIED', now(), now(), now() + interval '1 second', '{}'::jsonb)
      RETURNING id`;
    // 3. Reprise par la route (droits revérifiés, journalisée).
    const r = await R.genPOST(req('/x', { method: 'POST', body: { action: 'resume' } }), ctx(generationId));
    expect(r.status, await r.clone().text()).toBe(202);
    await waitForExecutionsExport(generationId);
    const m = JSON.parse(stored(`${prefix}manifeste.json`).toString('utf8')) as Json;
    expect(m.status).toBe('COMPLETE');
    expect(m.resumes).toHaveLength(1);
    expect(m.sessions).toHaveLength(2);
    const ex = execLines(m, prefix).map((x) => x.id);
    expect(new Set(ex).size).toBe(ex.length);
    expect(ex.sort()).toEqual(attendus);
    expect(ex).not.toContain(`T4:${neuf.id}`);
    expect((m.files as Json[]).filter((x) => x.kind === 'executions').map((x) => x.part)).toEqual([...Array(m.files.filter((x: Json) => x.kind === 'executions').length)].map((_, k) => k + 1));
    expect((await R.genPOST(req('/x', { method: 'POST', body: { action: 'resume' } }), ctx(generationId))).status).toBe(409);

    // 4. Processus disparu (génération RUNNING sans signe de vie depuis 20 min) : interrompue, reprenable.
    const gen = await import('@/services/admin/export-generations');
    const { initialResumeState } = await import('@/services/ai/business-execution/export-model');
    const { perimeterOf } = await svc();
    const id2 = (await import('node:crypto')).randomUUID();
    await gen.startGeneration({ id: id2, kind: 'AI_EXECUTIONS_EXPORT', mode: 'stockage', adminUserId: adminOk.id, targetType: 'AI_EXECUTIONS', targetId: null, targetAccountId: C.id, perimeter: {}, storagePrefix: `admin-exports/ia-executions/${id2}/` });
    await gen.saveResumeState(id2, initialResumeState(perimeterOf(f, false), new Date(Date.now() - 1000), { partRows: 400 }));
    await sql`UPDATE admin_export_generations SET heartbeat_at = now() - interval '20 minutes' WHERE id = ${id2}`;
    const g2 = await (await R.genGET(req('/x'), ctx(id2))).json() as Json;
    expect(g2.generation).toMatchObject({ interrupted: true, status: 'FAILED' });
    expect(g2.resumable).toBe(true);
    expect((await R.genPOST(req('/x', { method: 'POST', body: { action: 'resume' } }), ctx(id2))).status).toBe(202);
    await waitForExecutionsExport(id2);
    const m2 = JSON.parse(stored(`admin-exports/ia-executions/${id2}/manifeste.json`).toString('utf8')) as Json;
    expect(m2.status).toBe('COMPLETE');
    expect(execLines(m2, `admin-exports/ia-executions/${id2}/`).map((x) => x.id).sort()).toEqual(attendus);
  });

  it('L84D-E2E-06 — détail (manque, causes, appels, relance existante liée) et journalisation des consultations, exports et relances', async () => {
    as(adminOk, 'ADMIN');
    const debut = new Date(Date.now() - 1000).toISOString();
    const d = await (await R.detail(req('/x'), ctx(ids.f1))).json() as Json;
    expect(d.execution).toMatchObject({ id: ids.f1, outcome: 'FAILED' });
    expect(d.missing).toEqual([expect.stringMatching(/Aucun résultat métier exploitable/)]);
    expect(d.cause).toMatch(/^T4_FAILED/);
    expect(d.calls.map((c: Json) => c.model).sort()).toEqual(['m-principal', 'm-repli']);
    expect(d.calls.find((c: Json) => c.model === 'm-principal')).toMatchObject({ status: 'error', captureStatus: 'CAPTURED', promptChars: 26 });
    expect(d.relaunch).toEqual([expect.objectContaining({ kind: 'queue-retry', endpoint: `/api/admin/ai/queue/jobs/${ids.f1.split(':')[1]}/retry` })]);
    const di = await (await R.detail(req('/x'), ctx(ids.i1))).json() as Json;
    expect(di.missing[0]).toMatch(/Décision manquante/);
    // Relance EXISTANTE (File IA) depuis le détail : liée à l'exécution d'origine, même identité.
    const jobId = ids.f1.split(':')[1];
    const rr = await R.retry(req('/x', { method: 'POST', body: d.relaunch[0].body }), { params: Promise.resolve({ jobId }) });
    expect(rr.status, await rr.clone().text()).toBe(200);
    const [j] = await sql<{ status: string; origin: string }[]>`SELECT status, origin FROM ai_job_queue WHERE id = ${Number(jobId)}`;
    expect(j).toMatchObject({ status: 'PENDING', origin: 'manual' });
    expect((await (await R.detail(req('/x'), ctx(ids.f1))).json() as Json).execution).toMatchObject({ id: ids.f1, outcome: 'NOT_FINAL' });
    // Une relance d'un travail vivant est refusée (aucun doublon) — et journalisée.
    expect((await R.retry(req('/x', { method: 'POST', body: d.relaunch[0].body }), { params: Promise.resolve({ jobId }) })).status).toBe(409);
    const e = await exporter({ accountId: String(C.id), outcome: 'INCOMPLETE' });
    expect((await R.download(req('/x?path=manifeste.json'), ctx(e.id))).status).toBe(302);
    expect((await R.unit(req('/x'), ctx(ids.i1))).status).toBe(200);
    as(adminSans, 'ADMIN');
    expect((await R.unit(req('/x?contenus=1'), ctx(ids.i1))).status).toBe(403);

    const journal = await sql<{ admin_user_id: number; action_type: string; result: string; details: string }[]>`
      SELECT admin_user_id, action_type, result, details FROM admin_audit_log WHERE "timestamp" >= ${debut}::timestamptz
         AND action_type IN ('AI_BUSINESS_EXECUTION_READ', 'AI_EXECUTIONS_EXPORT', 'AI_EXECUTIONS_EXPORT_DOWNLOAD', 'AI_EXECUTION_RELAUNCH', 'AI_MODEL_OUTPUT_READ')
       ORDER BY id`;
    const vu = (action: string, result: string, f: (x: Json) => boolean) => journal.some((l) => l.action_type === action && l.result === result && f(JSON.parse(l.details)));
    expect(vu('AI_BUSINESS_EXECUTION_READ', 'SUCCESS', (x) => x.executionId === ids.f1)).toBe(true);
    expect(vu('AI_EXECUTION_RELAUNCH', 'SUCCESS', (x) => x.businessExecutionId === ids.f1 && x.kind === 'queue-retry')).toBe(true);
    expect(vu('AI_EXECUTION_RELAUNCH', 'FAILURE', (x) => x.businessExecutionId === ids.f1 && x.code === 'JOB_NOT_FAILED')).toBe(true);
    expect(vu('AI_EXECUTIONS_EXPORT', 'SUCCESS', (x) => x.generationId === e.id && x.phase === 'launched')).toBe(true);
    expect(vu('AI_EXECUTIONS_EXPORT', 'SUCCESS', (x) => x.generationId === e.id && x.phase === 'finished' && x.status === 'COMPLETE')).toBe(true);
    expect(vu('AI_EXECUTIONS_EXPORT_DOWNLOAD', 'SUCCESS', (x) => x.generationId === e.id && x.path === 'manifeste.json')).toBe(true);
    expect(vu('AI_EXECUTIONS_EXPORT', 'SUCCESS', (x) => x.scope === 'unitaire' && x.executionId === ids.i1)).toBe(true);
    expect(vu('AI_EXECUTIONS_EXPORT', 'DENIED', (x) => x.scope === 'unitaire' && x.code === 'SENSITIVE_CONTENT_FORBIDDEN')).toBe(true);
    expect(journal.some((l) => l.action_type === 'AI_MODEL_OUTPUT_READ' && l.result === 'DENIED' && l.admin_user_id === adminSans.id)).toBe(true);
    // Reprise et refus antérieurs de ce fichier : journalisés eux aussi.
    const tout = await sql<{ details: string; result: string }[]>`SELECT details, result FROM admin_audit_log WHERE action_type = 'AI_EXECUTIONS_EXPORT' AND admin_user_id IN (${adminOk.id}, ${adminSans.id})`;
    expect(tout.some((l) => JSON.parse(l.details).phase === 'resumed')).toBe(true);
    expect(tout.some((l) => JSON.parse(l.details).phase === 'interrupted' && l.result === 'FAILURE')).toBe(true);
    expect(tout.some((l) => l.result === 'DENIED' && JSON.parse(l.details).scope === 'groupe')).toBe(true);
  });

  it('L84D-E2E-07 — collecteur 77C : T2 (demandes) et T6 (générations FORMULATE) ajoutés, sans contenu', async () => {
    const rid = `l84d-t2-${Math.random().toString(36).slice(2)}`;
    await sql`INSERT INTO verebona_request_runs (request_id, account_id, intent, mode, machine_final_state, source_count, status, error_code, retrieval_methods_json)
              VALUES (${rid}, ${C.id}, 'ASK_DATA', 'ai', 'ERROR_FINAL', 0, 'error', 'T2_TIMEOUT', '{}'::jsonb)`;
    await sql`INSERT INTO home_mascot_generations (account_id, context_hash, mode, status, model, trace_id, error, input_json, output_json)
              VALUES (${C.id}, 'h', 'display', 'validation_failed', 'm-t6', 'l84d-t6-trace', 'date relative', '{"secret":"ENTREE-T6"}'::jsonb, '{"texte":"SORTIE-T6"}'::jsonb)`;
    const { generateDiagnostic } = await import('@/services/admin/diagnostics-export/collect');
    // Lot 91A : moteur unique — les tables T2 / T6 sont exportées intégralement (filtre utilisateur), sans contenu.
    const b = await generateDiagnostic({ scope: 'user', id: C.ownerUserId, reinforced: false }, { adminUserId: adminOk.id });
    const t2 = b.files.find((f) => f.path === 'donnees/extractions-ia/verebona_request_runs.json');
    const t6 = b.files.find((f) => f.path === 'donnees/extractions-ia/home_mascot_generations.json');
    expect(JSON.parse(t2!.content)).toEqual(expect.arrayContaining([expect.objectContaining({ request_id: rid, status: 'error', error_code: 'T2_TIMEOUT' })]));
    expect(JSON.parse(t6!.content)).toEqual(expect.arrayContaining([expect.objectContaining({ trace_id: 'l84d-t6-trace', status: 'validation_failed' })]));
    expect(t6!.content).not.toMatch(/ENTREE-T6|SORTIE-T6/);
    expect(b.manifest.files.find((f: Json) => f.path === 'donnees/extractions-ia/verebona_request_runs.json')).toMatchObject({ status: 'COMPLETE' });
  });
});
