import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { effectiveAccountId, getSessionRole, resolveOwnedSessionAccount } from '@/services/account/membership.service';
import { db } from '@/db';
import {
  accountSubscriptions,
  referralLinks,
  referralEvents,
} from '@/db/schema';
import { eq, count, and, ne } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { buildReferralUrl } from '@/services/referral/referral-invitation.service';
import { REFERRAL_RULES, referrerEligibility } from '@/services/referral/referral-rules';

/**
 * Génère un code de parrainage de 8 caractères alphanumériques (uppercase).
 * Retry jusqu'à 5 fois en cas de collision.
 */
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // exclut 0/O, 1/I pour lisibilité
  let code = '';
  const bytes = randomBytes(8);
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/**
 * Éligibilité parrain — règle centrale (lot 102D, `referrerEligibility`) :
 * titulaire d'un abonnement PAYANT en cours (Standard, Premium ou Premium
 * Duo, mensuel ou annuel ; premier paiement constaté). La récompense étant un
 * report d'échéance de cet abonnement, un compte sans abonnement payant n'a
 * rien à recevoir. Avant ce lot : `plan_type` PREMIUM / PREMIUM_DUO seul
 * (Standard exclu, compte forcé sans paiement admis), contraire à l'aide.
 */
async function isReferralEligible(accountId: number, role: string | null): Promise<boolean> {
  const [subscription] = await db
    .select({
      planCode: accountSubscriptions.planCode,
      status: accountSubscriptions.status,
      firstBilledAt: accountSubscriptions.firstBilledAt,
      stripeSubscriptionId: accountSubscriptions.stripeSubscriptionId,
    })
    .from(accountSubscriptions)
    .where(eq(accountSubscriptions.accountId, accountId))
    .limit(1);
  return referrerEligibility({ role, subscription: subscription ?? null }).eligible;
}

/** Le compte courant est-il un FILLEUL dont l'attribution est en cours ou acquise ? */
async function referredState(accountId: number): Promise<{ attributed: boolean }> {
  const [ev] = await db
    .select({ id: referralEvents.id })
    .from(referralEvents)
    .where(and(eq(referralEvents.referredAccountId, accountId), ne(referralEvents.status, 'canceled')))
    .limit(1);
  return { attributed: Boolean(ev) };
}

/**
 * GET /api/referral/me
 * Retourne le lien de parrainage de l'utilisateur connecté (ou null si non éligible / pas encore créé).
 * Inclut les stats (validated, credits).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    // Lot 72D : compte de la SESSION (et non « la première adhésion », sans
    // ordre) ; le parrainage au nom du compte est réservé au titulaire (Q14).
    const courant = await effectiveAccountId(session);
    if (!courant) {
      return NextResponse.json({ code: 'NO_ACCOUNT' }, { status: 404 });
    }
    const membership = { accountId: courant };
    const referred = await referredState(courant);
    const role = await getSessionRole(session);
    if (role !== 'owner') {
      return NextResponse.json({ eligible: false, link: null, stats: null, reason: 'NOT_ACCOUNT_OWNER', referred });
    }

    const eligible = await isReferralEligible(membership.accountId, role);

    const [link] = await db
      .select()
      .from(referralLinks)
      .where(eq(referralLinks.accountId, membership.accountId))
      .limit(1);

    if (!eligible) {
      return NextResponse.json({ eligible: false, link: null, stats: null, reason: 'NO_PAID_SUBSCRIPTION', referred });
    }

    if (!link) {
      return NextResponse.json({ eligible: true, link: null, stats: null, referred });
    }

    // Stats
    const [validatedRow] = await db
      .select({ total: count() })
      .from(referralEvents)
      .where(
        and(
          eq(referralEvents.referrerAccountId, membership.accountId),
          eq(referralEvents.status, 'reward_granted'),
        ),
      );

    const [usedRow] = await db
      .select({ total: count() })
      .from(referralEvents)
      .where(eq(referralEvents.referrerAccountId, membership.accountId));

    const validatedCount = validatedRow?.total ?? 0;
    // Lot 102D : récompense lue dans la règle centrale (`rewardMonths`).
    const monthsEarned = validatedCount * REFERRAL_RULES.rewardMonths;

    return NextResponse.json({
      eligible: true,
      link: {
        id: link.id,
        code: link.code,
        url: buildReferralUrl(link.code),
        createdAt: link.createdAt,
      },
      stats: {
        usedCount: usedRow?.total ?? 0,
        validatedCount,
        monthsEarned,
      },
      referred,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) {
      return SessionService.handleSessionError(error);
    }
    console.error('[Referral/me GET]', error);
    return NextResponse.json({ code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

/**
 * POST /api/referral/me
 * Crée le lien de parrainage pour l'utilisateur (une seule fois, idempotent).
 */
export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    // Lot 72D : compte de la session, titulaire seulement (Q14).
    const owned = await resolveOwnedSessionAccount(session);
    if (!owned.ok) return owned.response;
    const membership = { accountId: owned.accountId };

    const eligible = await isReferralEligible(membership.accountId, 'owner');
    if (!eligible) {
      return NextResponse.json({ code: 'NOT_ELIGIBLE', message: 'Votre compte n\'est pas éligible au parrainage.' }, { status: 403 });
    }

    // Idempotent — si lien existe déjà, on le retourne
    const [existing] = await db
      .select()
      .from(referralLinks)
      .where(eq(referralLinks.accountId, membership.accountId))
      .limit(1);

    if (existing) {
      return NextResponse.json({
        code: existing.code,
        url: buildReferralUrl(existing.code),
        createdAt: existing.createdAt,
      });
    }

    // Générer un code unique
    let code = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateCode();
      const [exists] = await db
        .select({ id: referralLinks.id })
        .from(referralLinks)
        .where(eq(referralLinks.code, candidate))
        .limit(1);
      if (!exists) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      return NextResponse.json({ code: 'CODE_GENERATION_FAILED' }, { status: 500 });
    }

    const [created] = await db
      .insert(referralLinks)
      .values({
        accountId: membership.accountId,
        code,
        createdByUserId: session.userId,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    return NextResponse.json({
      code: created.code,
      url: buildReferralUrl(created.code),
      createdAt: created.createdAt,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('AUTH_REQUIRED')) {
      return SessionService.handleSessionError(error);
    }
    console.error('[Referral/me POST]', error);
    return NextResponse.json({ code: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
