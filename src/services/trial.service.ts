/**
 * Service d'essai gratuit (CDC §3).
 *
 * Regles :
 *  - tout nouveau compte recoit automatiquement 7 jours d'essai Premium ;
 *  - sans carte bancaire, sans abonnement Stripe (l'essai vit uniquement
 *    dans Verebona) ;
 *  - un seul essai par adresse email, controle cote serveur via la table
 *    trial_grants qui survit a la suppression/recreation d'un compte ;
 *  - a l'expiration sans souscription, le compte passe en mode restreint
 *    (statut `readonly`) : les donnees sont conservees.
 */
import { db } from '@/db';
import { accountSubscriptions, trialGrants } from '@/db/schema';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { trackFunnelEvent } from './funnel-analytics.service';

/** Duree de l'essai, en jours (7 periodes de 24 h — CDC §3.3). */
export const TRIAL_DURATION_DAYS = 7;

/** Offre dont beneficie l'essai (fonctionnalites Premium). */
export const TRIAL_PLAN_CODE = 'premium' as const;

/** Quotas specifiques a l'essai (CDC §3.2) — plus stricts que Premium. */
export const TRIAL_LIMITS = {
  maxAssets: 2,
  maxDocuments: 30,
  maxUsers: 1,
} as const;

export type TrialState =
  | { status: 'none' }
  | { status: 'active'; startedAt: Date; endsAt: Date; daysRemaining: number }
  | { status: 'expired'; startedAt: Date; endsAt: Date }
  | { status: 'converted'; startedAt: Date; endsAt: Date };

/**
 * Normalise une adresse email pour la cle d'unicite.
 * Minuscules + suppression des espaces : deux ecritures d'un meme email
 * ne doivent pas donner droit a deux essais.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Calcule la date de fin d'essai (UTC) a partir d'une date de depart. */
export function computeTrialEnd(startedAt: Date): Date {
  return new Date(startedAt.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Cette adresse email a-t-elle deja consomme son essai ?
 * Controle serveur — ne jamais s'appuyer sur le navigateur (CDC §3.4).
 */
export async function hasUsedTrial(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const rows = await db
    .select({ id: trialGrants.id })
    .from(trialGrants)
    .where(eq(trialGrants.emailNormalized, normalized))
    .limit(1);
  return rows.length > 0;
}

/**
 * Attribue l'essai a un compte nouvellement cree.
 *
 * Idempotent : si l'email a deja beneficie d'un essai, aucun nouvel essai
 * n'est accorde et la fonction renvoie `granted: false`. Le compte est alors
 * cree sans essai (il devra souscrire pour utiliser l'application).
 */
export async function grantTrial(params: {
  accountId: number;
  email: string;
  now?: Date;
}): Promise<{ granted: boolean; endsAt?: Date; reason?: 'ALREADY_USED' }> {
  const { accountId, email } = params;
  const now = params.now ?? new Date();
  const normalized = normalizeEmail(email);

  if (await hasUsedTrial(normalized)) {
    return { granted: false, reason: 'ALREADY_USED' };
  }

  const endsAt = computeTrialEnd(now);

  // Trace d'unicite : conservee meme si le compte est supprime ensuite.
  await db.insert(trialGrants).values({
    emailNormalized: normalized,
    accountId,
    grantedAt: now,
    expiresAt: endsAt,
    createdAt: now,
  });

  // Abonnement local en mode essai : aucun objet Stripe n'est cree ici.
  await db
    .insert(accountSubscriptions)
    .values({
      accountId,
      planCode: TRIAL_PLAN_CODE,
      status: 'trialing',
      billingPeriod: null,
      trialConsumed: true,
      trialStartedAt: now,
      trialEndsAt: endsAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: accountSubscriptions.accountId,
      set: {
        planCode: TRIAL_PLAN_CODE,
        status: 'trialing',
        trialConsumed: true,
        trialStartedAt: now,
        trialEndsAt: endsAt,
        updatedAt: now,
      },
    });

  void trackFunnelEvent({
    event: 'trial_started',
    accountId,
    planCode: TRIAL_PLAN_CODE,
  });

  return { granted: true, endsAt };
}

/** Etat courant de l'essai d'un compte (pour le bandeau et les droits). */
export async function getTrialState(accountId: number, now: Date = new Date()): Promise<TrialState> {
  const rows = await db
    .select({
      status: accountSubscriptions.status,
      startedAt: accountSubscriptions.trialStartedAt,
      endsAt: accountSubscriptions.trialEndsAt,
      firstBilledAt: accountSubscriptions.firstBilledAt,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);

  const row = rows[0];
  if (!row?.startedAt || !row?.endsAt) return { status: 'none' };

  if (row.firstBilledAt) {
    return { status: 'converted', startedAt: row.startedAt, endsAt: row.endsAt };
  }
  if (row.endsAt.getTime() <= now.getTime()) {
    return { status: 'expired', startedAt: row.startedAt, endsAt: row.endsAt };
  }

  const msRemaining = row.endsAt.getTime() - now.getTime();
  return {
    status: 'active',
    startedAt: row.startedAt,
    endsAt: row.endsAt,
    // arrondi au superieur : il reste « 1 jour » tant que le delai n'est pas ecoule
    daysRemaining: Math.ceil(msRemaining / (24 * 60 * 60 * 1000)),
  };
}

/**
 * Bascule en mode restreint les essais arrives a echeance sans souscription.
 * Concu pour un appel periodique (cron / tache planifiee).
 *
 * Aucun paiement n'est declenche, aucune donnee n'est supprimee (CDC §3.5).
 */
export async function expireOverdueTrials(
  now: Date = new Date(),
): Promise<{ expired: number; accountIds: number[] }> {
  const updated = await db
    .update(accountSubscriptions)
    .set({ status: 'readonly', updatedAt: now })
    .where(
      and(
        eq(accountSubscriptions.status, 'trialing'),
        lt(accountSubscriptions.trialEndsAt, now),
        isNull(accountSubscriptions.firstBilledAt),
      ),
    )
    .returning({ accountId: accountSubscriptions.accountId });

  return { expired: updated.length, accountIds: updated.map((r) => r.accountId) };
}

/**
 * Marque l'essai comme converti lorsqu'un abonnement est active.
 * Appele depuis le traitement des webhooks Stripe.
 */
export async function markTrialConverted(params: {
  accountId: number;
  email: string;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  await db
    .update(trialGrants)
    .set({ convertedAt: now })
    .where(eq(trialGrants.emailNormalized, normalizeEmail(params.email)));
}
