/**
 * GET /api/cron/billing-unpaid — cycle d'impayé de 90 jours (Centre d'aide
 * GAP-06, AID-BILL-008, AID-TRANSFER-006).
 *
 * Balayage QUOTIDIEN, idempotent :
 *   - rappels J-7 et J-1 avant suppression (dédupliqués par cycle et étape) ;
 *   - à J+90 sans régularisation (revérifiée chez Stripe) : résiliation de
 *     ce qui facture encore, puis suppression par le workflow unique
 *     (motif UNPAID, origine système) ;
 *   - cycle régularisé mais resté ouvert : refermé.
 *
 * Planifié en interne chaque jour entre 8 h et 12 h (Paris) par
 * `daily-maintenance-scheduler` (mode : BILLING_UNPAID_SWEEP) ; cette route
 * reste le déclenchement externe ou manuel, idempotent.
 *
 * Protégé par CRON_SECRET (Authorization: Bearer <secret>). `?dryRun=1`
 * simule sans rien écrire — à utiliser au premier passage en production.
 * Répond 409 si une suppression à échéance a échoué (supervision : une
 * anomalie est aussi ouverte).
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { runUnpaidCycleSweep } from '@/services/billing/unpaid-cycle.service';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';

  try {
    const result = await runUnpaidCycleSweep({ dryRun });
    return NextResponse.json({ dryRun, ...result }, { status: result.failed.length > 0 ? 409 : 200 });
  } catch (error) {
    console.error('[cron/billing-unpaid]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
