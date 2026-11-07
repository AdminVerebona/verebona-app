/**
 * Lot 113T (Trello #718, P1) — exports JSON du BO récupérables sur iPhone,
 * sur PostgreSQL 16 réel, par les VRAIES routes (garde administrateur réelle :
 * seule la lecture du cookie de session est simulée), puis par le client
 * commun du BO (`fetchExportFile`) branché sur ces routes.
 *
 *   L113T-E2E-01  exécution métier T1 (sans contenus) : 200, application/json, no-store,
 *                 Content-Disposition attachment, nom type + identifiant + date,
 *                 JSON complet de l'exécution choisie, aucun contenu d'échange
 *   L113T-E2E-02  avec contenus (admin habilité) : variante « avec-echanges », contenus présents
 *   L113T-E2E-03  droits : admin non habilité → 403 JSON (refus journalisé), sans contenus → 200
 *                 sans échanges ; non-admin → 403 ; session expirée → 401 JSON clair ; id inconnu → 404
 *   L113T-E2E-04  journalisation d'accès inchangée (AI_EXECUTIONS_EXPORT, AI_MODEL_OUTPUT_READ)
 *   L113T-E2E-05  export détaillé d'appel IA : en-têtes, nom, droits des sorties du modèle
 *   L113T-E2E-06  client commun du BO sur les vraies réponses : fichier .json identique et
 *                 nommé ; 401 / 403 / 404 → erreur claire, aucun fichier
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { scenario } from '../scenario';

type Json = Record<string, any>;

scenario('L113T', 'BO — exports JSON téléchargés / partagés sans page de texte brut (#718)', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '', expired: false };
  let NextRequest: typeof import('next/server').NextRequest;
  type Route = (r: import('next/server').NextRequest, c?: unknown) => Promise<Response>;
  let unit: Route;
  let call: Route;
  const req = (url: string) => new NextRequest(`http://app.test${url}`, { headers: { origin: 'http://app.test', host: 'app.test' } });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let adminOk: { id: number; email: string };
  let adminSans: { id: number; email: string };
  let user: { id: number; email: string };
  const EXEC = `T1:${randomUUID()}`;
  const SHORT = EXEC.slice(3, 11);
  const TRACE = randomUUID();
  const SECRET = `PROMPT-SECRET-L113T-${randomUUID().slice(0, 6)}`;
  let eventId = 0;
  let adminIdsAvant: string | undefined;
  let debut = '';
  const as = (u: { id: number; email: string }, role: string) => { session.userId = u.id; session.role = role; session.email = u.email; session.expired = false; };
  const jour = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const unitUrl = (q: string) => `/api/admin/ai/business-executions/${encodeURIComponent(EXEC)}/export${q}`;

  beforeAll(async () => {
    adminIdsAvant = process.env.AI_MODEL_OUTPUT_ADMIN_IDS;
    ({ NextRequest } = await import('next/server'));
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => {
      if (session.expired) throw new Error('INVALID_TOKEN');
      return { userId: session.userId, role: session.role, email: session.email } as never;
    });
    unit = (await import('@/app/api/admin/ai/business-executions/[id]/export/route')).GET as Route;
    call = (await import('@/app/api/admin/ai/executions/[id]/export/route')).GET as Route;
    const a = await make.user({ role: 'ADMIN' });
    const b = await make.user({ role: 'ADMIN' });
    const u = await make.user();
    adminOk = { id: a.id, email: a.email };
    adminSans = { id: b.id, email: b.email };
    user = { id: u.id, email: u.email };
    process.env.AI_MODEL_OUTPUT_ADMIN_IDS = String(adminOk.id);
    const C = await make.account();
    // Analyse T1 (dépôt) portant l'identifiant d'exécution, comme le travail 6775 de la carte.
    const [job] = await sql<{ id: number }[]>`INSERT INTO ai_job_queue (treatment, account_id, target_type, target_id, dedupe_key, status, origin, trigger_code, attempts,
        last_error, created_at, started_at, finished_at, available_at, payload)
      VALUES ('T1', ${C.id}, 'asset_file', '387', ${`l113t:${randomUUID()}`}, 'FAILED', 'automatic', 'document_uploaded', 1,
        'Files API 403', now() - interval '20 minutes', now() - interval '19 minutes', now() - interval '18 minutes', now() + interval '30 days',
        ${JSON.stringify({ businessExecution: { id: EXEC, origin: 'USER' } })}::jsonb)
      RETURNING id`;
    const [ev] = await sql<{ id: number }[]>`INSERT INTO ai_usage_event (account_id, operation_type, operation_code, provider, model, model_rank, is_billable, is_fallback,
        cost_micros, duration_ms, status, error_code, metadata, use_case_code, business_execution_id, job_id, created_at)
      VALUES (${C.id}, 'document_analysis', 'document_analysis', 'fake', 'm-principal', 'primary', true, false, NULL, 5, 'error', 'PROVIDER_403',
        ${JSON.stringify({ traceId: TRACE, callKind: 'analysis' })}::jsonb, 'DOCUMENT_ANALYSIS', ${EXEC}, ${job.id}, now() - interval '18 minutes')
      RETURNING id`;
    eventId = ev.id;
    await sql`INSERT INTO ai_call_captures (trace_id, usage_event_id, call_index, call_kind, origin, account_id, operation_code, model, model_rank, capture_status,
                prompt_status, prompt_text, prompt_chars, response_status, response_raw, response_chars, business_execution_id)
              VALUES (${TRACE}, ${ev.id}, 0, 'analysis', 'gateway', ${C.id}, 'document_analysis', 'm-principal', 'primary', 'CAPTURED',
                'CAPTURED', ${SECRET}, ${SECRET.length}, 'CAPTURED', 'REPONSE-L113T', 13, ${EXEC})`;
    [{ t: debut }] = await sql<{ t: string }[]>`SELECT now()::text AS t`;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (adminIdsAvant === undefined) delete process.env.AI_MODEL_OUTPUT_ADMIN_IDS; else process.env.AI_MODEL_OUTPUT_ADMIN_IDS = adminIdsAvant;
  });

  it('L113T-E2E-01 — exécution métier sans contenus : vrai fichier .json nommé, complet, sans échanges', async () => {
    as(adminSans, 'ADMIN');
    const r = await unit(req(unitUrl('?download=1')), ctx(encodeURIComponent(EXEC)));
    expect(r.status, await r.clone().text()).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const name = `verebona-execution-T1-${SHORT}-${jour()}.json`;
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
    const text = await r.text();
    const body = JSON.parse(text) as Json;
    expect(body.format).toBe('verebona.ai-business-execution/1');
    expect(body.sensitiveContent).toBe(false);
    expect(body.execution.id).toBe(EXEC);
    expect(body.calls).toHaveLength(1);
    expect(text).not.toContain(SECRET);
    // Sans `download=1` : même JSON, sans pièce jointe (lecture directe inchangée).
    const v = await unit(req(unitUrl('')), ctx(encodeURIComponent(EXEC)));
    expect(v.status).toBe(200);
    expect(v.headers.get('content-disposition')).toBeNull();
  });

  it('L113T-E2E-02 — avec contenus (admin habilité) : variante « avec-echanges », échanges présents', async () => {
    as(adminOk, 'ADMIN');
    const r = await unit(req(unitUrl('?download=1&contenus=1')), ctx(encodeURIComponent(EXEC)));
    expect(r.status).toBe(200);
    const name = `verebona-execution-T1-${SHORT}-avec-echanges-${jour()}.json`;
    expect(r.headers.get('content-disposition')).toContain(`filename="${name}"`);
    const text = await r.text();
    expect(JSON.parse(text).sensitiveContent).toBe(true);
    expect(text).toContain(SECRET);
  });

  it('L113T-E2E-03 — droits et erreurs : 403 / 401 / 404 en JSON clair, jamais de pièce jointe', async () => {
    as(adminSans, 'ADMIN');
    const r403 = await unit(req(unitUrl('?download=1&contenus=1')), ctx(encodeURIComponent(EXEC)));
    expect(r403.status).toBe(403);
    expect(r403.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r403.headers.get('content-disposition')).toBeNull();
    expect((await r403.json()).message).toMatch(/AI_MODEL_OUTPUT_ADMIN_IDS/);

    as(user, 'USER');
    const rUser = await unit(req(unitUrl('?download=1')), ctx(encodeURIComponent(EXEC)));
    expect(rUser.status).toBe(403);
    expect(rUser.headers.get('content-disposition')).toBeNull();

    session.expired = true;
    const r401 = await unit(req(unitUrl('?download=1&contenus=1')), ctx(encodeURIComponent(EXEC)));
    expect(r401.status).toBe(401);
    expect(r401.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r401.headers.get('content-disposition')).toBeNull();
    expect(await r401.json()).toMatchObject({ code: 'INVALID_TOKEN', message: 'Votre session a expiré. Merci de vous reconnecter.' });

    as(adminOk, 'ADMIN');
    const inconnu = `T1:${randomUUID()}`;
    const r404 = await unit(req(`/api/admin/ai/business-executions/${encodeURIComponent(inconnu)}/export?download=1`), ctx(encodeURIComponent(inconnu)));
    expect(r404.status).toBe(404);
    expect(r404.headers.get('content-disposition')).toBeNull();
  });

  it('L113T-E2E-04 — journalisation d’accès conservée', async () => {
    const rows = await sql<{ admin_user_id: number; action_type: string; result: string; details: string }[]>`
      SELECT admin_user_id, action_type, result, details FROM admin_audit_log
       WHERE "timestamp" >= ${debut}::timestamptz AND admin_user_id IN (${adminOk.id}, ${adminSans.id})
         AND action_type IN ('AI_EXECUTIONS_EXPORT', 'AI_MODEL_OUTPUT_READ') ORDER BY id`;
    const vu = (who: number, action: string, result: string, f: (x: Json) => boolean) =>
      rows.some((l) => l.admin_user_id === who && l.action_type === action && l.result === result && f(JSON.parse(l.details)));
    expect(vu(adminSans.id, 'AI_EXECUTIONS_EXPORT', 'SUCCESS', (x) => x.scope === 'unitaire' && x.executionId === EXEC && x.contenusSensibles === false)).toBe(true);
    expect(vu(adminOk.id, 'AI_EXECUTIONS_EXPORT', 'SUCCESS', (x) => x.executionId === EXEC && x.contenusSensibles === true)).toBe(true);
    expect(vu(adminOk.id, 'AI_MODEL_OUTPUT_READ', 'SUCCESS', (x) => x.purpose === 'export' && x.executionId === EXEC)).toBe(true);
    expect(vu(adminSans.id, 'AI_EXECUTIONS_EXPORT', 'DENIED', (x) => x.code === 'SENSITIVE_CONTENT_FORBIDDEN')).toBe(true);
    expect(vu(adminSans.id, 'AI_MODEL_OUTPUT_READ', 'DENIED', (x) => x.executionId === EXEC)).toBe(true);
  });

  it('L113T-E2E-05 — export détaillé d’appel IA : en-têtes, nom, droits des sorties du modèle', async () => {
    as(adminSans, 'ADMIN');
    const r = await call(req(`/api/admin/ai/executions/${eventId}/export?download=1`), ctx(String(eventId)));
    expect(r.status, await r.clone().text()).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(r.headers.get('content-disposition')).toMatch(new RegExp(`^attachment; filename="execution-ia-appel-${eventId}-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}\\.json"$`));
    expect(await r.text()).not.toContain(SECRET);
    const refus = await call(req(`/api/admin/ai/executions/${eventId}/export?download=1&includeModelOutput=1`), ctx(String(eventId)));
    expect(refus.status).toBe(403);
    expect(refus.headers.get('content-disposition')).toBeNull();
  });

  it('L113T-E2E-06 — client commun du BO sur les vraies réponses : fichier nommé et identique, erreurs sans fichier', async () => {
    const { fetchExportFile, ExportError } = await import('@/lib/files/export-delivery');
    const viaRoute = (async (u: RequestInfo | URL) => {
      const url = String(u);
      const m = /^\/api\/admin\/ai\/business-executions\/([^/]+)\/export/.exec(url);
      return unit(req(url), ctx(m![1]));
    }) as typeof fetch;
    as(adminOk, 'ADMIN');
    const f = await fetchExportFile(unitUrl('?download=1&contenus=1'), { fallbackName: 'repli.json' }, { fetch: viaRoute, refresh: async () => false });
    expect(f.fileName).toBe(`verebona-execution-T1-${SHORT}-avec-echanges-${jour()}.json`);
    const parsed = JSON.parse(await f.blob.text()) as Json;
    expect(parsed.execution.id).toBe(EXEC);
    expect(parsed.sensitiveContent).toBe(true);

    as(adminSans, 'ADMIN');
    const e403 = await fetchExportFile(unitUrl('?download=1&contenus=1'), { fallbackName: 'repli.json' }, { fetch: viaRoute, refresh: async () => false }).catch((e) => e);
    expect(e403).toBeInstanceOf(ExportError);
    expect(e403.code).toBe('FORBIDDEN');
    expect(e403.message).toMatch(/réservés aux administrateurs habilités/);

    session.expired = true;
    const refresh = vi.fn(async () => false as const);
    const e401 = await fetchExportFile(unitUrl('?download=1'), { fallbackName: 'repli.json' }, { fetch: viaRoute, refresh }).catch((e) => e);
    expect(e401.code).toBe('SESSION_EXPIRED');
    expect(refresh).toHaveBeenCalledTimes(1);
    // Session renouvelée entre-temps : la relecture aboutit (un seul renouvellement).
    const renew = vi.fn(async () => { session.expired = false; return true as const; });
    as(adminOk, 'ADMIN');
    session.expired = true;
    expect((await fetchExportFile(unitUrl('?download=1'), { fallbackName: 'repli.json' }, { fetch: viaRoute, refresh: renew })).fileName)
      .toBe(`verebona-execution-T1-${SHORT}-${jour()}.json`);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});
