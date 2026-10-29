/**
 * Identités externes Google / Apple — lot 93, CDC 18 §5, §8, §12.1, §12.3,
 * §31.2.
 *
 *   · clé de rattachement : (provider, issuer, subject), JAMAIS l'adresse
 *     (une égalité d'e-mail ne lie rien : §8.1, LOGIN-04) ;
 *   · une identité n'appartient qu'à un utilisateur : un rattachement qui la
 *     vise ailleurs est REFUSÉ sans rien déplacer (§8.3, SIGN-09) ;
 *   · un Google et un Apple au plus par utilisateur (§27.1) ;
 *   · dissociation refusée si elle retirait la DERNIÈRE méthode de connexion
 *     utilisable (§12.3, LAST_LOGIN_METHOD) — contrôle et suppression dans la
 *     même transaction, ligne utilisateur verrouillée (deux onglets ne peuvent
 *     pas retirer chacun « l'autre » méthode).
 */
import { pgClient } from '@/db';
import type { OAuthProvider } from './config';
import type { TxClaims } from './transactions';

export interface LinkedIdentity {
  id: number;
  userId: number;
  provider: OAuthProvider;
  issuer: string;
  emailAtLinkTime: string | null;
  lastProviderEmail: string | null;
  isPrivateRelay: boolean;
  linkedAt: Date;
  lastUsedAt: Date | null;
}

type Row = {
  id: string | number; user_id: number; provider: OAuthProvider; issuer: string; email_at_link_time: string | null;
  last_provider_email: string | null; is_private_relay: boolean; linked_at: Date | string; last_used_at: Date | string | null;
};
const toIdentity = (r: Row): LinkedIdentity => ({
  id: Number(r.id), userId: r.user_id, provider: r.provider, issuer: r.issuer, emailAtLinkTime: r.email_at_link_time,
  lastProviderEmail: r.last_provider_email, isPrivateRelay: r.is_private_relay, linkedAt: new Date(r.linked_at),
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
});

type Sql = typeof pgClient;

export async function findIdentityBySubject(
  provider: OAuthProvider, issuer: string, subject: string, sql: Sql = pgClient,
): Promise<LinkedIdentity | null> {
  const rows = await sql<Row[]>`
    SELECT id, user_id, provider, issuer, email_at_link_time, last_provider_email, is_private_relay, linked_at, last_used_at
      FROM auth_identities WHERE provider = ${provider} AND issuer = ${issuer} AND subject = ${subject}`;
  return rows[0] ? toIdentity(rows[0]) : null;
}

export async function listIdentities(userId: number, sql: Sql = pgClient): Promise<LinkedIdentity[]> {
  const rows = await sql<Row[]>`
    SELECT id, user_id, provider, issuer, email_at_link_time, last_provider_email, is_private_relay, linked_at, last_used_at
      FROM auth_identities WHERE user_id = ${userId} ORDER BY provider`;
  return rows.map(toIdentity);
}

/** Connexion réussie par ce fournisseur : date d'usage et dernière adresse observée (informative). */
export async function touchIdentity(id: number, claims: TxClaims, now = new Date()): Promise<void> {
  await pgClient`
    UPDATE auth_identities SET last_used_at = ${now.toISOString()}, last_provider_email = ${claims.email},
           is_private_relay = ${claims.isPrivateRelay},
           refresh_token_ciphertext = COALESCE(${claims.refreshTokenCiphertext ?? null}, refresh_token_ciphertext),
           updated_at = ${now.toISOString()}
     WHERE id = ${id}`;
}

export type LinkOutcome =
  | { ok: true; identityId: number; alreadyLinked: boolean }
  | { ok: false; code: 'OAUTH_IDENTITY_ALREADY_LINKED' | 'PROVIDER_ALREADY_LINKED' };

/**
 * Lie une identité à un utilisateur (création sociale, rattachement après
 * authentification complète, liaison depuis Mon compte). Jamais de
 * déplacement : identité liée ailleurs → refus ; même identité déjà liée à
 * CET utilisateur → succès idempotent.
 */
export async function linkIdentity(userId: number, claims: TxClaims, sql: Sql = pgClient, now = new Date()): Promise<LinkOutcome> {
  const existing = await findIdentityBySubject(claims.provider, claims.issuer, claims.subject, sql);
  if (existing) {
    if (existing.userId !== userId) return { ok: false, code: 'OAUTH_IDENTITY_ALREADY_LINKED' };
    return { ok: true, identityId: existing.id, alreadyLinked: true };
  }
  const rows = await sql<{ id: string }[]>`
    INSERT INTO auth_identities
      (user_id, provider, issuer, subject, email_at_link_time, email_verified, last_provider_email, is_private_relay,
       refresh_token_ciphertext, linked_at, last_used_at, created_at, updated_at)
    VALUES (${userId}, ${claims.provider}, ${claims.issuer}, ${claims.subject}, ${claims.email}, ${claims.emailVerified},
            ${claims.email}, ${claims.isPrivateRelay}, ${claims.refreshTokenCiphertext ?? null}, ${now.toISOString()}, ${now.toISOString()}, ${now.toISOString()}, ${now.toISOString()})
    ON CONFLICT DO NOTHING
    RETURNING id`;
  if (rows[0]) return { ok: true, identityId: Number(rows[0].id), alreadyLinked: false };
  // Conflit concurrent : l'une des deux contraintes uniques a joué.
  const again = await findIdentityBySubject(claims.provider, claims.issuer, claims.subject, sql);
  if (again) return again.userId === userId ? { ok: true, identityId: again.id, alreadyLinked: true } : { ok: false, code: 'OAUTH_IDENTITY_ALREADY_LINKED' };
  return { ok: false, code: 'PROVIDER_ALREADY_LINKED' };
}

// ── Méthodes de connexion utilisables ───────────────────────────────────────

export interface LoginMethods {
  password: boolean;
  providers: OAuthProvider[];
}

/** Nombre de méthodes UTILISABLES (règle pure, testée). */
export function usableMethodCount(m: LoginMethods): number {
  return (m.password ? 1 : 0) + new Set(m.providers).size;
}

/** Dissocier `provider` laisserait-il au moins une méthode ? (§12.3) */
export function canUnlink(m: LoginMethods, provider: OAuthProvider): boolean {
  if (!m.providers.includes(provider)) return false;
  return usableMethodCount({ password: m.password, providers: m.providers.filter((p) => p !== provider) }) >= 1;
}

export async function loadLoginMethods(userId: number, sql: Sql = pgClient): Promise<LoginMethods & { email: string } | null> {
  const [u] = await sql<{ email: string; has_password: boolean }[]>`
    SELECT email, (password_hash IS NOT NULL AND password_hash LIKE '$2%') AS has_password FROM users WHERE id = ${userId}`;
  if (!u) return null;
  const ids = await listIdentities(userId, sql);
  return { email: u.email, password: !!u.has_password, providers: ids.map((i) => i.provider) };
}

export type UnlinkOutcome =
  | { ok: true; refreshTokenCiphertext: string | null }
  | { ok: false; code: 'NOT_LINKED' | 'LAST_LOGIN_METHOD' };

/** Dissociation atomique avec garde « dernière méthode » (ligne utilisateur verrouillée). */
export async function unlinkIdentity(userId: number, provider: OAuthProvider): Promise<UnlinkOutcome> {
  return pgClient.begin(async (tx) => {
    await tx`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const methods = await loadLoginMethods(userId, tx as unknown as Sql);
    if (!methods || !methods.providers.includes(provider)) return { ok: false as const, code: 'NOT_LINKED' as const };
    if (!canUnlink(methods, provider)) return { ok: false as const, code: 'LAST_LOGIN_METHOD' as const };
    const rows = await tx<{ refresh_token_ciphertext: string | null }[]>`
      DELETE FROM auth_identities WHERE user_id = ${userId} AND provider = ${provider} RETURNING refresh_token_ciphertext`;
    return { ok: true as const, refreshTokenCiphertext: rows[0]?.refresh_token_ciphertext ?? null };
  }) as Promise<UnlinkOutcome>;
}

/** Jetons Apple chiffrés d'un utilisateur (révocation à la clôture du compte). */
export async function appleRefreshTokensOf(userId: number): Promise<string[]> {
  const rows = await pgClient<{ c: string }[]>`
    SELECT refresh_token_ciphertext AS c FROM auth_identities
     WHERE user_id = ${userId} AND provider = 'apple' AND refresh_token_ciphertext IS NOT NULL`;
  return rows.map((r) => r.c);
}

export async function clearAppleRefreshTokens(userId: number): Promise<void> {
  await pgClient`UPDATE auth_identities SET refresh_token_ciphertext = NULL, updated_at = now() WHERE user_id = ${userId} AND provider = 'apple'`;
}
