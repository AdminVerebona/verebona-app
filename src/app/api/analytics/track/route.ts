import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { accountMemberships } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { trackFunnelEvent, type FunnelEvent } from '@/services/funnel-analytics.service';

/**
 * POST /api/analytics/track
 *
 * Enregistre un evenement de parcours observable uniquement depuis
 * l'interface (CDC tarification §17).
 *
 * Seuls les evenements de cette liste sont acceptes : le client ne peut pas
 * inscrire n'importe quoi dans les statistiques, notamment pas un paiement
 * ou une conversion, qui restent constates cote serveur.
 */
const CLIENT_ALLOWED: FunnelEvent[] = [
  'offers_viewed',
  'plan_selected',
  'billing_period_selected',
  'checkout_abandoned',
  'first_question_asked',
  'first_export_generated',
];

export async function POST(request: NextRequest) {
  try {
    const session = await SessionService.getSession(request);

    const [membership] = await db
      .select({ accountId: accountMemberships.accountId })
      .from(accountMemberships)
      .where(eq(accountMemberships.userId, session.userId))
      .limit(1);

    if (!membership) {
      return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 404 });
    }

    const body = await request.json();
    const event = String(body.event ?? '') as FunnelEvent;

    if (!CLIENT_ALLOWED.includes(event)) {
      return NextResponse.json({ error: 'EVENT_NOT_ALLOWED' }, { status: 400 });
    }

    await trackFunnelEvent({
      event,
      accountId: membership.accountId,
      userId: session.userId,
      planCode: body.plan_code ? String(body.plan_code) : null,
      billingPeriod: body.billing_period ? String(body.billing_period) : null,
    });

    return NextResponse.json({ ok: true });
  } catch {
    // La mesure ne doit jamais faire echouer une action utilisateur.
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
