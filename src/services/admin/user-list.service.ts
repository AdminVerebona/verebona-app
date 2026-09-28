/**
 * Liste des utilisateurs — CDC Back-Office V1 §6.1 (USR-L01 à USR-L05).
 *
 * - USR-L01 : compteurs total / actifs / désactivés, indépendants de la
 *   recherche.
 * - Colonnes : identité, e-mail, compte rattaché, offre du compte, statut.
 *   Le compte est celui de l'adhésion active de l'utilisateur, titulaire ou
 *   second utilisateur (le titulaire est préféré s'il y en a plusieurs).
 * - USR-L02 : recherche insensible à la casse sur prénom, nom, « prénom nom »,
 *   e-mail et nom du compte rattaché.
 * - USR-L03 / USR-L04 : ni filtre ni colonne statut administrateur, rôle,
 *   dernière connexion ou date de création.
 * - USR-L05 : pagination classique et tri sur les colonnes visibles.
 */
import { pgClient } from '@/db';
import { containsPattern, type ListParams, type PageResult } from './list-params';

export const USER_SORTS = ['name', 'email', 'account', 'plan', 'status'] as const;
export type UserSort = (typeof USER_SORTS)[number];

/** Expressions SQL de tri (liste blanche : aucune entrée utilisateur interpolée). */
const ORDER_SQL: Record<UserSort, string> = {
  name: `lower(u.last_name), lower(u.first_name)`,
  email: `lower(u.email)`,
  account: `lower(acc.name)`,
  plan: `upper(coalesce(acc.plan_type, u.plan_type))`,
  status: `u.status`,
};

export function userOrderBy(sort: UserSort, dir: 'asc' | 'desc'): string {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  const cols = ORDER_SQL[sort].split(',').map((c) => `${c.trim()} ${d} NULLS LAST`);
  return [...cols, `u.id ${d}`].join(', ');
}

/** Statut affiché (§6.1) : actif ou désactivé, selon `users.status`. */
export function userDisplayStatus(status: string | null | undefined): 'active' | 'disabled' {
  return status === 'ACTIVE' ? 'active' : 'disabled';
}

export interface UserListItem {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  accountId: number | null;
  accountName: string | null;
  planType: string | null;
  status: 'active' | 'disabled';
}

export interface UserListSummary {
  total: number;
  active: number;
  disabled: number;
}

const ACCOUNT_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT a.id, a.name, a.plan_type
      FROM account_memberships m
      JOIN accounts a ON a.id = m.account_id
     WHERE m.user_id = u.id AND m.status = 'active'
     ORDER BY (m.role = 'owner') DESC, m.joined_at ASC NULLS LAST, m.id ASC
     LIMIT 1
  ) acc ON TRUE`;

const SEARCH_SQL = `(
     u.email ILIKE $1 OR u.first_name ILIKE $1 OR u.last_name ILIKE $1
  OR (u.first_name || ' ' || u.last_name) ILIKE $1
  OR (u.last_name || ' ' || u.first_name) ILIKE $1
  OR EXISTS (
       SELECT 1 FROM account_memberships m2 JOIN accounts a2 ON a2.id = m2.account_id
        WHERE m2.user_id = u.id AND m2.status IN ('active', 'pending') AND a2.name ILIKE $1)
)`;

export async function getUserSummary(): Promise<UserListSummary> {
  const [row] = await pgClient.unsafe<{ total: string; active: string }[]>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'ACTIVE') AS active FROM users`,
  );
  const total = Number(row?.total ?? 0);
  const active = Number(row?.active ?? 0);
  return { total, active, disabled: total - active };
}

export async function getUsersPage(params: ListParams<UserSort>): Promise<PageResult<UserListItem>> {
  const where = params.q ? `WHERE ${SEARCH_SQL}` : '';
  const args: (string | number)[] = params.q ? [containsPattern(params.q)] : [];

  const [countRow] = await pgClient.unsafe<{ n: string }[]>(
    `SELECT count(*) AS n FROM users u ${where}`,
    args,
  );
  const total = Number(countRow?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
  const page = Math.min(Math.max(1, params.page), totalPages);
  const limitIdx = args.length + 1;

  const rows = await pgClient.unsafe<
    { id: number; first_name: string; last_name: string; email: string; status: string; account_id: number | null; account_name: string | null; plan_type: string | null }[]
  >(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.status,
            acc.id AS account_id, acc.name AS account_name, acc.plan_type
       FROM users u
       ${ACCOUNT_LATERAL}
       ${where}
      ORDER BY ${userOrderBy(params.sort, params.dir)}
      LIMIT $${limitIdx} OFFSET $${limitIdx + 1}`,
    [...args, params.pageSize, (page - 1) * params.pageSize],
  );

  return {
    items: rows.map((r) => ({
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
      accountId: r.account_id,
      accountName: r.account_name,
      planType: r.plan_type ? r.plan_type.toUpperCase() : null,
      status: userDisplayStatus(r.status),
    })),
    page,
    pageSize: params.pageSize,
    total,
    totalPages,
  };
}
