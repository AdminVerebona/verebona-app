/** Outils communs aux contrôles du registre (purs ou lecture seule). */
import { createHash } from 'node:crypto';
import type { Sql } from './types';

/** Empreinte courte et stable d'une valeur JSON (clés triées). */
export function hashOf(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(stable(value) ?? null)).digest('hex').slice(0, 24);
}

export type Row = Record<string, unknown>;

/**
 * Paramètres SQL : les dates sont transmises en ISO 8601 — les sérialiseurs de
 * dates du client `pgClient` sont rendus transparents par Drizzle (voir
 * `src/db/index.ts`), une instance `Date` n'y est pas sérialisable.
 */
const sqlParams = (params: readonly unknown[]): never[] =>
  params.map((v) => (v instanceof Date ? v.toISOString() : v)) as never[];

/** Requête paramétrée (SQL brut, comme les campagnes « À traiter »). */
export async function rows(sql: Sql, text: string, params: readonly unknown[] = []): Promise<Row[]> {
  return (await sql.unsafe(text, sqlParams(params))) as unknown as Row[];
}

/** Écriture paramétrée (même conversion des paramètres). */
export async function exec(sql: Sql, text: string, params: readonly unknown[] = []): Promise<void> {
  await sql.unsafe(text, sqlParams(params));
}

/** Identifiants entiers d'une colonne `id` (ordre conservé). */
export const idsOf = (r: Row[], col = 'id'): number[] => r.map((x) => Number(x[col])).filter((x) => Number.isSafeInteger(x));

/** Tableau d'entiers pour `ANY($n::int[])` / `::bigint[]`. */
export const intArray = (ids: readonly number[]): number[] => [...new Set(ids.filter((x) => Number.isSafeInteger(x)))];
