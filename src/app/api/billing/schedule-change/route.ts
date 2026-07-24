import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accountMemberships } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { scheduleChange, cancelScheduledChange } from '@/services/plan-change.service';

/**
 * POST   /api/billing/schedule-change  — programme un changement (CDC §10)
 * DELETE /api/billing/schedule-change  — annule un changement programme (§10.3)
 *
 * Le client transmet uniquement une offre et une periodicite ; le serveur
 * resout lui-meme le prix et la date de prise d'effet.
 */

async function resolveAccountId(request: NextRequest): Promise<number | null> {
  const session = await SessionService.getSession(request);
  const [membership] = await db
    .select({ accountId: accountMemberships.accountId })
    .from(accountMemberships)
    .where(eq(accountMemberships.userId, session.userId))
    .limit(1);
  return membership?.accountId ?? null;
}

export async function POST(request: NextRequest) {
  try {
    const accountId = await resolveAccountId(request);
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 404 });

    const body = await request.json();
    const result = await scheduleChange({
      accountId,
      planCode: String(body.plan_code ?? ''),
      billingPeriod: String(body.billing_period ?? ''),
    });

    if (!result.ok) {
      const messages: Record<string, string> = {
        NO_SUBSCRIPTION: "Aucun abonnement n'est associe a ce compte.",
        NO_ACTIVE_PLAN: 'Un abonnement actif est necessaire pour programmer un changement.',
        INVALID_TARGET: "L'offre ou la periodicite demandee est invalide.",
        SAME_AS_CURRENT: 'Cette offre et cette periodicite sont deja actives.',
      };
      return NextResponse.json(
        { error: result.reason, message: messages[result.reason] },
        { status: 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      effectiveAt: result.effectiveAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error('[schedule-change] erreur:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const accountId = await resolveAccountId(request);
    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 404 });

    await cancelScheduledChange(accountId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[schedule-change] erreur:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
