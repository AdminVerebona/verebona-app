/**
 * Lot 85A (O-2) — image AVANT d'un compte et restauration EXACTE.
 *
 * Journal du rattrapage `operations-v5-rebuild` (comme les journaux ligne à
 * ligne des autres rattrapages, à l'échelle des tables du périmètre
 * `REBUILD_SCOPE`) : avant la purge, dans la MÊME transaction et sous le
 * verrou Opération du compte, les lignes du compte de chaque table du
 * périmètre sont copiées dans `operations_rebuild_snapshots`. Ce n'est pas
 * une sauvegarde parallèle (C-Q8) : le point de restauration de la base
 * (82E) reste exigé et reste le retour arrière global.
 *
 * Empreinte (`accountStateHash`) : empreinte des lignes du compte de toutes
 * les tables du périmètre — relevée à la fin de la reconstruction ; elle sert
 * à l'idempotence (compte inchangé depuis : rien à refaire) et à la
 * restauration (compte modifié depuis : restauration refusée, jamais
 * d'écrasement).
 *
 * Restauration : dans UNE transaction, table par table — lignes en trop
 * supprimées (enfants d'abord), lignes modifiées remises (en place ; en cas
 * de collision d'unicité, supprimées puis réinsérées), lignes manquantes
 * réinsérées avec leur identifiant (parents d'abord), jusqu'à convergence ;
 * puis VÉRIFICATION exacte (chaque ligne de l'image présente et identique,
 * aucune ligne en trop). Écart restant : tout est annulé (rien d'écrit).
 */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { deletionOrder, type ScopeTable } from './model';

type Sql = postgres.Sql | postgres.TransactionSql;
type Row = Record<string, unknown>;

export interface TableMeta extends ScopeTable {
  /** Colonnes réinjectables (hors colonnes générées). */
  columns: string[];
  generated: string[];
  pk: string[];
}

const ident = (x: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(x)) throw new Error(`identifiant SQL invalide : ${x}`);
  return `"${x}"`;
};

/** Métadonnées des tables PRÉSENTES du périmètre (colonnes, générées, clé primaire), dans l'ordre du périmètre. */
export async function scopeMeta(sql: Sql, scope: readonly ScopeTable[]): Promise<TableMeta[]> {
  const noms = scope.map((s) => s.table);
  const cols = await sql.unsafe<Array<{ t: string; c: string; g: boolean; pk: boolean }>>(`
    SELECT c.relname AS t, a.attname AS c, (a.attgenerated <> '') AS g,
           EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace AND c.relname = ANY($1::text[])
     ORDER BY c.relname, a.attnum`, [noms] as never[]);
  const out: TableMeta[] = [];
  for (const s of scope) {
    const c = cols.filter((x) => x.t === s.table);
    if (!c.length) continue;
    const pk = c.filter((x) => x.pk).map((x) => x.c);
    if (!pk.length) throw new Error(`table ${s.table} sans clé primaire : hors du périmètre de restauration`);
    out.push({ ...s, columns: c.filter((x) => !x.g).map((x) => x.c), generated: c.filter((x) => x.g).map((x) => x.c), pk });
  }
  return out;
}

/** Expression jsonb d'une ligne sans ses colonnes générées (alias `alias`). */
const rowJson = (m: TableMeta, alias: string) =>
  m.generated.length ? `(to_jsonb(${alias}) - ARRAY[${m.generated.map((g) => `'${g}'`).join(', ')}]::text[])` : `to_jsonb(${alias})`;
const pkOrder = (m: TableMeta, alias: string) => m.pk.map((p) => `${alias}.${ident(p)}`).join(', ');
const pkMatch = (m: TableMeta, a: string, b: string) => m.pk.map((p) => `${a}.${ident(p)} IS NOT DISTINCT FROM ${b}.${ident(p)}`).join(' AND ');

/** Lignes du compte d'une table (jsonb, sans colonnes générées), ordonnées par clé primaire. */
export async function readTableRows(sql: Sql, m: TableMeta, accountId: number): Promise<Row[]> {
  const [r] = await sql.unsafe<Array<{ rows: Row[] | null }>>(
    `SELECT COALESCE(jsonb_agg(${rowJson(m, 't')} ORDER BY ${pkOrder(m, 't')}), '[]'::jsonb) AS rows FROM ${ident(m.table)} t WHERE ${m.filter}`,
    [accountId] as never[]);
  return (r?.rows ?? []) as Row[];
}

/** Empreinte par table des lignes du compte (lecture seule). */
export async function tableHashes(sql: Sql, meta: readonly TableMeta[], accountId: number): Promise<Record<string, { rows: number; hash: string }>> {
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const m of meta) {
    const [r] = await sql.unsafe<Array<{ n: number; h: string | null }>>(
      `SELECT count(*)::int AS n, md5(COALESCE(string_agg(md5(${rowJson(m, 't')}::text), ',' ORDER BY ${pkOrder(m, 't')}), '')) AS h
         FROM ${ident(m.table)} t WHERE ${m.filter}`, [accountId] as never[]);
    out[m.table] = { rows: Number(r?.n ?? 0), hash: String(r?.h ?? '') };
  }
  return out;
}

/** Empreinte globale (pure) des empreintes par table. */
export function combineHashes(h: Record<string, { rows: number; hash: string }>): string {
  return createHash('sha256').update(Object.keys(h).sort().map((t) => `${t}:${h[t].rows}:${h[t].hash}`).join('|')).digest('hex');
}

export async function accountStateHash(sql: Sql, meta: readonly TableMeta[], accountId: number): Promise<{ hash: string; tables: Record<string, { rows: number; hash: string }> }> {
  const tables = await tableHashes(sql, meta, accountId);
  return { hash: combineHashes(tables), tables };
}

/** Tables dont l'empreinte diffère (pure). */
export function changedTables(a: Record<string, { rows: number; hash: string }>, b: Record<string, { rows: number; hash: string }>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((t) => a[t]?.hash !== b[t]?.hash || a[t]?.rows !== b[t]?.rows).sort();
}

/** Copie l'image AVANT du compte dans le journal de l'exécution (dans la transaction de la purge). */
export async function captureSnapshot(tx: Sql, meta: readonly TableMeta[], runId: string, accountId: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const m of meta) {
    const r = await tx.unsafe<Array<{ n: number }>>(
      `INSERT INTO operations_rebuild_snapshots (run_id, account_id, table_name, row_count, rows)
       SELECT $2::uuid, $1::int, $3::text, count(*)::int, COALESCE(jsonb_agg(${rowJson(m, 't')} ORDER BY ${pkOrder(m, 't')}), '[]'::jsonb)
         FROM ${ident(m.table)} t WHERE ${m.filter}
       RETURNING row_count AS n`, [accountId, runId, m.table] as never[]);
    out[m.table] = Number(r[0]?.n ?? 0);
  }
  return out;
}

export interface RestoreDiff { table: string; missing: number; extra: number; changed: number }

/** Écart entre l'image et l'état courant d'une table (lecture, dans la transaction). */
async function diffTable(tx: Sql, m: TableMeta, accountId: number, image: string): Promise<RestoreDiff> {
  const [r] = await tx.unsafe<Array<{ missing: number; extra: number; changed: number }>>(`
    WITH s AS (SELECT * FROM jsonb_populate_recordset(NULL::${ident(m.table)}, $2::jsonb))
    SELECT (SELECT count(*)::int FROM s WHERE NOT EXISTS (SELECT 1 FROM ${ident(m.table)} t WHERE ${pkMatch(m, 't', 's')})) AS missing,
           (SELECT count(*)::int FROM ${ident(m.table)} t WHERE (${m.filter}) AND NOT EXISTS (SELECT 1 FROM s WHERE ${pkMatch(m, 't', 's')})) AS extra,
           (SELECT count(*)::int FROM s JOIN ${ident(m.table)} t ON ${pkMatch(m, 't', 's')} WHERE ${rowJson(m, 't')} IS DISTINCT FROM ${rowJson(m, 's')}) AS changed`,
  [accountId, image] as never[]);
  return { table: m.table, missing: Number(r.missing), extra: Number(r.extra), changed: Number(r.changed) };
}

/**
 * Remet les lignes du compte à l'image (dans la transaction `tx`, verrou du
 * compte déjà pris). Lève si l'état exact n'est pas atteint (la transaction
 * est alors annulée par l'appelant). Rend le nombre d'écritures.
 */
export async function restoreFromImages(tx: Sql, meta: readonly TableMeta[], accountId: number, images: ReadonlyMap<string, string>): Promise<{ writes: number; rounds: number }> {
  let writes = 0;
  const cols = (m: TableMeta, a: string) => m.columns.map((c) => `${a}.${ident(c)}`).join(', ');
  const liste = (m: TableMeta) => m.columns.map(ident).join(', ');
  const img = (m: TableMeta) => images.get(m.table) ?? '[]';
  const ordre = [...meta];
  const inverse = deletionOrder(meta) as TableMeta[];
  for (let round = 1; round <= 5; round++) {
    // 1. Lignes en trop (créées depuis l'image), enfants d'abord.
    for (const m of inverse) {
      const r = await tx.unsafe(`
        WITH s AS (SELECT * FROM jsonb_populate_recordset(NULL::${ident(m.table)}, $2::jsonb))
        DELETE FROM ${ident(m.table)} t WHERE (${m.filter}) AND NOT EXISTS (SELECT 1 FROM s WHERE ${pkMatch(m, 't', 's')}) RETURNING 1`,
      [accountId, img(m)] as never[]);
      writes += r.length;
    }
    // 2. Lignes modifiées : remises en place ; collision d'unicité transitoire → supprimées (réinsérées ensuite).
    for (const m of ordre) {
      const setCols = m.columns.filter((c) => !m.pk.includes(c));
      if (!setCols.length) continue;
      const assign = setCols.length === 1 ? `${ident(setCols[0])} = s.${ident(setCols[0])}` : `(${setCols.map(ident).join(', ')}) = (${setCols.map((c) => `s.${ident(c)}`).join(', ')})`;
      try {
        const r = await (tx as postgres.TransactionSql).savepoint((sp) => sp.unsafe(`
          WITH s AS (SELECT * FROM jsonb_populate_recordset(NULL::${ident(m.table)}, $1::jsonb))
          UPDATE ${ident(m.table)} t SET ${assign} FROM s
           WHERE ${pkMatch(m, 't', 's')} AND ${rowJson(m, 't')} IS DISTINCT FROM ${rowJson(m, 's')} RETURNING 1`,
        [img(m)] as never[]));
        writes += (r as unknown[]).length;
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        const r = await tx.unsafe(`
          WITH s AS (SELECT * FROM jsonb_populate_recordset(NULL::${ident(m.table)}, $1::jsonb))
          DELETE FROM ${ident(m.table)} t USING s WHERE ${pkMatch(m, 't', 's')} AND ${rowJson(m, 't')} IS DISTINCT FROM ${rowJson(m, 's')} RETURNING 1`,
        [img(m)] as never[]);
        writes += r.length;
      }
    }
    // 3. Lignes manquantes (supprimées depuis l'image, ou par cascade ci-dessus), parents d'abord.
    for (const m of ordre) {
      const r = await tx.unsafe(`
        WITH s AS (SELECT * FROM jsonb_populate_recordset(NULL::${ident(m.table)}, $1::jsonb))
        INSERT INTO ${ident(m.table)} (${liste(m)})
        SELECT ${cols(m, 's')} FROM s WHERE NOT EXISTS (SELECT 1 FROM ${ident(m.table)} t WHERE ${pkMatch(m, 't', 's')})
        ON CONFLICT DO NOTHING RETURNING 1`,
      [img(m)] as never[]);
      writes += r.length;
    }
    const ecarts = [];
    for (const m of ordre) {
      const d = await diffTable(tx, m, accountId, img(m));
      if (d.missing || d.extra || d.changed) ecarts.push(d);
    }
    if (!ecarts.length) return { writes, rounds: round };
    if (round === 5) {
      throw Object.assign(new Error(`restauration inexacte : ${ecarts.map((d) => `${d.table} (manquantes ${d.missing}, en trop ${d.extra}, différentes ${d.changed})`).join(' ; ')}`),
        { code: 'RESTORE_NOT_EXACT', diffs: ecarts });
    }
  }
  return { writes, rounds: 5 };
}
