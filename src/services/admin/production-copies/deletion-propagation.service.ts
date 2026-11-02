/**
 * Suppressions de production → copies de données réelles en préproduction
 * (lot 104A, P1-F). Protocole et cryptographie : `./deletion-signals.ts`.
 * Registre des copies (lot 102C) : `./production-copies.service.ts`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CÔTÉ PRODUCTION — `serveDeletionSignals` (route serveur à serveur
 *   `GET /api/internal/production-deletion-signals`, requête signée) : publie
 *   le registre minimal des suppressions (`account_deletion_registry`,
 *   lot 102A — AUCUN nouveau registre) sous forme d'empreintes HMAC non
 *   réversibles. Servi seulement en production, clé configurée ; sinon 404 /
 *   503 sans détail. Chaque page servie est journalisée (sans empreinte).
 *
 * CÔTÉ PRÉPRODUCTION — `syncProductionDeletionSignals` (tâche planifiée
 *   `production-deletion-signals`, toutes les heures ; bouton BO ; juste
 *   après l'import d'une copie) :
 *     1. inventaire des copies actives : chaque compte et utilisateur copiés
 *        (cible locale) avec les empreintes de leurs identifiants source et
 *        de leur adresse, établi À L'IMPORT (`captureCopySubjects`) ;
 *     2. lecture signée des suppressions de production, réponse vérifiée ;
 *     3. correspondance par EMPREINTE (jamais par identifiant local présumé) ;
 *     4. purge par le moteur existant (`replayRegistryEntry` →
 *        `executeScheduledDeletion` : base et cascade, objets du stockage en
 *        file de purge, dérivés IA et index rattachés, historiques
 *        pseudonymisés) — idempotente, tracée (registre local, sujet de la
 *        copie : date, référence opaque, essais, erreur) ;
 *     5. rattrapage : échecs repris à chaque passage (même sans nouvelle
 *        lecture), comptes réapparus après une restauration purgés de
 *        nouveau, copies sans inventaire, couverture insuffisante du registre
 *        de production, copies purgées / closes nettoyées ;
 *     6. Supervision : une anomalie regroupée tant qu'un problème subsiste,
 *        résolue d'elle-même ensuite.
 *   POLITIQUE PRUDENTE : tant que la propagation n'est pas configurée ET
 *   vérifiée (dernier échange réussi < PRODUCTION_DELETION_SIGNAL_MAX_AGE_HOURS),
 *   aucun import de données réelles n'est autorisé (`deletionPropagationReadiness`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type postgres from 'postgres';
import { pgClient } from '@/db';
import {
  DELETION_SIGNAL_DEFAULTS, DELETION_SIGNAL_HEADERS, DELETION_SIGNAL_SCHEMA, accountIdFingerprint, buildSignalIndex, cursorId,
  emailFingerprint, matchSubject, parseSignalPage, readinessMaxAgeHours, signRequest, signResponse, signalKey, signalKeyStatus,
  signalSourceUrl, userIdFingerprint, verifyRequestSignature, verifyResponseSignature,
  type CopySubject, type DeletionSignalEntry, type DeletionSignalPage,
} from './deletion-signals';
import { currentEnvironmentName, isProductionEnvironment } from './rules';

type Sql = postgres.Sql;
type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const DELETION_PROPAGATION_FINGERPRINT_PARTS = ['production-copy', 'deletion-propagation'] as const;

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

/* ══ Production : publication des suppressions ══════════════════════════════ */

/** Rotation du registre de production (même règle que le lot 102A). */
async function registryWindowDays(env: Env): Promise<number> {
  const { registryRetentionDays } = await import('@/services/account/deletion-registry.service');
  return registryRetentionDays(env as NodeJS.ProcessEnv);
}

/** Une page de suppressions, en empreintes seulement. */
export async function buildDeletionSignalPage(input: { key: string; after: string | null; limit: number; now: Date; env: Env; sql?: Sql }): Promise<DeletionSignalPage> {
  const sql = input.sql ?? pgClient;
  const limit = Math.max(1, Math.min(DELETION_SIGNAL_DEFAULTS.pageSize, Math.trunc(input.limit) || DELETION_SIGNAL_DEFAULTS.pageSize));
  const rows = await sql<Row[]>`
    SELECT id, scope, user_ids, account_ids, signal_contacts, executed_at
      FROM account_deletion_registry WHERE id > ${cursorId(input.after)} ORDER BY id LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const entries: DeletionSignalEntry[] = page.map((r) => ({
    ref: `r${Number(r.id)}`,
    executedAt: iso(r.executed_at)!,
    scope: r.scope === 'user' ? 'user' : 'account',
    subjects: [
      ...((r.user_ids as number[] | null) ?? []).map((id) => userIdFingerprint(input.key, Number(id))),
      ...((r.account_ids as number[] | null) ?? []).map((id) => accountIdFingerprint(input.key, Number(id))),
    ],
    contacts: ((r.signal_contacts as string[] | null) ?? []).filter((x) => /^[0-9a-f]{64}$/.test(x)),
  }));
  const coversSince = new Date(input.now.getTime() - (await registryWindowDays(input.env)) * 86_400_000);
  return {
    schema: DELETION_SIGNAL_SCHEMA,
    environment: currentEnvironmentName(input.env) ?? 'inconnu',
    generatedAt: input.now.toISOString(),
    coversSince: coversSince.toISOString(),
    entries,
    next: rows.length > limit ? entries[entries.length - 1].ref : null,
  };
}

export interface ServedResponse { status: number; body: string; headers: Record<string, string> }

/**
 * Réponse de la route serveur à serveur (pure côté HTTP, testable sans
 * serveur). 404 hors production (rien n'est exposé), 503 sans clé, 401 si
 * la signature manque, est périmée ou fausse — jamais de détail exploitable.
 */
export async function serveDeletionSignals(input: {
  method: string;
  url: string;
  headers: { get(name: string): string | null };
  env?: Env;
  now?: Date;
  sql?: Sql;
}): Promise<ServedResponse> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const base = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const json = (status: number, body: Record<string, unknown>) => ({ status, body: JSON.stringify(body), headers: base });
  if (!isProductionEnvironment(currentEnvironmentName(env), env)) return json(404, { code: 'NOT_FOUND' });
  const key = signalKey(env);
  if (!key) return json(503, { code: 'NOT_CONFIGURED' });
  if (input.method.toUpperCase() !== 'GET') return json(405, { code: 'METHOD_NOT_ALLOWED' });
  const u = new URL(input.url);
  const check = verifyRequestSignature(key, {
    method: 'GET', pathname: u.pathname, params: u.searchParams,
    timestamp: input.headers.get(DELETION_SIGNAL_HEADERS.timestamp), signature: input.headers.get(DELETION_SIGNAL_HEADERS.signature),
  }, now.getTime());
  if (!check.ok) {
    console.warn(`[deletion-signals] requête refusée (${check.reason})`);
    return json(401, { code: 'SIGNATURE_REFUSED' });
  }
  const page = await buildDeletionSignalPage({
    key, after: u.searchParams.get('after'), limit: Number(u.searchParams.get('limit') ?? DELETION_SIGNAL_DEFAULTS.pageSize), now, env, sql: input.sql,
  });
  const body = JSON.stringify(page);
  const ts = String(now.getTime());
  console.info(`[deletion-signals] page servie : ${page.entries.length} suppression(s)${page.next ? ', suite disponible' : ''}.`);
  return {
    status: 200, body,
    headers: { ...base, [DELETION_SIGNAL_HEADERS.timestamp]: ts, [DELETION_SIGNAL_HEADERS.signature]: signResponse(key, body, ts) },
  };
}

/* ══ Préproduction : inventaire des copies ═════════════════════════════════ */

/**
 * Inventaire d'une copie : comptes copiés (`account_ids` de la copie) et
 * leurs utilisateurs (titulaires et membres), avec les empreintes de leurs
 * identifiants SOURCE (ceux présents dans les données copiées, lus à
 * l'import) et de leur adresse. Idempotent. Sans clé : rien (repris plus
 * tard par le rattrapage). Renvoie le nombre de sujets inscrits.
 */
export async function captureCopySubjects(copyId: number, opts: { sql?: Sql; env?: Env; now?: Date } = {}): Promise<number> {
  const sql = opts.sql ?? pgClient;
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const key = signalKey(env);
  if (!key) return 0;
  const [copy] = await sql<Row[]>`SELECT account_ids FROM production_data_copies WHERE id = ${copyId}`;
  if (!copy) return 0;
  const ids = (Array.isArray(copy.account_ids) ? copy.account_ids : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  let n = 0;
  if (ids.length > 0) {
    const accounts = await sql<Row[]>`SELECT id FROM accounts WHERE id IN ${sql(ids)}`;
    for (const a of accounts) {
      const r = await sql`
        INSERT INTO production_copy_subjects (copy_id, subject_kind, target_id, id_fingerprints, created_at, updated_at)
        VALUES (${copyId}, 'account', ${Number(a.id)}, ${[accountIdFingerprint(key, Number(a.id))]}::text[], ${now.toISOString()}, ${now.toISOString()})
        ON CONFLICT (copy_id, subject_kind, target_id) DO NOTHING`;
      n += r.count;
    }
    const people = await sql<Row[]>`
      SELECT DISTINCT u.id, u.email FROM users u
       WHERE u.id IN (SELECT a.owner_user_id FROM accounts a WHERE a.id IN ${sql(ids)} AND a.owner_user_id IS NOT NULL
                      UNION SELECT m.user_id FROM account_memberships m WHERE m.account_id IN ${sql(ids)})`;
    for (const p of people) {
      const contact = emailFingerprint(key, p.email as string | null);
      const r = await sql`
        INSERT INTO production_copy_subjects (copy_id, subject_kind, target_id, id_fingerprints, contact_fingerprints, created_at, updated_at)
        VALUES (${copyId}, 'user', ${Number(p.id)}, ${[userIdFingerprint(key, Number(p.id))]}::text[], ${contact ? [contact] : []}::text[],
                ${now.toISOString()}, ${now.toISOString()})
        ON CONFLICT (copy_id, subject_kind, target_id) DO NOTHING`;
      n += r.count;
    }
  }
  await sql`UPDATE production_data_copies SET subjects_captured_at = COALESCE(subjects_captured_at, ${now.toISOString()}), updated_at = ${now.toISOString()} WHERE id = ${copyId}`;
  return n;
}

/** Copie purgée ou close : sujets clos, empreintes effacées (trace seule). */
export async function closeCopySubjects(copyId: number, status: 'purged' | 'closed', sql: Sql = pgClient, now = new Date()): Promise<void> {
  await sql`
    UPDATE production_copy_subjects
       SET status = ${status}, purged_at = CASE WHEN ${status} = 'purged' THEN COALESCE(purged_at, ${now.toISOString()}::timestamptz) ELSE purged_at END,
           id_fingerprints = '{}', contact_fingerprints = '{}', updated_at = ${now.toISOString()}
     WHERE copy_id = ${copyId} AND status IN ('present', 'failed')`;
}

/* ══ Préproduction : état et « prête » ══════════════════════════════════════ */

export interface PropagationState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string;
  lastError: string | null;
  consecutiveFailures: number;
  sourceEnvironment: string | null;
  coversSince: string | null;
  entriesSeen: number;
  lastReport: Record<string, unknown> | null;
}

export async function readPropagationState(sql: Sql = pgClient): Promise<PropagationState> {
  let r: Row | undefined;
  try { [r] = await sql<Row[]>`SELECT * FROM production_deletion_signal_state WHERE id = 1`; } catch { r = undefined; }
  return {
    lastAttemptAt: iso(r?.last_attempt_at), lastSuccessAt: iso(r?.last_success_at), lastStatus: String(r?.last_status ?? 'never'),
    lastError: (r?.last_error as string) ?? null, consecutiveFailures: Number(r?.consecutive_failures ?? 0),
    sourceEnvironment: (r?.source_environment as string) ?? null, coversSince: iso(r?.covers_since), entriesSeen: Number(r?.entries_seen ?? 0),
    lastReport: (r?.last_report as Record<string, unknown>) ?? null,
  };
}

const STATE_COLUMNS = new Set(['last_attempt_at', 'last_success_at', 'last_status', 'last_error', 'consecutive_failures', 'source_environment', 'covers_since', 'entries_seen']);

/** Mise à jour partielle de l'état (une ligne) ; `last_report` en JSON. */
async function writeState(sql: Sql, patch: Record<string, unknown>, now: Date): Promise<void> {
  await sql`INSERT INTO production_deletion_signal_state (id, updated_at) VALUES (1, ${now.toISOString()}) ON CONFLICT (id) DO NOTHING`;
  const cols: Record<string, string | number | null> = { updated_at: now.toISOString() };
  for (const [k, v] of Object.entries(patch)) {
    if (STATE_COLUMNS.has(k)) cols[k] = (v ?? null) as string | number | null;
  }
  await sql`UPDATE production_deletion_signal_state SET ${sql(cols)} WHERE id = 1`;
  if ('last_report' in patch) {
    await sql`UPDATE production_deletion_signal_state SET last_report = ${JSON.stringify(patch.last_report ?? null)}::jsonb WHERE id = 1`;
  }
}

export interface Readiness { ready: boolean; reason: string | null; code: 'READY' | 'NOT_APPLICABLE' | 'KEY_MISSING' | 'KEY_TOO_SHORT' | 'SOURCE_MISSING' | 'NEVER_VERIFIED' | 'STALE' | 'FAILING' }

/**
 * Propagation configurée ET vérifiée ? Condition d'autorisation de tout import
 * de données réelles (politique prudente, lot 104A). Ne lève jamais.
 */
export async function deletionPropagationReadiness(opts: { sql?: Sql; env?: Env; now?: Date } = {}): Promise<Readiness> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const current = currentEnvironmentName(env);
  if (!current || isProductionEnvironment(current, env)) return { ready: true, reason: null, code: 'NOT_APPLICABLE' };
  const k = signalKeyStatus(env);
  if (k === 'missing') return { ready: false, code: 'KEY_MISSING', reason: 'propagation des suppressions de production non configurée (PRODUCTION_DELETION_SIGNAL_KEY absente)' };
  if (k === 'too_short') return { ready: false, code: 'KEY_TOO_SHORT', reason: 'clé PRODUCTION_DELETION_SIGNAL_KEY trop courte (32 caractères au moins)' };
  if (!signalSourceUrl(env)) return { ready: false, code: 'SOURCE_MISSING', reason: 'adresse de la production absente ou invalide (PRODUCTION_DELETION_SIGNAL_URL, HTTPS)' };
  const st = await readPropagationState(opts.sql ?? pgClient);
  if (!st.lastSuccessAt) return { ready: false, code: 'NEVER_VERIFIED', reason: 'propagation jamais vérifiée : aucun échange réussi avec la production (BO › Copies de données réelles › « Vérifier la propagation »)' };
  if (st.lastStatus !== 'ok') return { ready: false, code: 'FAILING', reason: `dernier échange avec la production en échec (${st.lastError ?? st.lastStatus})` };
  const maxAgeMs = readinessMaxAgeHours(env) * 3_600_000;
  if (now.getTime() - new Date(st.lastSuccessAt).getTime() > maxAgeMs) {
    return { ready: false, code: 'STALE', reason: `dernier échange réussi avec la production trop ancien (plus de ${readinessMaxAgeHours(env)} h)` };
  }
  return { ready: true, reason: null, code: 'READY' };
}

/* ══ Préproduction : synchronisation et rattrapage ═════════════════════════ */

export type PurgeOutcome = 'purged' | 'gone' | { failed: string };
export interface PropagationDeps {
  /** Purge d'un sujet copié par le moteur existant. */
  purge: (subject: { kind: 'user' | 'account'; targetId: number }, now: Date) => Promise<PurgeOutcome>;
}

/** Purge par le moteur existant (registre 102A → `executeScheduledDeletion`). */
async function purgeByEngine(subject: { kind: 'user' | 'account'; targetId: number }, now: Date): Promise<PurgeOutcome> {
  const { replayRegistryEntry } = await import('@/services/account/deletion-registry.service');
  const owned = subject.kind === 'user'
    ? (await pgClient<Row[]>`SELECT id FROM accounts WHERE owner_user_id = ${subject.targetId} ORDER BY id`).map((r) => Number(r.id))
    : [subject.targetId];
  const r = await replayRegistryEntry({
    scheduleId: null, reason: 'ADMIN', scope: subject.kind === 'user' ? 'user' : 'account',
    userIds: subject.kind === 'user' ? [subject.targetId] : [], accountIds: owned, executedAt: now.toISOString(),
  }, now);
  if (r.status === 'replayed') return 'purged';
  if (r.status === 'nothing') return 'gone';
  return { failed: r.reason.slice(0, 200) };
}

export interface PropagationIssue {
  code: 'NOT_CONFIGURED' | 'SYNC_FAILED' | 'PURGE_FAILED' | 'COVERAGE_GAP' | 'ORPHAN_COPY';
  detail: string;
  copies?: number[];
}

export interface PropagationReport {
  status: 'ok' | 'unavailable' | 'invalid' | 'not_configured' | 'skipped';
  reason?: string;
  entries: number;
  matched: number;
  purged: number;
  alreadyGone: number;
  repurged: number;
  failed: number;
  captured: number;
  issues: PropagationIssue[];
  error?: string;
}

async function fetchAllSignals(input: { key: string; url: string; fetchImpl: FetchLike; clock: () => number; env: Env }): Promise<
  { ok: true; entries: DeletionSignalEntry[]; coversSince: string; environment: string } | { ok: false; kind: 'unavailable' | 'invalid'; error: string }
> {
  const target = new URL(input.url);
  let after: string | null = null;
  const entries: DeletionSignalEntry[] = [];
  let coversSince = '';
  let environment = '';
  for (let pageNo = 0; pageNo < 1_000; pageNo++) {
    const params: Record<string, string> = { limit: String(DELETION_SIGNAL_DEFAULTS.pageSize) };
    if (after) params.after = after;
    const ts = String(input.clock());
    const sig = signRequest(input.key, 'GET', target.pathname, params, ts);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DELETION_SIGNAL_DEFAULTS.timeoutMs);
    let res: Response;
    let body: string;
    try {
      res = await input.fetchImpl(`${target.origin}${target.pathname}?${new URLSearchParams(params).toString()}`, {
        method: 'GET', cache: 'no-store', redirect: 'error', signal: ctrl.signal,
        headers: { accept: 'application/json', [DELETION_SIGNAL_HEADERS.timestamp]: ts, [DELETION_SIGNAL_HEADERS.signature]: sig },
      });
      body = await res.text();
    } catch (e) {
      return { ok: false, kind: 'unavailable', error: ctrl.signal.aborted ? `délai dépassé (${DELETION_SIGNAL_DEFAULTS.timeoutMs} ms)` : `production injoignable (${(e as Error).message.slice(0, 120)})` };
    } finally {
      clearTimeout(timer);
    }
    if (res.status !== 200) {
      let code = '';
      try { code = String((JSON.parse(body) as { code?: unknown }).code ?? ''); } catch { /* corps non JSON */ }
      return { ok: false, kind: 'unavailable', error: `HTTP ${res.status}${code ? ` ${code}` : ''}` };
    }
    const check = verifyResponseSignature(input.key, body, res.headers.get(DELETION_SIGNAL_HEADERS.timestamp), res.headers.get(DELETION_SIGNAL_HEADERS.signature), input.clock());
    if (!check.ok) return { ok: false, kind: 'invalid', error: `réponse non authentifiée (${check.reason})` };
    let raw: unknown;
    try { raw = JSON.parse(body); } catch { return { ok: false, kind: 'invalid', error: 'réponse illisible' }; }
    const parsed = parseSignalPage(raw);
    if (!parsed.ok) return { ok: false, kind: 'invalid', error: parsed.error };
    if (!isProductionEnvironment(parsed.page.environment, input.env)) {
      return { ok: false, kind: 'invalid', error: `la source n'est pas un environnement de production (${parsed.page.environment})` };
    }
    environment = parsed.page.environment;
    coversSince = coversSince || parsed.page.coversSince;
    entries.push(...parsed.page.entries);
    if (entries.length > DELETION_SIGNAL_DEFAULTS.maxEntries) return { ok: false, kind: 'invalid', error: 'trop de suppressions publiées (garde-fou)' };
    if (!parsed.page.next) return { ok: true, entries, coversSince, environment };
    after = parsed.page.next;
  }
  return { ok: false, kind: 'invalid', error: 'pagination sans fin' };
}

async function existingIds(sql: Sql, kind: 'user' | 'account', ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = kind === 'user'
    ? await sql<Row[]>`SELECT id FROM users WHERE id IN ${sql(ids)}`
    : await sql<Row[]>`SELECT id FROM accounts WHERE id IN ${sql(ids)}`;
  return new Set(rows.map((r) => Number(r.id)));
}

/**
 * Synchronisation + rattrapage (préproduction). Ne lève jamais : tout échec
 * est rapporté, l'anomalie Supervision reste ouverte jusqu'à résolution.
 */
export async function syncProductionDeletionSignals(opts: {
  sql?: Sql; env?: Env; now?: Date; fetchImpl?: FetchLike; deps?: PropagationDeps; trigger?: string;
} = {}): Promise<PropagationReport> {
  const sql = opts.sql ?? pgClient;
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const clock = opts.now ? () => opts.now!.getTime() : () => Date.now();
  const deps = opts.deps ?? { purge: purgeByEngine };
  const report: PropagationReport = { status: 'ok', entries: 0, matched: 0, purged: 0, alreadyGone: 0, repurged: 0, failed: 0, captured: 0, issues: [] };
  const current = currentEnvironmentName(env);
  if (!current) return { ...report, status: 'skipped', reason: 'environnement inconnu (NEXT_PUBLIC_APP_ENV)' };
  if (isProductionEnvironment(current, env)) return { ...report, status: 'skipped', reason: 'sans objet en production' };

  try {
    const key = signalKey(env);
    const url = signalSourceUrl(env);
    const active = await sql<Row[]>`
      SELECT id, account_ids, subjects_captured_at, COALESCE(source_snapshot_at, imported_at) AS snap
        FROM production_data_copies WHERE status IN ('active', 'purging') ORDER BY id`;

    // 1. Inventaire des copies actives qui n'en ont pas encore (clé posée après l'import, copie antérieure au lot 104A).
    if (key) {
      for (const c of active) {
        if (!c.subjects_captured_at) report.captured += await captureCopySubjects(Number(c.id), { sql, env, now });
      }
    }

    // 2. Copies purgées / closes : sujets clos, empreintes effacées.
    const ended = await sql<Row[]>`
      SELECT DISTINCT c.id, c.status FROM production_data_copies c JOIN production_copy_subjects s ON s.copy_id = c.id
       WHERE c.status IN ('purged', 'closed', 'expired_unused') AND s.status IN ('present', 'failed')`;
    for (const c of ended) await closeCopySubjects(Number(c.id), c.status === 'purged' ? 'purged' : 'closed', sql, now);

    // 3. Lecture des suppressions de production.
    const before = await readPropagationState(sql);
    let entries: DeletionSignalEntry[] | null = null;
    if (!key || !url) {
      report.status = 'not_configured';
      report.reason = !key ? (signalKeyStatus(env) === 'too_short' ? 'clé trop courte' : 'clé absente') : 'adresse de la production absente ou invalide';
      await writeState(sql, { last_attempt_at: now.toISOString(), last_status: 'not_configured', last_error: report.reason }, now);
      if (active.length > 0) {
        report.issues.push({ code: 'NOT_CONFIGURED', detail: `propagation des suppressions non configurée (${report.reason}) alors que ${active.length} copie(s) de données réelles sont présentes : une suppression en production n'y serait pas répercutée avant l'échéance`, copies: active.map((c) => Number(c.id)) });
      }
    } else {
      const fetched = await fetchAllSignals({ key, url, fetchImpl: opts.fetchImpl ?? (globalThis.fetch as FetchLike), clock, env });
      if (!fetched.ok) {
        report.status = fetched.kind;
        report.error = fetched.error;
        const failures = before.consecutiveFailures + 1;
        await writeState(sql, { last_attempt_at: now.toISOString(), last_status: fetched.kind, last_error: fetched.error, consecutive_failures: failures }, now);
        if (active.length > 0 || failures >= DELETION_SIGNAL_DEFAULTS.alertAfterFailures) {
          report.issues.push({ code: 'SYNC_FAILED', detail: `lecture des suppressions de production impossible (${fetched.error}) — ${failures} échec(s) consécutif(s)`, copies: active.map((c) => Number(c.id)) });
        }
      } else {
        entries = fetched.entries;
        report.entries = entries.length;
        // Couverture : une copie dont l'état source est antérieur à la fenêtre du registre de production
        // peut avoir manqué des suppressions plus anciennes → purge recommandée.
        const gap = active.filter((c) => c.snap && new Date(c.snap as string).getTime() < Date.parse(fetched.coversSince)).map((c) => Number(c.id));
        if (gap.length > 0) {
          report.issues.push({ code: 'COVERAGE_GAP', detail: `copie(s) dont l'état source est antérieur au ${fetched.coversSince.slice(0, 10)} (début du registre des suppressions de production) : des suppressions plus anciennes peuvent manquer — « Purger maintenant » recommandé`, copies: gap });
        }
        await writeState(sql, {
          last_attempt_at: now.toISOString(), last_success_at: now.toISOString(), last_status: 'ok', last_error: null, consecutive_failures: 0,
          source_environment: fetched.environment, covers_since: fetched.coversSince, entries_seen: entries.length,
        }, now);
      }
    }

    // 4. Correspondances et purges.
    const subjectRows = await sql<Row[]>`
      SELECT s.id, s.copy_id, s.subject_kind, s.target_id, s.id_fingerprints, s.contact_fingerprints, s.status, s.matched_signal_ref,
             COALESCE(c.source_snapshot_at, c.imported_at) AS snap
        FROM production_copy_subjects s JOIN production_data_copies c ON c.id = s.copy_id
       WHERE c.status IN ('active', 'purging') AND s.status IN ('present', 'failed', 'purged')
       ORDER BY CASE s.subject_kind WHEN 'account' THEN 0 ELSE 1 END, s.id`;
    const index = entries ? buildSignalIndex(entries) : null;
    const presentUsers = await existingIds(sql, 'user', subjectRows.filter((r) => r.subject_kind === 'user').map((r) => Number(r.target_id)));
    const presentAccounts = await existingIds(sql, 'account', subjectRows.filter((r) => r.subject_kind === 'account').map((r) => Number(r.target_id)));
    const failedCopies = new Set<number>();
    const failures: string[] = [];

    for (const r of subjectRows) {
      const kind = r.subject_kind === 'user' ? 'user' : 'account';
      const subject: CopySubject = {
        id: Number(r.id), copyId: Number(r.copy_id), kind, targetId: Number(r.target_id),
        idFingerprints: (r.id_fingerprints as string[]) ?? [], contactFingerprints: (r.contact_fingerprints as string[]) ?? [],
        copySnapshotAt: r.snap ? new Date(r.snap as string) : null,
      };
      const stillThere = (kind === 'user' ? presentUsers : presentAccounts).has(subject.targetId);
      let ref: string | null = null;
      let reason: 'match' | 'retry' | 'reappeared' | null = null;
      if (r.status === 'purged') {
        // Reprise après restauration : un compte purgé réapparu est purgé de nouveau.
        if (stillThere) { reason = 'reappeared'; ref = (r.matched_signal_ref as string) ?? null; }
      } else if (r.status === 'failed') {
        reason = 'retry'; ref = (r.matched_signal_ref as string) ?? null;
      } else if (index) {
        const e = matchSubject(subject, index);
        if (e) { reason = 'match'; ref = e.ref; report.matched += 1; }
      }
      if (!reason) continue;

      let outcome: PurgeOutcome;
      if (!stillThere && reason !== 'reappeared') outcome = 'gone';
      else {
        try { outcome = await deps.purge({ kind, targetId: subject.targetId }, now); } catch (e) { outcome = { failed: (e as Error).message.slice(0, 200) }; }
      }
      if (outcome === 'purged' || outcome === 'gone') {
        if (outcome === 'purged') { if (reason === 'reappeared') report.repurged += 1; else report.purged += 1; } else report.alreadyGone += 1;
        await sql`
          UPDATE production_copy_subjects
             SET status = 'purged', matched_at = COALESCE(matched_at, ${now.toISOString()}), matched_signal_ref = COALESCE(${ref}, matched_signal_ref),
                 purged_at = ${now.toISOString()}, attempts = attempts + 1, last_error = NULL,
                 id_fingerprints = '{}', contact_fingerprints = '{}', updated_at = ${now.toISOString()}
           WHERE id = ${subject.id}`;
        // Le compte supprimé emporte ses utilisateurs : ils ne seront plus « présents ».
        if (kind === 'account') {
          const still = await existingIds(sql, 'user', [...presentUsers]);
          for (const u of [...presentUsers]) if (!still.has(u)) presentUsers.delete(u);
        }
      } else {
        report.failed += 1;
        failedCopies.add(subject.copyId);
        failures.push(`copie ${subject.copyId} · ${kind === 'user' ? 'utilisateur' : 'compte'} ${subject.targetId} : ${outcome.failed}`);
        await sql`
          UPDATE production_copy_subjects
             SET status = 'failed', matched_at = COALESCE(matched_at, ${now.toISOString()}), matched_signal_ref = COALESCE(${ref}, matched_signal_ref),
                 attempts = attempts + 1, last_error = ${outcome.failed}, updated_at = ${now.toISOString()}
           WHERE id = ${subject.id}`;
      }
    }
    if (failures.length > 0) {
      report.issues.push({ code: 'PURGE_FAILED', detail: `${failures.length} purge(s) en échec, reprises au prochain passage : ${failures.slice(0, 10).join(' ; ')}`, copies: [...failedCopies] });
    }

    // 5. Copies sans inventaire (aucune correspondance possible).
    const orphans = (await sql<Row[]>`
      SELECT c.id FROM production_data_copies c
       WHERE c.status IN ('active', 'purging') AND jsonb_array_length(c.account_ids) > 0
         AND NOT EXISTS (SELECT 1 FROM production_copy_subjects s WHERE s.copy_id = c.id)`).map((r) => Number(r.id));
    if (orphans.length > 0 && key) {
      report.issues.push({ code: 'ORPHAN_COPY', detail: 'copie(s) active(s) sans inventaire des comptes copiés (comptes introuvables à l’import) : la propagation ne peut pas les couvrir — « Purger maintenant » recommandé', copies: orphans });
    }

    await writeState(sql, { last_report: { at: now.toISOString(), trigger: opts.trigger ?? null, ...summary(report) } }, now);
  } catch (e) {
    report.status = 'unavailable';
    report.error = (e as Error).message.slice(0, 200);
    report.issues.push({ code: 'SYNC_FAILED', detail: `synchronisation interrompue : ${report.error}` });
  }
  await superviseIssues(report);
  if (report.matched || report.purged || report.repurged || report.failed || report.status !== 'ok') {
    console.info(`[deletion-signals] préproduction : ${report.status} — ${report.entries} suppression(s) lue(s), ${report.matched} correspondance(s), `
      + `${report.purged} purge(s), ${report.repurged} reprise(s), ${report.failed} échec(s)${report.error ? ` (${report.error})` : ''}.`);
  }
  return report;
}

function summary(r: PropagationReport): Record<string, unknown> {
  return {
    status: r.status, entries: r.entries, matched: r.matched, purged: r.purged, alreadyGone: r.alreadyGone, repurged: r.repurged,
    failed: r.failed, captured: r.captured, issues: r.issues.map((i) => ({ code: i.code, copies: i.copies ?? [] })), error: r.error ?? null,
  };
}

async function superviseIssues(report: PropagationReport): Promise<void> {
  try {
    const { autoResolveAnomaly, buildFingerprint, reportAnomaly } = await import('@/services/admin/anomaly.service');
    const fingerprint = buildFingerprint('other', ...DELETION_PROPAGATION_FINGERPRINT_PARTS);
    if (report.issues.length > 0) {
      await reportAnomaly({
        domain: 'other',
        fingerprint,
        title: `Copies de données réelles : propagation des suppressions de production à traiter (${report.issues.map((i) => i.code).join(', ')})`,
        detail: {
          problemes: report.issues.map((i) => ({ code: i.code, detail: i.detail, copies: i.copies ?? [] })),
          bilan: summary(report),
          action: 'BO › Exploitation › Sauvegardes et recette › « Copies de données réelles » — docs/exploitation/copies-donnees-reelles-preproduction.md (§ 5).',
        },
      });
    } else if (report.status !== 'skipped') {
      await autoResolveAnomaly(fingerprint, { origin: 'production_deletion_signals', cause: 'propagation des suppressions à jour' });
    }
  } catch (e) {
    console.error('[deletion-signals] supervision impossible :', (e as Error).message);
  }
}
