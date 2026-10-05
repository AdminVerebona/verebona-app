/**
 * Index construits en `CREATE INDEX CONCURRENTLY` par une migration — reprise
 * d'un index INVALIDE (revue lot 12, CDC 15 migrations 0217 à 0219).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE DÉFAUT CORRIGÉ
 *
 * Une construction CONCURRENTLY interrompue (redémarrage, `lock_timeout`,
 * doublon d'un index unique…) laisse l'index en place avec
 * `pg_index.indisvalid = false`. Au démarrage suivant, `IF NOT EXISTS`
 * RÉUSSIT sans rien faire, le fichier est marqué appliqué : l'index reste
 * invalide pour toujours — jamais utilisé par le planificateur, toujours
 * maintenu en écriture.
 *
 * `runMigrationSql`, pour un fichier à UNE instruction `CREATE [UNIQUE] INDEX
 * CONCURRENTLY IF NOT EXISTS <nom>` :
 *   1. prend un verrou consultatif de SESSION sur le nom de l'index
 *      (`pg_try_advisory_lock`, sur une connexion réservée) — deux instances
 *      qui démarrent ensemble ne se détruisent pas mutuellement l'index en
 *      construction ; verrou non obtenu → `deferred`, rien n'est fait ;
 *   2. construction en cours ailleurs (`pg_stat_progress_create_index`) →
 *      `deferred`, rien n'est fait ;
 *   3. index invalide → `DROP INDEX CONCURRENTLY IF EXISTS`, puis
 *      construction ; le fichier n'est applicable que si l'index est VALIDE.
 * `deferred` : le fichier n'est pas marqué appliqué et sera repris au
 * prochain démarrage (ce n'est pas un échec).
 *
 * `repairInvalidMigrationIndexes` (contrôle de démarrage, après les
 * migrations) traite les index invalides d'un fichier DÉJÀ marqué appliqué
 * (ex. 0217) : reconstruction IMMÉDIATE par `runMigrationSql` — même verrou,
 * mêmes garde-fous. Choix : réparer tout de suite plutôt que seulement
 * supprimer la ligne `_migrations` — l'index manque sinon jusqu'au prochain
 * redémarrage, qui peut être lointain. Si la reconstruction est différée ou
 * échoue, la ligne `_migrations` est supprimée : le fichier sera rejoué au
 * prochain démarrage (filet de sécurité, jamais d'index invalide oublié).
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Module sans connexion propre : le client est passé par l'appelant
 * (`ensureMigrations`, harnais E2E, tests).
 */

/** Sous-ensemble du client `postgres` utilisé ici. */
export interface SqlRunner {
  unsafe(query: string, params?: never[]): Promise<unknown>;
  /** Connexion dédiée (client `postgres`) — requise pour un verrou de session. */
  reserve?: () => Promise<SqlRunner & { release(): void }>;
}

const CONCURRENT_INDEX = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+("?)([A-Za-z_][A-Za-z0-9_]*)\1\s+ON\s/i;

/** Retire les commentaires `-- …` (les fichiers de migration n'en ont pas d'autres). */
function sansCommentaires(sql: string): string {
  return sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n').trim();
}

/**
 * Nom de l'index si le fichier est UNE seule instruction
 * `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <nom> ON …`, sinon null.
 */
export function concurrentIndexName(sql: string): string | null {
  const corps = sansCommentaires(sql).replace(/;\s*$/, '');
  if (corps.includes(';')) return null;
  const m = CONCURRENT_INDEX.exec(corps);
  return m ? m[2] : null;
}

/** Validité d'un index du schéma courant : true, false, ou null s'il n'existe pas. */
export async function indexValidity(client: SqlRunner, name: string): Promise<boolean | null> {
  const rows = (await client.unsafe(
    `SELECT i.indisvalid AS valid
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
    [name] as never[],
  )) as Array<{ valid: boolean }>;
  return rows.length ? rows[0].valid : null;
}

/** Une construction de cet index est-elle en cours (autre session) ? */
export async function indexBuildInProgress(client: SqlRunner, name: string): Promise<boolean> {
  const rows = (await client.unsafe(
    `SELECT 1 FROM pg_stat_progress_create_index p
       JOIN pg_class c ON c.oid = p.index_relid
      WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
    [name] as never[],
  )) as unknown[];
  return rows.length > 0;
}

/**
 * `lock_timeout` de la construction (relecture lot 17) : `CREATE INDEX
 * CONCURRENTLY` est une instruction seule par fichier, hors transaction —
 * le délai est donc posé par `SET` sur la connexion RÉSERVÉE avant la
 * construction (et la suppression d'un index invalide), puis réinitialisé
 * (`RESET`) avant de rendre la connexion au pool. Délai dépassé : erreur,
 * fichier non marqué appliqué, repris au démarrage suivant (index invalide
 * réparé). Sans connexion réservable, rien n'est posé (on ne modifie pas une
 * connexion partagée du pool).
 */
export const MIGRATION_INDEX_LOCK_TIMEOUT = '10s';

/** Clé du verrou consultatif d'un index (texte haché par PostgreSQL). */
export const indexLockKey = (name: string) => `verebona:migration-index:${name}`;

export type MigrationRunStatus =
  /** Fichier exécuté (index valide le cas échéant) : à marquer appliqué. */
  | 'applied'
  /** Index invalide supprimé puis reconstruit, valide : à marquer appliqué. */
  | 'rebuilt'
  /** Verrou non obtenu ou construction en cours ailleurs : rien fait, à reprendre. */
  | 'deferred';

export interface MigrationRunResult {
  status: MigrationRunStatus;
  index: string | null;
}

/**
 * Exécute un fichier de migration. Pour un index CONCURRENTLY : verrou,
 * reprise d'un index invalide, contrôle de validité (lève si l'index reste
 * invalide : le fichier n'est alors PAS marqué appliqué et sera retenté).
 */
export async function runMigrationSql(client: SqlRunner, sql: string): Promise<MigrationRunResult> {
  const index = concurrentIndexName(sql);
  if (!index) {
    await client.unsafe(sql);
    return { status: 'applied', index: null };
  }

  // Verrou de SESSION : il doit être pris et rendu sur la même connexion.
  const cnx = client.reserve ? await client.reserve() : null;
  const c: SqlRunner = cnx ?? client;
  let verrou = false;
  try {
    const [r] = (await c.unsafe(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [indexLockKey(index)] as never[],
    )) as Array<{ ok: boolean }>;
    verrou = r?.ok === true;
    if (!verrou) {
      console.warn(`[db] index ${index} : verrou détenu par une autre instance — construction différée.`);
      return { status: 'deferred', index };
    }
    if (await indexBuildInProgress(c, index)) {
      console.warn(`[db] index ${index} : construction en cours ailleurs — rien n'est fait.`);
      return { status: 'deferred', index };
    }
    if (cnx) await cnx.unsafe(`SET lock_timeout = '${MIGRATION_INDEX_LOCK_TIMEOUT}'`);
    let status: MigrationRunStatus = 'applied';
    if ((await indexValidity(c, index)) === false) {
      console.warn(`[db] index ${index} INVALIDE (construction interrompue) : suppression puis reconstruction.`);
      await c.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${index}"`);
      status = 'rebuilt';
    }
    await c.unsafe(sql);
    if ((await indexValidity(c, index)) !== true) {
      throw new Error(`index ${index} absent ou invalide après construction CONCURRENTLY`);
    }
    return { status, index };
  } finally {
    if (cnx) await cnx.unsafe('RESET lock_timeout').catch(() => undefined);
    if (verrou) {
      await c.unsafe(`SELECT pg_advisory_unlock(hashtext($1))`, [indexLockKey(index)] as never[]).catch(() => undefined);
    }
    cnx?.release();
  }
}

/** Index invalides du schéma courant (contrôle de démarrage). Ne lève jamais. */
export async function listInvalidIndexes(client: SqlRunner): Promise<string[]> {
  try {
    const rows = (await client.unsafe(
      `SELECT c.relname AS name
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE NOT i.indisvalid AND c.relnamespace = current_schema()::regnamespace
        ORDER BY 1`,
    )) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

export interface IndexRepairReport {
  /** Reconstruits et valides. */
  repaired: string[];
  /** Différés ou en échec : ligne `_migrations` supprimée, rejoués au prochain démarrage. */
  requeued: Array<{ index: string; filename: string; reason: string }>;
  /** Invalides sans fichier de migration connu : signalés seulement. */
  unknown: string[];
}

/**
 * Contrôle de démarrage : répare les index invalides issus d'un fichier de
 * migration `CREATE INDEX CONCURRENTLY` (voir l'en-tête pour le choix).
 * Ne lève jamais.
 */
export async function repairInvalidMigrationIndexes(
  client: SqlRunner,
  files: Array<{ filename: string; sql: string }>,
): Promise<IndexRepairReport> {
  const report: IndexRepairReport = { repaired: [], requeued: [], unknown: [] };
  const invalides = await listInvalidIndexes(client);
  if (invalides.length === 0) return report;
  const parIndex = new Map<string, { filename: string; sql: string }>();
  for (const f of files) {
    const name = concurrentIndexName(f.sql);
    if (name) parIndex.set(name, f);
  }
  for (const index of invalides) {
    const f = parIndex.get(index);
    if (!f) { report.unknown.push(index); continue; }
    let reason: string;
    try {
      const r = await runMigrationSql(client, f.sql);
      if (r.status !== 'deferred') { report.repaired.push(index); continue; }
      reason = 'différé (verrou ou construction en cours)';
    } catch (e) {
      reason = (e as Error).message;
    }
    try {
      await client.unsafe(`DELETE FROM _migrations WHERE filename = $1`, [f.filename] as never[]);
    } catch { /* signalé ci-dessous de toute façon */ }
    report.requeued.push({ index, filename: f.filename, reason });
  }
  return report;
}

export interface MigrationFileFailure {
  filename: string;
  message: string;
  code?: string;
}

/**
 * Applique, dans l'ordre LEXICOGRAPHIQUE, les fichiers non encore marqués
 * dans `_migrations` (boucle de `ensureMigrations`, exportée pour être
 * éprouvée telle quelle par le harnais E2E — revue lot 20).
 *
 * Un échec n'interrompt pas la chaîne : le fichier n'est pas marqué et sera
 * retenté au démarrage suivant, toujours APRÈS ceux qui le précèdent. Les
 * fichiers d'une même migration qui dépendent du principal (`_idx_N`)
 * doivent donc échouer proprement tant qu'il manque (colonne absente, garde
 * explicite comme 0229_idx_3) plutôt que de détruire un état valide.
 */
export async function applyMigrationFiles(
  client: SqlRunner,
  files: Array<{ filename: string; sql: string }>,
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } = console,
): Promise<{ applied: string[]; deferred: string[]; failures: MigrationFileFailure[] }> {
  const out = { applied: [] as string[], deferred: [] as string[], failures: [] as MigrationFileFailure[] };
  const deja = (await client.unsafe(`SELECT filename FROM _migrations`)) as Array<{ filename: string }>;
  const appliedSet = new Set(deja.map((r) => r.filename));
  for (const f of [...files].sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))) {
    if (appliedSet.has(f.filename)) continue;
    try {
      const r = await runMigrationSql(client, f.sql);
      if (r.status === 'deferred') {
        log.warn(`[db] Migration ${f.filename} differee (index ${r.index} en construction ailleurs).`);
        out.deferred.push(f.filename);
        continue;
      }
      await client.unsafe(`INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [f.filename] as never[]);
      log.info(`[db] Applied migration: ${f.filename}`);
      out.applied.push(f.filename);
    } catch (e) {
      const err = e as { message?: string; code?: string };
      out.failures.push({ filename: f.filename, message: err.message ?? String(e), code: err.code });
      log.error(
        `[db] ECHEC de la migration ${f.filename} (${err.code ?? 'sans code'}) : ${err.message ?? e}\n` +
        '     La chaine se poursuit. Ce fichier sera retente au prochain demarrage.',
      );
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// EXÉCUTION COORDONNÉE ET ÉTAT DU SCHÉMA (APP-PERF-16)
//
// Ce module reste SANS IMPORT : il est chargé tel quel par l'étape de
// migration du déploiement (`scripts/migrate.mjs`, Node sans `tsx` — les
// devDependencies sont élaguées sur Scalingo) grâce au retrait des types de
// Node. N'y utiliser que de la syntaxe TypeScript effaçable (ni `enum`, ni
// `namespace`, ni propriété de paramètre).
//
// Contrat :
//   · un seul exécutant à la fois, toutes instances confondues : verrou
//     consultatif de SESSION `MIGRATION_RUNNER_LOCK_KEY`, attendu au plus
//     `lockWaitMs`. Les autres processus n'appliquent rien et relisent l'état ;
//   · chaque instruction DDL est bornée par `lock_timeout` (une ALTER TABLE
//     en file derrière une longue requête bloquerait tout le trafic) ;
//     `statement_timeout` est réglable, sans limite par défaut (une migration
//     de données légitime peut être longue) ;
//   · la réparation des index invalides (longue) est distincte : `repairIndexes`,
//     activée par l'étape de déploiement, désactivée au démarrage web ;
//   · criticité d'un fichier (`migrationCriticality`) : un index NON unique
//     construit CONCURRENTLY n'est qu'une optimisation → `optional` (mode
//     dégradé) ; tout le reste — tables, colonnes, contraintes, index UNIQUE
//     (cibles d'ON CONFLICT) — est `critical` : son absence fait échouer des
//     requêtes, la version ne doit pas être mise en service.
// ══════════════════════════════════════════════════════════════════════════

/** Clé du verrou consultatif de l'exécutant (texte haché par PostgreSQL). */
export const MIGRATION_RUNNER_LOCK_KEY = 'verebona:migrations';

export type MigrationCriticality = 'critical' | 'optional';

/** Criticité d'un fichier de migration (voir le contrat ci-dessus). */
export function migrationCriticality(sql: string): MigrationCriticality {
  if (!concurrentIndexName(sql)) return 'critical';
  return /^CREATE\s+UNIQUE\s/i.test(sansCommentaires(sql)) ? 'critical' : 'optional';
}

export interface MigrationFile {
  filename: string;
  sql: string;
}

export interface MigrationCatalogEntry {
  filename: string;
  criticality: MigrationCriticality;
}

export function migrationCatalog(files: MigrationFile[]): MigrationCatalogEntry[] {
  return files.map((f) => ({ filename: f.filename, criticality: migrationCriticality(f.sql) }));
}

/** Fichiers `.sql` du dossier de migrations, triés (ordre d'application). */
export async function readMigrationFiles(dir?: string): Promise<MigrationFile[]> {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const d = dir ?? join(process.cwd(), 'src', 'db', 'migrations');
  const noms = (await readdir(d)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(noms.map(async (filename) => ({ filename, sql: await readFile(join(d, filename), 'utf-8') })));
}

export interface SchemaState {
  /** Table `_migrations` présente. */
  tracked: boolean;
  pendingCritical: string[];
  pendingOptional: string[];
}

/**
 * Fichiers non marqués appliqués, par criticité. Lecture seule (une requête).
 * Lève si la base ne répond pas — sauf table `_migrations` absente (`42P01`),
 * qui signifie « rien d'appliqué ».
 */
export async function readSchemaState(client: SqlRunner, catalog: MigrationCatalogEntry[]): Promise<SchemaState> {
  let appliquees = new Set<string>();
  let tracked = true;
  try {
    const rows = (await client.unsafe(`SELECT filename FROM _migrations`)) as Array<{ filename: string }>;
    appliquees = new Set(rows.map((r) => r.filename));
  } catch (e) {
    if ((e as { code?: string }).code !== '42P01') throw e;
    tracked = false;
  }
  const pendingCritical: string[] = [];
  const pendingOptional: string[] = [];
  for (const m of catalog) {
    if (appliquees.has(m.filename)) continue;
    (m.criticality === 'critical' ? pendingCritical : pendingOptional).push(m.filename);
  }
  return { tracked, pendingCritical, pendingOptional };
}

/**
 * `ready` : tout est appliqué. `degraded` : seuls des fichiers optionnels
 * manquent. `waiting` : des fichiers critiques manquent mais un autre
 * exécutant détient le verrou (ou construit l'index) — état à relire.
 * `failed` : des fichiers critiques manquent alors que cet exécutant avait
 * la main — la version ne doit pas recevoir de trafic.
 */
export type MigrationRunOutcome = 'ready' | 'degraded' | 'waiting' | 'failed';

export interface MigrationRunFailure extends MigrationFileFailure {
  criticality: MigrationCriticality;
}

export interface MigrationRunReport {
  outcome: MigrationRunOutcome;
  lockAcquired: boolean;
  lockWaitMs: number;
  durationMs: number;
  applied: string[];
  deferred: string[];
  failures: MigrationRunFailure[];
  /** Premier échec CRITIQUE dans l'ordre d'application : la cause à corriger d'abord. */
  firstCriticalFailure: MigrationRunFailure | null;
  repair: IndexRepairReport | null;
  pendingCritical: string[];
  pendingOptional: string[];
}

type MigrationLog = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

export interface MigrationRunOptions {
  lockKey?: string;
  /** Attente maximale du verrou de l'exécutant (ms). */
  lockWaitMs?: number;
  lockPollMs?: number;
  /** `lock_timeout` de chaque instruction (ex. `10s`). */
  lockTimeout?: string;
  /** `statement_timeout` de chaque instruction (`0` : aucun). */
  statementTimeout?: string;
  /** Réparation des index invalides après les migrations (opération longue). */
  repairIndexes?: boolean;
  log?: MigrationLog;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const MIGRATION_DEFAULT_LOCK_TIMEOUT = '10s';

/** Durée PostgreSQL acceptée dans un `SET` (aucune interpolation libre). */
export function isPgDuration(v: string): boolean {
  return /^\d{1,7}(ms|s|min)?$/.test(v);
}

/**
 * Applique les migrations en attente sous verrou exclusif inter-processus.
 * Ne lève que si la base est injoignable (connexion, verrou) ; un fichier en
 * échec est rapporté dans `failures`, jamais levé.
 */
export async function runMigrations(
  client: SqlRunner,
  files: MigrationFile[],
  opts: MigrationRunOptions = {},
): Promise<MigrationRunReport> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? console;
  const lockKey = opts.lockKey ?? MIGRATION_RUNNER_LOCK_KEY;
  const lockWaitMs = Math.max(0, opts.lockWaitMs ?? 30_000);
  const lockPollMs = Math.max(10, opts.lockPollMs ?? 500);
  const lockTimeout = opts.lockTimeout ?? MIGRATION_DEFAULT_LOCK_TIMEOUT;
  const statementTimeout = opts.statementTimeout ?? '0';
  for (const [nom, v] of [['lockTimeout', lockTimeout], ['statementTimeout', statementTimeout]] as const) {
    if (!isPgDuration(v)) throw new Error(`[db] ${nom} invalide : « ${v} » (attendu : 500ms, 10s, 2min, 0).`);
  }
  const catalog = migrationCatalog(files);
  const criticite = new Map(catalog.map((m) => [m.filename, m.criticality]));
  const debut = now();

  // Connexion DÉDIÉE : le verrou de session, les `SET` et toutes les
  // instructions passent par elle. Exposée sans `reserve` : `runMigrationSql`
  // reste sur cette connexion (verrou d'index compris) et n'y touche pas aux
  // délais posés ici.
  const cnx = client.reserve ? await client.reserve() : null;
  const c: SqlRunner = cnx ? { unsafe: (q, p) => cnx.unsafe(q, p) } : client;
  let verrou = false;
  let attente = 0;
  const report: MigrationRunReport = {
    outcome: 'failed', lockAcquired: false, lockWaitMs: 0, durationMs: 0,
    applied: [], deferred: [], failures: [], firstCriticalFailure: null, repair: null,
    pendingCritical: [], pendingOptional: [],
  };
  try {
    const attenteDebut = now();
    for (;;) {
      const [r] = (await c.unsafe(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [lockKey] as never[],
      )) as Array<{ ok: boolean }>;
      if (r?.ok === true) { verrou = true; break; }
      if (now() - attenteDebut >= lockWaitMs) break;
      await sleep(lockPollMs);
    }
    attente = now() - attenteDebut;
    report.lockAcquired = verrou;
    report.lockWaitMs = attente;

    if (!verrou) {
      log.warn(`[db] migrations : verrou détenu par un autre exécutant après ${attente} ms — aucune modification, état relu.`);
    } else {
      if (cnx) {
        await c.unsafe(`SET lock_timeout = '${lockTimeout}'`);
        await c.unsafe(`SET statement_timeout = '${statementTimeout}'`);
      }
      await c.unsafe(`
        CREATE TABLE IF NOT EXISTS _migrations (
          id         SERIAL PRIMARY KEY,
          filename   TEXT        NOT NULL UNIQUE,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      const res = await applyMigrationFiles(c, files, log);
      report.applied = res.applied;
      report.deferred = res.deferred;
      report.failures = res.failures.map((f) => ({ ...f, criticality: criticite.get(f.filename) ?? 'critical' }));
      if (opts.repairIndexes) report.repair = await repairInvalidMigrationIndexes(c, files);
    }

    const etat = await readSchemaState(c, catalog);
    report.pendingCritical = etat.pendingCritical;
    report.pendingOptional = etat.pendingOptional;
  } finally {
    if (cnx) {
      await cnx.unsafe('RESET lock_timeout').catch(() => undefined);
      await cnx.unsafe('RESET statement_timeout').catch(() => undefined);
    }
    if (verrou) {
      await c.unsafe(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey] as never[]).catch(() => undefined);
    }
    cnx?.release();
  }

  report.firstCriticalFailure = report.failures.find((f) => f.criticality === 'critical') ?? null;
  if (report.pendingCritical.length === 0) {
    const reparationIncomplete = (report.repair?.requeued.length ?? 0) > 0;
    report.outcome = report.pendingOptional.length > 0 || reparationIncomplete ? 'degraded' : 'ready';
  } else if (!verrou || report.pendingCritical.every((f) => report.deferred.includes(f))) {
    report.outcome = 'waiting';
  } else {
    report.outcome = 'failed';
  }
  report.durationMs = now() - debut;
  return report;
}
