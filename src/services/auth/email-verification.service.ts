/**
 * Vérification de l'adresse e-mail — jeton du lien envoyé à l'inscription.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE JETON ÉTAIT FABRICABLE — ET IL OUVRAIT UNE SESSION
 *
 * Le lien portait `base64(email:horodatage)`. N'importe qui pouvait en
 * fabriquer un pour une adresse de son choix : il suffisait de s'inscrire
 * avec l'adresse d'un tiers, puis de « vérifier » soi-même le compte sans
 * jamais recevoir l'e-mail. Pire, `/api/auth/verify-email` pose les cookies
 * de session à l'issue : le lien fabriqué valait connexion.
 *
 * Même remède que pour la réinitialisation du mot de passe
 * (`password-reset.service.ts`) :
 *
 *   base64url(userId.horodatage.HMAC-SHA256(secret, "email-verification:" userId:email:horodatage))
 *
 *   - la SIGNATURE empêche la fabrication (secret serveur) ;
 *   - le PRÉFIXE de contexte sépare ces jetons de ceux de la réinitialisation,
 *     signés avec le même secret par défaut : un jeton de l'un ne peut jamais
 *     être rejoué comme jeton de l'autre ;
 *   - l'ADRESSE dans le message invalide le lien si l'adresse du compte
 *     change (neutralisation `released+…@invalid.local` à la réinscription) ;
 *   - l'IDENTIFIANT invalide le lien d'un compte non vérifié supprimé puis
 *     recréé avec la même adresse (nouvel identifiant) ;
 *   - DURÉE LIMITÉE : 24 heures, comme annoncé dans l'e-mail ;
 *   - USAGE UNIQUE : l'activation est un UPDATE conditionnel
 *     (`is_active = false` → `true`, RETURNING). Une fois l'adresse vérifiée,
 *     le même lien — rejoué, intercepté, double-cliqué — n'ouvre plus de
 *     session : il ne mène qu'à « adresse déjà vérifiée, connectez-vous ».
 *
 * Conséquence assumée : les liens émis avant ce déploiement ne sont plus
 * acceptés. Ils sont reconnus (`isLegacyVerificationToken`) pour afficher un
 * message dédié et proposer un nouvel envoi, plutôt qu'un « lien invalide »
 * sans explication.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '@/db';
import { users } from '@/db/schema';
import { and, eq } from 'drizzle-orm';

/** Durée de validité d'un lien de vérification (annoncée dans l'e-mail). */
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** Valeur de repli historique — publique (dans le dépôt), donc sans valeur de secret. */
const INSECURE_DEFAULT_SECRET = 'your-secret-key-change-in-production';

/** Contexte signé : sépare ces jetons de ceux de la réinitialisation. */
const PURPOSE = 'email-verification';

/**
 * Secret de signature des liens de vérification.
 *
 * `EMAIL_VERIFICATION_SECRET` s'il est défini, sinon `JWT_SECRET` (même
 * convention que `PASSWORD_RESET_SECRET`).
 *
 * EN PRODUCTION, AUCUN SECRET PAR DÉFAUT : la valeur de repli est dans le
 * code source ; avec elle, n'importe qui signerait un lien valide — donc une
 * session — pour n'importe quel compte non vérifié. Une configuration
 * manquante lève ici, et `instrumentation.ts` appelle cette fonction au
 * démarrage : le serveur refuse de démarrer plutôt que de tourner sans
 * protection. Hors production, le repli reste admis pour le développement.
 */
export function emailVerificationSecret(): string {
  const configured = process.env.EMAIL_VERIFICATION_SECRET || process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production' && (!configured || configured === INSECURE_DEFAULT_SECRET)) {
    throw new Error(
      '[email-verification] Aucun secret configuré : définissez EMAIL_VERIFICATION_SECRET (ou JWT_SECRET) '
      + 'avec une valeur aléatoire. Les liens de vérification d’adresse ne peuvent pas être signés.',
    );
  }
  return configured || INSECURE_DEFAULT_SECRET;
}

export interface VerificationSubject {
  id: number;
  email: string;
}

function sign(subject: VerificationSubject, issuedAtMs: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${PURPOSE}:${subject.id}:${subject.email.trim().toLowerCase()}:${issuedAtMs}`)
    .digest('base64url');
}

/** Jeton signé pour un utilisateur. Pur (hors horloge) : testable sans base. */
export function createEmailVerificationToken(
  subject: VerificationSubject,
  now: number = Date.now(),
  secret: string = emailVerificationSecret(),
): string {
  return Buffer.from(`${subject.id}.${now}.${sign(subject, now, secret)}`, 'utf8').toString('base64url');
}

/** Lecture du jeton sans base : identifiant et horodatage, ou `null`. */
export function parseEmailVerificationToken(
  token: string,
): { userId: number; issuedAtMs: number; signature: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('.');
  if (parts.length !== 3 || !parts[2]) return null;
  const userId = Number(parts[0]);
  const issuedAtMs = Number(parts[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(issuedAtMs)) return null;
  return { userId, issuedAtMs, signature: parts[2] };
}

/**
 * Lien émis AVANT ce correctif : `base64(email:horodatage)`.
 *
 * Reconnu uniquement pour expliquer le refus (« ce lien n'est plus valable,
 * demandez-en un nouveau »). Il n'accorde RIEN : l'adresse qu'il contient
 * sert au plus à pré-remplir le champ de renvoi, dont la réponse ne révèle
 * pas si le compte existe.
 */
export function isLegacyVerificationToken(token: string): { email: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const m = /^([^\s:@]+@[^\s:@]+\.[^\s:@]+):(\d{10,})$/.exec(decoded);
  return m ? { email: m[1].toLowerCase() } : null;
}

export type VerificationTokenCheck =
  | { ok: true; userId: number }
  | { ok: false; code: 'INVALID_TOKEN' | 'TOKEN_EXPIRED' };

/**
 * Vérifie un jeton contre l'utilisateur qu'il désigne. Pur : l'appelant
 * fournit l'utilisateur relu en base (ou `null`).
 */
export function checkEmailVerificationToken(
  token: string,
  subject: VerificationSubject | null,
  now: number = Date.now(),
  secret: string = emailVerificationSecret(),
): VerificationTokenCheck {
  const parsed = parseEmailVerificationToken(token);
  if (!parsed || !subject || subject.id !== parsed.userId) return { ok: false, code: 'INVALID_TOKEN' };

  const expected = Buffer.from(sign(subject, parsed.issuedAtMs, secret));
  const provided = Buffer.from(parsed.signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
  // Un jeton daté dans le futur n'a pas été émis par ce serveur (tolérance
  // d'une minute pour les horloges de plusieurs instances).
  if (parsed.issuedAtMs > now + 60_000) return { ok: false, code: 'INVALID_TOKEN' };
  if (now - parsed.issuedAtMs > EMAIL_VERIFICATION_TTL_MS) return { ok: false, code: 'TOKEN_EXPIRED' };
  return { ok: true, userId: subject.id };
}

/** URL du lien envoyé par e-mail. `plan` : offre choisie avant l'inscription. */
export function buildEmailVerificationUrl(
  baseUrl: string,
  subject: VerificationSubject,
  plan?: string | null,
  now: number = Date.now(),
): string {
  const token = createEmailVerificationToken(subject, now);
  const params = new URLSearchParams({ token });
  if (plan) params.set('plan', plan);
  return `${baseUrl}/api/auth/verify-email?${params.toString()}`;
}

/**
 * Active le compte SI ET SEULEMENT SI il ne l'est pas encore.
 *
 * C'est ce qui rend le lien à usage unique, y compris en concurrence : deux
 * requêtes simultanées portant le même lien passent toutes deux la
 * vérification de signature, mais PostgreSQL sérialise les deux UPDATE sur la
 * ligne ; le second, réévaluant `is_active = false` après le premier, ne
 * modifie rien (0 ligne) et n'obtient donc pas de session.
 */
export async function consumeEmailVerification(userId: number): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.isActive, false)))
    .returning({ id: users.id });
  return updated.length === 1;
}
