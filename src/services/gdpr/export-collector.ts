/**
 * Collecte des données d'un utilisateur et de son compte pour l'export RGPD.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE SCHÉMA EST LA LISTE
 *
 * Comme la suppression (`scheduled-deletion.service`), la collecte ne tient
 * pas de liste de tables : elle lit le catalogue PostgreSQL.
 *
 *   1. `users` (la ligne de l'utilisateur) et `accounts` (ses comptes actifs) ;
 *   2. toute table portant une colonne « utilisateur » (user_id,
 *      owner_user_id…) égale à l'utilisateur, ou « compte » (account_id,
 *      owner_account_id) égale à l'un de ses comptes ;
 *   3. puis, de proche en proche (clés étrangères, 3 niveaux), les lignes
 *      filles des lignes déjà collectées — pièces, relevés, liens d'agenda…
 *      Si la table fille porte elle-même un `account_id`, seules les lignes
 *      de ses comptes sont retenues : on ne suit pas une clé vers les
 *      données d'un autre compte.
 *
 * Les clés étrangères pointant vers `users` / `accounts` ne sont PAS suivies
 * au-delà de l'étape 2 : `invited_by`, `updated_by`… mèneraient à des lignes
 * d'autres comptes (un modèle édité par un administrateur, par exemple).
 *
 * Le filtrage de ce qui peut sortir est fait ensuite, sans base, par
 * `export-content.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { pgClient } from '@/db';
import { EXCLUDED_TABLES, type CollectedTable, type DocumentCandidate } from './export-content';

const USER_COLUMNS = ['user_id', 'owner_user_id', 'billing_owner_user_id', 'initiator_user_id', 'recipient_user_id', 'created_by_user_id'];
const ACCOUNT_COLUMNS = ['account_id', 'owner_account_id'];
const ROOTS = new Set(['users', 'accounts']);
const MAX_DEPTH = 3;
/** Plafond de lignes par table et par passage (garde-fou mémoire). */
const MAX_ROWS_PER_QUERY = 20_000;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

interface ColumnInfo { table: string; column: string; type: string }
interface ForeignKey { child: string; childColumn: string; childType: string; parent: string; parentColumn: string }

async function listOwnerColumns(): Promise<ColumnInfo[]> {
  const rows = await pgClient<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT c.table_name, c.column_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = current_schema()
       AND c.column_name IN ${pgClient([...USER_COLUMNS, ...ACCOUNT_COLUMNS])}
       AND c.data_type IN ('integer', 'bigint')`;
  return rows.map((r) => ({ table: r.table_name, column: r.column_name, type: r.data_type }));
}

/** Clés étrangères mono-colonne du schéma courant. */
async function listForeignKeys(): Promise<ForeignKey[]> {
  const rows = await pgClient<{ child: string; child_column: string; child_type: string; parent: string; parent_column: string }[]>`
    SELECT cl.relname  AS child,  ca.attname AS child_column,
           format_type(ca.atttypid, ca.atttypmod) AS child_type,
           pl.relname  AS parent, pa.attname AS parent_column
      FROM pg_constraint con
      JOIN pg_class cl      ON cl.oid = con.conrelid
      JOIN pg_namespace ns  ON ns.oid = cl.relnamespace AND ns.nspname = current_schema()
      JOIN pg_class pl      ON pl.oid = con.confrelid
      JOIN pg_attribute ca  ON ca.attrelid = con.conrelid  AND ca.attnum = con.conkey[1]
      JOIN pg_attribute pa  ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1`;
  return rows.map((r) => ({
    child: r.child, childColumn: r.child_column, childType: r.child_type,
    parent: r.parent, parentColumn: r.parent_column,
  }));
}

async function hasAccountColumn(table: string, cache: Map<string, boolean>): Promise<boolean> {
  if (cache.has(table)) return cache.get(table)!;
  const [r] = await pgClient<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = 'account_id'`;
  const has = (r?.n ?? 0) > 0;
  cache.set(table, has);
  return has;
}

type Row = Record<string, unknown>;

export interface CollectedData {
  tables: CollectedTable[];
  accountIds: number[];
  documents: DocumentCandidate[];
}

/** Comptes de l'utilisateur : ceux dont il est membre actif, et ceux qu'il possède. */
export async function resolveUserAccountIds(userId: number): Promise<number[]> {
  const rows = await pgClient<{ id: number }[]>`
    SELECT account_id AS id FROM account_memberships WHERE user_id = ${userId} AND lower(status) = 'active'
    UNION
    SELECT id FROM accounts WHERE owner_user_id = ${userId}`;
  return [...new Set(rows.map((r) => Number(r.id)))];
}

export async function collectUserData(userId: number): Promise<CollectedData> {
  const accountIds = await resolveUserAccountIds(userId);
  const collected = new Map<string, { rows: Map<string, Row>; truncated: boolean }>();

  const add = (table: string, rows: Row[], truncated: boolean) => {
    let entry = collected.get(table);
    if (!entry) { entry = { rows: new Map(), truncated: false }; collected.set(table, entry); }
    entry.truncated ||= truncated;
    for (const r of rows) {
      const key = r.id != null ? `id:${String(r.id)}` : JSON.stringify(r);
      if (!entry.rows.has(key)) entry.rows.set(key, r);
    }
  };

  // 1. Racines.
  add('users', await pgClient<Row[]>`SELECT * FROM users WHERE id = ${userId}`, false);
  if (accountIds.length) {
    add('accounts', await pgClient<Row[]>`SELECT * FROM accounts WHERE id IN ${pgClient(accountIds)}`, false);
  }

  // 2. Tables rattachées à l'utilisateur ou à ses comptes.
  const ownerColumns = (await listOwnerColumns()).filter((c) => !ROOTS.has(c.table) && !EXCLUDED_TABLES.has(c.table));
  const byTable = new Map<string, ColumnInfo[]>();
  for (const c of ownerColumns) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);

  for (const [table, cols] of byTable) {
    const conds: string[] = [];
    const params: unknown[] = [];
    for (const c of cols) {
      if (USER_COLUMNS.includes(c.column)) {
        params.push(userId);
        conds.push(`${ident(c.column)} = $${params.length}`);
      } else if (accountIds.length) {
        params.push(accountIds);
        conds.push(`${ident(c.column)} = ANY($${params.length}::${c.type === 'bigint' ? 'bigint' : 'int'}[])`);
      }
    }
    if (!conds.length) continue;
    params.push(MAX_ROWS_PER_QUERY + 1);
    const rows = (await pgClient.unsafe(
      `SELECT * FROM ${ident(table)} WHERE ${conds.join(' OR ')} LIMIT $${params.length}`,
      params as never[],
    )) as unknown as Row[];
    add(table, rows.slice(0, MAX_ROWS_PER_QUERY), rows.length > MAX_ROWS_PER_QUERY);
  }

  // 3. Descendance par clés étrangères.
  const fks = (await listForeignKeys()).filter((fk) => !ROOTS.has(fk.parent) && !EXCLUDED_TABLES.has(fk.child) && fk.child !== fk.parent);
  const accountColumnCache = new Map<string, boolean>();
  let frontier = new Set([...collected.keys()].filter((t) => !ROOTS.has(t)));

  for (let depth = 0; depth < MAX_DEPTH && frontier.size > 0; depth++) {
    const next = new Set<string>();
    for (const fk of fks) {
      if (!frontier.has(fk.parent)) continue;
      const parentRows = [...(collected.get(fk.parent)?.rows.values() ?? [])];
      const values = [...new Set(parentRows.map((r) => r[fk.parentColumn]).filter((v) => v != null).map(String))];
      if (!values.length) continue;

      const before = collected.get(fk.child)?.rows.size ?? 0;
      const scoped = accountIds.length > 0 && (await hasAccountColumn(fk.child, accountColumnCache));
      for (let i = 0; i < values.length; i += 1000) {
        const chunk = values.slice(i, i + 1000);
        const params: unknown[] = [chunk];
        let where = `${ident(fk.childColumn)}::text = ANY($1::text[])`;
        if (scoped) {
          params.push(accountIds);
          where += ` AND (account_id IS NULL OR account_id = ANY($2::int[]))`;
        }
        params.push(MAX_ROWS_PER_QUERY + 1);
        const rows = (await pgClient.unsafe(
          `SELECT * FROM ${ident(fk.child)} WHERE ${where} LIMIT $${params.length}`,
          params as never[],
        )) as unknown as Row[];
        add(fk.child, rows.slice(0, MAX_ROWS_PER_QUERY), rows.length > MAX_ROWS_PER_QUERY);
      }
      if ((collected.get(fk.child)?.rows.size ?? 0) > before) next.add(fk.child);
    }
    frontier = next;
  }

  const tables: CollectedTable[] = [...collected.entries()].map(([table, e]) => ({
    table, rows: [...e.rows.values()], truncated: e.truncated,
  }));

  // Documents déposés, joints en binaire (hors liens web et fichiers supprimés).
  const docs = (collected.get('asset_files')?.rows.values() ?? []);
  const documents: DocumentCandidate[] = [...docs]
    .filter((r) => !r.is_web_link && !r.deleted_at)
    .map((r) => ({
      id: Number(r.id),
      originalFilename: (r.original_filename as string) ?? null,
      filename: (r.filename as string) ?? null,
      mimeType: (r.mime_type as string) ?? null,
      size: r.size == null ? null : Number(r.size),
      s3Key: (r.s3_key as string) ?? null,
      s3Bucket: (r.s3_bucket as string) ?? null,
    }));

  return { tables, accountIds, documents };
}
