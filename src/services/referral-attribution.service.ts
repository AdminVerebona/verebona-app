/**
 * Attribution du parrainage — CDC parrainage §4.5 à §4.7.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX MOMENTS À NE PAS CONFONDRE
 *
 *   • ATTRIBUTION — « quel parrain est rattaché à ce filleul ? »
 *     Enregistrée à la création effective du compte (§4.5, premier cas cité).
 *     C'est ce que fait ce service.
 *
 *   • AVANTAGE — « un mois offert au parrain ». Le filleul ne reçoit rien.
 *     Acquis lorsque le filleul souscrit un abonnement ANNUEL, et attribué
 *     après expiration du délai de rétractation (CDC tarification §13).
 *     C'est le rôle de `referral-reward.service.ts`, inchangé.
 *
 * Séparer les deux est ce qui rend le programme opérationnel : l'inscription
 * et la souscription sont séparées par une vérification d'adresse email et
 * jusqu'à sept jours d'essai. Sans mémorisation côté serveur au moment de
 * l'inscription, aucun code ne survit à cet intervalle — le §4.6 prévoit la
 * perte de l'attribution tant que le code n'a pas atteint le serveur, pas
 * après.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { db } from '@/db';
import { referralLinks, signupContexts } from '@/db/schema';
import { and, eq, isNull, or, gt } from 'drizzle-orm';

/**
 * Durée de validité de l'attribution mémorisée.
 *
 * ⚠️ PARAMÈTRE NON FIXÉ PAR LES CDC. La colonne `expires_at` est `NOT NULL`
 * (migration 0071) et sa valeur par défaut de 7 jours correspondait à un autre
 * usage. Elle est portée ici à 90 jours : un filleul qui laisse passer son
 * essai de 7 jours puis souscrit quelques semaines plus tard doit conserver
 * son parrain. À confirmer avec le responsable métier.
 */
export const REFERRAL_ATTRIBUTION_DAYS = 90;

/** Longueur maximale acceptée pour un code, alignée sur `/api/referral/validate`. */
const MAX_CODE_LENGTH = 20;

/**
 * Normalise un code reçu du navigateur.
 *
 * Pure et sans accès base : c'est la partie testable de la chaîne.
 * Retourne `null` si le code ne peut pas être un code de parrainage — sans
 * dire s'il existe, ce que seul le serveur décide (§4.7).
 */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cleaned.length === 0 || cleaned.length > MAX_CODE_LENGTH) return null;
  return cleaned;
}

export interface ResolvedReferral {
  linkId: number;
  referrerAccountId: number;
}

/**
 * Un lien de parrainage peut-il être attribué à ce compte ?
 *
 * Pure et testable. Sépare la décision de la lecture base, pour que les règles
 * du §4.7 soient vérifiables sans PostgreSQL.
 */
export function canAttribute(
  link: { id: number; accountId: number; isActive: boolean } | undefined | null,
  referredAccountId: number | null,
): ResolvedReferral | null {
  if (!link) return null;
  if (!link.isActive) return null;
  // Auto-parrainage : le compte parrainé ne peut pas être celui du parrain.
  if (referredAccountId !== null && link.accountId === referredAccountId) return null;
  return { linkId: link.id, referrerAccountId: link.accountId };
}

/** Recherche un lien de parrainage par son code, puis applique les contrôles. */
export async function resolveReferralCode(
  code: string,
  referredAccountId: number | null,
): Promise<ResolvedReferral | null> {
  const [link] = await db
    .select({
      id: referralLinks.id,
      accountId: referralLinks.accountId,
      isActive: referralLinks.isActive,
    })
    .from(referralLinks)
    .where(eq(referralLinks.code, code))
    .limit(1);

  return canAttribute(link, referredAccountId);
}

export interface RecordSignupReferralInput {
  userId: number;
  accountId: number | null;
  /** Code brut tel que transmis par le formulaire, avant normalisation. */
  rawCode: unknown;
  /** Origine de la saisie : lien de parrainage ou champ du formulaire. */
  codeSource?: 'referral_link' | 'signup_form';
  entryPoint?: string;
  now?: Date;
}

/**
 * Mémorise l'attribution au moment de la création du compte (§4.5).
 *
 * NE LÈVE JAMAIS. Un parrainage est un avantage commercial : son échec ne doit
 * en aucun cas empêcher la création d'un compte. Un code invalide est
 * enregistré avec son motif de rejet plutôt qu'ignoré — c'est ce qui permet de
 * distinguer, plus tard, « personne n'a parrainé cet inscrit » de « le code
 * saisi était erroné ».
 *
 * @returns l'attribution retenue, ou `null`.
 */
export async function recordSignupReferral(
  input: RecordSignupReferralInput,
): Promise<ResolvedReferral | null> {
  const now = input.now ?? new Date();
  const code = normalizeReferralCode(input.rawCode);

  // Aucun code saisi : rien à enregistrer. Le cas nominal.
  if (!code) return null;

  try {
    const resolved = await resolveReferralCode(code, input.accountId);

    await db
      .insert(signupContexts)
      .values({
        userId: input.userId,
        accountId: input.accountId,
        entryPoint: input.entryPoint ?? 'direct_signup',
        rawCode: code,
        codeSource: input.codeSource ?? 'referral_link',
        resolvedCodeType: resolved ? 'referral_link' : null,
        resolvedCodeId: resolved ? resolved.linkId : null,
        validationStatus: resolved ? 'valid' : 'rejected',
        validationMessage: resolved ? null : 'CODE_NOT_FOUND_OR_INACTIVE',
        createdAt: now,
        expiresAt: new Date(now.getTime() + REFERRAL_ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000),
      })
      .onConflictDoNothing();

    return resolved;
  } catch (e) {
    console.error(
      `[referral] enregistrement de l'attribution impossible pour l'utilisateur ${input.userId} :`,
      (e as Error).message,
    );
    return null;
  }
}

/**
 * Relit l'attribution mémorisée à l'inscription.
 *
 * Appelée au checkout lorsque la requête ne porte pas de code : c'est le cas
 * normal, puisque le filleul souscrit plusieurs jours après s'être inscrit.
 *
 * NE LÈVE JAMAIS : un incident de lecture ne doit pas empêcher un paiement.
 */
export async function getStoredReferralCode(userId: number): Promise<string | null> {
  try {
    const [row] = await db
      .select({ rawCode: signupContexts.rawCode })
      .from(signupContexts)
      .where(
        and(
          eq(signupContexts.userId, userId),
          eq(signupContexts.validationStatus, 'valid'),
          // Une attribution expirée n'est plus utilisée.
          or(isNull(signupContexts.expiresAt), gt(signupContexts.expiresAt, new Date())),
        ),
      )
      .limit(1);

    return row?.rawCode ?? null;
  } catch (e) {
    console.error(
      `[referral] relecture de l'attribution impossible pour l'utilisateur ${userId} :`,
      (e as Error).message,
    );
    return null;
  }
}
