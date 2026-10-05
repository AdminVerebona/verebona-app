/**
 * GET /api/cron/billing-pending-checkouts — rattrapage des paiements Checkout
 * engagés mais non appliqués (webhook absent, page de retour non atteinte).
 * APP-PERF-18.
 *
 * Planifié en interne à chaque tour de `daily-maintenance-scheduler`
 * (tâche `frequent-pending-checkout`) ; cette route reste le déclenchement
 * externe ou manuel. Idempotent : chaque compte est réservé en base avant
 * toute interrogation de Stripe, un paiement n'est appliqué qu'une fois.
 *
 * Protégé par CRON_SECRET (Authorization: Bearer <secret>).
 */
import { NextRequest, NextResponse } from 'next/server';
import { reconcilePendingCheckouts } from '@/services/billing/pending-checkout.service';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }
  try {
    return NextResponse.json(await reconcilePendingCheckouts());
  } catch (error) {
    console.error('[cron/billing-pending-checkouts]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
