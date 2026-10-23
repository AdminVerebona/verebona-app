/**
 * Exécuteur SQL du service de regroupement (lot 82D, CDC v5 O-1).
 *
 * Le service unique de regroupement est appelé depuis des transactions de
 * deux natures : Drizzle (`withBusinessOperationWrite`, écritures Agenda,
 * cartes « À traiter ») et postgres.js (consolidation d'agenda 76H, client
 * global de la projection). Une seule implémentation des règles, quel que soit
 * l'appelant : chaque fonction reçoit un `GroupingRunner` (texte SQL à
 * paramètres `$n`), adapté depuis l'une ou l'autre transaction.
 *
 * VERROU : toute écriture de regroupement prend le verrou consultatif
 * transactionnel des Opérations du compte (espace 39101, `lock.ts`) — même
 * sérialisation que T3 ; un verrou consultatif est réentrant dans la session.
 */
import { sql, type SQL } from 'drizzle-orm';
import { BUSINESS_OPERATION_LOCK_SPACE } from '../lock';

export interface GroupingRunner {
  q<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/** Texte `$n` → requête Drizzle paramétrée (aucune interpolation de valeur). */
export function compileSql(text: string, params: readonly unknown[] = []): SQL {
  const parts = text.split(/\$(\d+)/);
  const chunks: SQL[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) chunks.push(sql.raw(parts[i]));
    } else {
      const n = Number(parts[i]);
      if (!Number.isInteger(n) || n < 1 || n > params.length) throw new Error(`grouping : paramètre $${parts[i]} absent`);
      chunks.push(sql`${params[n - 1] as never}`);
    }
  }
  return sql.join(chunks, sql.raw(''));
}

/** Transaction (ou client) Drizzle. */
export function drizzleRunner(tx: { execute: (q: SQL) => Promise<unknown> }): GroupingRunner {
  return { q: async <T>(text: string, params: readonly unknown[] = []) => (await tx.execute(compileSql(text, params))) as unknown as T[] };
}

/** Transaction (ou client) postgres.js. */
export function postgresRunner(tx: { unsafe: (text: string, params?: never[]) => Promise<unknown> }): GroupingRunner {
  return { q: async <T>(text: string, params: readonly unknown[] = []) => (await tx.unsafe(text, params as never[])) as unknown as T[] };
}

/** Verrou des écritures Opération du compte (réentrant, relâché à la fin de la transaction). */
export async function lockGroupingAccount(r: GroupingRunner, accountId: number): Promise<void> {
  await r.q(`SELECT pg_advisory_xact_lock($1::int, $2::int)`, [BUSINESS_OPERATION_LOCK_SPACE, accountId]);
  // Marque de transaction lue par le déclencheur 0652 : le rôle écrit ici est explicite.
  await r.q(`SELECT set_config('verebona.grouping_write', 'on', true)`);
}

/** Tableau d'entiers PostgreSQL (`{1,2}`), dédoublonné, valeurs sûres seulement. */
export const intArray = (v: readonly number[]): string => `{${[...new Set(v)].filter((x) => Number.isSafeInteger(x)).join(',')}}`;
export const num = (v: unknown): number => Number(v);
