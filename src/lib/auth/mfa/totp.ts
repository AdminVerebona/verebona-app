/**
 * Application d'authentification — TOTP RFC 6238 (lot 110B, ticket §2, §5).
 *
 *   · secret aléatoire de 160 bits, UNIQUE par utilisateur, chiffré au repos
 *     (`secret-box.ts`, AES-256-GCM, clé hors base) ;
 *   · SHA-1 / 6 chiffres / 30 s (interopérable : Google Authenticator,
 *     Microsoft Authenticator, 1Password, Bitwarden, Apple Mots de passe…) ;
 *   · fenêtre d'horloge ±1 intervalle ; ANTI-REJEU : un intervalle déjà
 *     utilisé (ou antérieur) est refusé — mise à jour atomique de
 *     `last_used_step` ;
 *   · un secret n'est ACTIF qu'après la vérification d'un premier code
 *     (ligne PENDING → ACTIVE) ; une seule application active par compte
 *     (index unique partiel) ; remplacement = nouvel enrôlement confirmé, qui
 *     retire l'ancien dans la même transaction ;
 *   · le secret en clair n'est rendu qu'UNE fois, à l'enrôlement, à
 *     l'utilisateur lui-même (QR + clé copiable) — jamais journalisé.
 */
import { Secret, TOTP } from 'otpauth';
import { renderSVG } from 'uqr';
import { sealSecret, openSecret } from './secret-box';
import { sql } from './db';
import { markMfaEnrolled } from './db';
import { TOTP_DIGITS, TOTP_ISSUER, TOTP_PENDING_TTL_MS, TOTP_PERIOD_S, TOTP_SECRET_BYTES, TOTP_WINDOW } from './constants';

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: TOTP_ISSUER, label, algorithm: 'SHA1', digits: TOTP_DIGITS, period: TOTP_PERIOD_S,
    secret: Secret.fromBase32(secretBase32),
  });
}

/** Saisie normalisée : 6 chiffres exactement, sinon `null`. */
export function normalizeTotpCode(input: unknown): string | null {
  const s = String(input ?? '').replace(/\s+/g, '');
  return new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(s) ? s : null;
}

/**
 * Intervalle (compteur RFC 6238) auquel le code correspond, ou `null`.
 * Pur : exposé pour les tests (vecteurs RFC 6238).
 */
export function matchTotpStep(secretBase32: string, code: string, nowMs = Date.now()): number | null {
  const t = totpFor(secretBase32, 'x');
  const delta = t.validate({ token: code, timestamp: nowMs, window: TOTP_WINDOW });
  if (delta === null) return null;
  return t.counter({ timestamp: nowMs }) + delta;
}

/** Code courant (tests seulement — jamais exposé par une route). */
export function __totpCodeForTests(secretBase32: string, nowMs = Date.now()): string {
  return totpFor(secretBase32, 'x').generate({ timestamp: nowMs });
}

export interface TotpEnrollmentStart {
  /** URI otpauth:// (contient le secret : affichée une seule fois). */
  otpauthUri: string;
  secret: string;
  qrSvg: string;
  expiresAt: Date;
}

/** Démarre un enrôlement : un seul secret EN ATTENTE par compte (le précédent est retiré). */
export async function startTotpEnrollment(userId: number, accountLabel: string): Promise<TotpEnrollmentStart> {
  const secret = new Secret({ size: TOTP_SECRET_BYTES }).base32;
  const { sealed, keyId } = sealSecret(secret, userId);
  const expiresAt = new Date(Date.now() + TOTP_PENDING_TTL_MS);
  const db = await sql();
  await db.begin(async (tx) => {
    await tx`DELETE FROM mfa_totp_factors WHERE user_id = ${userId} AND status = 'PENDING'`;
    await tx`
      INSERT INTO mfa_totp_factors (user_id, status, secret_ciphertext, key_id, created_at, pending_expires_at)
      VALUES (${userId}, 'PENDING', ${sealed}, ${keyId}, now(), ${expiresAt.toISOString()})`;
  });
  const uri = totpFor(secret, accountLabel.slice(0, 80)).toString();
  return { otpauthUri: uri, secret, qrSvg: renderSVG(uri, { border: 2 }), expiresAt };
}

export type TotpConfirmResult = { ok: true; replaced: boolean; first: boolean } | { ok: false; reason: 'no_pending' | 'invalid' | 'key_unavailable' };

/** Confirme l'enrôlement par un premier code RÉELLEMENT vérifié ; active atomiquement. */
export async function confirmTotpEnrollment(userId: number, input: unknown, nowMs = Date.now()): Promise<TotpConfirmResult> {
  const code = normalizeTotpCode(input);
  if (!code) return { ok: false, reason: 'invalid' };
  const db = await sql();
  const [p] = await db<{ id: number; secret_ciphertext: string }[]>`
    SELECT id, secret_ciphertext FROM mfa_totp_factors
     WHERE user_id = ${userId} AND status = 'PENDING' AND pending_expires_at > ${new Date(nowMs).toISOString()}
     ORDER BY id DESC LIMIT 1`;
  if (!p) return { ok: false, reason: 'no_pending' };
  const opened = openSecret(p.secret_ciphertext, userId);
  if (!opened) return { ok: false, reason: 'key_unavailable' };
  const step = matchTotpStep(opened.plain, code, nowMs);
  if (step === null) return { ok: false, reason: 'invalid' };
  let replaced = false;
  let first = false;
  const done = await db.begin(async (tx) => {
    // Verrou du compte : enrôlements / suppressions concurrents sérialisés.
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const del = await tx`DELETE FROM mfa_totp_factors WHERE user_id = ${userId} AND status = 'ACTIVE' RETURNING id`;
    replaced = del.length > 0;
    const up = await tx`
      UPDATE mfa_totp_factors SET status = 'ACTIVE', confirmed_at = now(), last_used_step = ${step}, last_used_at = now(), pending_expires_at = NULL
       WHERE id = ${p.id} AND status = 'PENDING' RETURNING id`;
    if (up.length === 0) return false;
    first = await markMfaEnrolled(userId, 'totp', tx as never);
    return true;
  });
  if (!done) return { ok: false, reason: 'no_pending' };
  return { ok: true, replaced, first };
}

export type TotpVerifyResult = 'ok' | 'invalid' | 'replayed' | 'no_factor' | 'key_unavailable';

/** Vérifie un code de l'application ACTIVE ; consomme l'intervalle (anti-rejeu). */
export async function verifyTotp(userId: number, input: unknown, nowMs = Date.now()): Promise<TotpVerifyResult> {
  const code = normalizeTotpCode(input);
  const db = await sql();
  const [f] = await db<{ id: number; secret_ciphertext: string; last_used_step: string | number | null }[]>`
    SELECT id, secret_ciphertext, last_used_step FROM mfa_totp_factors WHERE user_id = ${userId} AND status = 'ACTIVE' LIMIT 1`;
  if (!f) return 'no_factor';
  if (!code) return 'invalid';
  let opened;
  try { opened = openSecret(f.secret_ciphertext, userId); } catch { return 'key_unavailable'; }
  if (!opened) return 'key_unavailable';
  const step = matchTotpStep(opened.plain, code, nowMs);
  if (step === null) return 'invalid';
  const rows = await db`
    UPDATE mfa_totp_factors SET last_used_step = ${step}, last_used_at = now()
     WHERE id = ${f.id} AND status = 'ACTIVE' AND (last_used_step IS NULL OR last_used_step < ${step})
    RETURNING id`;
  if (rows.length === 0) return 'replayed';
  if (opened.stale) {
    // Rotation de clé : rechiffrement avec la clé active (au mieux).
    try {
      const { sealed, keyId } = sealSecret(opened.plain, userId);
      await db`UPDATE mfa_totp_factors SET secret_ciphertext = ${sealed}, key_id = ${keyId} WHERE id = ${f.id}`;
    } catch { /* clé active indisponible : l'ancienne reste lisible */ }
  }
  return 'ok';
}

export async function hasActiveTotp(userId: number): Promise<boolean> {
  const db = await sql();
  const rows = await db`SELECT 1 FROM mfa_totp_factors WHERE user_id = ${userId} AND status = 'ACTIVE' LIMIT 1`;
  return rows.length > 0;
}
