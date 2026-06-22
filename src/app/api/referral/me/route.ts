import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import {
  accounts,
  accountMemberships,
  referralLinks,
  referralEvents,
} from '@/db/schema';
import { eq, count, and } from 'drizzle-orm';
import { randomBytes } from 'crypto';

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
 * Vérifie l'éligibilité parrain :
 * - Plan Standard, Premium ou Premium Duo (titulaire uniquement pour Duo)
 * - A déjà été facturé au moins une fois (firstBilledAt non null)
 */
async function isReferralEligible(accountId: number): Promise<boolean> {
  const [account] = await db
    .select({
      planType: accounts.planType,
      subscriptionStatus: accounts.subscriptionStatus,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  if (!account) return false;

  const plan = (account.planType || '').toUpperCase();
  // STANDARD seul n'est pas éligible (sauf s'il a déjà payé via Stripe)
  if (!['PREMIUM', 'PREMIUM_DUO'].includes(plan)) return false;

  // Plan PREMIUM/PREMIUM_DUO = nécessairement payé ou forcé admin → toujours éligible
  return true;
}

/**
 * GET /api/referral/me
 * Retourne le lien de parrainage de l'utilisateur connecté (ou null si non éligible / pas encore créé).
 * Inclut les stats (validated, credits).
 */
export async function GET(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    const [membership] = await db
      .select({ accountId: accountMemberships.accountId, role: accountMemberships.role })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, session.userId))
      .limit(1);

    if (!membership) {
      return NextResponse.json({ code: 'NO_ACCOUNT' }, { status: 404 });
    }

    const eligible = await isReferralEligible(membership.accountId);

    const [link] = await db
      .select()
      .from(referralLinks)
      .where(eq(referralLinks.accountId, membership.accountId))
      .limit(1);

    if (!eligible) {
      return NextResponse.json({ eligible: false, link: null, stats: null });
    }

    if (!link) {
      return NextResponse.json({ eligible: true, link: null, stats: null });
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
    const creditsEarned = validatedCount * 10;

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    return NextResponse.json({
      eligible: true,
      link: {
        id: link.id,
        code: link.code,
        url: `${appUrl}/r/${link.code}`,
        createdAt: link.createdAt,
      },
      stats: {
        usedCount: usedRow?.total ?? 0,
        validatedCount,
        creditsEarned,
      },
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

    const [membership] = await db
      .select({ accountId: accountMemberships.accountId })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, session.userId))
      .limit(1);

    if (!membership) {
      return NextResponse.json({ code: 'NO_ACCOUNT' }, { status: 404 });
    }

    const eligible = await isReferralEligible(membership.accountId);
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
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      return NextResponse.json({
        code: existing.code,
        url: `${appUrl}/r/${existing.code}`,
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

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    return NextResponse.json({
      code: created.code,
      url: `${appUrl}/r/${created.code}`,
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
