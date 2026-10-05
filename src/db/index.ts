import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";
import {
  migrationCatalog, readMigrationFiles, readSchemaState, runMigrations,
  type MigrationCatalogEntry, type MigrationCriticality, type SqlRunner,
} from "@/db/migration-index";
import { resolveMigrationRuntimeConfig, type MigrationBootMode } from "@/db/migration-config";
import { describePoolConfig, resolvePoolConfig } from "@/db/pool-config";

const connectionString = process.env.DATABASE_URL!;

// Sans URL, le pilote `postgres` ne proteste pas : il applique ses valeurs par
// defaut et tente une connexion sous le compte systeme courant. L'erreur
// remontee est alors une authentification refusee pour un utilisateur qui
// n'existe pas en base — un message qui n'evoque en rien la cause reelle.
// Silencieux en test : les tests unitaires n'ouvrent aucune connexion.
if (!connectionString && process.env.NODE_ENV !== 'test') {
  console.error(
    '[db] DATABASE_URL absente. La connexion va echouer sous votre compte ' +
    'systeme. Hors serveur Next, importez `@/lib/load-env` avant `@/db`.',
  );
}
// Pool dimensionné explicitement (APP-PERF-01, `pool-config.ts`) : plus de
// détection VERCEL / NEXT_RUNTIME. Une valeur invalide de DB_POOL_MAX fait
// échouer le démarrage avec un message clair plutôt qu'une taille devinée.
const poolConfig = resolvePoolConfig();
if (process.env.NODE_ENV !== 'test') {
  console.info(describePoolConfig(poolConfig));
  if (poolConfig.maxSource === 'défaut' && process.env.NODE_ENV === 'production') {
    console.warn(
      `[db] DB_POOL_MAX absente : ${poolConfig.max} connexions par défaut. ` +
      'Fixez-la selon le budget de connexions de l’environnement (voir src/db/pool-config.ts).',
    );
  }
}
const client = postgres(connectionString, {
  max: poolConfig.max,
  idle_timeout: poolConfig.idleTimeoutS,
  connect_timeout: poolConfig.connectTimeoutS,
  max_lifetime: poolConfig.maxLifetimeS,
  // Inchangé : ne pas réactiver les requêtes préparées sans valider le mode
  // d'accès PostgreSQL (pooler transactionnel éventuel) séparément.
  prepare: false,
  // Reconnexion automatique en cas de coupure
  connection: {
    application_name: 'verebona',
  },
});
export const db = drizzle(client, { schema });
export { client as pgClient };
export type Database = typeof db;

/**
 * Migrations dont l'echec a ete constate au demarrage.
 * Expose pour l'administration et les controles de sante : une migration
 * manquante se traduit toujours, plus loin, par une colonne absente et une
 * erreur 500 incomprehensible cote utilisateur.
 */
export interface MigrationFailure {
  filename: string;
  message: string;
  code?: string;
  criticality?: MigrationCriticality;
}

// ══════════════════════════════════════════════════════════════════════════
// ÉTAT DES MIGRATIONS — PARTAGÉ PAR PROCESSUS (APP-PERF-16)
//
// Deux défauts corrigés :
//   · `_migrated` passait à true AVANT l'exécution : un second appelant
//     concurrent repartait aussitôt, sur un schéma encore incomplet, et
//     « commencé » se confondait avec « réussi » ;
//   · l'état vivait dans le module. Next.js compile l'instrumentation et les
//     routes dans des couches (bundles) distinctes, qui peuvent chacune porter
//     SA copie de `@/db` : le premier `ensureMigrations()` d'une route pouvait
//     alors relancer toute la chaîne à la requête, et `/api/health` lire des
//     échecs jamais renseignés dans sa copie.
//
// Désormais l'état et la promesse en cours sont portés par `globalThis` (une
// instance par processus) : un seul passage, partagé, aux phases distinctes.
// Les appels à la requête (`await ensureMigrations()` dans les routes)
// attendent ce passage ou rendent immédiatement son résultat ; ils ne
// déclenchent jamais de DDL une fois le démarrage passé.
// ══════════════════════════════════════════════════════════════════════════

export type MigrationPhase =
  /** Aucun passage dans ce processus. */
  | 'idle'
  | 'running'
  /** Tout est appliqué. */
  | 'ready'
  /** Seuls des index optionnels manquent : servi, signalé. */
  | 'degraded'
  /** Critique manquant, un autre exécutant a la main : à relire. */
  | 'waiting'
  /** Critique manquant : la version ne doit pas recevoir de trafic. */
  | 'failed'
  /** État illisible (base injoignable, configuration invalide). */
  | 'unknown'
  /** MIGRATIONS_ON_BOOT=off : rien au démarrage. */
  | 'skipped';

export interface MigrationStatus {
  phase: MigrationPhase;
  mode: MigrationBootMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  lockWaitMs: number | null;
  applied: string[];
  pendingCritical: string[];
  pendingOptional: string[];
  failures: MigrationFailure[];
  /** Première cause utile : premier échec critique, sinon erreur du lanceur. */
  firstFailure: MigrationFailure | null;
  error: string | null;
}

interface MigrationGlobalState {
  status: MigrationStatus;
  promise: Promise<MigrationStatus> | null;
  catalog: MigrationCatalogEntry[] | null;
  recheck: Promise<void> | null;
  recheckedAt: number;
}

const ETAT_MIGRATIONS = Symbol.for('verebona.db.migrations');

function statutInitial(): MigrationStatus {
  return {
    phase: 'idle', mode: null, startedAt: null, finishedAt: null, durationMs: null, lockWaitMs: null,
    applied: [], pendingCritical: [], pendingOptional: [], failures: [], firstFailure: null, error: null,
  };
}

function etatMigrations(): MigrationGlobalState {
  const g = globalThis as unknown as Record<symbol, MigrationGlobalState | undefined>;
  return (g[ETAT_MIGRATIONS] ??= { status: statutInitial(), promise: null, catalog: null, recheck: null, recheckedAt: 0 });
}

/** Tests uniquement : oublie l'état partagé du processus. */
export function resetMigrationStateForTests(): void {
  const g = globalThis as unknown as Record<symbol, MigrationGlobalState | undefined>;
  delete g[ETAT_MIGRATIONS];
}

export function getMigrationStatus(): MigrationStatus {
  const s = etatMigrations().status;
  return { ...s, applied: [...s.applied], pendingCritical: [...s.pendingCritical], pendingOptional: [...s.pendingOptional], failures: [...s.failures] };
}

export function getMigrationFailures(): MigrationFailure[] {
  return [...etatMigrations().status.failures];
}

const runner = () => client as unknown as SqlRunner;

async function executerMigrations(): Promise<MigrationStatus> {
  const etat = etatMigrations();
  const s = etat.status;
  const debut = Date.now();
  s.phase = 'running';
  s.startedAt = new Date(debut).toISOString();
  try {
    const cfg = resolveMigrationRuntimeConfig();
    s.mode = cfg.mode;
    if (cfg.mode === 'off') {
      s.phase = 'skipped';
      return s;
    }
    const fichiers = await readMigrationFiles();
    etat.catalog = migrationCatalog(fichiers);

    if (cfg.mode === 'check') {
      const st = await readSchemaState(runner(), etat.catalog);
      s.pendingCritical = st.pendingCritical;
      s.pendingOptional = st.pendingOptional;
      s.phase = st.pendingCritical.length > 0 ? 'failed' : st.pendingOptional.length > 0 ? 'degraded' : 'ready';
      if (st.pendingCritical.length > 0) {
        s.firstFailure = { filename: st.pendingCritical[0], message: 'migration critique non appliquée (étape de déploiement absente ou en échec)', criticality: 'critical' };
      }
    } else {
      // Index invalides (construction CONCURRENTLY interrompue) : la
      // réparation est longue, elle relève de l'étape de déploiement ;
      // au démarrage seulement sur demande (MIGRATIONS_REPAIR_ON_BOOT).
      const r = await runMigrations(runner(), fichiers, {
        lockWaitMs: cfg.lockWaitMs, lockTimeout: cfg.lockTimeout, statementTimeout: cfg.statementTimeout,
        repairIndexes: cfg.repairOnBoot,
      });
      s.phase = r.outcome;
      s.lockWaitMs = r.lockWaitMs;
      s.applied = r.applied;
      s.pendingCritical = r.pendingCritical;
      s.pendingOptional = r.pendingOptional;
      s.failures = r.failures;
      s.firstFailure = r.firstCriticalFailure ?? r.failures[0] ?? null;
      for (const i of r.repair?.repaired ?? []) console.warn(`[db] index invalide ${i} reconstruit.`);
      for (const q of r.repair?.requeued ?? []) {
        console.error(`[db] index INVALIDE ${q.index} non reconstruit (${q.reason}) : ${q.filename} sera rejoue.`);
      }
      if ((r.repair?.unknown.length ?? 0) > 0) {
        console.error(
          `[db] ${r.repair!.unknown.length} index INVALIDE(S) hors migrations connues : ${r.repair!.unknown.join(', ')}. ` +
          'A supprimer (DROP INDEX CONCURRENTLY <nom>) puis recreer a la main.',
        );
      }
      if (r.outcome === 'failed' || r.outcome === 'waiting') {
        console.error(
          `[db] ${r.pendingCritical.length} migration(s) CRITIQUE(S) non appliquee(s) (${r.outcome}) : ` +
          `${r.pendingCritical.slice(0, 10).join(', ')}${r.pendingCritical.length > 10 ? '…' : ''}. ` +
          (s.firstFailure ? `Premiere cause : ${s.firstFailure.filename} (${s.firstFailure.code ?? 'sans code'}) ${s.firstFailure.message}` : ''),
        );
      }
    }
  } catch (e) {
    // Base injoignable, configuration invalide… : on ne conclut pas — ni
    // prêt, ni échec de migration. La readiness relira l'état.
    s.phase = 'unknown';
    s.error = (e as Error).message;
    s.firstFailure = s.firstFailure ?? { filename: '(lanceur)', message: s.error, code: (e as { code?: string }).code };
    console.error('[db] ensureMigrations : etat du schema indetermine —', s.error);
  } finally {
    s.finishedAt = new Date().toISOString();
    s.durationMs = Date.now() - debut;
    if (s.phase !== 'skipped') {
      console.info(
        `[db] migrations (${s.mode ?? '?'}) : ${s.phase} en ${s.durationMs} ms` +
        `${s.lockWaitMs != null ? `, attente verrou ${s.lockWaitMs} ms` : ''}, ${s.applied.length} appliquee(s), ` +
        `${s.pendingCritical.length} critique(s) / ${s.pendingOptional.length} optionnelle(s) en attente.`,
      );
    }
  }
  return s;
}

/**
 * Passage unique des migrations pour ce processus (voir l'en-tête). Ne lève
 * jamais : le résultat est dans le statut rendu (`phase`).
 */
export async function ensureMigrations(): Promise<MigrationStatus> {
  const etat = etatMigrations();
  if (!etat.promise) etat.promise = executerMigrations().then(() => getMigrationStatus());
  await etat.promise;
  return getMigrationStatus();
}

export interface SchemaReadiness {
  /** Prérequis critiques du schéma satisfaits. */
  ready: boolean;
  phase: MigrationPhase;
  pendingCritical: number;
  pendingOptional: number;
  /** Fichier et code de la première cause — jamais le message SQL. */
  firstFailure: { filename: string; code?: string } | null;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`délai de ${ms} ms dépassé`)), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Disponibilité du schéma pour la readiness. `ready` / `degraded` acquis au
 * démarrage : rendus sans requête (un schéma ne régresse pas). Sinon l'état
 * est RELU en base — une seule relecture en vol, au plus une par `maxAgeMs`,
 * bornée par `timeoutMs` — pour qu'une migration achevée ailleurs (étape de
 * déploiement, autre instance) rende la version disponible.
 */
export async function getSchemaReadiness(opts: { timeoutMs?: number; maxAgeMs?: number } = {}): Promise<SchemaReadiness> {
  const etat = etatMigrations();
  const s = etat.status;
  const relisible = s.phase === 'waiting' || s.phase === 'failed' || s.phase === 'unknown' || s.phase === 'skipped' || s.phase === 'idle';
  if (relisible && Date.now() - etat.recheckedAt >= (opts.maxAgeMs ?? 15_000)) {
    if (!etat.recheck) {
      etat.recheck = (async () => {
        try {
          if (!etat.catalog) etat.catalog = migrationCatalog(await readMigrationFiles());
          const st = await readSchemaState(runner(), etat.catalog);
          if (s.phase === 'running') return;
          s.pendingCritical = st.pendingCritical;
          s.pendingOptional = st.pendingOptional;
          // Échecs résolus depuis (appliqués ailleurs) : retirés du diagnostic.
          const enAttente = new Set([...st.pendingCritical, ...st.pendingOptional]);
          s.failures = s.failures.filter((f) => enAttente.has(f.filename));
          if (s.firstFailure && s.firstFailure.filename !== '(lanceur)' && !enAttente.has(s.firstFailure.filename)) {
            s.firstFailure = s.failures.find((f) => f.criticality === 'critical') ?? s.failures[0] ?? null;
          }
          if (st.pendingCritical.length === 0) {
            if (s.firstFailure?.filename === '(lanceur)') s.firstFailure = s.failures[0] ?? null;
            s.phase = st.pendingOptional.length > 0 ? 'degraded' : 'ready';
            s.error = null;
          }
        } finally {
          etat.recheckedAt = Date.now();
          etat.recheck = null;
        }
      })();
    }
    await withDeadline(etat.recheck, opts.timeoutMs ?? 1_500).catch(() => undefined);
  }
  const f = s.firstFailure;
  return {
    ready: s.phase === 'ready' || s.phase === 'degraded',
    phase: s.phase,
    pendingCritical: s.pendingCritical.length,
    pendingOptional: s.pendingOptional.length,
    firstFailure: f ? { filename: f.filename, code: f.code } : null,
  };
}

let _unaccentReady = false;
export async function ensureUnaccent(): Promise<void> {
  if (_unaccentReady) return;
  try {
    await client`CREATE EXTENSION IF NOT EXISTS unaccent`;
    _unaccentReady = true;
  } catch (e) {
    console.warn('[db] ensureUnaccent warning:', (e as Error).message);
    _unaccentReady = true; // don't retry on failure
  }
}

// ── Revoked tokens store (session revocation on logout) ──────────────────────
let _revokedTableReady = false;

export async function ensureRevokedTokensTable(): Promise<void> {
  if (_revokedTableReady) return;
  // Tables créées par la migration 0243 (critique) : schéma prêt → aucune DDL
  // à la requête. Repli historique ci-dessous seulement si l'état des
  // migrations est inconnu dans ce processus (script, démarrage sans base).
  const phase = etatMigrations().status.phase;
  if (phase === 'ready' || phase === 'degraded') {
    _revokedTableReady = true;
    return;
  }
  try {
    await client`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        id         SERIAL PRIMARY KEY,
        token_hash TEXT        NOT NULL UNIQUE,
        user_id    INTEGER     NOT NULL,
        revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `;
    await client`
      CREATE INDEX IF NOT EXISTS revoked_tokens_token_hash_idx ON revoked_tokens (token_hash)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx ON revoked_tokens (expires_at)
    `;
    // Révocation globale par utilisateur (changement / réinitialisation de mot
    // de passe) : tout jeton émis AVANT `revoked_before` est invalide, sans
    // avoir à connaître chaque jeton émis.
    await client`
      CREATE TABLE IF NOT EXISTS user_session_revocations (
        user_id        INTEGER     PRIMARY KEY,
        revoked_before TIMESTAMPTZ NOT NULL,
        reason         TEXT,
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    _revokedTableReady = true;
  } catch (e) {
    console.warn('[db] ensureRevokedTokensTable warning:', (e as Error).message);
  }
}

export async function revokeToken(tokenHash: string, userId: number, expiresAt: Date): Promise<void> {
  await ensureRevokedTokensTable();
  await client`
    INSERT INTO revoked_tokens (token_hash, user_id, expires_at)
    VALUES (${tokenHash}, ${userId}, ${expiresAt.toISOString()})
    ON CONFLICT (token_hash) DO NOTHING
  `;
  // Purge expired tokens opportunistically (keep table lean)
  await client`DELETE FROM revoked_tokens WHERE expires_at < now()`.catch(() => null);
}

/**
 * Révoque un jeton de façon ATOMIQUE et dit si c'est cet appel qui l'a fait.
 *
 * `false` : le jeton était déjà révoqué — une autre requête l'a consommé
 * entre-temps. Pour une rotation, c'est une réutilisation : elle ne doit pas
 * produire une seconde session. Lève si la base ne répond pas (la rotation
 * ne doit alors pas être annoncée comme réussie).
 */
export async function revokeTokenOnce(tokenHash: string, userId: number, expiresAt: Date): Promise<boolean> {
  await ensureRevokedTokensTable();
  const rows = await client<{ id: number }[]>`
    INSERT INTO revoked_tokens (token_hash, user_id, expires_at)
    VALUES (${tokenHash}, ${userId}, ${expiresAt.toISOString()})
    ON CONFLICT (token_hash) DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

export async function isTokenRevoked(tokenHash: string): Promise<boolean> {
  await ensureRevokedTokensTable();
  const rows = await client<{ id: number }[]>`
    SELECT id FROM revoked_tokens WHERE token_hash = ${tokenHash} LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * Invalide TOUTES les sessions d'un utilisateur : tout jeton (accès ou
 * renouvellement) émis avant maintenant est refusé — y compris par
 * `/api/auth/refresh`, qui ne peut plus en tirer une nouvelle session.
 *
 * Même système que `revokeToken` (table `revoked_tokens`), étendu d'une
 * borne par utilisateur : les jetons émis ne sont pas stockés, il n'y a donc
 * pas de liste à parcourir.
 *
 * Rend la borne appliquée : un jeton émis APRÈS elle (session conservée
 * volontairement) reste valide.
 */
export async function revokeAllUserSessions(userId: number, reason: string): Promise<Date> {
  await ensureRevokedTokensTable();
  // Horloge de l'APPLICATION, celle qui date les jetons (`iatMs`) : un écart
  // d'horloge avec la base ne doit ni sauver un ancien jeton, ni invalider la
  // session neuve émise juste après.
  const at = new Date();
  const rows = await client<{ revoked_before: Date }[]>`
    INSERT INTO user_session_revocations (user_id, revoked_before, reason, updated_at)
    VALUES (${userId}, ${at.toISOString()}, ${reason}, now())
    ON CONFLICT (user_id) DO UPDATE
      SET revoked_before = GREATEST(user_session_revocations.revoked_before, EXCLUDED.revoked_before),
          reason = EXCLUDED.reason, updated_at = now()
    RETURNING revoked_before
  `;
  return new Date(rows[0].revoked_before);
}

/** Borne de révocation globale de l'utilisateur, ou `null`. */
export async function getUserSessionCutoff(userId: number): Promise<Date | null> {
  await ensureRevokedTokensTable();
  const rows = await client<{ revoked_before: Date }[]>`
    SELECT revoked_before FROM user_session_revocations WHERE user_id = ${userId} LIMIT 1
  `;
  return rows[0] ? new Date(rows[0].revoked_before) : null;
}

/**
 * Le jeton a-t-il été émis avant la révocation globale de son utilisateur ?
 * `iatMs` (milliseconde d'émission) est préféré à `iat` (seconde) : un jeton
 * émis dans la même seconde que la révocation — la session conservée — ne
 * doit pas être confondu avec un ancien.
 */
export function isIssuedBefore(payload: { iat?: number; iatMs?: number }, cutoff: Date | null): boolean {
  if (!cutoff) return false;
  const issuedMs = typeof payload.iatMs === 'number' ? payload.iatMs : (payload.iat ?? 0) * 1000;
  return issuedMs <= cutoff.getTime();
}

/** SHA-256 hex hash of a token string (crypto available in Node.js 15+) */
export async function hashToken(token: string): Promise<string> {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(token).digest('hex');
}
