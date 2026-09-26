/**
 * Droits et quotas effectifs d'un compte (CDC §8).
 *
 * Source de verite unique, calculee cote serveur a partir de l'etat reel de
 * l'abonnement. Le frontend peut afficher ces valeurs, il ne les decide jamais.
 *
 * Matrice (CDC §8.1) :
 *
 *   Etat                        Biens  Documents  Premium  Utilisateurs
 *   Essai actif                    2       30       oui         1
 *   Standard actif                 2       30       non         1
 *   Premium actif                 10      150       oui         1
 *   Premium Duo actif             15      225       oui         2
 *   Essai expire (readonly)     bloque   bloque     non         1
 *
 * Mode restreint (`readonly`) : creation et modification bloquees, mais
 * consultation et export preserves — l'utilisateur doit pouvoir recuperer
 * ses donnees (engagement produit + portabilite RGPD).
 */
import { db } from '@/db';
import { accountSubscriptions, accounts, users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { TRIAL_LIMITS, hasUsedTrial } from './trial.service';
import { unpaidRestrictionMessage } from './billing/unpaid-cycle.rules';

export type EntitlementPlan = 'trial' | 'standard' | 'premium' | 'premium_duo' | 'none';

export interface Quotas {
  maxAssets: number;
  maxDocuments: number;
  maxUsers: number;
}

export interface Entitlements {
  /** Offre effective utilisee pour les droits. */
  plan: EntitlementPlan;
  /** Statut brut de l'abonnement (trialing | active | readonly | past_due | canceled).
   *  `past_due` : impayé, compte restreint (GAP-06). */
  status: string;
  quotas: Quotas;
  /** Fonctions Premium (questions a Verebona, sync agenda, dossiers prets). */
  premiumFeatures: boolean;
  /** Creation / modification de donnees metier autorisee. */
  canWrite: boolean;
  /** Consultation et export autorises. */
  canRead: boolean;
  /** Mode restreint : lecture + export uniquement. */
  isRestricted: boolean;
}

/** Quotas par offre (CDC §2). */
const PLAN_QUOTAS: Record<Exclude<EntitlementPlan, 'none'>, Quotas> = {
  trial: { ...TRIAL_LIMITS },
  standard: { maxAssets: 2, maxDocuments: 30, maxUsers: 1 },
  premium: { maxAssets: 10, maxDocuments: 150, maxUsers: 1 },
  premium_duo: { maxAssets: 15, maxDocuments: 225, maxUsers: 2 },
};

const NO_QUOTAS: Quotas = { maxAssets: 0, maxDocuments: 0, maxUsers: 1 };

/** Motifs de blocage, exploitables par l'UI pour afficher le bon message. */
export type DenialReason =
  | 'ASSET_QUOTA_REACHED'
  | 'ASSET_QUOTA_EXCEEDED'
  | 'DOCUMENT_QUOTA_REACHED'
  | 'USER_QUOTA_REACHED'
  | 'PREMIUM_REQUIRED'
  | 'TRIAL_EXPIRED'
  | 'SUBSCRIPTION_REQUIRED';

export interface Decision {
  allowed: boolean;
  reason?: DenialReason;
  /** Message pret a afficher (CDC §8.3). */
  message?: string;
  /** Quota concerne, pour l'affichage « x sur y ». */
  limit?: number;
}

/** Libelle lisible d'une offre, pour les messages utilisateur. */
function planLabel(plan: EntitlementPlan): string {
  switch (plan) {
    case 'trial': return 'votre essai gratuit';
    case 'standard': return 'votre offre Standard';
    case 'premium': return 'votre offre Premium';
    case 'premium_duo': return 'votre offre Premium Duo';
    default: return 'votre compte';
  }
}

/**
 * Calcule les droits effectifs d'un compte.
 * Toujours appeler cette fonction avant une action sensible.
 */
export async function getEntitlements(
  accountId: number,
  now: Date = new Date(),
): Promise<Entitlements> {
  const rows = await db
    .select({
      planCode: accountSubscriptions.planCode,
      status: accountSubscriptions.status,
      trialEndsAt: accountSubscriptions.trialEndsAt,
      firstBilledAt: accountSubscriptions.firstBilledAt,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);

  const row = rows[0];

  // Aucun abonnement : compte sans droits (ni essai, ni offre).
  if (!row) {
    return {
      plan: 'none', status: 'none', quotas: NO_QUOTAS,
      premiumFeatures: false, canWrite: false, canRead: true, isRestricted: true,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ L'EXPIRATION DE L'ESSAI EST DEDUITE DE LA DATE, PAS DU STATUT STOCKE
  //
  // Le passage `trialing` → `readonly` est realise par `expireOverdueTrials()`,
  // appele uniquement par `GET /api/cron/expire-trials`. Ce point d'entree
  // n'est declenche par AUCUNE planification declaree dans le depot : le
  // statut reste donc `trialing` indefiniment.
  //
  // Consequence observee : le bandeau d'essai annonce « termine » — il se
  // calcule sur `trialEndsAt`, comme `getTrialState()` — pendant que les
  // droits continuent d'autoriser l'ecriture. Un compte dont l'essai est
  // fini pouvait ajouter biens et documents sans le moindre refus.
  //
  // Les droits se calculent desormais sur la meme source que l'affichage :
  // la date. Le cron reste utile — il persiste le statut et declenche la
  // notification de fin d'essai — mais l'application n'en depend plus pour
  // etre juste.
  // ══════════════════════════════════════════════════════════════════════════
  const essaiEchu =
    row.status === 'trialing' &&
    !row.firstBilledAt &&
    row.trialEndsAt !== null &&
    row.trialEndsAt.getTime() <= now.getTime();

  const status = essaiEchu ? 'readonly' : row.status;

  // Mode restreint : essai expire sans souscription, abonnement suspendu, ou
  // impayé. Cycle d'impayé de 90 jours (Centre d'aide GAP-06, AID-BILL-008) :
  // « dès l'échec de paiement, les fonctions normales et payantes sont
  // suspendues, mais le compte reste accessible » — lecture, export et
  // transmission (routes non gardées par `canWrite`) restent ouvertes.
  // Auparavant `past_due` laissait tout écrire pendant 15 jours de grâce.
  if (status === 'readonly' || status === 'canceled' || status === 'past_due') {
    return {
      plan: 'none', status, quotas: NO_QUOTAS,
      premiumFeatures: false, canWrite: false, canRead: true, isRestricted: true,
    };
  }

  // Essai actif : fonctions Premium, mais quotas d'essai.
  if (status === 'trialing') {
    return {
      plan: 'trial', status, quotas: PLAN_QUOTAS.trial,
      premiumFeatures: true, canWrite: true, canRead: true, isRestricted: false,
    };
  }

  // Abonnement actif.
  const plan = (['standard', 'premium', 'premium_duo'] as const).find((p) => p === row.planCode)
    ?? 'standard';

  return {
    plan,
    status,
    quotas: PLAN_QUOTAS[plan],
    premiumFeatures: plan !== 'standard',
    canWrite: true,
    canRead: true,
    isRestricted: false,
  };
}

/**
 * Le compte n'a aucun abonnement parce que l'adresse de son titulaire a déjà
 * consommé l'essai (compte recréé, §3.4) ?
 *
 * Pour l'utilisateur, c'est une fin d'essai : il doit choisir son offre.
 * Le présenter comme « abonnement nécessaire » (vocabulaire d'une offre
 * résiliée) le mène vers « Passer à Premium » au lieu du choix d'une offre.
 */
export async function isTrialAlreadyUsedForAccount(accountId: number): Promise<boolean> {
  const [owner] = await db
    .select({ email: users.email })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.ownerUserId))
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!owner?.email) return false;
  return hasUsedTrial(owner.email).catch(() => false);
}

export const TRIAL_ALREADY_USED_MESSAGE =
  "L'essai gratuit a déjà été utilisé avec cette adresse. Vos données sont conservées : " +
  "choisissez votre offre pour ajouter et modifier vos biens et documents.";

export const WITHDRAWN_MESSAGE =
  "Vous avez exercé votre droit de rétractation : vos biens et documents restent consultables et exportables, " +
  "mais ne peuvent plus être modifiés.";

async function isWithdrawnAccount(accountId: number): Promise<boolean> {
  const [row] = await db
    .select({ s: accounts.subscriptionStatus })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row?.s === 'WITHDRAWN';
}

const TRIAL_EXPIRED_TEXT =
  "Votre essai gratuit est terminé. Vos données sont conservées : choisissez une offre pour reprendre l'ajout et la modification.";

/**
 * Motif de refus d'un compte restreint, commun à toutes les gardes.
 *   - essai échu (`readonly`)                    → TRIAL_EXPIRED ;
 *   - aucun abonnement, essai déjà consommé      → TRIAL_EXPIRED (compte recréé) ;
 *   - sinon (résilié, attribution échouée…)      → SUBSCRIPTION_REQUIRED.
 */
export async function restrictedRefusal(
  accountId: number,
  status: string,
): Promise<{ code: 'TRIAL_EXPIRED' | 'SUBSCRIPTION_REQUIRED'; message: string }> {
  // Cycle d'impayé en cours (GAP-06) : le message dit pourquoi, ce qui reste
  // possible et la date limite de régularisation.
  if (status === 'past_due' || status === 'canceled') {
    const [row] = await db
      .select({ startedAt: accounts.pastDueGraceStartedAt, endsAt: accounts.pastDueGraceEndsAt })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (row?.startedAt || status === 'past_due') {
      return { code: 'SUBSCRIPTION_REQUIRED', message: unpaidRestrictionMessage(row?.endsAt ?? null) };
    }
  }
  if (status === 'readonly') {
    // `readonly` sert aussi à la récupération après rétractation : ce n'est
    // pas une fin d'essai, et le dire enverrait vers le mauvais écran.
    if (await isWithdrawnAccount(accountId)) {
      return { code: 'SUBSCRIPTION_REQUIRED', message: WITHDRAWN_MESSAGE };
    }
    return { code: 'TRIAL_EXPIRED', message: TRIAL_EXPIRED_TEXT };
  }
  if (status === 'none' && (await isTrialAlreadyUsedForAccount(accountId))) {
    return { code: 'TRIAL_EXPIRED', message: TRIAL_ALREADY_USED_MESSAGE };
  }
  return { code: 'SUBSCRIPTION_REQUIRED', message: 'Un abonnement actif est nécessaire pour effectuer cette action.' };
}

/** Decision commune aux comptes restreints. */
async function restrictedDecision(accountId: number, status: string): Promise<Decision> {
  const r = await restrictedRefusal(accountId, status);
  return { allowed: false, reason: r.code, message: r.message };
}

/** Peut-on creer un bien supplementaire ? */
export async function canCreateAsset(accountId: number, currentCount: number): Promise<Decision> {
  const ent = await getEntitlements(accountId);
  if (!ent.canWrite) return restrictedDecision(accountId, ent.status);

  if (currentCount >= ent.quotas.maxAssets) {
    return {
      allowed: false,
      reason: 'ASSET_QUOTA_REACHED',
      limit: ent.quotas.maxAssets,
      message: `Vous avez atteint la limite de ${ent.quotas.maxAssets} biens de ${planLabel(ent.plan)}.`,
    };
  }
  return { allowed: true };
}

/**
 * Le compte peut-il MODIFIER ses biens ?
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEPASSER SON QUOTA N'EFFACE RIEN
 *
 * Un compte peut se retrouver au-dessus de sa limite sans avoir rien fait de
 * mal : quota revu a la baisse, ou changement d'offre vers une offre plus
 * petite. La regle retenue conserve tout — les biens restent consultables et
 * exportables — mais suspend l'ecriture tant que le compte est au-dessus.
 *
 * Aucun bien n'est designe « en trop », aucun n'est archive d'office : c'est
 * a l'utilisateur de choisir, en supprimant un bien ou en reprenant une offre
 * suffisante.
 *
 * Noter le `>` et non `>=` : etre PILE a la limite est parfaitement normal et
 * n'empeche que la creation (cf. `canCreateAsset`).
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function canModifyAssets(accountId: number, currentCount: number): Promise<Decision> {
  const ent = await getEntitlements(accountId);
  if (!ent.canWrite) return restrictedDecision(accountId, ent.status);

  if (currentCount > ent.quotas.maxAssets) {
    return {
      allowed: false,
      reason: 'ASSET_QUOTA_EXCEEDED',
      limit: ent.quotas.maxAssets,
      message:
        `Votre compte contient ${currentCount} biens alors que ${planLabel(ent.plan)} en autorise ` +
        `${ent.quotas.maxAssets}. Vos biens restent consultables et exportables. Pour les modifier à ` +
        `nouveau, supprimez-en ou choisissez une offre supérieure.`,
    };
  }
  return { allowed: true };
}

/** Peut-on ajouter un document supplementaire ? */
export async function canAddDocument(accountId: number, currentCount: number): Promise<Decision> {
  const ent = await getEntitlements(accountId);
  if (!ent.canWrite) return restrictedDecision(accountId, ent.status);

  if (currentCount >= ent.quotas.maxDocuments) {
    return {
      allowed: false,
      reason: 'DOCUMENT_QUOTA_REACHED',
      limit: ent.quotas.maxDocuments,
      message: `Vous avez atteint la limite de ${ent.quotas.maxDocuments} documents de ${planLabel(ent.plan)}.`,
    };
  }
  return { allowed: true };
}

/** Peut-on inviter un utilisateur supplementaire ? (Duo uniquement) */
export async function canInviteUser(accountId: number, currentCount: number): Promise<Decision> {
  const ent = await getEntitlements(accountId);
  if (!ent.canWrite) return restrictedDecision(accountId, ent.status);

  if (currentCount >= ent.quotas.maxUsers) {
    return {
      allowed: false,
      reason: 'USER_QUOTA_REACHED',
      limit: ent.quotas.maxUsers,
      message:
        ent.quotas.maxUsers === 1
          ? "L'ajout d'un second utilisateur est disponible avec l'offre Premium Duo."
          : `Vous avez atteint la limite de ${ent.quotas.maxUsers} utilisateurs de ${planLabel(ent.plan)}.`,
    };
  }
  return { allowed: true };
}

/** Peut-on utiliser une fonctionnalite Premium ? */
export async function canUsePremiumFeature(accountId: number): Promise<Decision> {
  const ent = await getEntitlements(accountId);
  if (!ent.canWrite) return restrictedDecision(accountId, ent.status);

  if (!ent.premiumFeatures) {
    return {
      allowed: false,
      reason: 'PREMIUM_REQUIRED',
      message: 'Cette fonctionnalité est disponible avec Premium et Premium Duo.',
    };
  }
  return { allowed: true };
}

/**
 * Etat d'usage d'un quota, pour l'affichage « 1 bien sur 2 »
 * et l'alerte a partir de 80 % (CDC §9.4).
 */
export function quotaUsage(used: number, limit: number) {
  const ratio = limit > 0 ? Math.round((used / limit) * 100) : 100;
  return {
    used,
    limit,
    ratio,
    label: `${used} sur ${limit}`,
    shouldWarn: ratio >= 80,
    isFull: used >= limit,
  };
}
