/**
 * Collecte des données d'un utilisateur et de son compte pour l'export RGPD.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE SCHÉMA EST LA LISTE
 *
 * Comme la suppression (`scheduled-deletion.service`), la collecte ne tient
 * pas de liste de tables : elle lit le catalogue PostgreSQL.
 *
 *   1. `users` (la ligne de l'utilisateur) et `accounts` (ses comptes) ;
 *   2. toute table portant une colonne « utilisateur » (user_id,
 *      owner_user_id…) égale à l'utilisateur, ou « compte » (account_id,
 *      owner_account_id) égale à l'un de ses comptes ;
 *   3. puis, de proche en proche (clés étrangères), les lignes filles des
 *      lignes déjà collectées — pièces, relevés, liens d'agenda… Si la table
 *      fille porte elle-même un `account_id`, seules les lignes de ses
 *      comptes sont retenues : on ne suit pas une clé vers les données d'un
 *      autre compte.
 *
 * Les clés étrangères pointant vers `users` / `accounts` ne sont PAS suivies
 * au-delà de l'étape 2 : `invited_by`, `updated_by`… mèneraient à des lignes
 * d'autres comptes (un modèle édité par un administrateur, par exemple).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 103C — EXHAUSTIVITÉ, MÉMOIRE BORNÉE, ISOLATION DUO
 *
 *  · Plus de plafond silencieux de 20 000 lignes : chaque requête est lue
 *    PAR PAGES (pagination par clé `id`, ou `ctid` pour une table sans `id`).
 *    Un garde-fou très haut (GDPR_EXPORT_MAX_ROWS_PER_TABLE) subsiste ; s'il
 *    est atteint, la table est déclarée incomplète (ROW_LIMIT) et l'archive
 *    devient PARTIELLE — jamais une troncature muette.
 *  · Profondeur des liens : la descente suit les clés étrangères jusqu'au
 *    POINT FIXE (plus aucune ligne nouvelle), au lieu de 3 niveaux arbitraires.
 *    Elle termine toujours : seules les valeurs parentes jamais interrogées
 *    sont relues, et les lignes sont dédoublonnées. Garde-fou
 *    GDPR_EXPORT_FK_MAX_DEPTH (défaut 12, très au-delà de la profondeur réelle
 *    du schéma) : s'il est atteint, les tables concernées sont déclarées
 *    incomplètes (DEPTH_LIMIT).
 *  · Mémoire bornée : avec `onRows`, chaque page est remise au rédacteur de
 *    l'archive (fichier temporaire) puis oubliée ; seules restent en mémoire
 *    les clés de dédoublonnage et les valeurs des colonnes référencées par
 *    une clé étrangère.
 *  · Espaces partagés (Premium Duo) : les tables PERSONNELLES
 *    (`PERSONAL_TABLES`) ne sont lues que pour l'utilisateur exporté, même
 *    via le compte partagé ; leurs filles ne sont atteintes que depuis ses
 *    lignes (`CHILD_SCOPED_TABLES`, clés étrangères).
 *
 * Le filtrage de ce qui peut sortir (colonnes sensibles) est fait ensuite,
 * sans base, par `export-content.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';
import { pgClient } from '@/db';
import {
  CHILD_SCOPED_TABLES, EXCLUDED_TABLES, PERSONAL_TABLES, toJsonValue,
  type CollectedTable, type DocumentCandidate,
} from './export-content';

const USER_COLUMNS = ['user_id', 'owner_user_id', 'billing_owner_user_id', 'initiator_user_id', 'recipient_user_id', 'created_by_user_id'];
const ACCOUNT_COLUMNS = ['account_id', 'owner_account_id'];
const ROOTS = new Set(['users', 'accounts']);

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}
/** Taille d'une page de lecture. */
const PAGE_SIZE = () => envInt('GDPR_EXPORT_PAGE_SIZE', 2_000);
/** Garde-fou de lignes par table (au-delà : table déclarée incomplète, archive PARTIELLE). */
const MAX_ROWS_PER_TABLE = () => envInt('GDPR_EXPORT_MAX_ROWS_PER_TABLE', 5_000_000);
/** Garde-fou de profondeur de la descente par clés étrangères. */
const MAX_DEPTH = () => envInt('GDPR_EXPORT_FK_MAX_DEPTH', 12);
/** Valeurs parentes par requête de descente. */
const CHUNK = 1000;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

type Row = Record<string, unknown>;
interface ForeignKey { child: string; childColumn: string; parent: string; parentColumn: string }

/** Colonnes (nom → type) de chaque table de base du schéma courant. */
async function listColumns(): Promise<Map<string, Map<string, string>>> {
  const rows = await pgClient<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT c.table_name, c.column_name, c.data_type
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = current_schema()`;
  const out = new Map<string, Map<string, string>>();
  for (const r of rows) {
    let m = out.get(r.table_name);
    if (!m) { m = new Map(); out.set(r.table_name, m); }
    m.set(r.column_name, r.data_type);
  }
  return out;
}

/** Clés étrangères mono-colonne du schéma courant. */
async function listForeignKeys(): Promise<ForeignKey[]> {
  const rows = await pgClient<{ child: string; child_column: string; parent: string; parent_column: string }[]>`
    SELECT cl.relname  AS child,  ca.attname AS child_column,
           pl.relname  AS parent, pa.attname AS parent_column
      FROM pg_constraint con
      JOIN pg_class cl      ON cl.oid = con.conrelid
      JOIN pg_namespace ns  ON ns.oid = cl.relnamespace AND ns.nspname = current_schema()
      JOIN pg_class pl      ON pl.oid = con.confrelid
      JOIN pg_attribute ca  ON ca.attrelid = con.conrelid  AND ca.attnum = con.conkey[1]
      JOIN pg_attribute pa  ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1`;
  return rows.map((r) => ({ child: r.child, childColumn: r.child_column, parent: r.parent, parentColumn: r.parent_column }));
}

/** Statistiques de collecte d'une table. */
export interface CollectedTableStat {
  table: string;
  rows: number;
  /** Garde-fou de lignes atteint. */
  truncated: boolean;
  /** Garde-fou de profondeur atteint (lignes filles possiblement non lues). */
  depthLimited: boolean;
}

interface CollectedData {
  /** Lignes par table — vides quand `onRows` reçoit les pages (mode flux). */
  tables: CollectedTable[];
  stats: CollectedTableStat[];
  accountIds: number[];
  documents: DocumentCandidate[];
}

export interface CollectOptions {
  /** Mode flux : chaque page de lignes NOUVELLES est remise ici, puis oubliée. */
  onRows?: (table: string, rows: Row[]) => Promise<void>;
  /** Appelé entre deux pages (bail perdu, délai) : lever interrompt la collecte. */
  checkpoint?: () => void;
  pageSize?: number;
  maxRowsPerTable?: number;
  maxDepth?: number;
}

/** Comptes de l'utilisateur : ceux dont il est membre actif, et ceux qu'il possède. */
async function resolveUserAccountIds(userId: number): Promise<number[]> {
  const rows = await pgClient<{ id: number }[]>`
    SELECT account_id AS id FROM account_memberships WHERE user_id = ${userId} AND lower(status) = 'active'
    UNION
    SELECT id FROM accounts WHERE owner_user_id = ${userId}`;
  return [...new Set(rows.map((r) => Number(r.id)))];
}

interface TableState {
  keys: Set<string>;
  count: number;
  truncated: boolean;
  depthLimited: boolean;
  rows: Row[] | null;
  /** Valeurs des colonnes référencées par une clé étrangère (descente). */
  tracked: Map<string, Set<string>>;
}

function rowKey(row: Row): string {
  if (row.id != null) return `id:${String(row.id)}`;
  return `h:${createHash('sha1').update(JSON.stringify(toJsonValue(row))).digest('base64')}`;
}

function toCandidate(r: Row): DocumentCandidate {
  return {
    id: Number(r.id),
    originalFilename: (r.original_filename as string) ?? null,
    filename: (r.filename as string) ?? null,
    retainedTitle: (r.retained_title as string) ?? null,
    publicId: r.public_id == null ? null : String(r.public_id),
    mimeType: (r.mime_type as string) ?? null,
    size: r.size == null ? null : Number(r.size),
    s3Key: (r.s3_key as string) ?? null,
    s3Bucket: (r.s3_bucket as string) ?? null,
  };
}

export async function collectUserData(userId: number, opts: CollectOptions = {}): Promise<CollectedData> {
  const pageSize = opts.pageSize ?? PAGE_SIZE();
  const maxRows = opts.maxRowsPerTable ?? MAX_ROWS_PER_TABLE();
  const maxDepth = opts.maxDepth ?? MAX_DEPTH();
  const streaming = typeof opts.onRows === 'function';

  const accountIds = await resolveUserAccountIds(userId);
  const columns = await listColumns();
  const allFks = await listForeignKeys();

  // Descente : clés étrangères (hors racines et tables exclues) + filles sans
  // clé déclarée des tables personnelles.
  const fks: ForeignKey[] = [
    ...allFks.filter((fk) => !ROOTS.has(fk.parent) && !EXCLUDED_TABLES.has(fk.child) && columns.has(fk.child)),
    ...Object.entries(CHILD_SCOPED_TABLES)
      .filter(([child]) => columns.get(child)?.has(CHILD_SCOPED_TABLES[child].column))
      .map(([child, s]) => ({ child, childColumn: s.column, parent: s.parent, parentColumn: s.parentColumn })),
  ];
  const trackedColumns = new Map<string, Set<string>>();
  for (const fk of fks) {
    let s = trackedColumns.get(fk.parent);
    if (!s) { s = new Set(); trackedColumns.set(fk.parent, s); }
    s.add(fk.parentColumn);
  }

  const state = new Map<string, TableState>();
  const documents: DocumentCandidate[] = [];
  const stateOf = (table: string): TableState => {
    let st = state.get(table);
    if (!st) {
      st = { keys: new Set(), count: 0, truncated: false, depthLimited: false, rows: streaming ? null : [], tracked: new Map() };
      for (const c of trackedColumns.get(table) ?? []) st.tracked.set(c, new Set());
      state.set(table, st);
    }
    return st;
  };

  /** Ajoute les lignes nouvelles ; renvoie leur nombre. */
  const ingest = async (table: string, rows: Row[]): Promise<number> => {
    const st = stateOf(table);
    const fresh: Row[] = [];
    for (const raw of rows) {
      if (st.count >= maxRows) { st.truncated = true; break; }
      const row = { ...raw };
      delete row.__vb_ctid;
      const key = rowKey(row);
      if (st.keys.has(key)) continue;
      st.keys.add(key);
      st.count++;
      fresh.push(row);
      for (const [col, set] of st.tracked) {
        const v = row[col];
        if (v != null) set.add(String(v));
      }
      if (table === 'asset_files' && !row.is_web_link && !row.deleted_at) documents.push(toCandidate(row));
    }
    if (!fresh.length) return 0;
    if (streaming) await opts.onRows!(table, fresh);
    else st.rows!.push(...fresh);
    return fresh.length;
  };

  /** Lecture paginée d'une requête ; s'arrête au garde-fou de lignes de la table. */
  const readPaged = async (table: string, where: string, params: unknown[]): Promise<number> => {
    const hasId = columns.get(table)?.has('id') ?? false;
    const keyExpr = hasId ? '"id"' : 'ctid';
    let last: unknown = null;
    let added = 0;
    for (;;) {
      opts.checkpoint?.();
      if (stateOf(table).truncated) return added;
      const p = [...params];
      let cond = `(${where})`;
      if (last !== null) {
        p.push(last);
        cond += ` AND ${keyExpr} > $${p.length}${hasId ? '' : '::tid'}`;
      }
      p.push(pageSize);
      const rows = (await pgClient.unsafe(
        `SELECT *${hasId ? '' : ', ctid::text AS "__vb_ctid"'} FROM ${ident(table)} WHERE ${cond} ORDER BY ${keyExpr} LIMIT $${p.length}`,
        p as never[],
      )) as unknown as Row[];
      if (!rows.length) return added;
      const tail = rows[rows.length - 1];
      last = hasId ? tail.id : tail.__vb_ctid;
      added += await ingest(table, rows);
      if (rows.length < pageSize) return added;
    }
  };

  const userColsOf = (table: string) => USER_COLUMNS.filter((c) => columns.get(table)?.has(c) && ['integer', 'bigint'].includes(columns.get(table)!.get(c)!));
  const accountColsOf = (table: string) => ACCOUNT_COLUMNS.filter((c) => columns.get(table)?.has(c) && ['integer', 'bigint'].includes(columns.get(table)!.get(c)!));
  const intArray = (table: string, col: string) => (columns.get(table)?.get(col) === 'bigint' ? 'bigint' : 'int');

  // 1. Racines.
  await readPaged('users', '"id" = $1', [userId]);
  if (accountIds.length) await readPaged('accounts', '"id" = ANY($1::int[])', [accountIds]);

  // 2. Tables rattachées à l'utilisateur ou à ses comptes.
  //    Filles d'une table personnelle : atteintes seulement par la descente.
  const childOfPersonal = new Set(fks.filter((fk) => PERSONAL_TABLES.has(fk.parent) && !PERSONAL_TABLES.has(fk.child)).map((fk) => fk.child));
  for (const table of [...columns.keys()].sort()) {
    if (ROOTS.has(table) || EXCLUDED_TABLES.has(table) || CHILD_SCOPED_TABLES[table] || childOfPersonal.has(table)) continue;
    const userCols = userColsOf(table);
    const accountCols = accountColsOf(table);
    if (!userCols.length && !accountCols.length) continue;
    const params: unknown[] = [];
    const conds: string[] = [];
    for (const c of userCols) { params.push(userId); conds.push(`${ident(c)} = $${params.length}`); }
    if (accountIds.length && accountCols.length) {
      const acc = accountCols.map((c) => { params.push(accountIds); return `${ident(c)} = ANY($${params.length}::${intArray(table, c)}[])`; });
      if (PERSONAL_TABLES.has(table) && userCols.length) {
        // Ligne « de compte » sans utilisateur (traitement système) seulement.
        conds.push(`((${userCols.map((c) => `${ident(c)} IS NULL`).join(' AND ')}) AND (${acc.join(' OR ')}))`);
      } else {
        conds.push(...acc);
      }
    }
    if (!conds.length) continue;
    await readPaged(table, conds.join(' OR '), params);
  }

  // 3. Descente par clés étrangères, jusqu'au point fixe.
  const queried = new Map<string, Set<string>>();
  const fkKey = (fk: ForeignKey) => `${fk.child}.${fk.childColumn}->${fk.parent}.${fk.parentColumn}`;
  const pendingValues = (fk: ForeignKey): string[] => {
    const vals = state.get(fk.parent)?.tracked.get(fk.parentColumn);
    if (!vals?.size) return [];
    const done = queried.get(fkKey(fk)) ?? new Set<string>();
    return [...vals].filter((v) => !done.has(v));
  };

  for (let depth = 0; depth < maxDepth; depth++) {
    let progressed = false;
    for (const fk of fks) {
      const values = pendingValues(fk);
      if (!values.length) continue;
      let done = queried.get(fkKey(fk));
      if (!done) { done = new Set(); queried.set(fkKey(fk), done); }
      for (const v of values) done.add(v);

      const scoped = accountIds.length > 0 && (columns.get(fk.child)?.has('account_id') ?? false);
      const personalUserCols = PERSONAL_TABLES.has(fk.child) ? userColsOf(fk.child) : [];
      for (let i = 0; i < values.length; i += CHUNK) {
        const params: unknown[] = [values.slice(i, i + CHUNK)];
        let where = `${ident(fk.childColumn)}::text = ANY($1::text[])`;
        if (scoped) {
          params.push(accountIds);
          where += ` AND (account_id IS NULL OR account_id = ANY($${params.length}::${intArray(fk.child, 'account_id')}[]))`;
        }
        if (personalUserCols.length) {
          params.push(userId);
          const n = params.length;
          where += ` AND (${personalUserCols.map((c) => `${ident(c)} = $${n}`).join(' OR ')} OR (${personalUserCols.map((c) => `${ident(c)} IS NULL`).join(' AND ')}))`;
        }
        if ((await readPaged(fk.child, where, params)) > 0) progressed = true;
      }
    }
    if (!progressed) break;
  }
  // Garde-fou atteint avec des valeurs encore non suivies : tables incomplètes.
  for (const fk of fks) if (pendingValues(fk).length) stateOf(fk.child).depthLimited = true;

  const stats: CollectedTableStat[] = [...state.entries()].map(([table, st]) => ({
    table, rows: st.count, truncated: st.truncated, depthLimited: st.depthLimited,
  }));
  const tables: CollectedTable[] = [...state.entries()].map(([table, st]) => ({
    table, rows: st.rows ?? [], truncated: st.truncated || st.depthLimited,
  }));

  return { tables, stats, accountIds, documents };
}
