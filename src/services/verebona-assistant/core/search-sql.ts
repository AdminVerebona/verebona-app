/**
 * Expression SQL de normalisation de la recherche LEXICALE (décision V1,
 * CDC BO IA T2-008 / Centre d'aide §4) — avec repli à l'exécution.
 *
 * La migration 0208 crée `verebona_unaccent_lower(text)`, enveloppe
 * IMMUTABLE qui porte les index trigrammes. Si elle n'a pas pu être créée
 * (droits, extension absente, migration en échec), les recherches ne doivent
 * pas échouer (42883 « function does not exist ») : la présence de la
 * fonction est détectée une fois, mise en cache, et l'expression retombe sur
 * `unaccent(lower(coalesce(x, '')))` — forme historique, sans index — ou, sans
 * l'extension unaccent, sur `lower(coalesce(x, ''))`.
 *
 * Cache : le mode « enveloppe » est définitif ; un mode de repli est relu
 * au plus toutes les minutes (la migration peut passer entre-temps).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pgClient } from '@/db';

export type SearchExprMode = 'wrapper' | 'unaccent' | 'lower';

const RETRY_MS = 60_000;
let cache: { mode: SearchExprMode; at: number } | null = null;
let enCours: Promise<SearchExprMode> | null = null;

async function detecter(): Promise<SearchExprMode> {
  try {
    const rows = (await pgClient.unsafe(
      `SELECT to_regprocedure('verebona_unaccent_lower(text)') IS NOT NULL AS wrapper,
              EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'unaccent') AS unaccent`,
    )) as unknown as Array<{ wrapper: boolean; unaccent: boolean }>;
    const r = rows[0];
    if (!r) return 'lower';
    return r.wrapper ? 'wrapper' : r.unaccent ? 'unaccent' : 'lower';
  } catch {
    return 'lower';
  }
}

/** Mode de normalisation disponible sur la base (mis en cache). */
export async function searchExprMode(now: number = Date.now()): Promise<SearchExprMode> {
  if (cache && (cache.mode === 'wrapper' || now - cache.at < RETRY_MS)) return cache.mode;
  enCours ??= detecter().then((mode) => {
    if (mode !== 'wrapper') console.warn(`[verebona] recherche lexicale sans verebona_unaccent_lower : repli « ${mode} » (index trigrammes inutilisés)`);
    cache = { mode, at: Date.now() };
    return mode;
  }).finally(() => { enCours = null; });
  return enCours;
}

/** Remise à zéro du cache (tests). */
export function resetSearchExprCache(): void {
  cache = null;
  enCours = null;
}

/** Expression drizzle normalisée d'une colonne ou d'une valeur. */
export function normalizedSql(mode: SearchExprMode, expr: SQL | AnyPgColumn | string): SQL {
  if (mode === 'wrapper') return sql`verebona_unaccent_lower(${expr})`;
  if (mode === 'unaccent') return sql`unaccent(lower(coalesce(${expr}, '')))`;
  return sql`lower(coalesce(${expr}, ''))`;
}

/** Même expression, en texte SQL brut (requêtes `pgClient.unsafe`). */
export function normalizedText(mode: SearchExprMode, expr: string): string {
  if (mode === 'wrapper') return `verebona_unaccent_lower(${expr})`;
  if (mode === 'unaccent') return `unaccent(lower(coalesce(${expr}, '')))`;
  return `lower(coalesce(${expr}, ''))`;
}
