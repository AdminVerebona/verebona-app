/**
 * Retrait / renommage des facteurs (lot 110B, ticket §4, §6) — opérations
 * ATOMIQUES : verrou de la ligne utilisateur, puis recomptage des méthodes
 * fortes DANS la transaction. Deux suppressions concurrentes ne peuvent pas
 * retirer ensemble les deux dernières méthodes.
 */
import { sql, countStrongMethods } from './db';
import { PASSKEY_NAME_MAX } from './constants';

export type RemoveOutcome = 'removed' | 'not_found' | 'last_method';

export async function removeTotpFactor(userId: number): Promise<RemoveOutcome> {
  const db = await sql();
  return db.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const [has] = await tx`SELECT id FROM mfa_totp_factors WHERE user_id = ${userId} AND status = 'ACTIVE' LIMIT 1`;
    if (!has) return 'not_found' as const;
    if ((await countStrongMethods(userId, tx as never)) <= 1) return 'last_method' as const;
    await tx`DELETE FROM mfa_totp_factors WHERE user_id = ${userId}`;
    return 'removed' as const;
  });
}

export async function removePasskey(userId: number, passkeyId: number): Promise<RemoveOutcome> {
  const db = await sql();
  return db.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    // Isolation : seule une clé de CET utilisateur (un identifiant d'un autre compte = introuvable).
    const [has] = await tx`SELECT id FROM mfa_passkeys WHERE id = ${passkeyId} AND user_id = ${userId}`;
    if (!has) return 'not_found' as const;
    if ((await countStrongMethods(userId, tx as never)) <= 1) return 'last_method' as const;
    await tx`DELETE FROM mfa_passkeys WHERE id = ${passkeyId} AND user_id = ${userId}`;
    return 'removed' as const;
  });
}

export function sanitizePasskeyName(input: unknown, fallback = 'Clé d’accès'): string {
  const s = String(input ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, PASSKEY_NAME_MAX);
  return s || fallback;
}

export async function renamePasskey(userId: number, passkeyId: number, name: unknown): Promise<boolean> {
  const db = await sql();
  const rows = await db`UPDATE mfa_passkeys SET name = ${sanitizePasskeyName(name)} WHERE id = ${passkeyId} AND user_id = ${userId} RETURNING id`;
  return rows.length > 0;
}
