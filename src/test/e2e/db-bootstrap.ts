/**
 * Harnais E2E — base PostgreSQL réelle (CDC 15 T2-41, DOD-20, décision D-07).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE VRAIE BASE
 *
 * Les tests unitaires mockent `@/db` : un retrieval SQL cassé, une cascade
 * absente, une colonne jamais créée par une migration passent au vert. Le
 * corpus E2E du CDC 15 (§15) vérifie l'ÉTAT FINAL — fiche, colonnes, agenda,
 * exports — et exige donc de vraies relations.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * COMMENT LA BASE EST CONSTRUITE
 *
 * Même chemin que la production, en deux temps :
 *   1. le schéma Drizzle (`src/db/schema.ts`) est matérialisé sur une base
 *      VIDE par `drizzle-kit/api` (équivalent d'un `drizzle-kit push`, sans
 *      interaction) ;
 *   2. les migrations SQL (`src/db/migrations/*.sql`) sont rejouées dans
 *      l'ordre, chacune isolément, exactement comme `ensureMigrations()` au
 *      démarrage : tables techniques, déclencheurs, index, contraintes que
 *      le schéma Drizzle ne décrit pas.
 *
 * Une migration en échec est rapportée. Celles qui échouent parce que le
 * schéma Drizzle a déjà créé l'objet autrement (migrations historiques non
 * idempotentes) sont listées dans `TOLERATED_MIGRATION_FAILURES` avec leur
 * raison ; toute AUTRE migration en échec fait échouer le démarrage du
 * harnais — c'est précisément ce que la CI doit attraper.
 *
 * Chaque exécution crée sa propre base (`verebona_e2e_<horodatage>`) et la
 * supprime à la fin (`E2E_KEEP_DB=1` pour la garder et l'inspecter).
 * ══════════════════════════════════════════════════════════════════════════
 */
import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runMigrationSql, type SqlRunner } from '../../db/migration-index';

export interface MigrationReport {
  applied: string[];
  failed: Array<{ file: string; code?: string; message: string }>;
}

export interface BootstrapResult {
  /** URL de la base E2E créée (à passer en `DATABASE_URL`). */
  url: string;
  database: string;
  drizzleStatements: number;
  migrations: MigrationReport;
  /** Échecs hors liste de tolérance (le harnais refuse de démarrer s'il y en a). */
  unexpectedFailures: MigrationReport['failed'];
}

/**
 * Migrations dont l'échec est attendu sur une base construite depuis le
 * schéma Drizzle, avec la raison. Maintenue à la main : une entrée ajoutée
 * sans raison vérifiable est une dette, pas une tolérance.
 *
 * Renseignée d'après l'exécution du 29/09/2026 (lot 11) sur PostgreSQL 16.
 */
export const TOLERATED_MIGRATION_FAILURES: Readonly<Record<string, string>> = {};

/**
 * URL d'administration : `E2E_DATABASE_URL` SEULEMENT. Jamais `DATABASE_URL` :
 * un poste de développement la fait pointer vers une vraie base, et le
 * harnais crée / supprime des bases sur ce serveur.
 */
export function adminUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.E2E_DATABASE_URL || null;
}

const HOTES_LOCAUX = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Refuse un serveur non local, sauf `E2E_ALLOW_REMOTE=1` explicite (pur).
 * Lève avec la raison ; rend l'URL sinon.
 */
export function assertSafeAdminUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  let hote: string;
  try {
    hote = new URL(url).hostname;
  } catch {
    throw new Error('[e2e] E2E_DATABASE_URL illisible.');
  }
  if (!HOTES_LOCAUX.has(hote) && env.E2E_ALLOW_REMOTE !== '1') {
    throw new Error(
      `[e2e] Serveur PostgreSQL non local refusé (« ${hote} ») : le harnais y crée et supprime des bases. `
      + 'Poser E2E_ALLOW_REMOTE=1 seulement pour un serveur JETABLE.',
    );
  }
  return url;
}

/** Remplace la base d'une URL PostgreSQL (pur). */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Instructions DDL du schéma Drizzle, depuis une base vide. */
export async function drizzleSchemaStatements(): Promise<string[]> {
  const [{ generateDrizzleJson, generateMigration }, schema] = await Promise.all([
    import('drizzle-kit/api'),
    import('@/db/schema'),
  ]);
  const vide = generateDrizzleJson({});
  const cible = generateDrizzleJson(schema as unknown as Record<string, unknown>);
  return generateMigration(vide, cible);
}

/** Rejoue les migrations SQL dans l'ordre, chacune isolément (comme `ensureMigrations`). */
export async function applySqlMigrations(
  sql: postgres.Sql,
  dir: string = join(process.cwd(), 'src', 'db', 'migrations'),
): Promise<MigrationReport> {
  await sql`CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY, filename TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const report: MigrationReport = { applied: [], failed: [] };
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf-8');
    try {
      // Même exécution que `ensureMigrations` (reprise des index CONCURRENTLY invalides).
      const r = await runMigrationSql(sql as unknown as SqlRunner, text);
      if (r.status === 'deferred') throw new Error(`index ${r.index} : construction différée (verrou)`);
      await sql`INSERT INTO _migrations (filename) VALUES (${file}) ON CONFLICT DO NOTHING`;
      report.applied.push(file);
    } catch (e) {
      const err = e as { message?: string; code?: string };
      report.failed.push({ file, code: err.code, message: err.message ?? String(e) });
    }
  }
  return report;
}

/**
 * Crée une base E2E neuve, y matérialise le schéma puis les migrations.
 * Lève si une migration échoue hors liste de tolérance.
 */
export async function bootstrapE2eDatabase(options: {
  adminUrl: string;
  database?: string;
  log?: (msg: string) => void;
}): Promise<BootstrapResult> {
  const log = options.log ?? (() => undefined);
  assertSafeAdminUrl(options.adminUrl);
  const database = options.database ?? `verebona_e2e_${Date.now()}_${process.pid}`;
  if (!/^[a-z0-9_]+$/.test(database)) throw new Error(`Nom de base E2E invalide : ${database}`);

  const admin = postgres(options.adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database}`);
    await admin.unsafe(`CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = withDatabase(options.adminUrl, database);
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    // Extensions utilisées par les migrations et le runtime (recherche).
    for (const ext of ['pg_trgm', 'unaccent']) {
      await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${ext}`).catch(() => undefined);
    }
    const statements = await drizzleSchemaStatements();
    for (const st of statements) await sql.unsafe(st);
    log(`[e2e] schéma Drizzle : ${statements.length} instruction(s)`);

    const migrations = await applySqlMigrations(sql);
    const unexpectedFailures = migrations.failed.filter((f) => !(f.file in TOLERATED_MIGRATION_FAILURES));
    log(`[e2e] migrations : ${migrations.applied.length} appliquée(s), ${migrations.failed.length} en échec`
      + ` (${unexpectedFailures.length} inattendu(s))`);
    const result: BootstrapResult = {
      url, database, drizzleStatements: statements.length, migrations, unexpectedFailures,
    };
    if (unexpectedFailures.length > 0) {
      const detail = unexpectedFailures.map((f) => `  · ${f.file} (${f.code ?? '—'}) : ${f.message}`).join('\n');
      const err = new Error(`[e2e] migration(s) en échec sur une base neuve :\n${detail}`);
      (err as Error & { result?: BootstrapResult }).result = result;
      throw err;
    }
    await sql.end({ timeout: 5 });
    return result;
  } catch (e) {
    // Aucune base orpheline : celle qu'on vient de créer est supprimée.
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await dropE2eDatabase(options.adminUrl, database, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Supprime la base E2E (sauf `E2E_KEEP_DB=1`). */
export async function dropE2eDatabase(adminUrl: string, database: string, opts: { force?: boolean } = {}): Promise<void> {
  if (process.env.E2E_KEEP_DB === '1' && !opts.force) return;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}
