/**
 * Liste des comptes — filtres, tri et pagination (CDC Back-Office V1
 * ACC-L01, ACC-L03 à ACC-L05, GEN-004). Pur : testé sans base.
 */
import { paginateRows, sortRows, type PageResult } from './list-params';

export type AccountListStatus = 'active' | 'suspended' | 'deletion_pending';

export const ACCOUNT_SORTS = ['name', 'plan', 'status', 'storage', 'documents', 'assets', 'members', 'created', 'lastLogin'] as const;
export type AccountSort = (typeof ACCOUNT_SORTS)[number];

export const ACCOUNT_STATUSES: readonly AccountListStatus[] = ['active', 'suspended', 'deletion_pending'];
export const ACCOUNT_PLANS = ['STANDARD', 'PREMIUM', 'PREMIUM_DUO'] as const;

export interface AccountListRow {
  id: number;
  name: string;
  planType: string;
  status: AccountListStatus;
  memberCount: number;
  assetCount: number;
  documentCount: number;
  storageBytes: number;
  createdAt: Date | string | null;
  lastLoginAt: Date | string | null;
}

export interface AccountFilters {
  plan: string | null;
  status: AccountListStatus | null;
}

/** Filtres ACC-L03 : valeurs hors liste ignorées. */
export function parseAccountFilters(sp: URLSearchParams): AccountFilters {
  const plan = (sp.get('plan') ?? '').toUpperCase();
  const status = sp.get('status') as AccountListStatus | null;
  return {
    plan: (ACCOUNT_PLANS as readonly string[]).includes(plan) ? plan : null,
    status: status && ACCOUNT_STATUSES.includes(status) ? status : null,
  };
}

export function filterAccounts<T extends AccountListRow>(rows: T[], f: AccountFilters): T[] {
  return rows.filter((r) => (!f.plan || r.planType === f.plan) && (!f.status || r.status === f.status));
}

const PLAN_RANK: Record<string, number> = { STANDARD: 1, PREMIUM: 2, PREMIUM_DUO: 3 };
const STATUS_RANK: Record<AccountListStatus, number> = { active: 1, suspended: 2, deletion_pending: 3 };

const toTime = (v: Date | string | null): number | null => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

/** Tri ACC-L04 (+ nom, utilisateurs) ; valeurs absentes en fin. */
export function sortAccounts<T extends AccountListRow>(rows: T[], sort: AccountSort, dir: 'asc' | 'desc'): T[] {
  const get: Record<AccountSort, (r: T) => string | number | null> = {
    name: (r) => r.name,
    plan: (r) => PLAN_RANK[r.planType] ?? 0,
    status: (r) => STATUS_RANK[r.status],
    storage: (r) => r.storageBytes,
    documents: (r) => r.documentCount,
    assets: (r) => r.assetCount,
    members: (r) => r.memberCount,
    created: (r) => toTime(r.createdAt),
    lastLogin: (r) => toTime(r.lastLoginAt),
  };
  return sortRows(rows, get[sort], dir);
}

export function summarizeAccounts(rows: Pick<AccountListRow, 'status'>[]) {
  return {
    total: rows.length,
    active: rows.filter((r) => r.status === 'active').length,
    suspended: rows.filter((r) => r.status === 'suspended').length,
    deletionPending: rows.filter((r) => r.status === 'deletion_pending').length,
  };
}

export function pageAccounts<T extends AccountListRow>(
  rows: T[],
  opts: { filters: AccountFilters; sort: AccountSort; dir: 'asc' | 'desc'; page: number; pageSize: number },
): PageResult<T> {
  return paginateRows(sortAccounts(filterAccounts(rows, opts.filters), opts.sort, opts.dir), opts.page, opts.pageSize);
}
