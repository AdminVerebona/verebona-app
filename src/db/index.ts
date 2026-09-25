import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

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
const isServerless = process.env.VERCEL === '1' || process.env.NEXT_RUNTIME === 'nodejs';
const client = postgres(connectionString, {
  // Dev: 8 connexions pour gérer les appels concurrents (pre-warm + load + tabs)
  // Serverless: 1 connexion par invocation
  max: isServerless ? 1 : 8,
  idle_timeout: isServerless ? 10 : 20,
  connect_timeout: 20,
  max_lifetime: isServerless ? 60 : 60 * 10,
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
}
let _migrationFailures: MigrationFailure[] = [];
export function getMigrationFailures(): MigrationFailure[] {
  return [..._migrationFailures];
}

let _migrated = false;
export async function ensureMigrations() {
  if (_migrated) return;
  _migrated = true;
  _migrationFailures = [];
  try {
    await client`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT        NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    const { readdir, readFile } = await import('fs/promises');
    const { join } = await import('path');
    const migrationsDir = join(process.cwd(), 'src', 'db', 'migrations');
    const allFiles = await readdir(migrationsDir);
    const sqlFiles = allFiles.filter(f => f.endsWith('.sql')).sort();
    const applied = await client<{ filename: string }[]>`SELECT filename FROM _migrations`;
    const appliedSet = new Set(applied.map(r => r.filename));

    // ══════════════════════════════════════════════════════════════════════
    // UN ECHEC N'INTERROMPT PLUS LA CHAINE
    //
    // La version precedente placait la boucle entiere dans un seul `try`.
    // La premiere migration en echec faisait sortir de la boucle : TOUTES les
    // suivantes etaient abandonnees, et l'exception etait avalee. Une base
    // pouvait ainsi rester bloquee des dizaines de migrations en arriere sans
    // qu'aucun signal ne remonte — le symptome n'apparaissant qu'au premier
    // `SELECT` portant sur une colonne jamais creee.
    //
    // Chaque fichier a desormais son propre `try`. Un echec est journalise,
    // enregistre dans `_migrationFailures`, et la chaine se poursuit. Le
    // fichier en echec n'est PAS marque comme applique : il sera retente au
    // prochain demarrage.
    // ══════════════════════════════════════════════════════════════════════
    for (const file of sqlFiles) {
      if (appliedSet.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf-8');
      try {
        await client.unsafe(sql);
        await client`INSERT INTO _migrations (filename) VALUES (${file}) ON CONFLICT DO NOTHING`;
        console.log(`[db] Applied migration: ${file}`);
      } catch (e) {
        const err = e as { message?: string; code?: string };
        _migrationFailures.push({
          filename: file,
          message: err.message ?? String(e),
          code: err.code,
        });
        console.error(
          `[db] ECHEC de la migration ${file} (${err.code ?? 'sans code'}) : ${err.message ?? e}\n` +
          '     La chaine se poursuit. Ce fichier sera retente au prochain demarrage.',
        );
      }
    }

    if (_migrationFailures.length > 0) {
      console.error(
        `[db] ${_migrationFailures.length} migration(s) en echec : ` +
        `${_migrationFailures.map(f => f.filename).join(', ')}. ` +
        'Le schema peut etre incomplet — corrigez avant toute mise en service.',
      );
    }
  } catch (e) {
    console.error('[db] ensureMigrations error:', (e as Error).message);
    // Don't rethrow — allow app to start even if migration runner fails
  }
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
