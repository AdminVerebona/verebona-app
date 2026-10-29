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
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 96A — INSCRIPTION REMPLACÉE PAR UN TIERS (CDC 18 Q9, P1)
 *
 * Faille REPRODUITE sur le lot 93 : la victime s'inscrit ; un tiers
 * s'inscrit ensuite avec la MÊME adresse et son propre mot de passe (réponse
 * neutre, l'inscription en attente est remplacée) ; le lien d'activation de
 * l'inscription du tiers arrive dans la boîte de la victime, qui clique :
 * le compte du tiers est activé, une session ouverte, et le tiers s'y
 * connecte ensuite avec son mot de passe.
 *
 * Correctif :
 *   · le lien est attaché à UNE inscription : la signature couvre en plus
 *     l'EMPREINTE d'inscription `users.signup_nonce` (migration 0828), tirée
 *     au hasard à chaque nouvelle inscription. Inscriptions antérieures
 *     (empreinte NULL) : signature inchangée, donc liens déjà envoyés
 *     reconnus — mais soumis à la règle suivante ;
 *   · le lien N'ACTIVE PLUS RIEN seul : il mène à une page qui demande le
 *     mot de passe choisi à l'inscription (`POST /api/auth/verify-email`) ;
 *     sans lui, rien n'est activé. La victime ne connaît pas le mot de passe
 *     du tiers : le compte du tiers reste inactif, et elle reprend son
 *     inscription (une réinscription avec un autre mot de passe remplace
 *     l'inscription en attente) ;
 *   · tentatives limitées (`AUTH_LIMITS.activationUser` / `activationIp`) et
 *     journalisées (ACCOUNT_ACTIVATION_FAILED / _THROTTLED / ACCOUNT_ACTIVATED) ;
 *   · comptes Google / Apple (« social-only ») : créés actifs, jamais concernés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from '@/db';
import { users } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

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

interface VerificationSubject {
  id: number;
  email: string;
  /**
   * Lot 96A : empreinte de l'inscription (`users.signup_nonce`). Absente ou
   * NULL : inscription antérieure au lot 96A — signature historique.
   */
  signupNonce?: string | null;
}

/** Lot 96A : nouvelle empreinte d'inscription (128 bits aléatoires). */
export function newSignupNonce(): string {
  return randomBytes(16).toString('base64url');
}

function sign(subject: VerificationSubject, issuedAtMs: number, secret: string): string {
  const nonce = subject.signupNonce ? `:${subject.signupNonce}` : '';
  return createHmac('sha256', secret)
    .update(`${PURPOSE}:${subject.id}:${subject.email.trim().toLowerCase()}:${issuedAtMs}${nonce}`)
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

type VerificationTokenCheck =
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
 * Active le compte SI ET SEULEMENT SI il ne l'est pas encore ET que
 * l'inscription est toujours celle du lien (empreinte inchangée, lot 96A).
 *
 * C'est ce qui rend le lien à usage unique, y compris en concurrence : deux
 * requêtes simultanées portant le même lien passent toutes deux la
 * vérification de signature, mais PostgreSQL sérialise les deux UPDATE sur la
 * ligne ; le second, réévaluant `is_active = false` après le premier, ne
 * modifie rien (0 ligne) et n'obtient donc pas de session. Une réinscription
 * concurrente (nouvelle empreinte, autre mot de passe) fait de même échouer
 * l'activation. L'empreinte est CONSERVÉE : un lien déjà utilisé reste
 * reconnu (« adresse déjà vérifiée ») au lieu de paraître fabriqué.
 *
 * L'appelant a VÉRIFIÉ le mot de passe de l'inscription (lot 96A) : cette
 * fonction ne doit jamais être appelée sur la seule foi du lien.
 */
export async function consumeEmailVerification(userId: number, signupNonce: string | null = null): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ isActive: true, updatedAt: new Date() })
    .where(and(
      eq(users.id, userId),
      eq(users.isActive, false),
      signupNonce ? eq(users.signupNonce, signupNonce) : isNull(users.signupNonce),
    ))
    .returning({ id: users.id });
  return updated.length === 1;
}
