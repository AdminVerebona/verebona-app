/**
 * Parcours « Mot de passe oublié » — service partagé.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL PARCOURS, DEUX DÉCLENCHEURS
 *
 * CDC Back-Office V1 USR-A07 : la réinitialisation déclenchée par
 * l'administrateur doit suivre « strictement le même parcours sécurisé » que
 * celle demandée par l'utilisateur ; le BO ne définit jamais un mot de passe.
 * La logique de `/api/auth/forgot-password` est donc extraite ici et appelée
 * par les deux routes : même jeton, même e-mail (`PASSWORD_RESET`), même page
 * `/reset-password`, même révocation des sessions à l'aboutissement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE JETON ÉTAIT FORGEABLE
 *
 * Le jeton valait `base64(email:horodatage)` : n'importe qui pouvait en
 * fabriquer un pour n'importe quelle adresse et changer le mot de passe du
 * compte, sans jamais recevoir l'e-mail. Il est désormais SIGNÉ :
 *
 *   base64url(userId.horodatage.HMAC-SHA256(secret, userId:email:horodatage:hash))
 *
 *   - la signature empêche la fabrication ;
 *   - l'empreinte du mot de passe courant (`password_hash`) dans le message
 *     rend le jeton À USAGE UNIQUE : dès que le mot de passe change, tous les
 *     jetons émis avant deviennent invalides ;
 *   - validité inchangée : une heure.
 *
 * Conséquence assumée : les liens émis avant ce déploiement (au plus une
 * heure) ne sont plus acceptés — l'utilisateur en redemande un.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';

/** Durée de validité d'un lien de réinitialisation. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

function resetSecret(): string {
  // Même secret que les jetons de session (voir `lib/jwt.ts`) ; une variable
  // dédiée permet de le séparer sans changement de code.
  return process.env.PASSWORD_RESET_SECRET || process.env.JWT_SECRET || 'your-secret-key-change-in-production';
}

interface ResetSubject {
  id: number;
  email: string;
  passwordHash: string;
}

function sign(subject: ResetSubject, issuedAtMs: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${subject.id}:${subject.email.toLowerCase()}:${issuedAtMs}:${subject.passwordHash}`)
    .digest('base64url');
}

/** Jeton signé pour un utilisateur. Pur (hors horloge) : testable sans base. */
export function createPasswordResetToken(
  subject: ResetSubject,
  now: number = Date.now(),
  secret: string = resetSecret(),
): string {
  return Buffer.from(`${subject.id}.${now}.${sign(subject, now, secret)}`, 'utf8').toString('base64url');
}

export type ResetTokenCheck =
  | { ok: true; userId: number }
  | { ok: false; code: 'INVALID_TOKEN' | 'TOKEN_EXPIRED' };

/** Lecture du jeton sans base : identifiant et horodatage, ou refus. */
export function parsePasswordResetToken(
  token: string,
): { userId: number; issuedAtMs: number; signature: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('.');
  if (parts.length !== 3) return null;
  const userId = Number(parts[0]);
  const issuedAtMs = Number(parts[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(issuedAtMs)) return null;
  return { userId, issuedAtMs, signature: parts[2] };
}

/**
 * Vérifie un jeton contre l'utilisateur qu'il désigne. Pur : l'appelant
 * fournit l'utilisateur relu en base.
 */
export function checkPasswordResetToken(
  token: string,
  subject: ResetSubject | null,
  now: number = Date.now(),
  secret: string = resetSecret(),
): ResetTokenCheck {
  const parsed = parsePasswordResetToken(token);
  if (!parsed || !subject || subject.id !== parsed.userId) return { ok: false, code: 'INVALID_TOKEN' };

  const expected = Buffer.from(sign(subject, parsed.issuedAtMs, secret));
  const provided = Buffer.from(parsed.signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
  if (parsed.issuedAtMs > now + 60_000) return { ok: false, code: 'INVALID_TOKEN' };
  if (now - parsed.issuedAtMs > PASSWORD_RESET_TTL_MS) return { ok: false, code: 'TOKEN_EXPIRED' };
  return { ok: true, userId: subject.id };
}

/** Vérifie un jeton reçu par `/api/auth/reset-password`. */
export async function verifyPasswordResetToken(token: string): Promise<ResetTokenCheck> {
  const parsed = parsePasswordResetToken(token);
  if (!parsed) return { ok: false, code: 'INVALID_TOKEN' };
  const [user] = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, parsed.userId))
    .limit(1);
  return checkPasswordResetToken(token, user ?? null);
}

export type StartResetResult =
  | { status: 'sent'; userId: number }
  | { status: 'unknown_email' }
  | { status: 'send_failed'; userId: number; error?: string };

async function sendResetEmail(user: ResetSubject & { firstName: string }): Promise<StartResetResult> {
  const token = createPasswordResetToken(user);
  const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;

  const result = await emailService.send({
    templateCode: 'PASSWORD_RESET',
    to: user.email,
    variables: {
      firstName: user.firstName,
      resetUrl,
      expiresAt: '1 heure',
    },
    userId: user.id,
  });

  if (!result.success) {
    console.error('[password-reset] envoi de l\'e-mail impossible :', result.error);
    return { status: 'send_failed', userId: user.id, error: result.error };
  }
  return { status: 'sent', userId: user.id };
}

const RESET_SUBJECT_COLUMNS = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  passwordHash: users.passwordHash,
};

/**
 * Démarre le parcours à partir d'une adresse (demande de l'utilisateur).
 * L'appelant ne doit pas révéler `unknown_email` au client.
 */
export async function startPasswordReset(email: string): Promise<StartResetResult> {
  const [user] = await db
    .select(RESET_SUBJECT_COLUMNS)
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user) return { status: 'unknown_email' };
  return sendResetEmail(user);
}

/**
 * Démarre le parcours pour un utilisateur désigné (action administrateur,
 * USR-A07). Aucun mot de passe n'est défini : l'utilisateur reçoit le même
 * lien que s'il l'avait demandé.
 */
export async function startPasswordResetForUser(userId: number): Promise<StartResetResult> {
  const [user] = await db.select(RESET_SUBJECT_COLUMNS).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return { status: 'unknown_email' };
  return sendResetEmail(user);
}
