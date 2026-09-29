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
