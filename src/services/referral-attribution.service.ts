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
 *     C'est le rôle de `referral-rewards.job.ts` (règle centrale :
 *     `referral/referral-rules.ts`, lot 102D).
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
import { accountMemberships, referralEvents, referralLinks, signupContexts, users } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { reportReferralAttributionFailure } from '@/services/admin/anomaly.service';
import {
  attributionDeadline, isWithinAttributionWindow, signupSelfReferralReason, type SelfReferralReason,
} from '@/services/referral/referral-rules';
import { verifyReferralTouch } from '@/services/referral/referral-touch';

// Lot 102D : la durée d'attribution (90 jours, usage du lien → inscription)
// est un paramètre de la règle centrale (`referral-rules.ts`).

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

interface ResolvedReferral {
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

interface RecordSignupReferralInput {
  userId: number;
  accountId: number | null;
  /** Code brut tel que transmis par le formulaire, avant normalisation. */
  rawCode: unknown;
  /**
   * Lot 102D : jeton `rt` signé par `/r/<code>` (instant d'usage du lien).
   * Absent ou invalide → le code est réputé utilisé à l'inscription.
   */
  referralTouch?: unknown;
  /** Origine de la saisie : lien de parrainage ou champ du formulaire. */
  codeSource?: 'referral_link' | 'signup_form';
  entryPoint?: string;
  now?: Date;
}

/** Membres actifs (titulaire compris) du compte parrain, avec leur adresse. */
async function referrerMembers(referrerAccountId: number): Promise<Array<{ userId: number; email: string | null }>> {
  const rows = await db
    .select({ userId: accountMemberships.userId, email: users.email })
    .from(accountMemberships)
    .innerJoin(users, eq(users.id, accountMemberships.userId))
    .where(and(eq(accountMemberships.accountId, referrerAccountId), eq(accountMemberships.status, 'active')));
  return rows.filter((r) => r.userId !== null).map((r) => ({ userId: r.userId as number, email: r.email ?? null }));
}

/**
 * Mémorise l'attribution au moment de la création du compte (§4.5).
 *
 * Lot 102D — règle centrale (`referral-rules.ts`) :
 *   · fenêtre : inscription au plus 90 jours après l'usage du lien (`rt`) ;
 *   · auto-parrainage refusé : même compte, filleul membre du compte parrain,
 *     même adresse e-mail normalisée qu'un membre du compte parrain ;
 *   · l'ÉVÉNEMENT de parrainage (`referral_events`, statut `link_used`) est
 *     créé ICI, à l'inscription : le paiement ne crée plus d'attribution.
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
    const touchedAt = verifyReferralTouch(code, input.referralTouch);
    const codeUsedAt = touchedAt && touchedAt.getTime() <= now.getTime() ? touchedAt : now;
    let resolved = await resolveReferralCode(code, input.accountId);
    let rejection: string | null = resolved ? null : 'CODE_NOT_FOUND_OR_INACTIVE';

    if (resolved && !isWithinAttributionWindow(codeUsedAt, now)) {
      resolved = null;
      rejection = 'ATTRIBUTION_WINDOW_EXPIRED';
    }
    if (resolved) {
      const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1);
      const self: SelfReferralReason | null = signupSelfReferralReason({
        referrerAccountId: resolved.referrerAccountId,
        referredAccountId: input.accountId,
        referredUserId: input.userId,
        referredEmail: me?.email ?? null,
        referrerMembers: await referrerMembers(resolved.referrerAccountId),
      });
      if (self) {
        resolved = null;
        rejection = self;
      }
    }

    const [ctx] = await db
      .insert(signupContexts)
      .values({
        userId: input.userId,
        accountId: input.accountId,
        entryPoint: input.entryPoint ?? 'direct_signup',
        rawCode: code,
        codeSource: input.codeSource ?? (touchedAt ? 'referral_link' : 'signup_form'),
        resolvedCodeType: resolved ? 'referral_link' : null,
        resolvedCodeId: resolved ? resolved.linkId : null,
        validationStatus: resolved ? 'valid' : 'rejected',
        validationMessage: rejection,
        createdAt: now,
        codeUsedAt,
        // Date limite d'inscription pour ce lien (usage + 90 jours).
        expiresAt: attributionDeadline(codeUsedAt),
      })
      .onConflictDoNothing()
      .returning({ id: signupContexts.id });

    if (resolved && input.accountId !== null) {
      await db
        .insert(referralEvents)
        .values({
          referralLinkId: resolved.linkId,
          referrerAccountId: resolved.referrerAccountId,
          referredAccountId: input.accountId,
          referredUserId: input.userId,
          status: 'link_used',
          rewardCredits: 0,
          signupContextId: ctx?.id ?? null,
          capturedAt: now,
          metadataJson: { attribution: 'signup', codeUsedAt: codeUsedAt.toISOString() },
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    return resolved;
  } catch (e) {
    console.error(
      `[referral] enregistrement de l'attribution impossible pour l'utilisateur ${input.userId} :`,
      (e as Error).message,
    );
    await reportReferralAttributionFailure({ userId: input.userId, accountId: input.accountId ?? null, code }, e);
    return null;
  }
}

/**
 * Relit l'attribution mémorisée à l'inscription.
 *
 * Lot 102D : depuis ce lot, l'événement de parrainage est créé à
 * l'inscription. Cette relecture ne sert plus qu'aux comptes inscrits AVANT
 * (contexte valide sans événement) : le paiement crée alors l'événement à
 * partir de l'attribution d'origine. Jamais à partir d'un code saisi au
 * paiement. Aucune date limite de souscription (règle centrale : la fenêtre
 * de 90 jours porte sur « usage du lien → inscription »).
 *
 * NE LÈVE JAMAIS : un incident de lecture ne doit pas empêcher un paiement.
 */
export async function getStoredReferralCode(userId: number): Promise<string | null> {
  try {
    const [row] = await db
      .select({ rawCode: signupContexts.rawCode })
      .from(signupContexts)
      .where(and(eq(signupContexts.userId, userId), eq(signupContexts.validationStatus, 'valid')))
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
