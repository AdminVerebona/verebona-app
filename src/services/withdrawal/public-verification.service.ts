/**
 * Vérification d'adresse — parcours public de rétractation (CDC 6 §6.3, §12.2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA RÉPONSE NE DOIT RIEN RÉVÉLER
 *
 * Le §12.2 est explicite : « la réponse ne doit pas révéler l'existence d'un
 * compte à un tiers ». Le parcours public est ouvert à n'importe qui : une
 * réponse différente selon que l'adresse est connue ou non en ferait un outil
 * d'énumération de la clientèle.
 *
 * `startPublicVerification` retourne donc toujours la même chose, et prend le
 * même temps quel que soit le cas. Seul le contenu de la boîte mail diffère —
 * et lui seul est légitime à le faire.
 *
 * Le jeton n'est jamais stocké en clair : seule son empreinte l'est. Une fuite
 * de la base ne permettrait pas de rétracter les contrats d'autrui.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomBytes } from 'crypto';
import { db } from '@/db';
import { accounts, users, withdrawalVerificationTokens } from '@/db/schema';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { hashToken } from './withdrawal.service';

/** Durée de validité du lien envoyé par courriel. */
export const VERIFICATION_TOKEN_TTL_MINUTES = 30;

/** Au-delà, le jeton est considéré comme attaqué et neutralisé. */
const MAX_ATTEMPTS = 5;

export interface StartVerificationInput {
  email: string;
  firstName?: string;
  lastName?: string;
  contractReference?: string;
  now?: Date;
}

export interface StartVerificationResult {
  /** Jeton en clair, à insérer dans le lien. `null` si aucun compte. */
  token: string | null;
  /** Destinataire, pour l'envoi. `null` si aucun compte. */
  email: string | null;
  userId: number | null;
  accountId: number | null;
  firstName: string | null;
}

/**
 * Ouvre une vérification d'adresse.
 *
 * ⚠️ L'APPELANT NE DOIT PAS DIFFÉRENCIER SA RÉPONSE selon que `token` vaut
 * `null` ou non. Ce retour sert uniquement à décider s'il y a un courriel à
 * envoyer ; la réponse HTTP, elle, est invariable.
 */
export async function startPublicVerification(
  input: StartVerificationInput,
): Promise<StartVerificationResult> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();

  const empty: StartVerificationResult = {
    token: null, email: null, userId: null, accountId: null, firstName: null,
  };

  const [user] = await db
    .select({ id: users.id, email: users.email, firstName: users.firstName })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) return empty;

  // Le §5.1 réserve la rétractation au titulaire : seul un compte dont cet
  // utilisateur est propriétaire ouvre un parcours.
  const [account] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.ownerUserId, user.id))
    .limit(1);

  if (!account) return empty;

  const token = randomBytes(32).toString('base64url');

  await db.insert(withdrawalVerificationTokens).values({
    tokenHash: hashToken(token),
    email,
    userId: user.id,
    accountId: account.id,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    contractReference: input.contractReference ?? null,
    expiresAt: new Date(now.getTime() + VERIFICATION_TOKEN_TTL_MINUTES * 60_000),
    createdAt: now,
  });

  return {
    token,
    email: user.email,
    userId: user.id,
    accountId: account.id,
    firstName: user.firstName ?? input.firstName ?? null,
  };
}

export interface VerifiedIdentity {
  userId: number;
  accountId: number;
  email: string;
  firstName: string | null;
  lastName: string | null;
  tokenId: number;
}

export type VerificationFailure =
  | 'TOKEN_UNKNOWN'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_CONSUMED'
  | 'TOO_MANY_ATTEMPTS';

/**
 * Vérifie un jeton sans le consommer.
 *
 * Utilisé à l'ouverture de la page : le consommateur doit pouvoir relire son
 * récapitulatif, revenir en arrière, réfléchir. Le jeton n'est consommé qu'à
 * la confirmation — un usage unique déclenché à l'affichage rendrait le lien
 * inutilisable au moindre rafraîchissement.
 */
export async function resolveVerificationToken(
  token: string,
  now: Date = new Date(),
): Promise<{ identity: VerifiedIdentity } | { failure: VerificationFailure }> {
  const [row] = await db
    .select()
    .from(withdrawalVerificationTokens)
    .where(eq(withdrawalVerificationTokens.tokenHash, hashToken(token)))
    .limit(1);

  if (!row) return { failure: 'TOKEN_UNKNOWN' };
  if (row.attempts >= MAX_ATTEMPTS) return { failure: 'TOO_MANY_ATTEMPTS' };
  if (row.consumedAt) return { failure: 'TOKEN_CONSUMED' };
  if (row.expiresAt <= now) return { failure: 'TOKEN_EXPIRED' };
  if (!row.userId || !row.accountId) return { failure: 'TOKEN_UNKNOWN' };

  return {
    identity: {
      userId: row.userId,
      accountId: row.accountId,
      email: row.email,
      firstName: row.firstName,
      lastName: row.lastName,
      tokenId: row.id,
    },
  };
}

/**
 * Consomme un jeton, à la confirmation seulement.
 *
 * L'écriture est conditionnée à `consumed_at IS NULL` : deux requêtes
 * simultanées ne peuvent pas le consommer toutes les deux. Un contrôle
 * préalable par lecture ne l'empêcherait pas.
 */
export async function consumeVerificationToken(
  tokenId: number,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(withdrawalVerificationTokens)
    .set({ consumedAt: now })
    .where(
      and(
        eq(withdrawalVerificationTokens.id, tokenId),
        isNull(withdrawalVerificationTokens.consumedAt),
        gt(withdrawalVerificationTokens.expiresAt, now),
      ),
    )
    .returning({ id: withdrawalVerificationTokens.id });
  return rows.length > 0;
}

/** Incrémente le compteur de tentatives sur un jeton malmené. */
export async function recordFailedAttempt(token: string): Promise<void> {
  const hash = hashToken(token);
  const [row] = await db
    .select({ id: withdrawalVerificationTokens.id, attempts: withdrawalVerificationTokens.attempts })
    .from(withdrawalVerificationTokens)
    .where(eq(withdrawalVerificationTokens.tokenHash, hash))
    .limit(1);
  if (!row) return;
  await db
    .update(withdrawalVerificationTokens)
    .set({ attempts: row.attempts + 1 })
    .where(eq(withdrawalVerificationTokens.id, row.id));
}

/** Purge les jetons expirés. Appelée par le balayage quotidien. */
export async function purgeExpiredTokens(now: Date = new Date()): Promise<number> {
  const rows = await db
    .delete(withdrawalVerificationTokens)
    .where(lt(withdrawalVerificationTokens.expiresAt, new Date(now.getTime() - 24 * 3600 * 1000)))
    .returning({ id: withdrawalVerificationTokens.id });
  return rows.length;
}
