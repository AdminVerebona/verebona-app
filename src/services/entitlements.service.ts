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
import { accountSubscriptions } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { TRIAL_LIMITS } from './trial.service';

export type EntitlementPlan = 'trial' | 'standard' | 'premium' | 'premium_duo' | 'none';

export interface Quotas {
  maxAssets: number;
  maxDocuments: number;
  maxUsers: number;
}

export interface Entitlements {
  /** Offre effective utilisee pour les droits. */
  plan: EntitlementPlan;
  /** Statut brut de l'abonnement (trialing | active | readonly | past_due | canceled). */
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

  // Mode restreint : essai expire sans souscription, ou abonnement suspendu.
  if (status === 'readonly' || status === 'canceled') {
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

  // Abonnement actif (ou en impaye : on laisse ecrire pendant la periode de grace).
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

/** Decision commune aux comptes restreints. */
function restrictedDecision(status: string): Decision {
  if (status === 'readonly') {
    return {
      allowed: false,
      reason: 'TRIAL_EXPIRED',
      message:
        "Votre essai gratuit est termine. Vos donnees sont conservees : choisissez une offre pour reprendre l'ajout et la modification.",
    };
  }
  return {
    allowed: false,
    reason: 'SUBSCRIPTION_REQUIRED',
    message: 'Un abonnement actif est necessaire pour effectuer cette action.',
  };
}

/** Peut-on creer un bien supplementaire ? */
export async function canCreateAsset(accountId: number, currentCount: number): Promise<Decision> {
  const ent = await getEntitlements(accountId);
  if (!ent.canWrite) return restrictedDecision(ent.status);

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

/** Peut-on ajouter un document supplementaire ? */
export async function canAddDocument(accountId: number, currentCount: number): Promise<Decision> {
  const ent = await getEntitlements(accountId);
  if (!ent.canWrite) return restrictedDecision(ent.status);

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
  if (!ent.canWrite) return restrictedDecision(ent.status);

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
  if (!ent.canWrite) return restrictedDecision(ent.status);

  if (!ent.premiumFeatures) {
    return {
      allowed: false,
      reason: 'PREMIUM_REQUIRED',
      message: 'Cette fonctionnalite est disponible avec Premium et Premium Duo.',
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
