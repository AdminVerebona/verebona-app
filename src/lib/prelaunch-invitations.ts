/**
 * Invitations qui permettent de créer un compte, y compris pendant le
 * pré-lancement (voir `src/lib/prelaunch.ts`).
 *
 * Deux jetons existent réellement dans le code :
 *
 *   - `account_memberships.invite_token` : invitation à rejoindre un compte
 *     partagé (AccountService.inviteMember → /signup?inviteToken=…). La
 *     création du compte consomme l'invitation (POST /api/users).
 *   - `duo_accounts.pending_invite_token` : invitation Premium Duo
 *     (POST /api/duo/invitation → /duo/join/[token] → /signup?inviteToken=…).
 *     Le rattachement au Duo reste fait par POST /api/duo/join, une fois
 *     connecté : l'inscription ne consomme pas ce jeton.
 *
 *   - `asset_transmissions.token` : transmission d'un bien à une personne
 *     qui n'a pas encore de compte (/transmission/[token] → /signup?
 *     transmissionToken=…). Sans cela, en pré-lancement, le destinataire
 *     tombait sur « Verebona ouvre bientôt » et ne pouvait JAMAIS recevoir le
 *     bien qu'on lui transmettait. L'inscription crée un compte ordinaire et
 *     ne consomme pas le jeton : l'acceptation reste faite, une fois connecté,
 *     par POST /api/transmission/[token].
 *
 * Une invitation n'est valide que si elle est en attente, non expirée,
 * destinée à cet email lorsqu'elle en désigne un, et — pour un Duo — si
 * l'abonnement du Duo est actif (mêmes règles que GET /api/duo/join).
 */
import { db } from '@/db';
import { accountMemberships, assetTransmissions, duoAccounts } from '@/db/schema';
import { eq } from 'drizzle-orm';

export type InvitationError = 'INVALID_INVITE_TOKEN' | 'INVITE_EMAIL_MISMATCH' | 'INVITE_TOKEN_EXPIRED';

export type SignupInvitation =
  | { valid: true; kind: 'account'; membership: typeof accountMemberships.$inferSelect }
  | { valid: true; kind: 'duo'; duoId: number }
  | { valid: true; kind: 'transmission'; transmissionId: number }
  | { valid: false; code: InvitationError };

const DUO_ACTIVE_STATUSES = ['ACTIVE', 'PAST_DUE_GRACE'];

function sameEmail(expected: string | null | undefined, email: string): boolean {
  if (!expected) return true;
  return expected.trim().toLowerCase() === email.trim().toLowerCase();
}

function isExpired(expiresAt: Date | string | null | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < now.getTime();
}

export async function resolveSignupInvitation(
  rawToken: unknown,
  rawEmail: unknown,
  now: Date = new Date(),
): Promise<SignupInvitation> {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  const email = typeof rawEmail === 'string' ? rawEmail : '';
  if (!token) return { valid: false, code: 'INVALID_INVITE_TOKEN' };

  // 1. Invitation à un compte partagé.
  const [membership] = await db
    .select()
    .from(accountMemberships)
    .where(eq(accountMemberships.inviteToken, token))
    .limit(1);

  if (membership) {
    if (membership.status !== 'pending') return { valid: false, code: 'INVALID_INVITE_TOKEN' };
    if (!sameEmail(membership.invitedEmail, email)) return { valid: false, code: 'INVITE_EMAIL_MISMATCH' };
    if (isExpired(membership.inviteTokenExpiresAt, now)) return { valid: false, code: 'INVITE_TOKEN_EXPIRED' };
    return { valid: true, kind: 'account', membership };
  }

  // 2. Invitation Premium Duo.
  const [duo] = await db
    .select({
      id: duoAccounts.id,
      pendingInviteEmail: duoAccounts.pendingInviteEmail,
      pendingInviteTokenExpiresAt: duoAccounts.pendingInviteTokenExpiresAt,
      subscriptionStatus: duoAccounts.subscriptionStatus,
    })
    .from(duoAccounts)
    .where(eq(duoAccounts.pendingInviteToken, token))
    .limit(1);

  if (duo) {
    if (!DUO_ACTIVE_STATUSES.includes(duo.subscriptionStatus)) return { valid: false, code: 'INVALID_INVITE_TOKEN' };
    if (!sameEmail(duo.pendingInviteEmail, email)) return { valid: false, code: 'INVITE_EMAIL_MISMATCH' };
    if (isExpired(duo.pendingInviteTokenExpiresAt, now)) return { valid: false, code: 'INVITE_TOKEN_EXPIRED' };
    return { valid: true, kind: 'duo', duoId: duo.id };
  }

  // 3. Transmission d'un bien. L'adresse du destinataire est OBLIGATOIRE
  // (colonne non nulle) : le jeton ne vaut invitation que pour elle — un lien
  // transféré à un tiers n'ouvre pas l'inscription. Seule une transmission
  // encore en attente compte : acceptée, refusée ou annulée, elle n'a plus
  // rien à remettre.
  const [transmission] = await db
    .select({
      id: assetTransmissions.id,
      status: assetTransmissions.status,
      recipientEmail: assetTransmissions.recipientEmail,
    })
    .from(assetTransmissions)
    .where(eq(assetTransmissions.token, token))
    .limit(1);

  if (transmission) {
    if (transmission.status !== 'pending') return { valid: false, code: 'INVALID_INVITE_TOKEN' };
    if (!transmission.recipientEmail || !sameEmail(transmission.recipientEmail, email)) {
      return { valid: false, code: 'INVITE_EMAIL_MISMATCH' };
    }
    return { valid: true, kind: 'transmission', transmissionId: transmission.id };
  }

  return { valid: false, code: 'INVALID_INVITE_TOKEN' };
}
