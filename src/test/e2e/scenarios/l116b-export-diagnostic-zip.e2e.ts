/**
 * Lot 116B — carte #802 « BO Exécutions & logs — Export diagnostic exhaustif
 * filtré en ZIP unique, plafond explicite », sur PostgreSQL 16 réel, par les
 * VRAIES routes BO (garde administrateur réelle : seule la lecture du cookie
 * de session est simulée) ; stockage OVH S3 SIMULÉ en mémoire. AUCUN appel à
 * un fournisseur d'IA : appels et captures sont des lignes de test.
 *
 * Règle impérative : « un seul ZIP complet et vérifiable, OU un blocage
 * explicite demandant de réduire la sélection ».
 *
 *   C802-CA01  137 exécutions correspondent aux filtres, 50 affichées → ZIP
 *              unique de 137 exécutions, identifiants exacts, sans doublon
 *   C802-CA02  toutes issues, tous traitements : liste = export = comptages ;
 *              aucun appel d'un autre compte
 *   C802-CA03  T1 / T2 / T3 / T4 / T6 : toutes les tentatives et réponses
 *              capturées (échec, repli, réparation, refus) et la version
 *              effective (captures SIMULÉES)
 *   C802-CA04  groupé aussi riche que l'unitaire : exécution + appels +
 *              diagnostic du ZIP = export unitaire (travaux, rapports, écritures)
 *   C802-CA05  sonde / qualification / test sans exécution : exportés dans le
 *              périmètre technique, jamais comme exécution métier
 *   C802-CA06  filtres modèle / opération / job / utilisateur / statut de
 *              l'onglet « Appels modèles » : appliqués ; filtre sans
 *              traduction bloqué AVANT lancement
 *   C802-CA07  sélection au-delà d'une limite technique : aucun lancement,
 *              message de la carte, cause et limite
 *   C802-CA08  dépassement pendant la génération, source illisible, plafond de
 *              projection, capture absente : aucun ZIP, échec exact, purge ;
 *              reprise après interruption sans doublon
 *   C802-CA09  ZIP unique vérifiable (manifeste, index CSV, SHA-256),
 *              téléchargement et rétention
 *   C802-CA10  non habilité, secret, opposition à l'amélioration, autre
 *              compte : refus / masquages journalisés ; droits revérifiés au
 *              téléchargement
 *   C802-CA11  historique de plus de 90 jours : bloqué ou annoncé, jamais une
 *              fausse complétude
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { scenario } from '../scenario';

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
        case 'HeadObjectCommand': {
          const o = objects.get(i.Key);
          if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
          return { ContentLength: o.body.length };
        }
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
  return { objects, uploads, client };
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
const N = 137;
const MESSAGE = 'Sélection trop volumineuse. Réduisez la période ou affinez les filtres (traitement, compte, statut)';
const ENV_KEYS = ['AI_MODEL_OUTPUT_ADMIN_IDS', 'AI_EXECUTIONS_EXPORT_MAX_RAW_BYTES', 'AI_EXECUTIONS_EXPORT_MAX_ZIP_BYTES', 'AI_EXECUTIONS_EXPORT_MAX_DURATION_MS', 'AI_EXECUTIONS_EXPORT_PRECHECK_BUDGET_MS'] as const;

scenario('C802', 'Export diagnostic exhaustif filtré en ZIP unique, plafond explicite (carte #802)', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  const R = {} as Record<'list' | 'calls' | 'unit' | 'exportsGET' | 'exportsPOST' | 'genGET' | 'genPOST' | 'download', Route>;
  const req = (url: string, init?: { method?: string; body?: unknown }) => new NextRequest(`http://app.test${url}`, {
    method: init?.method ?? 'GET', headers: { 'content-type': 'application/json', origin: 'http://app.test', host: 'app.test' },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let adminOk: { id: number; email: string };
  let adminSans: { id: number; email: string };
  let C: { id: number; ownerUserId: number };
  let autre: { id: number; ownerUserId: number };
  let oppose: { id: number; ownerUserId: number };
  let plein: { id: number };
  const ids: Record<string, string> = {};
  const ev: Record<string, number> = {};
  const envAvant: Record<string, string | undefined> = {};
  const as = (u: { id: number; email: string }, role = 'ADMIN') => { session.userId = u.id; session.role = role; session.email = u.email; };
  const svc = () => import('@/services/ai/business-execution/export');
  const post = (body: Json) => R.exportsPOST(req('/api/admin/ai/business-executions/exports', { method: 'POST', body }));
  const prefixOf = (id: string) => `admin-exports/ia-executions/${id}/`;
  const objectsOf = (id: string) => [...s3.objects.keys()].filter((k) => k.startsWith(prefixOf(id))).sort();

  interface Zip { id: string; files: Map<string, Buffer>; manifest: Json; index: string[][]; archiveKey: string; detail: Json }
  const jsonl = (z: Zip, kind: string): Json[] => [...z.files.entries()].filter(([p]) => p.startsWith(`${kind}/`)).sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, b]) => b.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json));
  const executionsOf = (z: Zip) => z.index.filter((r) => r[0] === 'EXECUTION').map((r) => r[1]);

  /** Ouvre l'archive UNIQUE d'une génération aboutie (jamais un fichier intermédiaire). */
  async function ouvrir(id: string): Promise<Zip> {
    const detail = await (await R.genGET(req('/x'), ctx(id))).json() as Json;
    expect(detail.generation.status, JSON.stringify(detail.generation.error ?? detail.failure)).toBe('COMPLETE');
    expect(detail.archive, 'archive absente du suivi').not.toBeNull();
    const archiveKey = `${prefixOf(id)}archive/${detail.archive.fileName}`;
    const body = s3.objects.get(archiveKey)!.body;
    expect(body.length).toBe(detail.archive.bytes);
    expect(sha(body)).toBe(detail.archive.sha256);
    const zip = await JSZip.loadAsync(body);
    const files = new Map<string, Buffer>();
    for (const n of Object.keys(zip.files)) if (!zip.files[n].dir) files.set(n, await zip.files[n].async('nodebuffer'));
    const { parseIndexRow } = await import('@/services/ai/business-execution/export-model');
    const index = files.get('index.csv')!.toString('utf8').replace(/^﻿/, '').split('\n').filter(Boolean).slice(1).map(parseIndexRow);
    return { id, files, manifest: JSON.parse(files.get('manifest.json')!.toString('utf8')) as Json, index, archiveKey, detail };
  }
  /** Lance par la route (précontrôle refait côté serveur), attend la tâche de fond, ouvre le ZIP. */
  async function exporter(body: Json): Promise<Zip> {
    const res = await post(body);
    expect(res.status, await res.clone().text()).toBe(202);
    const { generationId } = await res.json() as { generationId: string };
    await (await svc()).waitForExecutionsExport(generationId);
    return ouvrir(generationId);
  }
  const liste = async (q: string) => {
    const r = await R.list(req(`/api/admin/ai/business-executions?${q}`));
    expect(r.status).toBe(200);
    return r.json() as Promise<{ total: number; rows: Array<{ id: string; outcome: string; treatment: string }>; cards: { failed: number; incomplete: number } }>;
  };
  const tousLesIds = async (q: string) => {
    const out: string[] = [];
    for (let offset = 0; ; offset += 200) {
      const b = await liste(`${q}&limit=200&offset=${offset}`);
      out.push(...b.rows.map((r) => r.id));
      if (offset + 200 >= b.total) return out;
    }
  };
  const appelsEcran = async (q: string) => {
    const out: Json[] = [];
    for (let offset = 0; ; offset += 200) {
      const r = await R.calls(req(`/api/admin/ai/executions?${q}&limit=200&offset=${offset}`));
      expect(r.status).toBe(200);
      const b = await r.json() as { total: number; rows: Json[] };
      out.push(...b.rows);
      if (offset + 200 >= b.total) return { total: b.total, rows: out };
    }
  };
  const journalDepuis = (debut: string) => sql<{ admin_user_id: number; action_type: string; result: string; details: string }[]>`
    SELECT admin_user_id, action_type, result, details FROM admin_audit_log WHERE "timestamp" >= ${debut}::timestamptz
       AND action_type IN ('AI_EXECUTIONS_EXPORT', 'AI_EXECUTIONS_EXPORT_DOWNLOAD') ORDER BY id`;

  const job = async (treatment: string, o: { status: string; result?: string | null; lastError?: string | null; finished: string | null; origin?: string; targetType?: string; target?: string; account?: number | null }) => {
    const [r] = await sql<{ id: number }[]>`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, origin, trigger_code, attempts,
        business_result, last_error, created_at, started_at, finished_at, available_at, payload)
      VALUES (${treatment}, ${o.account === undefined ? C.id : o.account}, ${o.targetType ?? 'asset'}, ${o.target ?? String(Math.floor(Math.random() * 1e9))}, ${`c802:${Math.random()}`}, ${o.status},
              ${o.origin ?? 'automatic'}, 'source_analyzed', 1, ${o.result ?? null}, ${o.lastError ?? null},
              now() - ${o.finished ?? '7 hours'}::interval - interval '10 minutes', now() - ${o.finished ?? '7 hours'}::interval - interval '10 minutes',
              ${o.finished === null ? null : sql`now() - ${o.finished}::interval`}, now() + interval '30 days', '{}'::jsonb)
      RETURNING id`;
    return r.id;
  };
  /** Appel modèle de test (aucun fournisseur appelé). */
  const appel = async (o: {
    account: number | null; exec?: string | null; job?: number | null; user?: number | null; model?: string; rank?: string; status?: string; errorCode?: string | null;
    op?: string; useCase?: string; trace?: string; kind?: string; ago?: string; fallback?: boolean; extra?: Json;
  }) => {
    const [r] = await sql<{ id: number }[]>`INSERT INTO ai_usage_event (account_id, user_id, operation_type, operation_code, provider, model, model_rank, is_billable, is_fallback, cost_micros, duration_ms,
        status, error_code, metadata, use_case_code, business_execution_id, job_id, app_version, pipeline_version, created_at)
      VALUES (${o.account}, ${o.user ?? null}, ${o.op ?? 't4_classify_event'}, ${o.op ?? 't4_classify_event'}, 'fake', ${o.model ?? 'm-principal'}, ${o.rank ?? 'primary'}, ${o.account !== null}, ${o.fallback ?? false},
        ${o.status === 'error' ? null : 12}, 40, ${o.status ?? 'success'}, ${o.errorCode ?? null},
        ${JSON.stringify({ traceId: o.trace ?? `c802-${randomUUID()}`, callKind: o.kind ?? 'analysis', promptVersion: 'pv-7', ...(o.extra ?? {}) })}::jsonb,
        ${o.useCase ?? 'AGENDA_INTELLIGENCE'}, ${o.exec ?? null}, ${o.job ?? null}, 'app-9.9.9', 'pipe-3', now() - ${o.ago ?? '3 hours'}::interval)
      RETURNING id`;
    return r.id;
  };
  /** Capture SIMULÉE d'un échange (prompt final, variables, paramètres, réponse brute, sortie parsée). */
  const capture = async (usageEventId: number, o: { account: number | null; exec?: string | null; prompt: string; response?: string | null; responseStatus?: string; parsed?: Json | null; kind?: string }) => {
    await sql`INSERT INTO ai_call_captures (trace_id, usage_event_id, call_index, call_kind, origin, account_id, operation_code, model, model_rank, capture_status,
        prompt_status, prompt_text, prompt_chars, prompt_sha256, response_status, response_raw, variables, request_params, parsed_output, business_execution_id)
      VALUES (${`cap-${usageEventId}`}, ${usageEventId}, 0, ${o.kind ?? 'analysis'}, 'gateway', ${o.account}, 't4_classify_event', 'm', 'primary', 'CAPTURED',
        'CAPTURED', ${o.prompt}, ${o.prompt.length}, ${sha(o.prompt)}, ${o.responseStatus ?? 'CAPTURED'}, ${o.response ?? null},
        ${JSON.stringify({ variable: `VAR-${usageEventId}` })}::jsonb, ${JSON.stringify({ temperature: 0, schema: 'sortie-v3' })}::jsonb,
        ${o.parsed === undefined || o.parsed === null ? null : JSON.stringify(o.parsed)}::jsonb, ${o.exec ?? null})`;
  };

  beforeAll(async () => {
    for (const k of ENV_KEYS) envAvant[k] = process.env[k];
    for (const k of ENV_KEYS) if (k !== 'AI_MODEL_OUTPUT_ADMIN_IDS') delete process.env[k];
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    R.list = (await import('@/app/api/admin/ai/business-executions/route')).GET as Route;
    R.calls = (await import('@/app/api/admin/ai/executions/route')).GET as Route;
    R.unit = (await import('@/app/api/admin/ai/business-executions/[id]/export/route')).GET as Route;
    const ex = await import('@/app/api/admin/ai/business-executions/exports/route');
    R.exportsGET = ex.GET as Route;
    R.exportsPOST = ex.POST as Route;
    const g = await import('@/app/api/admin/ai/business-executions/exports/[id]/route');
    R.genGET = g.GET as Route;
    R.genPOST = g.POST as Route;
    R.download = (await import('@/app/api/admin/ai/business-executions/exports/[id]/download/route')).GET as Route;

    const a = await make.user({ role: 'ADMIN' });
    const b = await make.user({ role: 'ADMIN' });
    adminOk = { id: a.id, email: a.email };
    adminSans = { id: b.id, email: b.email };
    process.env.AI_MODEL_OUTPUT_ADMIN_IDS = String(adminOk.id);
    C = await make.account();
    autre = await make.account();
    oppose = await make.account();
    plein = await make.account();

    // ── 137 exécutions T4 réussies du compte C (CA01) ; deux appels pour les 100 premières ───────
    const ok = (await sql<{ id: number }[]>`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, origin, trigger_code, attempts, business_result,
                                created_at, started_at, finished_at, available_at, payload)
      SELECT 'T4', ${C.id}, 'asset', g::text, 'c802:ok:' || ${C.id} || ':' || g, 'DONE', 'automatic', 'source_analyzed', 1, 'APPLIED',
             now() - (g * 41 + 5) * interval '1 minute', now() - (g * 41 + 5) * interval '1 minute', now() - (g * 41) * interval '1 minute',
             now() + interval '30 days', '{}'::jsonb
        FROM generate_series(1, ${N}) g RETURNING id`).map((r) => r.id);
    await sql`
      INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, model_rank, is_billable, is_fallback, cost_micros, duration_ms,
                                  status, error_code, metadata, use_case_code, business_execution_id, job_id, created_at)
      SELECT j.account_id, 't4_classify_event', 't4_classify_event', 'fake', CASE WHEN k = 1 THEN 'm-principal' ELSE 'm-repli' END,
             CASE WHEN k = 1 THEN 'primary' ELSE 'fallback_1' END, true, k = 2, CASE WHEN k = 1 THEN NULL ELSE 10 END, 5,
             CASE WHEN k = 1 THEN 'error' ELSE 'success' END, CASE WHEN k = 1 THEN 'TIMEOUT' END,
             jsonb_build_object('traceId', 'c802-' || j.id, 'callKind', 'analysis'), 'AGENDA_INTELLIGENCE', 'T4:' || j.id, j.id, coalesce(j.finished_at, now())
        FROM ai_job_queue j CROSS JOIN generate_series(1, 2) k WHERE j.id = ANY(${ok.slice(0, 100)})`;

    // ── Autres issues et traitements du compte C (CA02, CA03, CA04) ─────────────────────────────
    // T4 en échec : échec du principal (capturé), réparation, repli réussi, rang non sollicité (refus de secours).
    const f1 = await job('T4', { status: 'FAILED', lastError: 'T4_FAILED : candidat illisible', finished: '3 hours' });
    ids.f1 = `T4:${f1}`;
    ev.f1a = await appel({ account: C.id, exec: ids.f1, job: f1, user: C.ownerUserId, status: 'error', errorCode: 'TIMEOUT', trace: 'c802-f1' });
    await capture(ev.f1a, { account: C.id, exec: ids.f1, prompt: 'PROMPT-FINAL-C802-ECHEC', response: null, responseStatus: 'NOT_CAPTURED' });
    ev.f1b = await appel({ account: C.id, exec: ids.f1, job: f1, user: C.ownerUserId, kind: 'repair', trace: 'c802-f1', extra: { repaired: true } });
    await capture(ev.f1b, { account: C.id, exec: ids.f1, prompt: 'PROMPT-REPARATION-C802', response: 'REPONSE-BRUTE-REPAREE-C802', parsed: { ok: true }, kind: 'repair' });
    ev.f1c = await appel({ account: C.id, exec: ids.f1, job: f1, user: C.ownerUserId, model: 'm-repli', rank: 'fallback_1', fallback: true, trace: 'c802-f1' });
    await capture(ev.f1c, { account: C.id, exec: ids.f1, prompt: 'PROMPT-REPLI-C802 jeton api_key=SECRET-C802-123456', response: 'REPONSE-REPLI-C802', parsed: { decision: 'x' } });
    ev.f1d = await appel({ account: C.id, exec: ids.f1, job: f1, model: 'm-repli-2', rank: 'fallback_2', status: 'error', errorCode: 'FALLBACK_NOT_ADMISSIBLE', trace: 'c802-f1' });
    // Appel SANS capture (rupture de capture) : signalé absent, jamais reconstitué.
    ev.f1e = await appel({ account: C.id, exec: ids.f1, job: f1, trace: 'c802-f1', model: 'm-sans-capture' });
    // Appel rattaché à l'exécution de C mais porté par un AUTRE compte (anomalie) : jamais exporté sous le filtre du compte C.
    ev.intrus = await appel({ account: autre.id, exec: ids.f1, job: f1, model: 'm-intrus' });
    ids.f2 = `T4:${await job('T4', { status: 'FAILED', lastError: 'erreur fournisseur définitive', finished: '2 days' })}`;
    ids.inc = `T4:${await job('T4', { status: 'FAILED', lastError: 'T4_INCOMPLETE : 1 décision manquante', finished: '4 hours' })}`;
    ids.attente = `T4:${await job('T4', { status: 'PENDING', finished: null })}`;
    // T3 : travail, rapport d'exécution et trois écritures (CA04).
    const t3 = await job('T3', { status: 'DONE', result: 'APPLIED', finished: '5 hours' });
    ids.t3 = `T3:${t3}`;
    const [rep] = await sql<{ id: number }[]>`INSERT INTO ai_execution_reports (account_id, treatment, scope, status, job_id, trace_ids, entry_count, steps)
      VALUES (${C.id}, 'T3', 'ASSET', 'SUCCESS', ${t3}, ${['c802-t3']}, 3, '[{"step":"CONSOLIDATION","status":"OK"}]'::jsonb) RETURNING id`;
    for (const [seq, res] of [[1, 'WRITTEN'], [2, 'WRITTEN'], [3, 'REJECTED']] as const) {
      await sql`INSERT INTO ai_execution_report_entries (report_id, seq, account_id, section, table_name, field_key, label, write_result, reason_code, reason)
                VALUES (${rep.id}, ${seq}, ${C.id}, 'WRITES', 'assets', ${`champ_${seq}`}, ${`Champ ${seq}`}, ${res}, ${res === 'REJECTED' ? 'CONFLICT' : null}, ${res === 'REJECTED' ? 'valeur en conflit' : null})`;
    }
    ev.t3 = await appel({ account: C.id, exec: ids.t3, job: t3, op: 't3_consolidate', useCase: 'ASSET_CONSOLIDATION', trace: 'c802-t3' });
    await capture(ev.t3, { account: C.id, exec: ids.t3, prompt: 'PROMPT-T3-C802', response: 'REPONSE-T3-C802', parsed: { arbitrage: 'a' } });
    // Balayage T3 (technique) du compte C.
    ids.balayage = `T3:${await job('T3', { status: 'FAILED', lastError: 'balayage interrompu', finished: '2 hours', targetType: 't3_sweep' })}`;
    // T1 : travail d'analyse d'un document.
    const fichier = await make.assetFile(C as never);
    const t1 = await job('T1', { status: 'FAILED', lastError: 'T1_INVALID_OUTPUT : sortie illisible', finished: '6 hours', targetType: 'asset_file', target: String(fichier.id) });
    ids.t1 = `T1:job:${t1}`;
    ev.t1 = await appel({ account: C.id, exec: ids.t1, job: t1, op: 't1_analyze_document', useCase: 'DOCUMENT_ANALYSIS', status: 'error', errorCode: 'INVALID_OUTPUT', trace: 'c802-t1' });
    await capture(ev.t1, { account: C.id, exec: ids.t1, prompt: 'PROMPT-T1-C802', response: 'REPONSE-T1-ILLISIBLE-C802', parsed: null });
    // T2 : demande de l'assistant en erreur.
    const rid = `c802-t2-${randomUUID()}`;
    await sql`INSERT INTO verebona_request_runs (request_id, account_id, user_id, intent, mode, machine_final_state, source_count, status, error_code, retrieval_methods_json, created_at)
              VALUES (${rid}, ${C.id}, ${C.ownerUserId}, 'ASK_DATA', 'ai', 'ERROR_FINAL', 0, 'error', 'T2_TIMEOUT', '{}'::jsonb, now() - interval '90 minutes')`;
    ids.t2 = `T2:${rid}`;
    ev.t2 = await appel({ account: C.id, exec: ids.t2, user: C.ownerUserId, op: 't2_answer', useCase: 'ASSISTANT', status: 'error', errorCode: 'TIMEOUT', trace: rid, ago: '90 minutes' });
    await capture(ev.t2, { account: C.id, exec: ids.t2, prompt: 'PROMPT-T2-C802', response: null, responseStatus: 'NOT_CAPTURED' });
    // T6 : génération de la mascotte rejetée ; son appel n'est rattaché QUE par sa trace (colonne vide).
    const t6trace = `c802-t6-${randomUUID()}`;
    await sql`INSERT INTO home_mascot_generations (account_id, context_hash, mode, status, model, trace_id, error, created_at)
              VALUES (${C.id}, 'h', 'display', 'validation_failed', 'm-t6', ${t6trace}, 'date relative', now() - interval '100 minutes')`;
    ids.t6 = `T6F:${t6trace}`;
    ev.t6 = await appel({ account: C.id, exec: null, op: 't6_formulate', useCase: 'HOME_MASCOT', trace: t6trace, ago: '100 minutes' });
    await capture(ev.t6, { account: C.id, prompt: 'PROMPT-T6-C802', response: 'REPONSE-T6-REJETEE-C802', parsed: { texte: 'demain' } });

    // ── Autre compte : ses exécutions et ses appels ne sortent jamais sous le filtre de C ───────
    const a1 = await job('T4', { status: 'FAILED', lastError: 'autre compte', finished: '2 hours', account: autre.id });
    ids.autre = `T4:${a1}`;
    ev.autre = await appel({ account: autre.id, exec: ids.autre, job: a1, model: 'm-principal' });
    await capture(ev.autre, { account: autre.id, exec: ids.autre, prompt: 'PROMPT-AUTRE-COMPTE-C802', response: 'REPONSE-AUTRE-COMPTE-C802' });

    // ── Compte opposé à l'amélioration (CA10) ───────────────────────────────────────────────────
    const { setImprovementOptOut } = await import('@/services/privacy/improvement-opt-out');
    await setImprovementOptOut({ accountId: oppose.id, userId: oppose.ownerUserId, optOut: true, channel: 'web' });
    const o1 = await job('T4', { status: 'DONE', result: 'APPLIED', finished: '2 hours', account: oppose.id });
    ids.oppose = `T4:${o1}`;
    ev.oppose = await appel({ account: oppose.id, exec: ids.oppose, job: o1 });
    await capture(ev.oppose, { account: oppose.id, exec: ids.oppose, prompt: 'PROMPT-COMPTE-OPPOSE-C802', response: 'REPONSE-COMPTE-OPPOSE-C802' });

    // ── Appels techniques AUTONOMES : sonde, qualification, test fournisseur — aucune exécution (CA05) ──
    ev.sonde = await appel({ account: null, op: 'model_operational_probe', useCase: 'AI_GOVERNANCE', model: 'm-sonde', trace: 'c802-sonde', ago: '50 minutes' });
    await capture(ev.sonde, { account: null, prompt: 'PROMPT-SONDE-C802', response: 'REPONSE-SONDE-C802' });
    ev.qualif = await appel({ account: null, op: 'model_qualification_probe', useCase: 'AI_GOVERNANCE', model: 'm-qualif', status: 'error', errorCode: 'TIMEOUT', ago: '55 minutes' });
    ev.testFournisseur = await appel({ account: null, op: 'provider_test', useCase: 'AI_GOVERNANCE', model: 'm-test', ago: '58 minutes' });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) { if (envAvant[k] === undefined) delete process.env[k]; else process.env[k] = envAvant[k]; }
    await sql`UPDATE ai_job_queue SET status = 'CANCELLED', finished_at = now() WHERE status IN ('PENDING', 'RUNNING') AND account_id IN (${C.id}, ${autre.id}, ${oppose.id}, ${plein.id})`;
  });

  it('C802-CA01 — 137 exécutions correspondent aux filtres, 50 affichées : ZIP unique de 137 exécutions, identifiants exacts, sans doublon', async () => {
    as(adminOk);
    const filtres = { accountId: String(C.id), treatment: 'T4', outcome: 'SUCCEEDED', nature: 'BUSINESS', days: '7' };
    const q = new URLSearchParams(filtres).toString();
    const page = await liste(q); // la liste de l'écran : 50 lignes par page
    expect(page.total).toBe(N);
    expect(page.rows).toHaveLength(50);
    const attendus = (await tousLesIds(q)).sort();
    expect(attendus).toHaveLength(N);

    // Précontrôle affiché avant tout lancement : nombre attendu, taille estimée, limites — rien n'est créé.
    const avant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_export_generations WHERE kind = 'AI_EXECUTIONS_EXPORT'`)[0].n;
    const pc = await post({ ...filtres, scope: 'executions', action: 'precheck' });
    expect(pc.status).toBe(200);
    const { precheck } = await pc.json() as Json;
    expect(precheck).toMatchObject({ ok: true, scope: 'executions', executions: N, calls: 200, autonomousCalls: 0, refusal: null });
    expect(precheck.estimatedRawBytes).toBeGreaterThan(0);
    expect(precheck.limits.maxRawBytes).toBeGreaterThan(precheck.estimatedRawBytes);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_export_generations WHERE kind = 'AI_EXECUTIONS_EXPORT'`)[0].n).toBe(avant);

    const z = await exporter({ ...filtres, scope: 'executions' });
    const exportes = executionsOf(z);
    expect(exportes).toHaveLength(N);
    expect(new Set(exportes).size).toBe(N);
    expect(exportes.slice().sort()).toEqual(attendus);
    expect(jsonl(z, 'executions').map((x) => x.id).sort()).toEqual(attendus);
    expect(z.manifest).toMatchObject({
      status: 'COMPLETE', selection: { scope: 'executions', filters: { accountId: String(C.id), treatment: 'T4', outcome: 'SUCCEEDED', nature: 'BUSINESS', days: '7' } },
      totals: { executions: { expected: N, exported: N }, calls: { expected: 200, exported: 200 } },
      completeness: { executions: { expected: N, exported: N, indexed: N, uniqueIds: true } },
      precontrol: { executions: N, calls: 200 },
    });
    // L'estimation du précontrôle majore le volume réellement écrit (mesure reportée dans la fiche de recette).
    const brut = (z.manifest.files as Json[]).reduce((n, f) => n + f.bytes, 0);
    expect(precheck.estimatedRawBytes).toBeGreaterThanOrEqual(brut);
    console.log(`[c802] CA01 : estimation ${precheck.estimatedRawBytes} octets, écrit ${brut} octets, ZIP ${z.detail.archive.bytes} octets`);
  });

  it('C802-CA02 — toutes issues, tous traitements : liste, export et comptages réconciliés ; aucun appel d’un autre compte', async () => {
    as(adminOk);
    const q = `accountId=${C.id}&nature=all&days=7`;
    const attendus = (await tousLesIds(q)).sort();
    expect(attendus).toEqual(expect.arrayContaining([ids.f1, ids.f2, ids.inc, ids.attente, ids.t3, ids.balayage, ids.t1, ids.t2, ids.t6]));
    expect(attendus).not.toContain(ids.autre);
    const z = await exporter({ accountId: String(C.id), nature: 'all', days: '7', scope: 'executions' });
    expect(executionsOf(z).slice().sort()).toEqual(attendus);
    // Comptages par issue et par traitement : ceux de la liste de l'écran.
    const parIssue: Record<string, number> = {};
    const parTraitement: Record<string, number> = {};
    for (let offset = 0; offset < attendus.length; offset += 200) {
      for (const r of (await liste(`${q}&limit=200&offset=${offset}`)).rows) { parIssue[r.outcome] = (parIssue[r.outcome] ?? 0) + 1; parTraitement[r.treatment] = (parTraitement[r.treatment] ?? 0) + 1; }
    }
    expect(z.manifest.totals.byOutcome).toEqual(parIssue);
    expect(z.manifest.totals.byTreatment).toEqual(parTraitement);
    expect(Object.keys(parTraitement).sort()).toEqual(['T1', 'T2', 'T3', 'T4', 'T6']);
    expect(z.manifest.totals.cards).toEqual((await liste(`accountId=${C.id}&days=7`)).cards);
    // Séparation des comptes : ni exécution, ni appel, ni contenu d'un autre compte.
    const appels = jsonl(z, 'appels');
    expect(appels.every((c) => c.account_id === null || c.account_id === C.id)).toBe(true);
    expect(appels.map((c) => c.id)).not.toContain(ev.intrus);
    expect(appels.map((c) => c.id)).not.toContain(ev.autre);
    expect([...z.files.values()].some((b) => b.toString('utf8').includes('AUTRE-COMPTE'))).toBe(false);
    expect(z.manifest.totals.callsOtherAccount).toBe(1);
    expect(z.manifest.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'NON_EXPORTE', count: 1, what: expect.stringContaining('autre compte') })]));
    expect(z.manifest.totals.calls.exported).toBe(appels.length);
    // Sous un filtre de compte, les sondes (sans compte) ne sont pas dans la sélection : zéro, et c'est dit.
    expect(z.manifest.totals.autonomousCalls).toEqual({ expected: 0, exported: 0 });
  });

  it('C802-CA03 — T1 / T2 / T3 / T4 / T6 : toutes les tentatives et réponses capturées (échec, repli, réparation, refus) et version effective', async () => {
    as(adminOk);
    const z = await exporter({ accountId: String(C.id), nature: 'all', days: '7', scope: 'executions', contenusSensibles: true });
    const appels = jsonl(z, 'appels');
    const de = (exec: string) => appels.filter((c) => c.businessExecutionId === exec);
    // T4 en échec : les cinq tentatives du compte, dans l'ordre, avec leur statut.
    const f1 = de(ids.f1);
    expect(f1.map((c) => c.id)).toEqual([ev.f1a, ev.f1b, ev.f1c, ev.f1d, ev.f1e]);
    expect(f1[0]).toMatchObject({ status: 'error', error_code: 'TIMEOUT', model_rank: 'primary', echange: { prompt: 'PROMPT-FINAL-C802-ECHEC', response: { $etat: 'absent', motif: 'NOT_CAPTURED' } } });
    expect(f1[1]).toMatchObject({ call_kind: 'repair', repaired: true, echange: { prompt: 'PROMPT-REPARATION-C802', response: 'REPONSE-BRUTE-REPAREE-C802', parsed: { ok: true } } });
    expect(f1[2]).toMatchObject({ model: 'm-repli', model_rank: 'fallback_1', is_fallback: true, echange: { response: 'REPONSE-REPLI-C802', parsed: { decision: 'x' } } });
    expect(f1[3]).toMatchObject({ error_code: 'FALLBACK_NOT_ADMISSIBLE', non_sollicite: true, is_fallback: false });
    // Aucune capture : absence dite, jamais reconstituée.
    expect(f1[4].echange).toMatchObject({ $etat: 'absent' });
    // Version effective du code, de la chaîne et du prompt ; variables et paramètres transmis.
    expect(f1[1]).toMatchObject({ app_version: 'app-9.9.9', pipeline_version: 'pipe-3', prompt_version: 'pv-7' });
    expect(f1[1].echange).toMatchObject({ variables: { variable: `VAR-${ev.f1b}` }, requestParams: { temperature: 0, schema: 'sortie-v3' } });
    // Les autres traitements : appel et échange de chacun.
    expect(de(ids.t1)[0]).toMatchObject({ id: ev.t1, status: 'error', echange: { prompt: 'PROMPT-T1-C802', response: 'REPONSE-T1-ILLISIBLE-C802' } });
    expect(de(ids.t2)[0]).toMatchObject({ id: ev.t2, status: 'error', echange: { prompt: 'PROMPT-T2-C802', response: { $etat: 'absent' } } });
    expect(de(ids.t3)[0]).toMatchObject({ id: ev.t3, echange: { prompt: 'PROMPT-T3-C802', parsed: { arbitrage: 'a' } } });
    // T6 : appel rattaché par sa trace (colonne vide) — exporté avec son exécution, jamais comme appel autonome.
    expect(de(ids.t6)[0]).toMatchObject({ id: ev.t6, echange: { prompt: 'PROMPT-T6-C802', response: 'REPONSE-T6-REJETEE-C802' } });
    // Synthèse des appels de la fiche : inconnu ≠ zéro (coût null dès qu'un appel est sans tarif).
    expect(jsonl(z, 'executions').find((x) => x.id === ids.f1)?.calls).toMatchObject({ calls: 4, failedCalls: 1, notCalled: 1, repairCalls: 1 });
  });

  it('C802-CA04 — le groupé est aussi riche que l’unitaire : exécution + appels + diagnostic du ZIP = export unitaire (travaux, rapports, écritures)', async () => {
    as(adminOk);
    const z = await exporter({ accountId: String(C.id), nature: 'all', days: '7', scope: 'executions' });
    const execs = jsonl(z, 'executions');
    const appels = jsonl(z, 'appels');
    const diags = jsonl(z, 'diagnostics');
    expect(diags.map((d) => d.executionId)).toEqual(execs.map((x) => x.id));
    const { maskForExport } = await import('@/services/admin/diagnostics-export/model');
    const { networkRequestsOfUsageRows } = await import('@/services/ai/business-execution/export');
    for (const id of [ids.t3, ids.f1, ids.t1, ids.t2, ids.t6, ids.attente]) {
      const u = await (await R.unit(req('/x'), ctx(id))).json() as Json;
      const { executionId, ...diag } = diags.find((d) => d.executionId === id)!;
      expect(executionId).toBe(id);
      const reconstitue = { execution: execs.find((x) => x.id === id), calls: appels.filter((c) => c.businessExecutionId === id), ...diag };
      const { format: _f, readAt: _r, snapshot: _s, sensitiveContent: _c, ...unitaire } = u;
      unitaire.execution = maskForExport(unitaire.execution) as Json;
      if (id === ids.f1) {
        // L'unitaire, lu SANS filtre de compte, porte aussi l'appel de l'autre compte rattaché à cette exécution : retiré ici
        // (et sa trace dans la synthèse des appels) pour comparer à périmètre égal — les autres exécutions sont comparées telles quelles.
        expect((unitaire.calls as Json[]).map((c) => c.id)).toContain(ev.intrus);
        unitaire.calls = (unitaire.calls as Json[]).filter((c) => c.id !== ev.intrus);
        unitaire.execution = { ...unitaire.execution, calls: reconstitue.execution!.calls };
        // Règle remplacée (carte #828, écart B) : `aiUsage.providerCalls` n'est plus le NOMBRE DE LIGNES d'appels
        // (`calls.length`) mais les requêtes réseau réellement émises ; les lignes sont dites sous leur vrai nom
        // (`usageEventLines`). À périmètre égal, les compteurs dérivés des appels sont ceux des lignes du ZIP.
        unitaire.aiUsage = { ...unitaire.aiUsage, ...networkRequestsOfUsageRows(reconstitue.calls as Json[]) };
      }
      // Carte #828 : dans le ZIP, le diagnostic de chaque exécution se concilie avec SES lignes d'appels (fichier
      // « appels ») — requêtes réseau, lignes, lignes sans envoi, lignes anciennes indéterminées.
      expect((diag as { aiUsage: Json }).aiUsage, id).toMatchObject({ ...networkRequestsOfUsageRows(reconstitue.calls as Json[]), providerCallsSemantics: 'NETWORK_REQUESTS_V1' });
      expect(Object.keys(reconstitue).sort(), id).toEqual(Object.keys(unitaire).sort());
      expect(reconstitue, id).toEqual(unitaire);
    }
    // T3 : travail, rapport et écritures corrélés par leurs identifiants réels.
    const t3 = diags.find((d) => d.executionId === ids.t3)!;
    const jobId = Number(ids.t3.split(':')[1]);
    expect(t3.jobs).toEqual([expect.objectContaining({ id: jobId, treatment: 'T3', status: 'DONE', business_result: 'APPLIED' })]);
    expect(t3.reports).toEqual([expect.objectContaining({ treatment: 'T3', status: 'SUCCESS', job_id: jobId })]);
    const reportId = Number(t3.reports[0].id);
    expect(t3.writes.map((w: Json) => [Number(w.report_id), w.seq, w.write_result, w.reason_code])).toEqual([
      [reportId, 1, 'WRITTEN', null], [reportId, 2, 'WRITTEN', null], [reportId, 3, 'REJECTED', 'CONFLICT'],
    ]);
    expect(execs.find((x) => x.id === ids.t3)).toMatchObject({ jobIds: [jobId], reportIds: [reportId] });
    // Ce qui manque et la cause : dans le diagnostic, comme dans l'unitaire.
    expect(diags.find((d) => d.executionId === ids.f1)).toMatchObject({ missing: [expect.stringMatching(/Aucun résultat métier exploitable/)], causeUnknown: false });
    // L'index mène à chaque ligne : fichier et numéro de ligne.
    const ligne = z.index.find((r) => r[1] === ids.t3)!;
    const fichierExec = z.files.get(ligne[12])!.toString('utf8').split('\n');
    expect(JSON.parse(fichierExec[Number(ligne[13]) - 1]).id).toBe(ids.t3);
    const fichierAppels = z.files.get(ligne[15])!.toString('utf8').split('\n');
    expect(JSON.parse(fichierAppels[Number(ligne[16]) - 1])).toMatchObject({ businessExecutionId: ids.t3, id: ev.t3 });
  });

  it('C802-CA05 — sonde, qualification, test fournisseur sans exécution : exportés dans le périmètre technique, jamais comme exécution métier', async () => {
    as(adminOk);
    // Vue technique sans filtre de compte : les exécutions techniques (balayage) ET les appels autonomes.
    const pc = await (await post({ nature: 'TECHNICAL', days: '1', scope: 'executions', action: 'precheck' })).json() as Json;
    expect(pc.precheck).toMatchObject({ ok: true, autonomous: { included: true } });
    expect(pc.precheck.autonomousCalls).toBeGreaterThanOrEqual(3);
    const z = await exporter({ nature: 'TECHNICAL', days: '1', scope: 'executions' });
    const autonomes = jsonl(z, 'appels-autonomes');
    const miens = autonomes.filter((c) => [ev.sonde, ev.qualif, ev.testFournisseur].includes(c.id));
    expect(miens.map((c) => c.operation_code).sort()).toEqual(['model_operational_probe', 'model_qualification_probe', 'provider_test']);
    expect(miens.every((c) => c.type === 'APPEL_AUTONOME' && c.classe === 'TECHNIQUE' && c.businessExecutionId === null)).toBe(true);
    // Identité préservée, échange masqué (export sans contenus) ou signalé absent.
    expect(miens.find((c) => c.id === ev.sonde)).toMatchObject({ model: 'm-sonde', use_case_code: 'AI_GOVERNANCE', echange: { prompt: { $etat: 'masque', longueur: 'PROMPT-SONDE-C802'.length } } });
    expect(miens.find((c) => c.id === ev.qualif)).toMatchObject({ status: 'error', error_code: 'TIMEOUT', echange: { $etat: 'absent' } });
    // Jamais une exécution : ni dans executions/, ni dans les totaux d'exécutions, ni comptés dans les cartes.
    const execIds = jsonl(z, 'executions').map((x) => x.id);
    expect(execIds).toContain(ids.balayage);
    expect(jsonl(z, 'executions').every((x) => x.nature === 'TECHNICAL')).toBe(true);
    expect(z.index.filter((r) => r[0] === 'APPEL_AUTONOME').map((r) => r[1])).toEqual(expect.arrayContaining([`appel:${ev.sonde}`, `appel:${ev.qualif}`, `appel:${ev.testFournisseur}`]));
    expect(z.index.filter((r) => r[0] === 'EXECUTION')).toHaveLength(z.manifest.totals.executions.exported);
    expect(z.manifest.totals.autonomousCalls.exported).toBe(autonomes.length);
    expect(z.manifest.totals.cards).toEqual({ failed: 0, incomplete: 0 });
    // Aucun appel autonome en double avec un appel d'exécution.
    expect(jsonl(z, 'appels').map((c) => c.id).filter((id) => autonomes.some((a) => a.id === id))).toEqual([]);

    // Vue métier : les appels autonomes n'y entrent pas — dit au précontrôle et au manifeste (non applicable), jamais silencieux.
    const m = await exporter({ accountId: String(C.id), outcome: 'FAILED', days: '7', scope: 'executions' });
    expect(jsonl(m, 'appels-autonomes')).toEqual([]);
    expect(m.manifest.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'NON_APPLICABLE', what: expect.stringContaining('autonomes') })]));
    // Onglet « Appels modèles » : la sonde y est visible (écran) et exportée comme appel autonome.
    const ecran = await appelsEcran('operationCode=model_operational_probe&model=m-sonde');
    expect(ecran.rows.map((r) => r.id)).toEqual([ev.sonde]);
    const a = await exporter({ scope: 'calls', operationCode: 'model_operational_probe', model: 'm-sonde' });
    expect(jsonl(a, 'appels-autonomes').map((c) => c.id)).toEqual([ev.sonde]);
    expect(jsonl(a, 'executions')).toEqual([]);
    expect(a.manifest.totals).toMatchObject({ executions: { expected: 0, exported: 0 }, autonomousCalls: { expected: 1, exported: 1 } });
  });

  it('C802-CA06 — filtres modèle / opération / job / utilisateur / statut : appliqués dans le ZIP ; filtre sans traduction bloqué avant lancement', async () => {
    as(adminOk);
    const jobF1 = ids.f1.split(':')[1];
    const cas: Array<[string, Json]> = [
      ['modèle', { accountId: String(C.id), model: 'm-repli' }],
      ['opération', { accountId: String(C.id), operationCode: 't3_consolidate' }],
      ['job', { jobId: jobF1 }],
      ['utilisateur', { userId: String(C.ownerUserId) }],
      ['statut', { accountId: String(C.id), status: 'error' }],
      ['rang', { accountId: String(C.id), rank: 'fallback' }],
      ['erreurs seulement + modèle', { accountId: String(C.id), errorsOnly: '1', model: 'm-principal' }],
    ];
    for (const [nom, filtres] of cas) {
      const ecran = await appelsEcran(new URLSearchParams(filtres).toString());
      expect(ecran.total, nom).toBeGreaterThan(0);
      const z = await exporter({ ...filtres, scope: 'calls' });
      const exportes = [...jsonl(z, 'appels'), ...jsonl(z, 'appels-autonomes')].map((c) => c.id).sort((a, b) => a - b);
      // Exactement les appels de l'écran : ni plus, ni moins.
      expect(exportes, nom).toEqual(ecran.rows.map((r) => r.id).sort((a: number, b: number) => a - b));
      expect(z.manifest.selection, nom).toMatchObject({ scope: 'calls', filters: filtres });
      expect(z.manifest.period.timeZone, nom).toBe('UTC');
      expect(z.manifest.totals.calls.exported + z.manifest.totals.autonomousCalls.exported, nom).toBe(ecran.total);
    }
    // Job de f1 : une seule exécution, sa fiche complète ; les appels hors filtre sont comptés, pas exportés.
    const z = await exporter({ scope: 'calls', accountId: String(C.id), model: 'm-repli' });
    const execs = jsonl(z, 'executions');
    expect(execs.map((x) => x.id)).toContain(ids.f1);
    expect(jsonl(z, 'appels').every((c) => c.model === 'm-repli')).toBe(true);
    const d = jsonl(z, 'diagnostics').find((x) => x.executionId === ids.f1)!;
    expect(d.callsFilter).toMatchObject({ applied: true, exported: 1, totalOfExecution: 6, notExported: 5 });
    expect(d.jobs).toEqual([expect.objectContaining({ id: Number(jobF1) })]);
    expect(z.manifest.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'NON_EXPORTE', what: expect.stringContaining('ne correspondant pas aux filtres') })]));
    expect(new Set(execs.map((x) => x.id)).size).toBe(execs.length);

    // Filtres sans traduction : 422 AVANT lancement, rien de créé, refus journalisé.
    const debut = new Date(Date.now() - 1000).toISOString();
    const avant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_export_generations WHERE kind = 'AI_EXECUTIONS_EXPORT'`)[0].n;
    const bloques: Array<[Json, string]> = [
      [{ scope: 'executions', accountId: String(C.id), model: 'm-repli' }, 'model'],          // filtre d'appels envoyé au journal : jamais ignoré
      [{ scope: 'executions', treatment: 'T9' }, 'treatment'],                               // valeur que l'écran ignorerait : export plus large → bloqué
      [{ scope: 'executions', outcome: 'PERDU' }, 'outcome'],
      [{ scope: 'calls', outcome: 'FAILED' }, 'outcome'],                                    // filtre du journal envoyé aux appels
      [{ scope: 'calls', status: 'timeout' }, 'status'],
      [{ scope: 'calls', filtreInconnu: 'x' }, 'filtreInconnu'],
      [{ scope: 't2', accountId: String(C.id) }, 'scope'],                                   // onglet « Requêtes T2 » : pas de traduction
      [{ scope: 'executions', accountId: { $ne: 1 } }, 'accountId'],
    ];
    for (const [body, cle] of bloques) {
      for (const action of ['precheck', undefined]) {
        const r = await post({ ...body, ...(action ? { action } : {}) });
        expect(r.status, JSON.stringify(body)).toBe(422);
        const j = await r.json() as Json;
        expect(j.code).toBe('FILTER_NOT_SUPPORTED');
        expect(j.unsupported.map((u: Json) => u.key)).toContain(cle);
        expect(j.error).toContain('Aucun export n’a été lancé');
      }
    }
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_export_generations WHERE kind = 'AI_EXECUTIONS_EXPORT'`)[0].n).toBe(avant);
    const refus = (await journalDepuis(debut)).filter((l) => l.result === 'DENIED' && JSON.parse(l.details).code === 'FILTER_NOT_SUPPORTED');
    expect(refus).toHaveLength(bloques.length);
  });

  it('C802-CA07 — sélection au-delà d’une limite technique : aucun lancement, message de la carte, cause et limite concrètes', async () => {
    as(adminOk);
    const debut = new Date(Date.now() - 1000).toISOString();
    const filtres = { accountId: String(C.id), treatment: 'T4', outcome: 'SUCCEEDED', nature: 'BUSINESS', days: '7', scope: 'executions' };
    const avant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_export_generations WHERE kind = 'AI_EXECUTIONS_EXPORT'`)[0].n;
    const objets = s3.objects.size;
    process.env.AI_EXECUTIONS_EXPORT_MAX_RAW_BYTES = '50000';
    try {
      // Précontrôle : refus affiché avec le nombre attendu, la taille estimée et la limite.
      const { precheck } = await (await post({ ...filtres, action: 'precheck' })).json() as Json;
      expect(precheck).toMatchObject({ ok: false, executions: N, calls: 200, refusal: { code: 'LIMIT_RAW_BYTES' } });
      expect(precheck.refusal.message.startsWith(`${MESSAGE} — `)).toBe(true);
      expect(precheck.refusal.cause).toMatch(/avant compression au-delà de la limite de 48,8 Kio \(AI_EXECUTIONS_EXPORT_MAX_RAW_BYTES\)/);
      expect(precheck.refusal.cause).toContain(`${N} exécution(s)`);
      expect(precheck.limits.maxRawBytes).toBe(50_000);
      // Lancement forcé (sans passer par le précontrôle de l'écran) : le serveur refuse de même.
      const r = await post(filtres);
      expect(r.status).toBe(422);
      const j = await r.json() as Json;
      expect(j).toMatchObject({ code: 'SELECTION_TOO_LARGE', refusalCode: 'LIMIT_RAW_BYTES' });
      expect(j.error.startsWith(`${MESSAGE} — `)).toBe(true);
      // La sélection est rendue telle quelle (filtres conservés).
      expect(j.precheck.filters).toEqual({ accountId: String(C.id), treatment: 'T4', outcome: 'SUCCEEDED', nature: 'BUSINESS', days: '7' });
    } finally {
      delete process.env.AI_EXECUTIONS_EXPORT_MAX_RAW_BYTES;
    }
    // Délai du précontrôle dépassé : la sélection n'a pas pu être dénombrée → refus, jamais un lancement à l'aveugle.
    const { precheckExecutionsExport } = await svc();
    const { parseExportSelection } = await import('@/services/ai/business-execution/export-selection');
    const { executionsExportLimits } = await import('@/services/ai/business-execution/export-settings');
    const sel = parseExportSelection(filtres);
    if (!sel.ok) throw new Error('sélection invalide');
    let t = 0;
    const lent = await precheckExecutionsExport(sel.selection, { sensitive: false, limits: { ...executionsExportLimits(), precheckBudgetMs: 5_000 }, clock: () => (t += 3_000) });
    expect(lent).toMatchObject({ ok: false, refusal: { code: 'LIMIT_PRECHECK_BUDGET' } });
    expect(lent.refusal!.message.startsWith(`${MESSAGE} — `)).toBe(true);
    expect(lent.refusal!.cause).toMatch(/n’a pas pu être dénombrée dans le délai du précontrôle de 5 s/);
    // Rien n'a été lancé : aucune génération, aucun objet stocké ; refus journalisé.
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_export_generations WHERE kind = 'AI_EXECUTIONS_EXPORT'`)[0].n).toBe(avant);
    expect(s3.objects.size).toBe(objets);
    expect(s3.uploads.size).toBe(0);
    expect((await journalDepuis(debut)).some((l) => l.result === 'DENIED' && JSON.parse(l.details).phase === 'precheck' && JSON.parse(l.details).code === 'LIMIT_RAW_BYTES')).toBe(true);
    // La même sélection, limite rétablie, s'exporte : rien n'a été altéré.
    expect((await (await post({ ...filtres, action: 'precheck' })).json() as Json).precheck.ok).toBe(true);
  });

  it('C802-CA08 — dépassement pendant la génération, source illisible, plafond de projection : aucun ZIP, échec exact, purge ; reprise sans doublon', async () => {
    as(adminOk);
    const { startExecutionsExport, waitForExecutionsExport, runExecutionsExport, perimeterOf, ExportRefusedError } = await svc();
    const { parseJournalFilter } = await import('@/services/ai/business-execution/journal');
    const { executionsExportLimits } = await import('@/services/ai/business-execution/export-settings');
    const f = parseJournalFilter(new URLSearchParams(`accountId=${C.id}&treatment=T4&outcome=SUCCEEDED&days=7`));
    const debut = new Date(Date.now() - 1000).toISOString();

    // 1. Le volume réellement écrit dépasse la limite APRÈS la première partie (le précontrôle était passé).
    const limits = { ...executionsExportLimits() };
    const g1 = await startExecutionsExport({ id: adminOk.id }, f, {
      sensitive: false, partRows: 40, sliceMs: 6 * 3600_000, limits,
      onCheckpoint: (st) => { if (!st.done) limits.maxRawBytes = 10; },
    });
    await waitForExecutionsExport(g1.generationId);
    const d1 = await (await R.genGET(req('/x'), ctx(g1.generationId))).json() as Json;
    expect(d1.generation.status).toBe('FAILED');
    expect(d1.failure).toMatchObject({ code: 'LIMIT_RAW_BYTES' });
    expect(d1.failure.message.startsWith(`${MESSAGE} — `)).toBe(true);
    expect(d1.failure.message).toContain('constaté pendant la génération');
    expect(d1.generation.error).toBe(d1.failure.message);
    expect(d1).toMatchObject({ archive: null, manifest: null, resumable: false });
    // Purge : plus aucun artefact (parties closes comprises), aucun envoi en cours.
    expect(objectsOf(g1.generationId)).toEqual([]);
    expect(s3.uploads.size).toBe(0);
    // Aucun ZIP servi ; pas de reprise (la même sélection échouerait).
    const dl = await R.download(req('/x'), ctx(g1.generationId));
    expect(dl.status).toBe(404);
    expect((await dl.json() as Json).error).toBe(d1.failure.message);
    expect((await R.genPOST(req('/x', { method: 'POST', body: { action: 'resume' } }), ctx(g1.generationId))).status).toBe(409);

    // 2. Durée maximale dépassée pendant la génération.
    let saut = 0;
    const g2 = await startExecutionsExport({ id: adminOk.id }, f, {
      sensitive: false, partRows: 40, sliceMs: 6 * 3600_000, clock: () => Date.now() + saut,
      onCheckpoint: (st) => { if (!st.done) saut = 3 * 3600_000; },
    });
    await waitForExecutionsExport(g2.generationId);
    const d2 = await (await R.genGET(req('/x'), ctx(g2.generationId))).json() as Json;
    expect(d2.failure).toMatchObject({ code: 'LIMIT_DURATION' });
    expect(d2.failure.message).toMatch(/durée maximale de 2 h \(AI_EXECUTIONS_EXPORT_MAX_DURATION_MS\)/);
    expect(objectsOf(g2.generationId)).toEqual([]);

    // 3. Archive plus grosse que la limite du ZIP : constaté sur les octets compressés, même issue.
    const limitesZip = { ...executionsExportLimits(), maxZipBytes: 600 };
    const g3 = await startExecutionsExport({ id: adminOk.id }, f, { sensitive: false, partRows: 500, limits: limitesZip });
    await waitForExecutionsExport(g3.generationId);
    const d3 = await (await R.genGET(req('/x'), ctx(g3.generationId))).json() as Json;
    expect(d3.failure).toMatchObject({ code: 'LIMIT_ZIP_BYTES' });
    expect(d3.failure.message).toMatch(/au-delà de la limite de 600 octets \(AI_EXECUTIONS_EXPORT_MAX_ZIP_BYTES\)/);
    expect(objectsOf(g3.generationId)).toEqual([]);

    // 4. Source illisible pendant la génération (un traitement ne se lit plus) : jamais « complet ».
    const gen = await import('@/services/admin/export-generations');
    const { initialResumeState } = await import('@/services/ai/business-execution/export-model');
    const { openReadSession } = await import('@/services/admin/account-data/session');
    const tout = parseJournalFilter(new URLSearchParams(`accountId=${C.id}&nature=all&days=7`));
    const id4 = randomUUID();
    await gen.startGeneration({ id: id4, kind: 'AI_EXECUTIONS_EXPORT', mode: 'stockage', adminUserId: adminOk.id, targetType: 'AI_EXECUTIONS', targetId: null, targetAccountId: C.id, perimeter: {}, storagePrefix: prefixOf(id4) });
    const st4 = initialResumeState(perimeterOf(tout, false), new Date(), { partRows: 60 });
    await gen.saveResumeState(id4, st4);
    const reelle = await openReadSession();
    let lectures = 0;
    const cassee = { ...reelle, q: (async (text: string, params?: unknown[]) => {
      if (/home_mascot_generations/.test(text) && ++lectures > 2) throw Object.assign(new Error('relation illisible (simulation)'), { code: '57014' });
      return reelle.q(text, params as never);
    }) as typeof reelle.q };
    cassee.savepoint = reelle.savepoint.bind(reelle);
    let refus: unknown = null;
    try {
      await runExecutionsExport({ generationId: id4, state: st4, session: { ...cassee, savepoint: async <T>(fn: () => Promise<T>) => fn() } as never, storage: { client: s3.client as never, bucket: 'bucket-e2e' } });
    } catch (e) { refus = e; } finally { await (reelle as unknown as { close(): Promise<void> }).close().catch(() => undefined); }
    expect(refus).toBeInstanceOf(ExportRefusedError);
    expect((refus as { code: string }).code).toBe('SOURCE_UNREADABLE');
    expect((refus as Error).message).toMatch(/^Export incomplet, non livré : une source de la sélection est illisible \(T6 illisible/);
    expect(st4).toMatchObject({ done: true, archive: null, failure: { code: 'SOURCE_UNREADABLE' } });
    expect(objectsOf(id4)).toEqual([]);
    // (Appel direct du moteur : la clôture du suivi, faite d'ordinaire par la tâche de fond, est faite ici.)
    await gen.finishGeneration(id4, { status: 'FAILED', error: (refus as Error).message });
    expect((await (await R.genGET(req('/x'), ctx(id4))).json() as Json)).toMatchObject({ archive: null, resumable: false, failure: { code: 'SOURCE_UNREADABLE' } });

    // 5. Plafond de projection : plus de 20 000 exécutions dans la même minute — bloqué AVANT lancement (aucune coupe silencieuse).
    await sql`
      INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, origin, trigger_code, attempts, business_result,
                                created_at, started_at, finished_at, available_at, payload)
      SELECT 'T4', ${plein.id}, 'asset', g::text, 'c802:plein:' || ${plein.id} || ':' || g, 'DONE', 'automatic', 'source_analyzed', 1, 'APPLIED',
             date_trunc('minute', now() - interval '2 hours'), date_trunc('minute', now() - interval '2 hours'), date_trunc('minute', now() - interval '2 hours') + (g % 50) * interval '1 second',
             now() + interval '30 days', '{}'::jsonb
        FROM generate_series(1, 20050) g`;
    const p = await post({ accountId: String(plein.id), treatment: 'T4', days: '1', scope: 'executions' });
    expect(p.status).toBe(422);
    const pj = await p.json() as Json;
    expect(pj).toMatchObject({ code: 'SELECTION_TOO_LARGE', refusalCode: 'LIMIT_PROJECTION_CAP' });
    expect(pj.error.startsWith(`${MESSAGE} — `)).toBe(true);
    expect(pj.error).toMatch(/plafond de lecture de la projection atteint sur une tranche d’une minute/);

    // 6. Interruption (processus arrêté) : aucun ZIP tant que la génération n'a pas abouti ; reprise SANS doublon ni perte.
    let arrets = 0;
    const g6 = await startExecutionsExport({ id: adminOk.id }, f, {
      sensitive: false, partRows: 40, sliceMs: 6 * 3600_000,
      onCheckpoint: (st) => { if (!st.done && arrets++ === 0) throw new Error('processus arrêté (simulation)'); },
    });
    await waitForExecutionsExport(g6.generationId);
    const d6 = await (await R.genGET(req('/x'), ctx(g6.generationId))).json() as Json;
    expect(d6).toMatchObject({ generation: { status: 'FAILED' }, archive: null, failure: null, resumable: true });
    expect((await R.download(req('/x'), ctx(g6.generationId))).status).toBe(404);
    expect(objectsOf(g6.generationId).some((k) => k.includes('/archive/'))).toBe(false);
    expect((await R.genPOST(req('/x', { method: 'POST', body: { action: 'resume' } }), ctx(g6.generationId))).status).toBe(202);
    await waitForExecutionsExport(g6.generationId);
    const z = await ouvrir(g6.generationId);
    const exportes = executionsOf(z);
    expect(exportes).toHaveLength(N);
    expect(new Set(exportes).size).toBe(N);
    expect(z.manifest).toMatchObject({ status: 'COMPLETE', resumes: [expect.objectContaining({ adminUserId: adminOk.id })] });
    // Après livraison : seuls l'archive et le manifeste de suivi restent (fichiers intermédiaires purgés).
    expect(objectsOf(g6.generationId)).toEqual([z.archiveKey, `${prefixOf(g6.generationId)}manifeste.json`].sort());

    // Chaque arrêt est journalisé avec son code.
    const j = (await journalDepuis(debut)).map((l) => ({ result: l.result, d: JSON.parse(l.details) as Json }));
    for (const code of ['LIMIT_RAW_BYTES', 'LIMIT_DURATION', 'LIMIT_ZIP_BYTES']) expect(j.some((l) => l.result === 'FAILURE' && l.d.phase === 'refused' && l.d.code === code), code).toBe(true);
    expect(j.some((l) => l.result === 'DENIED' && l.d.phase === 'precheck' && l.d.code === 'LIMIT_PROJECTION_CAP')).toBe(true);
    expect(j.some((l) => l.result === 'FAILURE' && l.d.phase === 'interrupted' && l.d.generationId === g6.generationId)).toBe(true);
  });

  it('C802-CA09 — ZIP unique vérifiable : manifeste, index CSV, SHA-256 de chaque fichier, téléchargement, rétention', async () => {
    as(adminOk);
    const z = await exporter({ accountId: String(C.id), nature: 'all', days: '7', scope: 'executions' });
    // Structure lisible : trois documents de tête, puis les données ; rien d'autre.
    const noms = [...z.files.keys()];
    expect(noms.slice(0, 3)).toEqual(['index.csv', 'manifest.json', 'LISEZMOI.txt']);
    expect(noms.slice(3).every((n) => /^(executions|appels|diagnostics|appels-autonomes)\/[a-z-]+\.part-\d{4}\.jsonl$/.test(n))).toBe(true);
    expect(z.manifest.archive.entries).toEqual(noms);
    // Chaque fichier listé au manifeste : présent, taille, lignes et SHA-256 exacts.
    for (const f of z.manifest.files as Json[]) {
      const buf = z.files.get(f.path);
      expect(buf, f.path).toBeDefined();
      expect(buf!.length, f.path).toBe(f.bytes);
      expect(sha(buf!), f.path).toBe(f.sha256);
      expect(f.status, f.path).toBe('COMPLETE');
      if (f.kind !== 'documentation') expect(buf!.toString('utf8').split('\n').filter(Boolean).length - (f.kind === 'index' ? 1 : 0), f.path).toBe(f.exported);
      if (f.expected !== null) expect(f.exported, f.path).toBe(f.expected);
    }
    expect((z.manifest.files as Json[]).map((f) => f.path).sort()).toEqual(noms.filter((n) => n !== 'manifest.json').sort());
    // Manifeste : filtres exacts, environnement, version, instants de lecture et de génération, limites, omissions motivées.
    expect(z.manifest).toMatchObject({
      schema: 'verebona.ai-executions-export/2', environment: expect.any(String), build: expect.objectContaining({ version: expect.anything() }),
      generatedAt: expect.any(String), finishedAt: expect.any(String), period: { readAt: expect.any(String), timeZone: 'Europe/Paris' },
      selection: { scope: 'executions', sensitiveContent: false }, perimeter: { timeZone: 'Europe/Paris' }, limits: { maxZipBytes: expect.any(Number), maxRawBytes: expect.any(Number), maxDurationMs: expect.any(Number) },
    });
    expect('commit' in z.manifest.build).toBe(true);
    const statuts = new Set((z.manifest.omissions as Json[]).map((o) => o.status));
    expect([...statuts].sort()).toEqual(['INEXISTANT', 'MASQUE', 'NON_EXPORTE']);
    expect((z.manifest.omissions as Json[]).every((o) => o.reason.length > 10)).toBe(true);
    // Index CSV : en-tête, une ligne par exécution, identifiants = fichiers.
    const csv = z.files.get('index.csv')!.toString('utf8');
    expect(csv.startsWith('﻿type;identifiant;traitement;mode;nature;issue;origine;compte;')).toBe(true);
    expect(executionsOf(z)).toEqual(jsonl(z, 'executions').map((x) => x.id));
    const lisezmoi = z.files.get('LISEZMOI.txt')!.toString('utf8');
    expect(lisezmoi).toContain(`${z.manifest.totals.executions.exported} exécution(s) exportée(s) sur ${z.manifest.totals.executions.expected} attendue(s)`);
    expect(lisezmoi).toContain('OMISSIONS (motivées)');
    // Suivi : UN seul téléchargeable — l'archive (taille et empreinte), plus aucun volume ni fichier séparé.
    expect(z.detail.archive).toMatchObject({ fileName: expect.stringMatching(/^verebona-diagnostic-executions-ia-[0-9a-f]{8}\.zip$/), entries: noms.length, sha256: sha(s3.objects.get(z.archiveKey)!.body) });
    expect(z.detail.downloadables).toBeUndefined();
    expect(z.detail.manifest.volumes).toBeUndefined();
    const dl = await R.download(req('/x'), ctx(z.id));
    expect(dl.status).toBe(302);
    expect(dl.headers.get('location')).toBe(`https://s3.e2e.invalid/${z.archiveKey}?nom=${encodeURIComponent(z.detail.archive.fileName)}`);
    expect((await R.download(req('/x?volume=1'), ctx(z.id))).status).toBe(410);
    expect((await R.download(req('/x?path=manifeste.json'), ctx(z.id))).status).toBe(410);
    // Deux téléchargements = le même objet (aucun recalcul).
    expect((await R.download(req('/x'), ctx(z.id))).headers.get('location')).toBe(dl.headers.get('location'));
    // Liste des générations : statut, nombre, périmètre.
    const l = await (await R.exportsGET(req('/x?pageSize=3'))).json() as Json;
    expect(l.items.find((g: Json) => g.id === z.id)).toMatchObject({ status: 'COMPLETE', rowsExported: z.manifest.totals.executions.exported });
    expect(l.limits).toMatchObject({ maxZipBytes: expect.any(Number) });

    // Rétention (30 jours, règle existante) : archive purgée → plus rien n'est remis, et c'est dit.
    for (const k of objectsOf(z.id)) s3.objects.get(k)!.modified = new Date(Date.now() - 31 * 86_400_000);
    const { purgeOldExecutionsExports } = await svc();
    expect(await purgeOldExecutionsExports({ client: s3.client as never, bucket: 'bucket-e2e' })).toBeGreaterThanOrEqual(2);
    expect(objectsOf(z.id)).toEqual([]);
    const apres = await R.download(req('/x'), ctx(z.id));
    expect(apres.status).toBe(404);
    expect((await apres.json() as Json).code).toBe('ARCHIVE_PURGED');
  });

  it('C802-CA10 — non habilité, secret, opposition à l’amélioration, autre compte : refus et masquages journalisés ; droits revérifiés au téléchargement', async () => {
    const debut = new Date(Date.now() - 1000).toISOString();
    // Non administrateur : refusé partout.
    const u = await make.user();
    as({ id: u.id, email: u.email }, 'USER');
    for (const r of [await post({ scope: 'executions' }), await post({ scope: 'executions', action: 'precheck' }), await R.exportsGET(req('/x')),
      await R.genGET(req('/x'), ctx(randomUUID())), await R.download(req('/x'), ctx(randomUUID()))]) expect([401, 403]).toContain(r.status);

    // Administrateur NON habilité : contenus refusés (précontrôle et lancement), refus journalisé ; export sans contenus : tout est masqué.
    as(adminSans);
    for (const action of ['precheck', undefined]) {
      const r = await post({ accountId: String(C.id), outcome: 'FAILED', days: '7', scope: 'executions', contenusSensibles: true, ...(action ? { action } : {}) });
      expect(r.status).toBe(403);
      expect((await r.json() as Json).code).toBe('SENSITIVE_CONTENT_FORBIDDEN');
    }
    const masque = await exporter({ accountId: String(C.id), outcome: 'FAILED', days: '7', scope: 'executions' });
    const brut = [...masque.files.values()].map((b) => b.toString('utf8')).join('\n');
    expect(brut).not.toMatch(/PROMPT-FINAL-C802|PROMPT-REPLI-C802|REPONSE-REPLI-C802|REPONSE-BRUTE-REPAREE|SECRET-C802|VAR-\d+/);
    expect(jsonl(masque, 'appels').find((c) => c.id === ev.f1b)?.echange).toMatchObject({
      captureStatus: 'CAPTURED', prompt: { $etat: 'masque', longueur: 'PROMPT-REPARATION-C802'.length, sha256: sha('PROMPT-REPARATION-C802') }, response: { $etat: 'masque' },
    });
    expect(masque.manifest.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'MASQUE', what: 'Contenu des échanges IA' })]));

    // Administrateur habilité : contenus intégraux, SECRETS toujours masqués.
    as(adminOk);
    const clair = await exporter({ accountId: String(C.id), outcome: 'FAILED', days: '7', scope: 'executions', contenusSensibles: true });
    const texte = [...clair.files.values()].map((b) => b.toString('utf8')).join('\n');
    expect(texte).toContain('PROMPT-FINAL-C802-ECHEC');
    expect(texte).toContain('PROMPT-REPLI-C802');
    expect(texte).not.toContain('SECRET-C802-123456');
    expect(texte).toContain('[secret masqué]');
    expect(clair.manifest.selection.sensitiveContent).toBe(true);

    // Opposition à l'amélioration : contenu exclu même pour un habilité (longueur et empreinte seulement), dit au manifeste.
    const opp = await exporter({ accountId: String(oppose.id), days: '7', scope: 'executions', contenusSensibles: true });
    const appelOppose = jsonl(opp, 'appels').find((c) => c.id === ev.oppose)!;
    expect(appelOppose.echange).toMatchObject({ exclusion: expect.stringContaining('opposition'), prompt: { $etat: 'exclu', longueur: 'PROMPT-COMPTE-OPPOSE-C802'.length }, response: { $etat: 'exclu' } });
    expect([...opp.files.values()].some((b) => /PROMPT-COMPTE-OPPOSE|REPONSE-COMPTE-OPPOSE/.test(b.toString('utf8')))).toBe(false);
    expect(opp.manifest.omissions).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'MASQUE', what: expect.stringContaining('opposés') })]));

    // Séparation des comptes : le périmètre « appels » filtré sur C ne livre jamais la fiche ni les appels d'un autre compte.
    const calls = await exporter({ scope: 'calls', accountId: String(C.id), model: 'm-principal', contenusSensibles: true });
    expect(jsonl(calls, 'executions').every((x) => x.accountId === C.id)).toBe(true);
    expect([...jsonl(calls, 'appels'), ...jsonl(calls, 'appels-autonomes')].every((c) => c.account_id === C.id)).toBe(true);
    expect([...calls.files.values()].some((b) => b.toString('utf8').includes('AUTRE-COMPTE'))).toBe(false);
    // L'appel de l'autre compte rattaché à une exécution de C : exporté sous SON compte comme appel sans fiche (la fiche de C n'est pas livrée).
    const intrus = await exporter({ scope: 'calls', accountId: String(autre.id), model: 'm-intrus' });
    expect(jsonl(intrus, 'executions')).toEqual([]);
    expect(jsonl(intrus, 'appels-autonomes')).toEqual([expect.objectContaining({ id: ev.intrus, classe: 'EXECUTION_INTROUVABLE', businessExecutionId: ids.f1, account_id: autre.id })]);

    // Droits REVÉRIFIÉS au téléchargement : l'export « avec contenus » n'est remis qu'à un habilité ; le suivi ne le remet pas non plus à un non-admin.
    as(adminSans);
    const refuse = await R.download(req('/x'), ctx(clair.id));
    expect(refuse.status).toBe(403);
    expect((await refuse.json() as Json).code).toBe('SENSITIVE_CONTENT_FORBIDDEN');
    expect((await R.download(req('/x'), ctx(masque.id))).status).toBe(302);
    expect((await R.genPOST(req('/x', { method: 'POST', body: { action: 'resume' } }), ctx(clair.id))).status).toBe(409);
    as({ id: u.id, email: u.email }, 'USER');
    expect([401, 403]).toContain((await R.download(req('/x'), ctx(masque.id))).status);
    as(adminOk);
    expect((await R.download(req('/x'), ctx(clair.id))).status).toBe(302);

    // Journal : lancements (avec précontrôle), refus, téléchargements et refus de téléchargement.
    const j = (await journalDepuis(debut)).map((l) => ({ admin: l.admin_user_id, action: l.action_type, result: l.result, d: JSON.parse(l.details) as Json }));
    expect(j.filter((l) => l.action === 'AI_EXECUTIONS_EXPORT' && l.result === 'DENIED' && l.admin === adminSans.id && l.d.code === 'SENSITIVE_CONTENT_FORBIDDEN')).toHaveLength(2);
    expect(j.some((l) => l.action === 'AI_EXECUTIONS_EXPORT' && l.result === 'SUCCESS' && l.d.phase === 'launched' && l.d.generationId === clair.id && l.d.contenusSensibles === true && l.d.precheck.executions > 0)).toBe(true);
    expect(j.some((l) => l.action === 'AI_EXECUTIONS_EXPORT' && l.result === 'SUCCESS' && l.d.phase === 'finished' && l.d.generationId === clair.id && typeof l.d.archiveSha256 === 'string')).toBe(true);
    expect(j.some((l) => l.action === 'AI_EXECUTIONS_EXPORT_DOWNLOAD' && l.result === 'DENIED' && l.admin === adminSans.id && l.d.generationId === clair.id)).toBe(true);
    expect(j.some((l) => l.action === 'AI_EXECUTIONS_EXPORT_DOWNLOAD' && l.result === 'SUCCESS' && l.admin === adminOk.id && l.d.generationId === clair.id && l.d.sha256 === clair.detail.archive.sha256)).toBe(true);
  });

  it('C802-CA11 — historique de plus de 90 jours : bloqué ou annoncé, jamais une fausse complétude', async () => {
    as(adminOk);
    const jour = (msAgo: number) => new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() - msAgo));
    const J = 86_400_000;
    // Journal : une période saisie de plus de 90 jours ne peut pas être lue en une fois — l'écran la réduit, l'export REFUSE (jamais plus étroit sans le dire).
    const large = { accountId: String(C.id), from: jour(200 * J), to: jour(0), scope: 'executions' };
    for (const action of ['precheck', undefined]) {
      const r = await post({ ...large, ...(action ? { action } : {}) });
      expect(r.status).toBe(422);
      const j = await r.json() as Json;
      expect(j.code).toBe('FILTER_NOT_SUPPORTED');
      expect(j.error).toMatch(/période de plus de 90 jours : le journal des exécutions couvre au plus 90 jours par lecture — réduisez la période/);
    }
    expect((await post({ accountId: String(C.id), days: '120', scope: 'executions' })).status).toBe(422);

    // Une période ANCIENNE de moins de 90 jours s'exporte ; ce que l'historique ne contient plus est annoncé AVANT lancement et écrit au manifeste.
    const vieux = await job('T4', { status: 'DONE', result: 'APPLIED', finished: '150 days' });
    const vieilAppel = await appel({ account: C.id, exec: `T4:${vieux}`, job: vieux, ago: '150 days', model: 'm-ancien' });
    // Journée archivée PUIS supprimée de la base (archive antérieure au lot 82C) : ses appels n'existent plus qu'en archive.
    const jourArchive = new Date(Date.now() - 160 * J).toISOString().slice(0, 10);
    await sql`INSERT INTO ai_log_archives (source_table, period_day, part, s3_key, row_count, min_id, max_id, bytes, sha256, t2_content_excluded, environment, source_rows_kept)
              VALUES ('ai_usage_event', ${jourArchive}::date, 1, ${`ai-logs/e2e/c802-${randomUUID()}.ndjson.gz`}, 42, 1, 42, 1000, ${sha('archive')}, true, 'e2e', false)`;
    const ancien = { accountId: String(C.id), from: jour(170 * J), to: jour(140 * J), scope: 'executions' };
    const { precheck } = await (await post({ ...ancien, action: 'precheck' })).json() as Json;
    expect(precheck).toMatchObject({ ok: true, executions: 1, calls: 1 });
    expect(precheck.notices.join('\n')).toMatch(/Appels modèles archivés puis supprimés de la base : 1 journée\(s\) de la période n’existent plus que dans les archives/);
    expect(precheck.notices.join('\n')).toMatch(/Données de plus de 90 jours : la période remonte à plus de 90 jours/);
    const z = await exporter(ancien);
    expect(executionsOf(z)).toEqual([`T4:${vieux}`]);
    expect(jsonl(z, 'appels').map((c) => c.id)).toEqual([vieilAppel]);
    // Appel ancien sans capture : absent, dit — jamais reconstitué.
    expect(jsonl(z, 'appels')[0].echange).toMatchObject({ $etat: 'absent' });
    expect(z.manifest.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'NON_EXPORTE', what: 'Appels modèles archivés puis supprimés de la base', count: 42 }),
      expect.objectContaining({ status: 'INEXISTANT', what: 'Données de plus de 90 jours' }),
    ]));
    expect(z.files.get('LISEZMOI.txt')!.toString('utf8')).toMatch(/\[NON_EXPORTE\] Appels modèles archivés puis supprimés de la base \(42\)/);
    // Une période récente ne porte aucune de ces annonces.
    const recent = await (await post({ accountId: String(C.id), days: '7', scope: 'executions', action: 'precheck' })).json() as Json;
    expect(recent.precheck.notices.join('\n')).not.toMatch(/archivés|plus de 90 jours/);
    // Onglet « Appels modèles » sans période (tout l'historique en base) : exporté, avec la même annonce.
    const tout = await (await post({ scope: 'calls', accountId: String(C.id), model: 'm-ancien', action: 'precheck' })).json() as Json;
    expect(tout.precheck).toMatchObject({ ok: true, calls: 1 });
    expect(tout.precheck.notices.join('\n')).toMatch(/Données de plus de 90 jours/);
  });
});
