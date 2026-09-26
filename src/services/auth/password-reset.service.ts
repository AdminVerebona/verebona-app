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
import { and, eq } from 'drizzle-orm';
import { emailService } from '@/lib/email/email-service';

/** Durée de validité d'un lien de réinitialisation. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/** Valeur de repli historique — publique (dans le dépôt), donc sans valeur de secret. */
const INSECURE_DEFAULT_SECRET = 'your-secret-key-change-in-production';

/**
 * Secret de signature des liens de réinitialisation.
 *
 * Même secret que les jetons de session (voir `lib/jwt.ts`) ; une variable
 * dédiée (`PASSWORD_RESET_SECRET`) permet de le séparer sans changement de code.
 *
 * EN PRODUCTION, AUCUN SECRET PAR DÉFAUT : la valeur de repli figure dans le
 * code source ; avec elle, n'importe qui pourrait signer un lien valide pour
 * n'importe quel compte. Une configuration manquante doit échouer bruyamment
 * (erreur explicite, 500 côté route) plutôt que dégrader silencieusement la
 * sécurité. Hors production, le repli reste admis pour le développement.
 */
export function resetSecret(): string {
  const configured = process.env.PASSWORD_RESET_SECRET || process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && (!configured || configured === INSECURE_DEFAULT_SECRET)) {
    throw new Error(
      '[password-reset] Aucun secret configuré : définissez PASSWORD_RESET_SECRET (ou JWT_SECRET) '
      + 'avec une valeur aléatoire. Les liens de réinitialisation ne peuvent pas être signés.',
    );
  }
  return configured || INSECURE_DEFAULT_SECRET;
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

/**
 * Vérifie un jeton reçu par `/api/auth/reset-password`. Renvoie aussi
 * l'empreinte du mot de passe contre laquelle il a été validé : c'est elle
 * qui conditionne l'écriture (voir `consumePasswordResetToken`).
 */
export async function verifyPasswordResetToken(
  token: string,
): Promise<{ ok: true; userId: number; passwordHash: string } | { ok: false; code: 'INVALID_TOKEN' | 'TOKEN_EXPIRED' }> {
  const parsed = parsePasswordResetToken(token);
  if (!parsed) return { ok: false, code: 'INVALID_TOKEN' };
  const [user] = await db
    .select({ id: users.id, email: users.email, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, parsed.userId))
    .limit(1);
  const check = checkPasswordResetToken(token, user ?? null);
  if (!check.ok) return check;
  if (!user) return { ok: false, code: 'INVALID_TOKEN' };
  return { ok: true, userId: check.userId, passwordHash: user.passwordHash };
}

/**
 * Consomme un jeton : remplace le mot de passe SI ET SEULEMENT SI il n'a pas
 * changé depuis la vérification.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * USAGE UNIQUE, Y COMPRIS EN CONCURRENCE
 *
 * L'empreinte du mot de passe dans la signature rend le jeton caduc après
 * usage — mais seulement pour les requêtes qui le vérifient APRÈS l'écriture.
 * Deux requêtes simultanées portant le même lien (double clic, lien
 * intercepté rejoué en parallèle) passaient toutes deux la vérification,
 * puis écrivaient chacune leur mot de passe : le dernier arrivé l'emportait.
 *
 * L'écriture est donc un UPDATE conditionnel sur l'ancienne empreinte, avec
 * RETURNING : PostgreSQL sérialise les deux UPDATE sur la ligne ; le second,
 * réévaluant la condition après le premier, ne trouve plus l'ancienne
 * empreinte et ne modifie rien (0 ligne) → refus INVALID_TOKEN.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function consumePasswordResetToken(
  userId: number,
  expectedPasswordHash: string,
  newPasswordHash: string,
): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.passwordHash, expectedPasswordHash)))
    .returning({ id: users.id });
  return updated.length === 1;
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
