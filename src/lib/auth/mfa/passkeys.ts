/**
 * Clés d'accès (passkeys) WebAuthn — lot 110B, ticket §2, §4.
 *
 * Bibliothèque maintenue : @simplewebauthn/server (version exacte dans
 * package.json). Validation COMPLÈTE côté serveur : défi (stocké en base,
 * usage unique, `challenges.ts`), origine (liste exacte), RP ID, type,
 * signature, identifiant et clé publique, présence (UP) ET vérification de
 * l'utilisateur (UV) — `userVerification: 'required'` à l'enrôlement, à la
 * connexion ET à la réauthentification, et `requireUserVerification: true`
 * à chaque vérification. Rien n'est activé sur un simple retour de
 * l'interface.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * VARIABLES SCALINGO (distinctes en préproduction et en production)
 *
 *   WEBAUTHN_RP_ID     domaine de la partie de confiance, sans schéma ni
 *                      port (ex. `app.verebona.fr`). Changer cette valeur
 *                      rend inutilisables les clés déjà créées.
 *   WEBAUTHN_ORIGINS   origines EXACTES admises, séparées par des virgules
 *                      (ex. `https://app.verebona.fr`). Chaque origine Web
 *                      doit être en https et sur le RP ID ou l'un de ses
 *                      sous-domaines ; une application Android utilisant le
 *                      Credential Manager natif s'ajoute sous la forme
 *                      `android:apk-key-hash:<empreinte base64url>`. Aucune
 *                      origine libre, aucun joker.
 *   WEBAUTHN_RP_NAME   nom affiché (défaut « Verebona »).
 *
 * Production sans configuration valable : clés d'accès indisponibles (les
 * écrans ne proposent que les méthodes réellement possibles — lot 111W :
 * statut global anonyme `passkey` de GET /api/auth/oauth/providers) — jamais
 * une origine devinée. Hors production : `localhost` par défaut.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Stockage : identifiant de credential, clé publique COSE (base64url),
 * compteur, transports, type (mono-appareil / synchronisable), sauvegarde —
 * jamais de clé privée ni de donnée biométrique (elles ne quittent jamais
 * l'appareil). Compteur : les passkeys synchronisées restent à 0 ; un
 * compteur NON nul qui régresse est refusé (clone possible) et journalisé.
 */
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON, AuthenticatorTransportFuture } from '@simplewebauthn/server';
import { MAX_PASSKEYS_PER_USER, WEBAUTHN_CHALLENGE_TTL_MS } from './constants';
import { consumeChallenge, storeChallenge, type ChallengePurpose } from './challenges';
import { findPasskeyByCredentialId, listPasskeys, markMfaEnrolled, sql, type PasskeyRow } from './db';
import { sanitizePasskeyName } from './factor-ops';

type Env = Record<string, string | undefined>;

export interface WebAuthnConfig { rpID: string; rpName: string; origins: string[] }

export class WebAuthnUnavailableError extends Error {
  constructor(reason: string) { super(`WEBAUTHN_UNAVAILABLE: ${reason}`); this.name = 'WebAuthnUnavailableError'; }
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Origine admise pour ce RP ID ? (pur — exposé aux tests) */
export function isAcceptableOrigin(origin: string, rpID: string, production: boolean): boolean {
  if (/^android:apk-key-hash:[A-Za-z0-9_-]{20,}$/.test(origin)) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false; // aucune partie de chemin, pas de « / » final
  const host = u.hostname;
  const onRp = host === rpID || host.endsWith(`.${rpID}`);
  if (u.protocol === 'https:') return onRp;
  if (u.protocol === 'http:' && !production) return host === 'localhost' && rpID === 'localhost';
  return false;
}

export function readWebAuthnConfig(env: Env = process.env): WebAuthnConfig {
  const production = env.NODE_ENV === 'production';
  const rpID = (env.WEBAUTHN_RP_ID ?? '').trim().toLowerCase() || (production ? '' : 'localhost');
  const raw = (env.WEBAUTHN_ORIGINS ?? '').trim() || (production ? '' : 'http://localhost:3000');
  if (!rpID || !HOST_RE.test(rpID)) throw new WebAuthnUnavailableError('WEBAUTHN_RP_ID absent ou invalide');
  const origins = raw.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.length === 0) throw new WebAuthnUnavailableError('WEBAUTHN_ORIGINS absent');
  for (const o of origins) {
    if (!isAcceptableOrigin(o, rpID, production)) throw new WebAuthnUnavailableError('WEBAUTHN_ORIGINS contient une origine non admise');
  }
  return { rpID, rpName: (env.WEBAUTHN_RP_NAME ?? '').trim() || 'Verebona', origins };
}

export function webAuthnStatus(env: Env = process.env): { available: boolean; rpID: string | null; origins: string[]; problem: string | null } {
  try {
    const c = readWebAuthnConfig(env);
    return { available: true, rpID: c.rpID, origins: c.origins, problem: null };
  } catch (e) {
    return { available: false, rpID: null, origins: [], problem: (e as Error).message.replace(/^WEBAUTHN_UNAVAILABLE: /, '') };
  }
}

const userHandle = (userId: number) => new TextEncoder().encode(`vb-user-${userId}`);

// ── Enrôlement ─────────────────────────────────────────────────────────────

export async function passkeyRegistrationOptions(input: { userId: number; userName: string; displayName: string; binding: string }) {
  const cfg = readWebAuthnConfig();
  const existing = await listPasskeys(input.userId);
  if (existing.length >= MAX_PASSKEYS_PER_USER) return { ok: false as const, reason: 'too_many' as const };
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName: input.userName,
    userDisplayName: input.displayName,
    userID: userHandle(input.userId),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
  });
  const challengeId = await storeChallenge({
    purpose: 'passkey_register', userId: input.userId, challenge: options.challenge, binding: input.binding, ttlMs: WEBAUTHN_CHALLENGE_TTL_MS,
  });
  return { ok: true as const, options, challengeId };
}

export type PasskeyRegisterResult =
  | { ok: true; passkey: { id: number; name: string }; first: boolean }
  | { ok: false; reason: 'challenge' | 'invalid' | 'duplicate' };

export async function verifyPasskeyRegistration(input: {
  userId: number; challengeId: unknown; response: unknown; binding: string; name?: unknown;
}): Promise<PasskeyRegisterResult> {
  const cfg = readWebAuthnConfig();
  const ch = await consumeChallenge({ id: input.challengeId, purpose: 'passkey_register', binding: input.binding, userId: input.userId });
  if (!ch) return { ok: false, reason: 'challenge' };
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: ch.challenge,
      expectedOrigin: cfg.origins,
      expectedRPID: cfg.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
    });
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!verification.verified || !verification.registrationInfo?.userVerified) return { ok: false, reason: 'invalid' };
  const info = verification.registrationInfo;
  const cred = info.credential;
  const name = sanitizePasskeyName(input.name, info.credentialBackedUp ? 'Clé d’accès synchronisée' : 'Clé d’accès de cet appareil');
  const db = await sql();
  const out = await db.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id = ${input.userId} FOR UPDATE`;
    const rows = await tx<{ id: number }[]>`
      INSERT INTO mfa_passkeys (user_id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, name, created_at)
      VALUES (${input.userId}, ${cred.id}, ${Buffer.from(cred.publicKey).toString('base64url')}, ${cred.counter},
              ${cred.transports ?? []}, ${info.credentialDeviceType}, ${info.credentialBackedUp}, ${info.aaguid}, ${name}, now())
      ON CONFLICT (credential_id) DO NOTHING
      RETURNING id`;
    if (!rows[0]) return null;
    const first = await markMfaEnrolled(input.userId, 'passkey', tx as never);
    return { id: Number(rows[0].id), first };
  });
  if (!out) return { ok: false, reason: 'duplicate' };
  return { ok: true, passkey: { id: out.id, name }, first: out.first };
}

// ── Connexion / réauthentification ─────────────────────────────────────────

export async function passkeyAuthenticationOptions(input: {
  userId: number | null; binding: string; purpose: Extract<ChallengePurpose, 'passkey_login' | 'passkey_stepup'>;
}) {
  const cfg = readWebAuthnConfig();
  // Utilisateur connu (étape après mot de passe / Google / Apple, step-up) :
  // ses clés seulement. Inconnu (connexion sans mot de passe) : clés
  // découvrables, aucune liste — rien n'est révélé sur l'existence d'un compte.
  const allow = input.userId != null
    ? (await listPasskeys(input.userId)).map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] }))
    : undefined;
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID,
    userVerification: 'required',
    timeout: WEBAUTHN_CHALLENGE_TTL_MS,
    ...(allow ? { allowCredentials: allow } : {}),
  });
  const challengeId = await storeChallenge({ purpose: input.purpose, userId: input.userId, challenge: options.challenge, binding: input.binding, ttlMs: WEBAUTHN_CHALLENGE_TTL_MS });
  return { options, challengeId };
}

export type PasskeyAuthResult =
  | { ok: true; userId: number; passkey: PasskeyRow }
  | { ok: false; reason: 'challenge' | 'unknown' | 'invalid' | 'wrong_user' | 'counter'; userId?: number };

export async function verifyPasskeyAuthentication(input: {
  challengeId: unknown; response: unknown; binding: string; purpose: Extract<ChallengePurpose, 'passkey_login' | 'passkey_stepup'>;
  expectedUserId: number | null;
}): Promise<PasskeyAuthResult> {
  const cfg = readWebAuthnConfig();
  const resp = input.response as AuthenticationResponseJSON;
  const ch = await consumeChallenge({ id: input.challengeId, purpose: input.purpose, binding: input.binding, userId: input.expectedUserId });
  if (!ch) return { ok: false, reason: 'challenge' };
  const credId = typeof resp?.id === 'string' ? resp.id : '';
  const pk = credId ? await findPasskeyByCredentialId(credId) : null;
  if (!pk) return { ok: false, reason: 'unknown' };
  if (input.expectedUserId != null && pk.userId !== input.expectedUserId) return { ok: false, reason: 'wrong_user' };
  if (ch.userId != null && ch.userId !== pk.userId) return { ok: false, reason: 'wrong_user' };
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: resp,
      expectedChallenge: ch.challenge,
      expectedOrigin: cfg.origins,
      expectedRPID: cfg.rpID,
      credential: { id: pk.credentialId, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports as AuthenticatorTransportFuture[] },
      requireUserVerification: true,
    });
  } catch (e) {
    const counter = /counter/i.test((e as Error)?.message ?? '');
    return { ok: false, reason: counter ? 'counter' : 'invalid', userId: pk.userId };
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) return { ok: false, reason: 'invalid', userId: pk.userId };
  const db = await sql();
  await db`
    UPDATE mfa_passkeys SET counter = GREATEST(counter, ${verification.authenticationInfo.newCounter}), last_used_at = now(),
           backed_up = ${verification.authenticationInfo.credentialBackedUp}
     WHERE id = ${pk.id}`;
  return { ok: true, userId: pk.userId, passkey: pk };
}
