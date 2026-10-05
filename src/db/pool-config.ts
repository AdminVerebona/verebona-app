/**
 * Dimensionnement du pool PostgreSQL du processus — APP-PERF-01.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI UNE CONFIGURATION EXPLICITE
 *
 * Le pool était dimensionné par `VERCEL === '1' || NEXT_RUNTIME === 'nodejs'`
 * (« serverless » → 1 connexion, sinon 8). Vercel ne fait plus partie de
 * l'architecture (Scalingo), et `NEXT_RUNTIME` vaut `nodejs` dans TOUT
 * serveur Next : en production, le processus web — qui héberge aussi la file
 * IA, le worker d'exports, la sauvegarde et les tâches quotidiennes — tournait
 * donc vraisemblablement sur UNE seule connexion, sans que personne ne l'ait
 * décidé ni mesuré.
 *
 * La taille vient désormais de `DB_POOL_MAX`, validée ; les durées sont celles
 * d'un processus Node persistant. Les valeurs effectives sont journalisées au
 * démarrage, sans jamais `DATABASE_URL` ni identifiant.
 *
 * ── BUDGET DE CONNEXIONS (CA-02) ──────────────────────────────────────────
 *
 * Inventaire des processus du dépôt qui ouvrent des connexions :
 *   · web (`next start`, conteneurs `web-N` Scalingo) : UN pool par
 *     conteneur, partagé par les routes API, la file IA (AI_QUEUE_CONCURRENCY,
 *     3 par défaut), le worker d'exports V12 (une génération à la fois), la
 *     sauvegarde quotidienne et les tâches planifiées internes ;
 *   · migrations au démarrage (`ensureMigrations`) : même pool ;
 *   · étape `postdeploy` (`scripts/migrate.mjs`, Procfile) : conteneur
 *     ponctuel, pool propre de 2 connexions (`max: 2` : verrou consultatif
 *     de session + exécution), PENDANT que les anciens conteneurs web
 *     servent encore — à compter avec eux ;
 *   · scripts ponctuels (`src/db/run-migration.ts`, `check-*.ts`,
 *     `scalingo run …`) : 1 connexion chacun (`max: 1`) ;
 *   · administration humaine (psql, console de l'hébergeur) : 1 à 2.
 *
 *   total = conteneurs_web × DB_POOL_MAX + 2 (postdeploy) + scripts ponctuels
 *           + administration
 *
 * Ce total doit rester SOUS la limite de connexions de l'offre PostgreSQL de
 * l'environnement, avec une marge (connexions réservées au superutilisateur,
 * déploiement en recouvrement : pendant un déploiement Scalingo, l'ancien et le
 * nouveau conteneur coexistent — compter deux fois les conteneurs web).
 * Exemple : 2 conteneurs web, DB_POOL_MAX=5, recouvrement → 2 × 2 × 5 = 20,
 * + 2 (postdeploy) + 3 ponctuelles = 25, à comparer à la limite de l'offre.
 * Mesures (attente d'acquisition, temps SQL) : `pool-metrics.ts` (lot 24).
 * Détail : docs/exploitation/migrations-et-sondes.md §3.
 *
 * ⚠️ Ne pas augmenter arbitrairement (20, 50…) : au-delà du nombre de cœurs
 * de la base, des connexions supplémentaires dégradent PostgreSQL. Aucun gain
 * chiffré n'est acquis ; fixer la valeur après mesure (attente du pool, temps
 * SQL, p95 des API) sur l'environnement de recette.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Taille appliquée quand `DB_POOL_MAX` est absente — journalisée comme telle. */
export const DEFAULT_DB_POOL_MAX = 5;
/** Libération d'une connexion inactive (s) : rend la marge au budget. */
export const DEFAULT_DB_IDLE_TIMEOUT_S = 60;
/** Durée de vie maximale d'une connexion (s) : recyclage régulier. */
export const DEFAULT_DB_MAX_LIFETIME_S = 30 * 60;
/** Délai d'établissement d'une connexion (s) — inchangé. */
export const DEFAULT_DB_CONNECT_TIMEOUT_S = 20;

export interface PoolConfig {
  max: number;
  idleTimeoutS: number;
  maxLifetimeS: number;
  connectTimeoutS: number;
  /** Rôle du processus, pour lire les journaux (web-1, worker…). */
  role: string;
  /** Origine de `max` : variable explicite ou valeur par défaut. */
  maxSource: 'DB_POOL_MAX' | 'défaut';
}

/** Erreur de configuration : le processus refuse de démarrer avec une valeur douteuse. */
export class PoolConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PoolConfigError';
  }
}

type Env = Record<string, string | undefined>;

/**
 * Entier strictement positif, ou erreur. Une valeur vide vaut absence.
 * `Number('')`, `parseInt('5abc')` ou `1.5` ne doivent PAS devenir une taille
 * de pool silencieuse : on rejette tout ce qui n'est pas un entier écrit tel quel.
 */
function readPositiveInt(env: Env, name: string, max: number): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return null;
  const txt = raw.trim();
  if (!/^\d+$/.test(txt)) {
    throw new PoolConfigError(`[db] ${name} invalide (« ${txt} ») : entier strictement positif attendu.`);
  }
  const n = Number(txt);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new PoolConfigError(`[db] ${name} invalide (« ${txt} ») : entier strictement positif attendu.`);
  }
  if (n > max) {
    throw new PoolConfigError(`[db] ${name} = ${n} dépasse la borne de sécurité (${max}). Vérifiez le budget de connexions.`);
  }
  return n;
}

/**
 * Configuration effective du pool, sans dépendre de Vercel ni du runtime Next
 * (CA-01). Lève `PoolConfigError` sur une valeur invalide (T-01 : rejet
 * contrôlé plutôt qu'une valeur magique).
 */
export function resolvePoolConfig(env: Env = process.env): PoolConfig {
  const max = readPositiveInt(env, 'DB_POOL_MAX', 100);
  return {
    max: max ?? DEFAULT_DB_POOL_MAX,
    maxSource: max == null ? 'défaut' : 'DB_POOL_MAX',
    idleTimeoutS: readPositiveInt(env, 'DB_POOL_IDLE_TIMEOUT_S', 24 * 3600) ?? DEFAULT_DB_IDLE_TIMEOUT_S,
    maxLifetimeS: readPositiveInt(env, 'DB_POOL_MAX_LIFETIME_S', 24 * 3600) ?? DEFAULT_DB_MAX_LIFETIME_S,
    connectTimeoutS: DEFAULT_DB_CONNECT_TIMEOUT_S,
    // `CONTAINER` est posé par Scalingo (web-1, worker-1…).
    role: (env.DB_PROCESS_ROLE || env.CONTAINER || 'web').slice(0, 40),
  };
}

/**
 * Ligne de journal des valeurs effectives. Ne contient ni `DATABASE_URL`, ni
 * hôte, ni identifiant : seulement des tailles et des durées.
 */
export function describePoolConfig(c: PoolConfig): string {
  return `[db] pool PostgreSQL — rôle=${c.role} max=${c.max} (${c.maxSource}) ` +
    `idle_timeout=${c.idleTimeoutS}s max_lifetime=${c.maxLifetimeS}s connect_timeout=${c.connectTimeoutS}s`;
}

/**
 * `application_name` des connexions (lot 24b) : rend lisibles, dans
 * `pg_stat_activity` et le diagnostic des constructions d'index bloquées,
 * le processus qui tient une transaction — `verebona:<rôle>`, le rôle étant
 * celui du pool (`DB_PROCESS_ROLE`, sinon `CONTAINER` posé par Scalingo :
 * `web-1`, `one-off-1234`…, sinon `web`). L'étape de déploiement se nomme
 * `verebona-migrate:<conteneur>` (`scripts/migrate.mjs`).
 *
 * Paramètre de DÉMARRAGE de la connexion (pas un `SET`) : compatible avec
 * `prepare: false` et un pooler transactionnel. Aucune donnée sensible :
 * seulement le rôle, filtré, ≤ 63 octets (limite PostgreSQL).
 */
export function resolveApplicationName(role: string): string {
  const r = role.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  return r ? `verebona:${r}` : 'verebona';
}
