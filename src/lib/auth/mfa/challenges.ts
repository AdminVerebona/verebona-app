/**
 * Défis serveur à usage unique (lot 110B, ticket §4) : WebAuthn (création,
 * connexion, réauthentification) et code de récupération envoyé par e-mail.
 *
 * Stockés en BASE (`mfa_challenges`) : aléatoires, courts, liés à une
 * opération (`purpose`), à un contexte (`binding` : jeton provisoire, session
 * `sid`, ou navigateur anonyme) et, quand il est connu, à l'utilisateur.
 * CONSOMMATION ATOMIQUE (`UPDATE … WHERE consumed_at IS NULL AND
 * expires_at > now() RETURNING`) : un défi ne sert qu'une fois, même entre
 * deux onglets ou deux instances.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from './db';

export type ChallengePurpose = 'passkey_register' | 'passkey_login' | 'passkey_stepup' | 'recovery_email';

export function bindingHash(binding: string): string {
  return createHash('sha256').update(`verebona/mfa-binding/v1:${binding}`).digest('hex');
}

export async function storeChallenge(input: {
  purpose: ChallengePurpose; userId: number | null; challenge: string; binding: string; ttlMs: number;
}): Promise<string> {
  const id = randomUUID();
  const db = await sql();
  await db`
    INSERT INTO mfa_challenges (id, user_id, purpose, challenge, binding_hash, created_at, expires_at)
    VALUES (${id}, ${input.userId}, ${input.purpose}, ${input.challenge}, ${bindingHash(input.binding)},
            now(), ${new Date(Date.now() + input.ttlMs).toISOString()})`;
  return id;
}

/** Consomme le défi s'il correspond (opération, contexte, utilisateur) ; `null` sinon. */
export async function consumeChallenge(input: {
  id: unknown; purpose: ChallengePurpose; binding: string; userId?: number | null;
}): Promise<{ challenge: string; userId: number | null } | null> {
  if (typeof input.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.id)) return null;
  const db = await sql();
  const rows = await db<{ challenge: string; user_id: number | null }[]>`
    UPDATE mfa_challenges SET consumed_at = now()
     WHERE id = ${input.id} AND purpose = ${input.purpose} AND binding_hash = ${bindingHash(input.binding)}
       AND consumed_at IS NULL AND expires_at > now()
       AND (${input.userId ?? null}::int IS NULL OR user_id = ${input.userId ?? null})
    RETURNING challenge, user_id`;
  const r = rows[0];
  return r ? { challenge: r.challenge, userId: r.user_id == null ? null : Number(r.user_id) } : null;
}

/** Code e-mail : défi dont l'aléa est l'empreinte du code ; essais comptés. */
export async function storeEmailCode(userId: number, binding: string, code: string, ttlMs: number): Promise<string> {
  const db = await sql();
  await db`DELETE FROM mfa_challenges WHERE user_id = ${userId} AND purpose = 'recovery_email'`;
  return storeChallenge({ purpose: 'recovery_email', userId, challenge: emailCodeHash(userId, code), binding, ttlMs });
}

export function emailCodeHash(userId: number, code: string): string {
  return createHash('sha256').update(`verebona/mfa-recovery-email/v1:${userId}:${String(code).trim()}`).digest('hex');
}

/**
 * Vérifie le code e-mail de récupération : un essai faux est compté
 * (`attempts`), au-delà de `maxAttempts` le défi est épuisé. Bon code :
 * consommé atomiquement.
 */
export async function checkEmailCode(userId: number, binding: string, code: string, maxAttempts: number): Promise<boolean> {
  const db = await sql();
  const expected = emailCodeHash(userId, code);
  const ok = await db`
    UPDATE mfa_challenges SET consumed_at = now()
     WHERE user_id = ${userId} AND purpose = 'recovery_email' AND binding_hash = ${bindingHash(binding)}
       AND challenge = ${expected} AND consumed_at IS NULL AND expires_at > now() AND attempts < ${maxAttempts}
    RETURNING id`;
  if (ok.length > 0) return true;
  await db`
    UPDATE mfa_challenges SET attempts = attempts + 1
     WHERE user_id = ${userId} AND purpose = 'recovery_email' AND consumed_at IS NULL`;
  return false;
}

export function randomBinding(): string {
  return randomBytes(24).toString('base64url');
}

export async function purgeMfaChallenges(now = new Date()): Promise<number> {
  const db = await sql();
  const limit = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const a = await db`DELETE FROM mfa_challenges WHERE expires_at < ${limit} RETURNING id`;
  const b = await db`DELETE FROM mfa_pending_auth WHERE expires_at < ${limit} RETURNING id`;
  const c = await db`DELETE FROM mfa_totp_factors WHERE status = 'PENDING' AND pending_expires_at < ${limit} RETURNING id`;
  return a.length + b.length + c.length;
}
