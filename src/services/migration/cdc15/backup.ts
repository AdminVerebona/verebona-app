/**
 * Copie restaurable des écritures des rattrapages CDC 15 et restauration
 * (`--restore <runId>`) — relecture du lot 17. Voir la migration
 * `0225_cdc15_migration_report_backups.sql` pour le format.
 *
 * Copie : dans la MÊME transaction que l'écriture (appelants : `asset-write`
 * pour les fiches et colonnes, MIG-02 par le hook de la primitive, MIG-01 et
 * MIG-04 pour les faits et les preuves).
 *
 * Restauration : ordre INVERSE des écritures (une clé modifiée par MIG-01
 * puis MIG-03 revient d'abord à l'état MIG-01, puis à l'état d'origine) ;
 * chaque valeur n'est remise que si la valeur en place est EXACTEMENT celle
 * écrite par l'exécution — sinon conflit signalé, rien n'est écrit.
 * Idempotente (`restored_at`).
 */
import type postgres from 'postgres';
import type { SqlRunner } from '@/services/canonical/asset-state';
import type { MigStep } from './types';

export type BackupTarget = 'asset_column' | 'asset_kc' | 'field_evidence' | 'document_fact';

export interface BackupRow {
  targetType: BackupTarget;
  targetId: number;
  assetId: number | null;
  name: string;
  /** `{ v }`, ou null pour une clé de fiche absente. */
  old: { v: unknown } | null;
  next: { v: unknown } | null;
}

const egal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Clés de fiche modifiées entre deux états (valeurs et métadonnées) — pure, testée. */
export function kcDiff(before: Record<string, unknown>, after: Record<string, unknown>): Array<Pick<BackupRow, 'name' | 'old' | 'next'>> {
  const cles = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: Array<Pick<BackupRow, 'name' | 'old' | 'next'>> = [];
  for (const k of [...cles].sort()) {
    const a = k in before ? { v: before[k] } : null;
    const b = k in after ? { v: after[k] } : null;
    if (!egal(a, b)) out.push({ name: k, old: a, next: b });
  }
  return out;
}

/** Forme texte d'une valeur de colonne (comparée à `col::text` à la restauration). */
export const columnText = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z?$/.test(v)) return v.slice(0, 10);
  return String(v);
};

/** Copie des lignes (dans la transaction de l'appelant). */
export async function writeBackups(
  tx: SqlRunner, p: { runId: string; step: MigStep; accountId: number }, rows: BackupRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.unsafe(
    `INSERT INTO cdc15_migration_backups (run_id, step, account_id, asset_id, target_type, target_id, name, old_value, new_value)
     SELECT $1::uuid, $2, $3, b.asset_id, b.target_type, b.target_id, b.name, b.old_value, b.new_value
       FROM jsonb_to_recordset($4::jsonb) AS b(asset_id int, target_type text, target_id bigint, name text, old_value jsonb, new_value jsonb)`,
    [p.runId, p.step, p.accountId, JSON.stringify(rows.map((r) => ({
      asset_id: r.assetId, target_type: r.targetType, target_id: r.targetId, name: r.name, old_value: r.old, new_value: r.next,
    })))] as never[],
  );
}

/** Copie d'un changement de bien : fiche (diff complet) et colonnes écrites. */
export function assetBackupRows(
  assetId: number, kcBefore: Record<string, unknown>, kcAfter: Record<string, unknown> | null,
  row: Record<string, unknown>, columns: Record<string, unknown>,
): BackupRow[] {
  const out: BackupRow[] = [];
  if (kcAfter) {
    for (const d of kcDiff(kcBefore, kcAfter)) out.push({ targetType: 'asset_kc', targetId: assetId, assetId, ...d });
  }
  for (const [col, v] of Object.entries(columns)) {
    const avant = columnText(row[col]);
    const apres = columnText(v);
    if (avant !== apres) out.push({ targetType: 'asset_column', targetId: assetId, assetId, name: col, old: { v: avant }, next: { v: apres } });
  }
  return out;
}

/** Colonnes restaurables par table (liste blanche). */
const COLONNES: Record<Exclude<BackupTarget, 'asset_kc'>, { table: string; columns: Set<string> | null }> = {
  asset_column: { table: 'assets', columns: null },
  field_evidence: { table: 'field_evidence', columns: new Set(['canonical_key', 'raw_value', 'lifecycle_status', 'superseded_at', 'superseded_by_evidence_id']) },
  document_fact: { table: 'document_facts', columns: new Set(['canonical_key', 'raw_key', 'raw_value']) },
};

export interface RestoreResult {
  restored: number;
  conflicts: Array<{ targetType: BackupTarget; targetId: number; name: string }>;
}

/** Restauration d'une exécution (sous le verrou global, posé par l'appelant). */
export async function restoreBackups(sql: postgres.Sql, runId: string, mirrorColumns: readonly string[]): Promise<RestoreResult> {
  const out: RestoreResult = { restored: 0, conflicts: [] };
  const copies = await sql<Array<{ id: number; accountId: number; targetType: BackupTarget; targetId: number; name: string;
    old: { v: unknown } | null; next: { v: unknown } | null }>>`
    SELECT id::int AS id, account_id AS "accountId", target_type AS "targetType", target_id::int AS "targetId", name,
           old_value AS old, new_value AS next
      FROM cdc15_migration_backups WHERE run_id = ${runId} AND restored_at IS NULL ORDER BY id DESC`;
  const types = new Map<string, string>();
  const typeDe = async (table: string, col: string) => {
    const k = `${table}.${col}`;
    if (!types.has(k)) {
      const [t] = await sql<{ t: string }[]>`
        SELECT data_type AS t FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${col}`;
      types.set(k, t?.t ?? '');
    }
    return types.get(k)!;
  };
  const conflit = (c: (typeof copies)[number]) => out.conflicts.push({ targetType: c.targetType, targetId: c.targetId, name: c.name });

  for (const c of copies) {
    let ok = false;
    if (c.targetType === 'asset_kc') {
      await sql.begin(async (t) => {
        const [a] = await t<{ k: string | null }[]>`
          SELECT key_characteristics AS k FROM assets WHERE id = ${c.targetId} AND account_id = ${c.accountId} FOR UPDATE`;
        if (!a) return;
        let kc: Record<string, unknown> = {};
        try { kc = a.k ? JSON.parse(a.k) : {}; } catch { return; }
        const enPlace = c.name in kc ? { v: kc[c.name] } : null;
        if (!egal(enPlace, c.next)) return;
        if (c.old) kc[c.name] = c.old.v; else delete kc[c.name];
        await t`UPDATE assets SET key_characteristics = ${JSON.stringify(kc)}, updated_at = now() WHERE id = ${c.targetId} AND account_id = ${c.accountId}`;
        await t`UPDATE cdc15_migration_backups SET restored_at = now() WHERE id = ${c.id}`;
        ok = true;
      });
    } else {
      const cible = COLONNES[c.targetType];
      const autorisee = /^[a-z_][a-z0-9_]*$/.test(c.name)
        && (cible.columns ? cible.columns.has(c.name) : mirrorColumns.includes(c.name));
      const type = autorisee ? await typeDe(cible.table, c.name) : '';
      if (autorisee && type) {
        const proprio = cible.table === 'assets' ? 'id = $2 AND account_id = $3' : 'id = $2 AND account_id = $3';
        await sql.begin(async (t) => {
          const r = (await t.unsafe(
            `UPDATE ${cible.table} SET ${c.name} = $1::${type}${cible.table === 'assets' ? ', updated_at = now()' : ''}
              WHERE ${proprio} AND ${c.name}::text IS NOT DISTINCT FROM $4::text RETURNING id`,
            [c.old?.v ?? null, c.targetId, c.accountId, c.next?.v ?? null] as never[],
          )) as unknown as unknown[];
          if (r.length === 1) {
            await t`UPDATE cdc15_migration_backups SET restored_at = now() WHERE id = ${c.id}`;
            ok = true;
          }
        });
      }
    }
    if (ok) out.restored += 1; else conflit(c);
  }
  return out;
}
