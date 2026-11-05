/**
 * Codes de récupération (lot 110B, ticket §5) — 10 codes à usage unique,
 * ≈ 79 bits d'aléa chacun (16 caractères parmi 31 sans ambiguïté), affichés UNE
 * fois. Seule une EMPREINTE (SHA-256 étiquetée par utilisateur) est stockée ;
 * consommation atomique (`UPDATE … WHERE used_at IS NULL RETURNING`).
 * Régénération : tous les anciens codes sont supprimés dans la même
 * transaction. Jamais journalisés, exportés ni réaffichés.
 */
import { createHash, randomBytes } from 'node:crypto';
import { RECOVERY_CODE_COUNT, RECOVERY_CODE_LENGTH } from './constants';
import { sql } from './db';

// 31 symboles sans ambiguïté de lecture (ni 0/O, ni 1/I/L) ; tirage par rejet
// (octet < 248 = 31 × 8) : distribution uniforme, ≈ 79 bits par code de 16.
const SYMBOLS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  let out = '';
  while (out.length < RECOVERY_CODE_LENGTH) {
    for (const b of randomBytes(32)) {
      if (b < 248) out += SYMBOLS[b % 31];
      if (out.length === RECOVERY_CODE_LENGTH) break;
    }
  }
  return out;
}

/** Présentation : groupes de 4 (`ABCD-EFGH-JKMN-PQRS`). */
export function formatRecoveryCode(raw: string): string {
  return raw.match(/.{1,4}/g)!.join('-');
}

/** Normalisation de la saisie (espaces, tirets, casse). */
export function normalizeRecoveryCode(input: string): string {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function recoveryCodeHash(userId: number, code: string): string {
  return createHash('sha256').update(`verebona/mfa-recovery/v1:${userId}:${normalizeRecoveryCode(code)}`).digest('hex');
}

/** Génère et enregistre 10 nouveaux codes (les anciens sont invalidés). Rend les codes en clair (affichage unique). */
export async function regenerateRecoveryCodes(userId: number): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, randomCode);
  const db = await sql();
  await db.begin(async (tx) => {
    await tx`DELETE FROM mfa_recovery_codes WHERE user_id = ${userId}`;
    for (const c of codes) {
      await tx`INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (${userId}, ${recoveryCodeHash(userId, c)}, now())`;
    }
    await tx`UPDATE user_mfa_state SET recovery_confirmed_at = NULL, updated_at = now() WHERE user_id = ${userId}`;
  });
  return codes.map(formatRecoveryCode);
}

/** Consomme un code (usage unique, atomique). Vrai si CET appel l'a consommé. */
export async function consumeRecoveryCode(userId: number, input: string): Promise<boolean> {
  const n = normalizeRecoveryCode(input);
  if (n.length !== RECOVERY_CODE_LENGTH) return false;
  const db = await sql();
  const rows = await db`
    UPDATE mfa_recovery_codes SET used_at = now()
     WHERE user_id = ${userId} AND code_hash = ${recoveryCodeHash(userId, n)} AND used_at IS NULL
    RETURNING id`;
  return rows.length > 0;
}

export async function remainingRecoveryCodes(userId: number): Promise<number> {
  const db = await sql();
  const [r] = await db<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM mfa_recovery_codes WHERE user_id = ${userId} AND used_at IS NULL`;
  return r?.n ?? 0;
}
