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
 * Chaque exécution crée sa propre base MODÈLE (`verebona_e2e_<horodatage>_<pid>_modele`)
 * et, depuis le lot 100A, une copie de ce modèle PAR FICHIER de scénarios
 * (`…_f_<suffixe>`, `cloneE2eDatabase`) ; tout est supprimé à la fin
 * (`E2E_KEEP_DB=1` pour garder les bases et les inspecter ; `E2E_SHARED_DB=1`
 * pour revenir à une base commune à tous les fichiers).
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

/**
 * Lot 84A (CDC v5 O-10) — état DÉPLOYÉ d'avant la finalisation BO de
 * l'ancien modèle Sinistres. Le schéma Drizzle ne déclare plus
 * `business_operations.parent_operation_id` (ni les tables et `claim_json`,
 * que leurs migrations 0213 / 0317 / 0323 recréent) ; une base déployée la
 * porte pourtant jusqu'à l'action BO « Finaliser » (jamais supprimée par une
 * migration), et une migration historique s'y appuie (0316_idx_3). Rejouée
 * juste après le schéma Drizzle, comme la création d'origine (0316).
 */
export const PRE_O10_LEGACY_DDL: readonly string[] = [
  'ALTER TABLE business_operations ADD COLUMN IF NOT EXISTS parent_operation_id BIGINT',
  'ALTER TABLE business_operations ADD CONSTRAINT business_operations_parent_fk FOREIGN KEY (parent_operation_id, account_id) REFERENCES business_operations(id, account_id)',
  'ALTER TABLE business_operations ADD CONSTRAINT business_operations_parent_not_self_chk CHECK (parent_operation_id IS NULL OR parent_operation_id <> id)',
];

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
    for (const st of PRE_O10_LEGACY_DDL) await sql.unsafe(st);

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

/**
 * Lot 100A — nom d'une base E2E dérivée d'un préfixe d'exécution (pur).
 * Identifiant PostgreSQL : minuscules, chiffres et `_`, 63 caractères au plus.
 */
export function derivedDatabaseName(prefix: string, suffix: string): string {
  const name = `${prefix}_${suffix}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z0-9_]+$/.test(name) || name.length > 63) throw new Error(`Nom de base E2E invalide : ${name}`);
  return name;
}

/**
 * Lot 100A — copie d'une base MODÈLE déjà construite (`CREATE DATABASE … TEMPLATE`) :
 * même schéma, mêmes migrations, mêmes données de référence, en une fraction de seconde
 * (contre ~20 s pour `bootstrapE2eDatabase`). Le modèle ne doit avoir AUCUNE connexion
 * ouverte : PostgreSQL refuse sinon (55006) — nouvelle tentative brève dans ce cas.
 */
export async function cloneE2eDatabase(options: {
  adminUrl: string;
  template: string;
  database: string;
}): Promise<string> {
  assertSafeAdminUrl(options.adminUrl);
  for (const n of [options.template, options.database]) {
    if (!/^[a-z0-9_]+$/.test(n)) throw new Error(`Nom de base E2E invalide : ${n}`);
  }
  const admin = postgres(options.adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${options.database} WITH (FORCE)`);
    for (let essai = 1; ; essai += 1) {
      try {
        await admin.unsafe(`CREATE DATABASE ${options.database} TEMPLATE ${options.template} ENCODING 'UTF8'`);
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== '55006' || essai >= 20) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  return withDatabase(options.adminUrl, options.database);
}

/**
 * Lot 100A — supprime les bases `<prefix>_*` d'une exécution, sauf `except` (base du
 * fichier en cours). Appelé à la fin de chaque fichier pour les bases des fichiers
 * PRÉCÉDENTS — jamais la sienne : une écriture lancée sans attente (journal, e-mail…)
 * encore en vol à la fin d'un fichier se termine sur sa base au lieu d'échouer sur une
 * connexion coupée — et à la fin de l'exécution pour toutes.
 */
export async function dropE2eDatabasesWithPrefix(adminUrl: string, prefix: string, opts: { except?: string } = {}): Promise<string[]> {
  if (!/^[a-z0-9_]+$/.test(prefix) || prefix.length < 16) throw new Error(`Préfixe de base E2E invalide : ${prefix}`);
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    const rows = (await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE starts_with(datname, ${`${prefix}_`})`)
      .filter((r) => r.datname !== opts.except);
    for (const r of rows) await admin.unsafe(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
    return rows.map((r) => r.datname);
  } finally {
    await admin.end({ timeout: 5 });
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
