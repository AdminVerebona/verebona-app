/**
 * Accès base du registre RGPD (`gdpr_requests`, migration 0174).
 *
 * Toutes les décisions sont prises par `rules.ts` (pur) ; ce module ne fait
 * qu'appliquer le plan, dans une transaction avec verrou de ligne pour que
 * deux administrateurs ne puissent pas modifier une demande pendant qu'elle
 * passe à « Traitée ».
 */
import { pgClient } from '@/db';
import {
  DEFAULT_SORT,
  SORTS,
  planManualCreate,
  planManualUpdate,
  planReopen,
  type CreatePlan,
  type GdprChannel,
  type GdprOrigin,
  type GdprRequestState,
  type GdprRightType,
  type GdprRuleError,
  type GdprStatus,
  type ListQuery,
  type ManualRequestInput,
} from './rules';

type Sql = typeof pgClient;

export interface GdprRequestRow {
  id: number;
  origin: GdprOrigin;
  status: GdprStatus;
  rightType: GdprRightType;
  channel: GdprChannel;
  receivedAt: string;
  receivedDate: string;
  dueDate: string;
  processedAt: string | null;
  result: string | null;
  lastError: string | null;
  reopenedAt: string | null;
  reopenCount: number;
  userId: number | null;
  accountId: number | null;
  subjectUserRef: number | null;
  subjectAccountRef: number | null;
  subjectEmail: string | null;
  subjectName: string | null;
  accountName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GdprRequestDetail extends GdprRequestRow {
  internalComment: string | null;
  reopenedByEmail: string | null;
  createdByEmail: string | null;
  updatedByEmail: string | null;
  sourceRef: string | null;
}

const SELECT_COLUMNS = `
  r.id, r.origin, r.status, r.right_type, r.channel,
  r.received_at,
  to_char(r.received_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS received_date,
  to_char(r.due_date, 'YYYY-MM-DD') AS due_date,
  r.processed_at, r.result, r.last_error, r.reopened_at, r.reopen_count,
  r.user_id, r.account_id, r.subject_user_ref, r.subject_account_ref,
  coalesce(u.email, r.subject_email) AS subject_email,
  nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS subject_name,
  coalesce(a.name, r.subject_account_name) AS account_name,
  r.created_at, r.updated_at`;

const FROM = `
  FROM gdpr_requests r
  LEFT JOIN users u    ON u.id = r.user_id
  LEFT JOIN accounts a ON a.id = r.account_id`;

type Raw = Record<string, unknown>;

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const num = (v: unknown): number | null => (v == null ? null : Number(v));

function toRow(r: Raw): GdprRequestRow {
  return {
    id: Number(r.id),
    origin: r.origin as GdprOrigin,
    status: r.status as GdprStatus,
    rightType: r.right_type as GdprRightType,
    channel: r.channel as GdprChannel,
    receivedAt: iso(r.received_at)!,
    receivedDate: r.received_date as string,
    dueDate: r.due_date as string,
    processedAt: iso(r.processed_at),
    result: (r.result as string) ?? null,
    lastError: (r.last_error as string) ?? null,
    reopenedAt: iso(r.reopened_at),
    reopenCount: Number(r.reopen_count ?? 0),
    userId: num(r.user_id),
    accountId: num(r.account_id),
    subjectUserRef: num(r.subject_user_ref),
    subjectAccountRef: num(r.subject_account_ref),
    subjectEmail: (r.subject_email as string) ?? null,
    subjectName: (r.subject_name as string) ?? null,
    accountName: (r.account_name as string) ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

function toState(r: GdprRequestRow & { internalComment: string | null }): GdprRequestState {
  return {
    origin: r.origin,
    status: r.status,
    rightType: r.rightType,
    channel: r.channel,
    receivedDate: r.receivedDate,
    dueDate: r.dueDate,
    internalComment: r.internalComment,
    result: r.result,
    userId: r.userId,
    accountId: r.accountId,
  };
}

/* ── Lecture ───────────────────────────────────────────────────────────── */

export interface ListResult {
  items: GdprRequestRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counters: { open: number; processedInPeriod: number; from: string; to: string };
}

/** Liste paginée (GDP-001, GDP-005, GDP-006, GDP-018, GDP-019) et compteurs (GDP-002). */
export async function listGdprRequests(q: ListQuery): Promise<ListResult> {
  const sortExpr = SORTS[q.view][q.sort] ?? SORTS[q.view][DEFAULT_SORT[q.view].sort];
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const where = q.view === 'open' ? `r.status <> 'done'` : `r.status = 'done'`;
  const offset = (q.page - 1) * q.pageSize;

  const [rows, counters] = await Promise.all([
    pgClient.unsafe(
      `SELECT ${SELECT_COLUMNS}, count(*) OVER() AS total_count
       ${FROM}
       WHERE ${where}
       ORDER BY ${sortExpr} ${dir} NULLS LAST, r.id ${dir}
       LIMIT $1 OFFSET $2`,
      [q.pageSize, offset],
    ),
    pgClient<{ open: number; processed: number }[]>`
      SELECT
        count(*) FILTER (WHERE status <> 'done')::int AS open,
        count(*) FILTER (
          WHERE status = 'done'
            AND processed_at >= (${q.from}::date)::timestamp AT TIME ZONE 'Europe/Paris'
            AND processed_at <  ((${q.to}::date + 1))::timestamp AT TIME ZONE 'Europe/Paris'
        )::int AS processed
      FROM gdpr_requests`,
  ]);

  let total = rows.length > 0 ? Number((rows[0] as Raw).total_count) : 0;
  if (rows.length === 0 && offset > 0) {
    // Page au-delà de la fin : le total reste utile à la pagination.
    const [c] = await pgClient.unsafe(`SELECT count(*)::int AS n FROM gdpr_requests r WHERE ${where}`);
    total = Number((c as Raw).n);
  }

  return {
    items: (rows as unknown as Raw[]).map(toRow),
    total,
    page: q.page,
    pageSize: q.pageSize,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
    counters: {
      open: counters[0]?.open ?? 0,
      processedInPeriod: counters[0]?.processed ?? 0,
      from: q.from,
      to: q.to,
    },
  };
}

async function selectDetail(sql: Sql, id: number, lock = false): Promise<GdprRequestDetail | null> {
  const rows = await sql.unsafe(
    `SELECT ${SELECT_COLUMNS}, r.internal_comment, r.source_ref,
            rb.email AS reopened_by_email, cb.email AS created_by_email, ub.email AS updated_by_email
     ${FROM}
     LEFT JOIN users rb ON rb.id = r.reopened_by
     LEFT JOIN users cb ON cb.id = r.created_by
     LEFT JOIN users ub ON ub.id = r.updated_by
     WHERE r.id = $1
     ${lock ? 'FOR UPDATE OF r' : ''}`,
    [id],
  );
  const r = rows[0] as Raw | undefined;
  if (!r) return null;
  return {
    ...toRow(r),
    internalComment: (r.internal_comment as string) ?? null,
    sourceRef: (r.source_ref as string) ?? null,
    reopenedByEmail: (r.reopened_by_email as string) ?? null,
    createdByEmail: (r.created_by_email as string) ?? null,
    updatedByEmail: (r.updated_by_email as string) ?? null,
  };
}

export function getGdprRequest(id: number): Promise<GdprRequestDetail | null> {
  return selectDetail(pgClient, id);
}

/** Recherche d'une personne concernée pour la création manuelle. */
export async function searchSubjects(q: string, limit = 10) {
  const term = `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const asId = /^\d+$/.test(q.trim()) ? Number(q.trim()) : -1;
  const rows = await pgClient<Raw[]>`
    SELECT u.id AS user_id, u.email, u.first_name, u.last_name,
           a.id AS account_id, a.name AS account_name
      FROM users u
      LEFT JOIN LATERAL (
        SELECT m.account_id FROM account_memberships m
         WHERE m.user_id = u.id AND lower(m.status) = 'active'
         ORDER BY m.id LIMIT 1
      ) m ON true
      LEFT JOIN accounts a ON a.id = m.account_id
     WHERE u.status <> 'DELETED'
       AND (u.email ILIKE ${term} OR u.first_name ILIKE ${term} OR u.last_name ILIKE ${term}
            OR a.name ILIKE ${term} OR u.id = ${asId} OR a.id = ${asId})
     ORDER BY u.email
     LIMIT ${limit}`;
  return rows.map((r) => ({
    userId: Number(r.user_id),
    email: r.email as string,
    name: `${(r.first_name as string) ?? ''} ${(r.last_name as string) ?? ''}`.trim(),
    accountId: num(r.account_id),
    accountName: (r.account_name as string) ?? null,
  }));
}

/* ── Écriture manuelle ─────────────────────────────────────────────────── */

export type WriteOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: GdprRuleError | 'NOT_FOUND' | 'SUBJECT_NOT_FOUND'; field?: string };

/** Personne concernée : existence, compte par défaut, instantané affichable. */
async function resolveSubject(sql: Sql, userId: number | null, accountId: number | null) {
  let email: string | null = null;
  let accountName: string | null = null;
  let resolvedAccountId = accountId;
  if (userId !== null) {
    const [u] = await sql<Raw[]>`SELECT id, email FROM users WHERE id = ${userId}`;
    if (!u) return null;
    email = u.email as string;
    if (resolvedAccountId === null) {
      const [m] = await sql<Raw[]>`
        SELECT account_id FROM account_memberships
         WHERE user_id = ${userId} AND lower(status) = 'active' ORDER BY id LIMIT 1`;
      resolvedAccountId = m ? Number(m.account_id) : null;
    }
  }
  if (resolvedAccountId !== null) {
    const [a] = await sql<Raw[]>`SELECT id, name FROM accounts WHERE id = ${resolvedAccountId}`;
    if (!a) return null;
    accountName = a.name as string;
  }
  return { userId, accountId: resolvedAccountId, email, accountName };
}

/**
 * Création manuelle (GDP-010). `idempotencyKey` (en-tête Idempotency-Key)
 * protège de la double soumission (ERR-002) : la seconde requête renvoie la
 * demande déjà créée.
 */
export async function createManualRequest(
  input: ManualRequestInput & Record<string, unknown>,
  adminId: number,
  idempotencyKey: string | null,
  now: Date = new Date(),
): Promise<WriteOutcome<{ request: GdprRequestDetail; plan: CreatePlan; replayed: boolean }>> {
  const plan = planManualCreate(input, now);
  if (!plan.ok) return plan;
  const p = plan.value;
  const sourceRef = idempotencyKey ? `manual:${idempotencyKey.slice(0, 200)}` : null;

  return pgClient.begin(async (sql) => {
    if (sourceRef) {
      const [existing] = await sql<Raw[]>`SELECT id FROM gdpr_requests WHERE source_ref = ${sourceRef}`;
      if (existing) {
        const request = await selectDetail(sql as unknown as Sql, Number(existing.id));
        return { ok: true as const, value: { request: request!, plan: p, replayed: true } };
      }
    }
    const subject = await resolveSubject(sql as unknown as Sql, p.userId, p.accountId);
    if (!subject) return { ok: false as const, error: 'SUBJECT_NOT_FOUND' as const };

    const [row] = await sql<Raw[]>`
      INSERT INTO gdpr_requests (
        origin, user_id, account_id, subject_user_ref, subject_account_ref,
        subject_email, subject_account_name, right_type, channel, status,
        received_at, due_date, processed_at, internal_comment, result,
        created_by, updated_by, source_ref, created_at, updated_at
      ) VALUES (
        'manual', ${subject.userId}, ${subject.accountId}, ${subject.userId}, ${subject.accountId},
        ${subject.email}, ${subject.accountName}, ${p.rightType}, ${p.channel}, ${p.status},
        (${p.receivedDate}::date)::timestamp AT TIME ZONE 'Europe/Paris', ${p.dueDate}::date,
        ${p.status === 'done' ? now : null}, ${p.internalComment}, ${p.result},
        ${adminId}, ${adminId}, ${sourceRef}, ${now}, ${now}
      ) RETURNING id`;
    const request = await selectDetail(sql as unknown as Sql, Number(row.id));
    return { ok: true as const, value: { request: request!, plan: p, replayed: false } };
  }) as Promise<WriteOutcome<{ request: GdprRequestDetail; plan: CreatePlan; replayed: boolean }>>;
}

/** Modification d'une demande manuelle non traitée (GDP-014). */
export async function updateManualRequest(
  id: number,
  input: ManualRequestInput & Record<string, unknown>,
  adminId: number,
  now: Date = new Date(),
): Promise<WriteOutcome<{ before: GdprRequestDetail; after: GdprRequestDetail; dueDateRecomputed: boolean }>> {
  return pgClient.begin(async (sql) => {
    const s = sql as unknown as Sql;
    const before = await selectDetail(s, id, true);
    if (!before) return { ok: false as const, error: 'NOT_FOUND' as const };
    const plan = planManualUpdate(toState(before), input, now);
    if (!plan.ok) return plan;
    const c = plan.value.changes;

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };

    if (c.userId !== undefined || c.accountId !== undefined) {
      const subject = await resolveSubject(
        s,
        c.userId !== undefined ? c.userId : before.userId,
        c.accountId !== undefined ? c.accountId : before.accountId,
      );
      if (!subject) return { ok: false as const, error: 'SUBJECT_NOT_FOUND' as const };
      set('user_id', subject.userId);
      set('account_id', subject.accountId);
      set('subject_user_ref', subject.userId);
      set('subject_account_ref', subject.accountId);
      set('subject_email', subject.email);
      set('subject_account_name', subject.accountName);
    }
    if (c.rightType !== undefined) set('right_type', c.rightType);
    if (c.channel !== undefined) set('channel', c.channel);
    if (c.receivedDate !== undefined) {
      params.push(c.receivedDate);
      sets.push(`received_at = ($${params.length}::date)::timestamp AT TIME ZONE 'Europe/Paris'`);
    }
    if (c.dueDate !== undefined) set('due_date', c.dueDate, '::date');
    if (c.status !== undefined) set('status', c.status);
    if (plan.value.becomesDone) set('processed_at', now);
    if (c.internalComment !== undefined) set('internal_comment', c.internalComment);
    if (c.result !== undefined) set('result', c.result);
    set('updated_by', adminId);
    set('updated_at', now);

    params.push(id);
    await s.unsafe(
      `UPDATE gdpr_requests SET ${sets.join(', ')}
        WHERE id = $${params.length} AND origin = 'manual' AND status <> 'done'`,
      params as never[],
    );
    const after = await selectDetail(s, id);
    return { ok: true as const, value: { before, after: after!, dueDateRecomputed: plan.value.dueDateRecomputed } };
  }) as Promise<WriteOutcome<{ before: GdprRequestDetail; after: GdprRequestDetail; dueDateRecomputed: boolean }>>;
}

/** Réouverture (GDP-015 à GDP-017) : échéance conservée, auteur et date tracés. */
export async function reopenManualRequest(
  id: number,
  adminId: number,
  now: Date = new Date(),
): Promise<WriteOutcome<{ before: GdprRequestDetail; after: GdprRequestDetail }>> {
  return pgClient.begin(async (sql) => {
    const s = sql as unknown as Sql;
    const before = await selectDetail(s, id, true);
    if (!before) return { ok: false as const, error: 'NOT_FOUND' as const };
    const plan = planReopen(before);
    if (!plan.ok) return plan;
    // `due_date` n'apparaît volontairement pas ici (GDP-017).
    await s`
      UPDATE gdpr_requests
         SET status = ${plan.value.status}, processed_at = NULL,
             reopened_at = ${now}, reopened_by = ${adminId}, reopen_count = reopen_count + 1,
             updated_by = ${adminId}, updated_at = ${now}
       WHERE id = ${id} AND origin = 'manual' AND status = 'done'`;
    const after = await selectDetail(s, id);
    return { ok: true as const, value: { before, after: after! } };
  }) as Promise<WriteOutcome<{ before: GdprRequestDetail; after: GdprRequestDetail }>>;
}
