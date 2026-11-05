/**
 * Accès base des facteurs MFA (lot 110B) — SQL brut (`pgClient`), tables des
 * migrations 1165-1167. Aucune valeur secrète n'est jamais renvoyée par ces
 * fonctions hors de `loadActiveTotpSealed` (chiffré, lu par `totp.ts` seul).
 */
export const sql = async () => (await import('@/db')).pgClient;

export interface PasskeyRow {
  id: number; userId: number; credentialId: string; publicKey: string; counter: number;
  transports: string[]; deviceType: string | null; backedUp: boolean; name: string;
  createdAt: Date; lastUsedAt: Date | null;
}

interface PasskeyDbRow {
  id: number; user_id: number; credential_id: string; public_key: string; counter: string | number;
  transports: string[] | null; device_type: string | null; backed_up: boolean; name: string;
  created_at: Date; last_used_at: Date | null;
}

export const passkeyFromRow = (r: PasskeyDbRow): PasskeyRow => ({
  id: Number(r.id), userId: Number(r.user_id), credentialId: r.credential_id, publicKey: r.public_key,
  counter: Number(r.counter), transports: r.transports ?? [], deviceType: r.device_type, backedUp: !!r.backed_up,
  name: r.name, createdAt: new Date(r.created_at), lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
});

export async function listPasskeys(userId: number): Promise<PasskeyRow[]> {
  const db = await sql();
  const rows = await db<PasskeyDbRow[]>`SELECT * FROM mfa_passkeys WHERE user_id = ${userId} ORDER BY created_at`;
  return rows.map(passkeyFromRow);
}

export async function findPasskeyByCredentialId(credentialId: string): Promise<PasskeyRow | null> {
  const db = await sql();
  const rows = await db<PasskeyDbRow[]>`SELECT * FROM mfa_passkeys WHERE credential_id = ${credentialId} LIMIT 1`;
  return rows[0] ? passkeyFromRow(rows[0]) : null;
}

export interface FactorSummary {
  enabledAt: Date | null;
  recoveryConfirmedAt: Date | null;
  lastMethod: string | null;
  passkeys: PasskeyRow[];
  totp: { active: boolean; confirmedAt: Date | null };
  recoveryRemaining: number;
  recoveryTotal: number;
}

export async function loadFactorSummary(userId: number): Promise<FactorSummary> {
  const db = await sql();
  const [state] = await db<{ enabled_at: Date | null; recovery_confirmed_at: Date | null; last_method: string | null }[]>`
    SELECT enabled_at, recovery_confirmed_at, last_method FROM user_mfa_state WHERE user_id = ${userId}`;
  const [totp] = await db<{ confirmed_at: Date | null }[]>`
    SELECT confirmed_at FROM mfa_totp_factors WHERE user_id = ${userId} AND status = 'ACTIVE' LIMIT 1`;
  const [rc] = await db<{ remaining: number; total: number }[]>`
    SELECT COUNT(*) FILTER (WHERE used_at IS NULL)::int AS remaining, COUNT(*)::int AS total
      FROM mfa_recovery_codes WHERE user_id = ${userId}`;
  return {
    enabledAt: state?.enabled_at ? new Date(state.enabled_at) : null,
    recoveryConfirmedAt: state?.recovery_confirmed_at ? new Date(state.recovery_confirmed_at) : null,
    lastMethod: state?.last_method ?? null,
    passkeys: await listPasskeys(userId),
    totp: { active: !!totp, confirmedAt: totp?.confirmed_at ? new Date(totp.confirmed_at) : null },
    recoveryRemaining: rc?.remaining ?? 0,
    recoveryTotal: rc?.total ?? 0,
  };
}

/** Nombre de méthodes FORTES (clés d'accès + application d'authentification active). */
export async function countStrongMethods(userId: number, tx?: Awaited<ReturnType<typeof sql>>): Promise<number> {
  const db = tx ?? await sql();
  const [r] = await db<{ n: number }[]>`
    SELECT ((SELECT COUNT(*) FROM mfa_passkeys WHERE user_id = ${userId})
          + (SELECT COUNT(*) FROM mfa_totp_factors WHERE user_id = ${userId} AND status = 'ACTIVE'))::int AS n`;
  return r?.n ?? 0;
}

/**
 * Premier facteur (ou suivant) : l'obligation devient PERMANENTE pour ce
 * compte (`enabled_at`, jamais remis à NULL). Rend vrai si c'est le premier.
 */
export async function markMfaEnrolled(userId: number, method: string, tx?: Awaited<ReturnType<typeof sql>>): Promise<boolean> {
  const db = tx ?? await sql();
  const rows = await db<{ first: boolean }[]>`
    INSERT INTO user_mfa_state (user_id, enabled_at, last_method, updated_at)
    VALUES (${userId}, now(), ${method}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      enabled_at = COALESCE(user_mfa_state.enabled_at, EXCLUDED.enabled_at),
      last_method = EXCLUDED.last_method,
      updated_at = now()
    RETURNING (xmax = 0) AS first`;
  return !!rows[0]?.first;
}

export async function recordLastMethod(userId: number, method: string): Promise<void> {
  const db = await sql();
  await db`UPDATE user_mfa_state SET last_method = ${method}, updated_at = now() WHERE user_id = ${userId}`;
}

export async function markRecoveryConfirmed(userId: number): Promise<void> {
  const db = await sql();
  await db`UPDATE user_mfa_state SET recovery_confirmed_at = now(), updated_at = now() WHERE user_id = ${userId}`;
}
