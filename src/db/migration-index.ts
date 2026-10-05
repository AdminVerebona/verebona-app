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
 * passage suivant (ce n'est pas un échec).
 *
 * `repairInvalidMigrationIndexes` (étape de déploiement et maintenance en
 * arrière-plan, après les migrations) traite les index invalides d'un
 * fichier DÉJÀ marqué appliqué (ex. 0217) : reconstruction IMMÉDIATE par
 * `runMigrationSql` — même verrou, mêmes garde-fous. Choix : réparer tout de
 * suite plutôt que seulement supprimer la ligne `_migrations`. Si la
 * reconstruction est différée ou échoue, la ligne `_migrations` est
 * supprimée : le fichier est rejoué au passage suivant — maintenance en
 * arrière-plan de l'application (lot 24b) ou déploiement suivant (filet de
 * sécurité, jamais d'index invalide oublié).
 *
 * Lot 24b (préprod du 05/10) : délai des constructions réglable et long au
 * déploiement, budget de temps, aucune construction vouée à l'échec rejouée
 * dans un même passage, sessions bloquantes journalisées sur 55P03, démarrage
 * web sans index CONCURRENTLY, maintenance en arrière-plan — voir plus bas.
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
 * `lock_timeout` des constructions et suppressions CONCURRENTLY (lot 24b).
 *
 * `CREATE INDEX CONCURRENTLY` (et `DROP INDEX CONCURRENTLY`) attend la fin de
 * TOUTES les transactions plus anciennes que son instantané, dans la base
 * courante. Cette attente ne bloque pas le trafic (le verrou
 * ShareUpdateExclusive ne gêne que le DDL et le VACUUM), mais elle est
 * comptée dans `lock_timeout`. Les 10 s codées en dur jusqu'au lot 24 ne
 * suffisaient pas tant que l'ancienne version sert et fait tourner ses
 * tâches de fond : constructions en échec (55P03) à chaque déploiement,
 * index laissés INVALIDES (préprod du 05/10).
 *
 * Délai réglable (`MIGRATION_INDEX_LOCK_TIMEOUT`, durée PG validée) :
 *   · étape de déploiement et reconstruction en arrière-plan : LONG
 *     (`MIGRATION_INDEX_LOCK_TIMEOUT_DEPLOY`), borné par le budget de temps
 *     du postdeploy (Scalingo l'arrête à 20 min) ;
 *   · démarrage web : COURT (`MIGRATION_INDEX_LOCK_TIMEOUT_BOOT`) — le
 *     démarrage web ne construit d'ailleurs plus aucun index CONCURRENTLY.
 * Le même délai s'applique à la suppression d'un index invalide.
 *
 * Le délai est posé sur la connexion qui construit — réservée par
 * `runMigrationSql`, ou dédiée par l'exécutant (`dedicated`) — puis la
 * valeur PRÉCÉDENTE est rétablie (`set_config`), jamais un `RESET` qui
 * effacerait le `lock_timeout` posé par l'exécutant. Sur une connexion
 * partagée du pool (ni réservée ni dédiée), rien n'est posé.
 */
export const MIGRATION_INDEX_LOCK_TIMEOUT_DEPLOY = '10min';
export const MIGRATION_INDEX_LOCK_TIMEOUT_BOOT = '10s';
/** Compatibilité (lot 17) : délai court, celui du démarrage web. */
export const MIGRATION_INDEX_LOCK_TIMEOUT = MIGRATION_INDEX_LOCK_TIMEOUT_BOOT;

/** Durée PostgreSQL acceptée dans un `SET` (aucune interpolation libre). */
export function isPgDuration(v: string): boolean {
  return /^\d{1,7}(ms|s|min)?$/.test(v);
}

/** Durée PG (`isPgDuration`) en millisecondes ; `0` = aucune limite. */
export function pgDurationMs(v: string): number {
  const m = /^(\d{1,7})(ms|s|min)?$/.exec(v);
  if (!m) throw new Error(`durée invalide : « ${v} »`);
  const n = Number(m[1]);
  return m[2] === 'min' ? n * 60_000 : m[2] === 's' ? n * 1_000 : n; // sans unité : ms (comme PostgreSQL)
}

/** Délai le plus court entre une durée configurée et un reste de budget (ms). */
export function capDuration(v: string, restantMs: number): string {
  const ms = pgDurationMs(v);
  const borne = Math.max(0, Math.floor(restantMs));
  return ms === 0 || ms > borne ? `${borne}ms` : v;
}

/** Clé du verrou consultatif d'un index (texte haché par PostgreSQL). */
export const indexLockKey = (name: string) => `verebona:migration-index:${name}`;

/** Session plus ancienne qu'une construction CONCURRENTLY (diagnostic 55P03). */
export interface IndexBlocker {
  pid: number;
  applicationName: string;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  /** Âge de la transaction (s). */
  xactAgeS: number | null;
  /** Début de la requête, littéraux masqués. */
  query: string;
}

/**
 * Masque les littéraux d'une requête journalisée : chaînes (`'…'`, `E'…'`,
 * `$$…$$`) et longues suites de chiffres. Les requêtes de l'application sont
 * paramétrées ; une requête interpolée ne doit pas pour autant écrire une
 * adresse, un jeton ou un montant dans les journaux.
 */
export function maskQueryLiterals(q: string): string {
  return q
    .replace(/\$\$[\s\S]*?(\$\$|$)/g, () => '$$…$$')
    .replace(/[Ee]?'(?:[^']|'')*('|$)/g, "'…'")
    .replace(/\b\d{5,}\b/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sessions de la base courante dont la transaction a commencé AVANT `depuis`
 * (horloge de la base) : celles qu'attend une construction CONCURRENTLY.
 * Ne lève jamais (diagnostic).
 */
export async function listIndexBlockers(client: SqlRunner, depuis: string): Promise<IndexBlocker[]> {
  try {
    const rows = (await client.unsafe(
      `SELECT pid, application_name, state, wait_event_type, wait_event,
              floor(extract(epoch FROM clock_timestamp() - xact_start))::int AS xact_age_s,
              left(query, 120) AS query
         FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND xact_start IS NOT NULL AND xact_start < $1::timestamptz
        ORDER BY xact_start
        LIMIT 10`,
      [depuis] as never[],
    )) as Array<{ pid: number; application_name: string | null; state: string | null; wait_event_type: string | null; wait_event: string | null; xact_age_s: number | null; query: string | null }>;
    return rows.map((r) => ({
      pid: Number(r.pid),
      applicationName: r.application_name || '(sans nom)',
      state: r.state,
      waitEventType: r.wait_event_type,
      waitEvent: r.wait_event,
      xactAgeS: r.xact_age_s == null ? null : Number(r.xact_age_s),
      query: maskQueryLiterals(r.query ?? ''),
    }));
  } catch {
    return [];
  }
}

/** Une ligne de journal par session bloquante. */
export function formatIndexBlockers(index: string, blockers: IndexBlocker[]): string[] {
  if (blockers.length === 0) {
    return [`[db] index ${index} : délai de verrou dépassé (55P03) — aucune session plus ancienne visible (terminée entre-temps, ou droits insuffisants sur pg_stat_activity).`];
  }
  return [
    `[db] index ${index} : délai de verrou dépassé (55P03) — ${blockers.length} session(s) plus ancienne(s) que la construction :`,
    ...blockers.map((b) =>
      `[db]   pid=${b.pid} app=${b.applicationName} state=${b.state ?? '?'} wait=${b.waitEventType ?? '-'}/${b.waitEvent ?? '-'} ` +
      `transaction=${b.xactAgeS ?? '?'}s query="${b.query}"`),
  ];
}

/**
 * Une des sessions `pids` est-elle encore dans une transaction commencée
 * avant `depuis` ? (une construction relancée l'attendrait de nouveau).
 */
export async function blockersStillActive(client: SqlRunner, pids: number[], depuis: string): Promise<boolean> {
  if (pids.length === 0) return false;
  try {
    const rows = (await client.unsafe(
      `SELECT 1 FROM pg_stat_activity
        WHERE pid = ANY($1::int[]) AND xact_start IS NOT NULL AND xact_start < $2::timestamptz LIMIT 1`,
      [`{${pids.map((p) => Math.trunc(p)).join(',')}}`, depuis] as never[],
    )) as unknown[];
    return rows.length > 0;
  } catch {
    return false;
  }
}

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

type MigrationLog = { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

export interface MigrationSqlOptions {
  /** `lock_timeout` de la construction / suppression CONCURRENTLY. */
  indexLockTimeout?: string;
  /**
   * `client` est une connexion DÉDIÉE (celle de l'exécutant) : le délai peut
   * y être posé puis rétabli. Sinon il ne l'est que sur une connexion réservée.
   */
  dedicated?: boolean;
  log?: MigrationLog;
}

/** Erreur d'une construction CONCURRENTLY, avec les sessions bloquantes (55P03). */
export interface IndexBuildError extends Error {
  code?: string;
  index?: string;
  blockers?: IndexBlocker[];
  /** Horloge de la base au début de la construction (`blockersStillActive`). */
  blockedSince?: string;
}

/**
 * Exécute un fichier de migration. Pour un index CONCURRENTLY : verrou,
 * reprise d'un index invalide, contrôle de validité (lève si l'index reste
 * invalide : le fichier n'est alors PAS marqué appliqué et sera retenté).
 * Délai dépassé (55P03) : les sessions bloquantes sont journalisées et
 * jointes à l'erreur (`IndexBuildError.blockers`).
 */
export async function runMigrationSql(client: SqlRunner, sql: string, opts: MigrationSqlOptions = {}): Promise<MigrationRunResult> {
  const index = concurrentIndexName(sql);
  if (!index) {
    await client.unsafe(sql);
    return { status: 'applied', index: null };
  }
  const log = opts.log ?? console;
  const delai = opts.indexLockTimeout ?? MIGRATION_INDEX_LOCK_TIMEOUT_BOOT;
  if (!isPgDuration(delai)) throw new Error(`[db] indexLockTimeout invalide : « ${delai} ».`);

  // Verrou de SESSION : il doit être pris et rendu sur la même connexion.
  const cnx = client.reserve && !opts.dedicated ? await client.reserve() : null;
  const c: SqlRunner = cnx ?? client;
  const peutPoser = cnx != null || opts.dedicated === true;
  let verrou = false;
  let precedent: string | null = null;
  let depuis: string | null = null;
  try {
    const [r] = (await c.unsafe(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [indexLockKey(index)] as never[],
    )) as Array<{ ok: boolean }>;
    verrou = r?.ok === true;
    if (!verrou) {
      log.warn(`[db] index ${index} : verrou détenu par une autre instance — construction différée.`);
      return { status: 'deferred', index };
    }
    if (await indexBuildInProgress(c, index)) {
      log.warn(`[db] index ${index} : construction en cours ailleurs — rien n'est fait.`);
      return { status: 'deferred', index };
    }
    if (peutPoser) {
      const [p] = (await c.unsafe(`SELECT current_setting('lock_timeout') AS v`)) as Array<{ v: string }>;
      precedent = p?.v ?? null;
      await c.unsafe(`SET lock_timeout = '${delai}'`);
    }
    const [t] = (await c.unsafe(`SELECT clock_timestamp()::text AS t`)) as Array<{ t: string }>;
    depuis = t?.t ?? null;
    let status: MigrationRunStatus = 'applied';
    try {
      if ((await indexValidity(c, index)) === false) {
        log.warn(`[db] index ${index} INVALIDE (construction interrompue) : suppression puis reconstruction (délai ${peutPoser ? delai : 'de la connexion'}).`);
        await c.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${index}"`);
        status = 'rebuilt';
      }
      await c.unsafe(sql);
    } catch (e) {
      const err = e as IndexBuildError;
      if (err && typeof err === 'object' && err.code === '55P03') {
        err.index = index;
        if (depuis) {
          err.blockedSince = depuis;
          err.blockers = await listIndexBlockers(c, depuis);
          for (const l of formatIndexBlockers(index, err.blockers)) log.warn(l);
        }
      }
      throw e;
    }
    if ((await indexValidity(c, index)) !== true) {
      throw new Error(`index ${index} absent ou invalide après construction CONCURRENTLY`);
    }
    return { status, index };
  } finally {
    if (peutPoser && precedent != null) {
      await c.unsafe(`SELECT set_config('lock_timeout', $1, false)`, [precedent] as never[]).catch(() => undefined);
    }
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

// ══════════════════════════════════════════════════════════════════════════
// PASSAGE DE CONSTRUCTION D'INDEX (lot 24b)
//
// État partagé par la passe d'application et la passe de réparation d'UNE
// exécution, pour qu'aucune construction vouée à l'échec ne soit rejouée :
//   · un index déjà tenté sans succès dans ce passage (échec, différé) n'est
//     pas retenté par la réparation (préprod du 05/10 : 2 × 10 s par index) ;
//   · après un 55P03, tant qu'une des sessions bloquantes relevées est encore
//     dans la MÊME transaction, les index OPTIONNELS suivants sont différés
//     sans essai : ils l'attendraient aussi ;
//   · budget de temps (`deadline`, étape de déploiement) : le délai de
//     chaque construction est borné par le temps restant ; un index
//     optionnel est différé quand il ne reste plus de quoi l'essayer.
// Un index différé reste en attente (fichier non marqué) : la maintenance
// en arrière-plan de l'application le construira plus tard.
// ══════════════════════════════════════════════════════════════════════════

/** Marge gardée sur le budget (fin du passage, journal, sortie). */
const BUDGET_MARGIN_MS = 30_000;
/** En deçà, une construction n'a aucune chance utile : différée. */
const MIN_INDEX_ATTEMPT_MS = 5_000;

export interface IndexPass {
  indexLockTimeout: string;
  /** Échéance absolue (ms epoch) du passage, ou null. */
  deadline: number | null;
  now: () => number;
  dedicated: boolean;
  log: MigrationLog;
  /** Index tentés sans succès dans ce passage. */
  attempted: Set<string>;
  /** Dernières sessions bloquantes relevées (55P03). */
  blocked: { pids: number[]; since: string } | null;
}

export function createIndexPass(o: Partial<Omit<IndexPass, 'attempted' | 'blocked'>> = {}): IndexPass {
  return {
    indexLockTimeout: o.indexLockTimeout ?? MIGRATION_INDEX_LOCK_TIMEOUT_BOOT,
    deadline: o.deadline ?? null,
    now: o.now ?? Date.now,
    dedicated: o.dedicated ?? false,
    log: o.log ?? console,
    attempted: new Set(),
    blocked: null,
  };
}

type IndexAttempt = { go: true; timeout: string } | { go: false; reason: string };

/** Faut-il tenter cet index maintenant, et avec quel délai ? */
async function preparerIndex(pass: IndexPass, c: SqlRunner, index: string, criticality: MigrationCriticality): Promise<IndexAttempt> {
  if (pass.attempted.has(index)) return { go: false, reason: 'déjà tenté sans succès dans ce passage' };
  if (criticality === 'optional' && pass.blocked && await blockersStillActive(c, pass.blocked.pids, pass.blocked.since)) {
    return { go: false, reason: `transaction bloquante toujours ouverte (pid ${pass.blocked.pids.slice(0, 5).join(', ')})` };
  }
  if (pass.deadline == null) return { go: true, timeout: pass.indexLockTimeout };
  const reste = pass.deadline - pass.now() - BUDGET_MARGIN_MS;
  if (reste < MIN_INDEX_ATTEMPT_MS) {
    if (criticality === 'optional') return { go: false, reason: 'budget de temps du passage épuisé' };
    return { go: true, timeout: capDuration(pass.indexLockTimeout, MIN_INDEX_ATTEMPT_MS) };
  }
  return { go: true, timeout: capDuration(pass.indexLockTimeout, reste) };
}

/** Construit un index de migration dans le cadre d'un passage. */
async function construireIndex(
  pass: IndexPass, c: SqlRunner, f: MigrationFile, index: string,
): Promise<{ kind: 'ok'; status: MigrationRunStatus } | { kind: 'skip'; reason: string } | { kind: 'deferred' } | { kind: 'error'; error: unknown }> {
  const decision = await preparerIndex(pass, c, index, migrationCriticality(f.sql));
  if (!decision.go) return { kind: 'skip', reason: decision.reason };
  try {
    const r = await runMigrationSql(c, f.sql, { indexLockTimeout: decision.timeout, dedicated: pass.dedicated, log: pass.log });
    if (r.status === 'deferred') { pass.attempted.add(index); return { kind: 'deferred' }; }
    return { kind: 'ok', status: r.status };
  } catch (e) {
    pass.attempted.add(index);
    const err = e as IndexBuildError;
    if (err?.code === '55P03' && err.blockers && err.blockers.length > 0 && err.blockedSince) {
      pass.blocked = { pids: err.blockers.map((b) => b.pid), since: err.blockedSince };
    }
    return { kind: 'error', error: e };
  }
}

export interface IndexRepairReport {
  /** Reconstruits et valides. */
  repaired: string[];
  /** Différés ou en échec : ligne `_migrations` supprimée, rejoués plus tard (maintenance, déploiement suivant). */
  requeued: Array<{ index: string; filename: string; reason: string }>;
  /** Invalides sans fichier de migration connu : signalés seulement. */
  unknown: string[];
  /** Déjà tentés sans succès dans ce passage (fichier en attente) : non retentés. */
  skipped: string[];
}

/**
 * Répare les index invalides issus d'un fichier de migration `CREATE INDEX
 * CONCURRENTLY` (voir l'en-tête pour le choix). `pass` : passage en cours
 * (index déjà tentés exclus, budget, délai). Ne lève jamais.
 */
export async function repairInvalidMigrationIndexes(
  client: SqlRunner,
  files: Array<{ filename: string; sql: string }>,
  pass: IndexPass = createIndexPass(),
): Promise<IndexRepairReport> {
  const report: IndexRepairReport = { repaired: [], requeued: [], unknown: [], skipped: [] };
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
    if (pass.attempted.has(index)) { report.skipped.push(index); continue; }
    let reason: string;
    const r = await construireIndex(pass, client, f, index);
    if (r.kind === 'ok') { report.repaired.push(index); continue; }
    if (r.kind === 'skip') reason = `différé : ${r.reason}`;
    else if (r.kind === 'deferred') reason = 'différé (verrou ou construction en cours)';
    else reason = `${(r.error as { code?: string }).code ? `(${(r.error as { code?: string }).code}) ` : ''}${(r.error as Error).message}`;
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
  /** 55P03 sur une construction CONCURRENTLY : sessions plus anciennes. */
  blockers?: IndexBlocker[];
}

export interface ApplyMigrationOptions {
  /**
   * `build` (défaut) : construit les index CONCURRENTLY — les OPTIONNELS en
   * dernier, après tous les fichiers critiques (aucun fichier ne dépend d'un
   * index qui n'est qu'une optimisation : le schéma critique est prêt au
   * plus tôt, avant les attentes longues).
   * `skip` : n'en construit aucun (démarrage web). Un index CRITIQUE sauté
   * arrête la chaîne : les fichiers suivants peuvent en dépendre.
   */
  concurrentIndexes?: 'build' | 'skip';
  pass?: IndexPass;
}

const parNom = (a: { filename: string }, b: { filename: string }) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);

/**
 * Applique les fichiers non encore marqués dans `_migrations` (boucle de
 * `ensureMigrations`, exportée pour être éprouvée telle quelle par le
 * harnais E2E — revue lot 20). Ordre LEXICOGRAPHIQUE, index optionnels en
 * dernier (voir `ApplyMigrationOptions`).
 *
 * Un échec n'interrompt pas la chaîne : le fichier n'est pas marqué et sera
 * retenté au passage suivant, toujours APRÈS ceux qui le précèdent. Les
 * fichiers d'une même migration qui dépendent du principal (`_idx_N`)
 * doivent donc échouer proprement tant qu'il manque (colonne absente, garde
 * explicite comme 0229_idx_3) plutôt que de détruire un état valide.
 */
export async function applyMigrationFiles(
  client: SqlRunner,
  files: Array<{ filename: string; sql: string }>,
  log: MigrationLog = console,
  opts: ApplyMigrationOptions = {},
): Promise<{ applied: string[]; deferred: string[]; failures: MigrationFileFailure[]; skipped: string[] }> {
  const out = { applied: [] as string[], deferred: [] as string[], failures: [] as MigrationFileFailure[], skipped: [] as string[] };
  const pass = opts.pass ?? createIndexPass({ log });
  const sauter = opts.concurrentIndexes === 'skip';
  const deja = (await client.unsafe(`SELECT filename FROM _migrations`)) as Array<{ filename: string }>;
  const appliedSet = new Set(deja.map((r) => r.filename));
  const tries = [...files].sort(parNom);
  const ordre = sauter
    ? tries
    : [...tries.filter((f) => migrationCriticality(f.sql) === 'critical'), ...tries.filter((f) => migrationCriticality(f.sql) === 'optional')];
  let arret = false;
  for (const f of ordre) {
    if (appliedSet.has(f.filename)) continue;
    const index = concurrentIndexName(f.sql);
    if (arret || (sauter && index)) {
      out.skipped.push(f.filename);
      if (index && migrationCriticality(f.sql) === 'critical') arret = true;
      continue;
    }
    try {
      let status: MigrationRunStatus;
      if (index) {
        const r = await construireIndex(pass, client, f, index);
        if (r.kind === 'error') throw r.error;
        if (r.kind !== 'ok') {
          log.warn(`[db] Migration ${f.filename} differee (index ${index} : ${r.kind === 'skip' ? r.reason : 'en construction ailleurs'}).`);
          out.deferred.push(f.filename);
          continue;
        }
        status = r.status;
      } else {
        status = (await runMigrationSql(client, f.sql)).status;
      }
      if (status === 'deferred') { out.deferred.push(f.filename); continue; }
      await client.unsafe(`INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [f.filename] as never[]);
      log.info(`[db] Applied migration: ${f.filename}`);
      out.applied.push(f.filename);
    } catch (e) {
      const err = e as IndexBuildError;
      out.failures.push({
        filename: f.filename, message: err.message ?? String(e), code: err.code,
        ...(err.blockers ? { blockers: err.blockers } : {}),
      });
      const optionnel = migrationCriticality(f.sql) === 'optional';
      log.error(
        `[db] ECHEC de la migration ${f.filename} (${err.code ?? 'sans code'}) : ${err.message ?? e}\n` +
        (optionnel
          ? '     Index OPTIONNEL : le déploiement n\'échoue pas ; il sera reconstruit en arrière-plan par l\'application.'
          : '     La chaine se poursuit. Ce fichier sera retente au prochain passage.'),
      );
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// EXÉCUTION COORDONNÉE ET ÉTAT DU SCHÉMA (APP-PERF-16, lot 24b)
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
//     de données légitime peut être longue) ; les constructions CONCURRENTLY
//     ont leur propre délai (`indexLockTimeout`, voir plus haut) ;
//   · trois exécutants, trois rôles (lot 24b) :
//       - étape de déploiement (`scripts/migrate.mjs`) : tout, index compris
//         (délai long, budget < 20 min), puis réparation des index invalides ;
//       - démarrage web (`runBootMigrations`) : fichiers critiques seulement,
//         AUCUN index CONCURRENTLY ; verrou détenu ailleurs → attente bornée
//         d'un schéma critique prêt, sans rien appliquer ;
//       - maintenance en arrière-plan (`runIndexMaintenance`) : index en
//         attente ou invalides, délai long, sans le verrou de l'exécutant ;
//   · criticité d'un fichier (`migrationCriticality`) : un index construit
//     CONCURRENTLY NON unique n'est qu'une optimisation → `optional` (mode
//     dégradé) ; un index UNIQUE aussi s'il porte le marqueur
//     `-- verebona:optional-index` (le code garantit l'unicité sans lui,
//     justification dans le fichier) ; tout le reste — tables, colonnes,
//     contraintes, index UNIQUE cibles d'ON CONFLICT — est `critical` : son
//     absence fait échouer des requêtes, la version ne doit pas être mise
//     en service.
// ══════════════════════════════════════════════════════════════════════════

/** Clé du verrou consultatif de l'exécutant (texte haché par PostgreSQL). */
export const MIGRATION_RUNNER_LOCK_KEY = 'verebona:migrations';

export type MigrationCriticality = 'critical' | 'optional';

/** Marqueur d'un index UNIQUE dont le code n'a pas besoin pour être correct. */
const OPTIONAL_INDEX_MARKER = /^\s*--\s*verebona:optional-index\b/m;

/** Criticité d'un fichier de migration (voir le contrat ci-dessus). */
export function migrationCriticality(sql: string): MigrationCriticality {
  if (!concurrentIndexName(sql)) return 'critical';
  if (!/^CREATE\s+UNIQUE\s/i.test(sansCommentaires(sql))) return 'optional';
  return OPTIONAL_INDEX_MARKER.test(sql) ? 'optional' : 'critical';
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
 * exécutant détient le verrou (ou construit l'index), ou ils ont été sautés
 * volontairement (index critique au démarrage web) — état à relire.
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
  /** Fichiers volontairement non exécutés dans ce passage (index au démarrage web). */
  skipped: string[];
  failures: MigrationRunFailure[];
  /** Premier échec CRITIQUE dans l'ordre d'application : la cause à corriger d'abord. */
  firstCriticalFailure: MigrationRunFailure | null;
  repair: IndexRepairReport | null;
  pendingCritical: string[];
  pendingOptional: string[];
}

export interface MigrationRunOptions {
  lockKey?: string;
  /** Attente maximale du verrou de l'exécutant (ms). */
  lockWaitMs?: number;
  lockPollMs?: number;
  /** `lock_timeout` de chaque instruction (ex. `10s`). */
  lockTimeout?: string;
  /** `statement_timeout` de chaque instruction (`0` : aucun). */
  statementTimeout?: string;
  /** `lock_timeout` des constructions CONCURRENTLY (défaut : `lockTimeout`). */
  indexLockTimeout?: string;
  /** `build` (défaut) ou `skip` : voir `ApplyMigrationOptions`. */
  concurrentIndexes?: 'build' | 'skip';
  /** Échéance absolue (ms epoch) : borne l'attente du verrou et les constructions. */
  deadline?: number;
  /** Réparation des index invalides après les migrations (opération longue). */
  repairIndexes?: boolean;
  log?: MigrationLog;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const MIGRATION_DEFAULT_LOCK_TIMEOUT = '10s';

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
  const debut = now();
  let lockWaitMs = Math.max(0, opts.lockWaitMs ?? 30_000);
  if (opts.deadline != null) lockWaitMs = Math.max(0, Math.min(lockWaitMs, opts.deadline - debut - BUDGET_MARGIN_MS));
  const lockPollMs = Math.max(10, opts.lockPollMs ?? 500);
  const lockTimeout = opts.lockTimeout ?? MIGRATION_DEFAULT_LOCK_TIMEOUT;
  const statementTimeout = opts.statementTimeout ?? '0';
  const indexLockTimeout = opts.indexLockTimeout ?? lockTimeout;
  for (const [nom, v] of [['lockTimeout', lockTimeout], ['statementTimeout', statementTimeout], ['indexLockTimeout', indexLockTimeout]] as const) {
    if (!isPgDuration(v)) throw new Error(`[db] ${nom} invalide : « ${v} » (attendu : 500ms, 10s, 2min, 0).`);
  }
  const catalog = migrationCatalog(files);
  const criticite = new Map(catalog.map((m) => [m.filename, m.criticality]));

  // Connexion DÉDIÉE : le verrou de session, les `SET` et toutes les
  // instructions passent par elle. Exposée sans `reserve` : `runMigrationSql`
  // reste sur cette connexion (verrou d'index compris) et y pose puis rétablit
  // le délai des constructions (`dedicated`).
  const cnx = client.reserve ? await client.reserve() : null;
  const c: SqlRunner = cnx ? { unsafe: (q, p) => cnx.unsafe(q, p) } : client;
  let verrou = false;
  let attente = 0;
  const report: MigrationRunReport = {
    outcome: 'failed', lockAcquired: false, lockWaitMs: 0, durationMs: 0,
    applied: [], deferred: [], skipped: [], failures: [], firstCriticalFailure: null, repair: null,
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
      const pass = createIndexPass({ indexLockTimeout, deadline: opts.deadline ?? null, now, dedicated: cnx != null, log });
      const res = await applyMigrationFiles(c, files, log, { concurrentIndexes: opts.concurrentIndexes ?? 'build', pass });
      report.applied = res.applied;
      report.deferred = res.deferred;
      report.skipped = res.skipped;
      report.failures = res.failures.map((f) => ({ ...f, criticality: criticite.get(f.filename) ?? 'critical' }));
      if (opts.repairIndexes && opts.concurrentIndexes !== 'skip') report.repair = await repairInvalidMigrationIndexes(c, files, pass);
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
  } else if (!verrou || report.pendingCritical.every((f) => report.deferred.includes(f) || report.skipped.includes(f))) {
    report.outcome = 'waiting';
  } else {
    report.outcome = 'failed';
  }
  report.durationMs = now() - debut;
  return report;
}

// ══════════════════════════════════════════════════════════════════════════
// DÉMARRAGE WEB COORDONNÉ AVEC L'ÉTAPE DE DÉPLOIEMENT (lot 24b)
//
// Sur Scalingo, le conteneur web de la nouvelle version démarre AVANT le
// postdeploy (le port est ouvert avant l'instrumentation Next) : les deux
// exécutaient la chaîne en même temps (préprod du 05/10 : le web a pris le
// verrou, échoué en 10 s sur un index, refusé de démarrer au bout de 30 s ;
// le postdeploy, lui, a attendu le verrou puis échoué sur les mêmes index).
//
// Désormais le démarrage web :
//   · ne construit JAMAIS d'index CONCURRENTLY (`concurrentIndexes: 'skip'`)
//     ni ne répare : il ne tient le verrou que le temps des fichiers
//     critiques ordinaires (secondes) ;
//   · verrou détenu par un autre exécutant (postdeploy, autre conteneur) :
//     n'applique RIEN, relit l'état toutes les `pollMs` jusqu'à ce que le
//     schéma critique soit prêt, au plus `waitMs` (réglable,
//     `MIGRATION_BOOT_WAIT_MS`) ; au-delà, `waiting` — démarrage maintenu,
//     readiness à 503 jusqu'à relecture d'un schéma prêt ;
//   · échec critique par délai de verrou (55P03, transitoire : trafic de
//     l'ancienne version) : réessai dans la même attente bornée ;
//   · seul, sans postdeploy (poste local) : il prend le verrou et applique les
//     fichiers critiques lui-même ; les index sont construits juste après,
//     en arrière-plan (`runIndexMaintenance`).
// ══════════════════════════════════════════════════════════════════════════

export interface BootMigrationOptions {
  lockTimeout?: string;
  statementTimeout?: string;
  /** Attente maximale d'un schéma critique prêt quand un autre exécutant a la main (ms). */
  waitMs?: number;
  /** Intervalle de relecture (ms). */
  pollMs?: number;
  log?: MigrationLog;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const MIGRATION_BOOT_WAIT_DEFAULT_MS = 15 * 60_000;

export async function runBootMigrations(
  client: SqlRunner,
  files: MigrationFile[],
  opts: BootMigrationOptions = {},
): Promise<MigrationRunReport> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? console;
  const waitMs = Math.max(0, opts.waitMs ?? MIGRATION_BOOT_WAIT_DEFAULT_MS);
  const pollMs = Math.max(10, opts.pollMs ?? 5_000);
  const debut = now();
  const fin = debut + waitMs;
  let tours = 0;
  let dernierSignal = debut;
  for (;;) {
    // Au-delà du premier tour, l'avertissement « verrou détenu » de chaque
    // relecture est remplacé par une ligne par minute.
    const journal: MigrationLog = tours === 0 ? log : { info: log.info, warn: () => {}, error: log.error };
    const r = await runMigrations(client, files, {
      lockWaitMs: 0, lockTimeout: opts.lockTimeout, statementTimeout: opts.statementTimeout,
      concurrentIndexes: 'skip', repairIndexes: false, log: journal, now,
    });
    tours += 1;
    const transitoire = r.lockAcquired && r.outcome === 'failed'
      && r.failures.filter((f) => f.criticality === 'critical').every((f) => f.code === '55P03');
    const autreExecutant = !r.lockAcquired && r.pendingCritical.length > 0;
    const t = now();
    if ((!transitoire && !autreExecutant) || t >= fin) {
      r.lockWaitMs = t - debut;
      r.durationMs = t - debut;
      if (tours > 1) {
        log.info(`[db] migrations au démarrage : ${r.outcome} après ${Math.round((t - debut) / 1000)} s d'attente (${tours} relecture(s)).`);
      }
      return r;
    }
    if (tours === 1) {
      log.warn(
        autreExecutant
          ? `[db] migrations : un autre exécutant (étape de déploiement ?) a la main — ${r.pendingCritical.length} critique(s) en attente ; ` +
            `aucune modification d'ici, relecture toutes les ${Math.round(pollMs / 1000)} s pendant au plus ${Math.round(waitMs / 1000)} s.`
          : `[db] migrations : délai de verrou dépassé (55P03) sur ${r.firstCriticalFailure?.filename ?? '?'} — nouvel essai dans ${Math.round(pollMs / 1000)} s ` +
            `(au plus ${Math.round(waitMs / 1000)} s).`,
      );
    } else if (t - dernierSignal >= 60_000) {
      dernierSignal = t;
      log.warn(`[db] migrations : toujours en attente (${Math.round((t - debut) / 1000)} s, ${r.pendingCritical.length} critique(s)).`);
    }
    await sleep(Math.min(pollMs, Math.max(10, fin - t)));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// MAINTENANCE DES INDEX EN ARRIÈRE-PLAN (lot 24b)
//
// Un index optionnel resté en attente (délai dépassé au déploiement, budget
// épuisé, index invalide) finit par être construit SANS intervention : un
// passage périodique de l'application (`src/db/migration-maintenance.ts`)
// appelle cette fonction avec le délai long.
//   · schéma critique incomplet (poste local : index critique sauté au
//     démarrage web) : chaîne complète sous le verrou de l'exécutant, sans
//     l'attendre (`busy` s'il est pris) ;
//   · sinon : index optionnels en attente puis index invalides, SANS le
//     verrou de l'exécutant — chaque index a son propre verrou consultatif :
//     un déploiement qui démarre pendant une construction ne l'attend pas, il
//     diffère cet index (optionnel) et poursuit.
// Une connexion du pool par construction, une construction à la fois.
// ══════════════════════════════════════════════════════════════════════════

export interface IndexMaintenanceOptions {
  indexLockTimeout?: string;
  /** Échéance absolue (ms epoch) du passage : borne chaque construction. */
  deadline?: number;
  lockTimeout?: string;
  statementTimeout?: string;
  log?: MigrationLog;
  now?: () => number;
}

export interface IndexMaintenanceReport {
  /** `busy` : verrou de l'exécutant pris ailleurs (schéma critique incomplet). */
  kind: 'done' | 'pending' | 'busy';
  built: string[];
  deferred: string[];
  failures: MigrationRunFailure[];
  repair: IndexRepairReport | null;
  pendingCritical: string[];
  pendingOptional: string[];
}

export async function runIndexMaintenance(
  client: SqlRunner,
  files: MigrationFile[],
  opts: IndexMaintenanceOptions = {},
): Promise<IndexMaintenanceReport> {
  const log = opts.log ?? console;
  const indexLockTimeout = opts.indexLockTimeout ?? MIGRATION_INDEX_LOCK_TIMEOUT_DEPLOY;
  if (!isPgDuration(indexLockTimeout)) throw new Error(`[db] indexLockTimeout invalide : « ${indexLockTimeout} ».`);
  const catalog = migrationCatalog(files);
  const etat = await readSchemaState(client, catalog);

  if (!etat.tracked || etat.pendingCritical.length > 0) {
    const r = await runMigrations(client, files, {
      lockWaitMs: 0, lockTimeout: opts.lockTimeout, statementTimeout: opts.statementTimeout,
      indexLockTimeout, repairIndexes: true, log, now: opts.now, deadline: opts.deadline,
    });
    const reste = r.pendingCritical.length + r.pendingOptional.length + (r.repair?.requeued.length ?? 0);
    return {
      kind: !r.lockAcquired ? 'busy' : reste > 0 ? 'pending' : 'done',
      built: r.applied, deferred: r.deferred, failures: r.failures, repair: r.repair,
      pendingCritical: r.pendingCritical, pendingOptional: r.pendingOptional,
    };
  }

  const pass = createIndexPass({ indexLockTimeout, now: opts.now, log, deadline: opts.deadline });
  const out: IndexMaintenanceReport = {
    kind: 'done', built: [], deferred: [], failures: [], repair: null, pendingCritical: [], pendingOptional: [],
  };
  const parFichier = new Map(files.map((f) => [f.filename, f]));
  for (const nom of etat.pendingOptional) {
    const f = parFichier.get(nom);
    const index = f ? concurrentIndexName(f.sql) : null;
    if (!f || !index) continue;
    const r = await construireIndex(pass, client, f, index);
    if (r.kind === 'ok') {
      await client.unsafe(`INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [nom] as never[]);
      log.info(`[db] index ${index} construit (${nom}).`);
      out.built.push(nom);
    } else if (r.kind === 'error') {
      const err = r.error as IndexBuildError;
      out.failures.push({
        filename: nom, message: err.message ?? String(r.error), code: err.code, criticality: 'optional',
        ...(err.blockers ? { blockers: err.blockers } : {}),
      });
      log.warn(`[db] index ${index} non construit (${err.code ?? 'sans code'}) : ${err.message} — nouvel essai au prochain passage.`);
    } else {
      out.deferred.push(nom);
    }
  }
  out.repair = await repairInvalidMigrationIndexes(client, files, pass);
  for (const i of out.repair.repaired) log.info(`[db] index invalide ${i} reconstruit.`);
  const apres = await readSchemaState(client, catalog);
  out.pendingCritical = apres.pendingCritical;
  out.pendingOptional = apres.pendingOptional;
  out.kind = apres.pendingCritical.length + apres.pendingOptional.length + out.repair.requeued.length > 0 ? 'pending' : 'done';
  return out;
}
