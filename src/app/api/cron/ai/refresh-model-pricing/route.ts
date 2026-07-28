/**
 * GET /api/cron/ai/refresh-model-pricing
 *
 * Rafraîchit le catalogue tarifaire depuis la grille du compte Google.
 * Fréquence recommandée : hebdomadaire, conformément à la veille du CDC
 * Assistant §15.13. Protégé par `CRON_SECRET`, comme les autres tâches
 * planifiées du dépôt.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { refreshModelPricing } from '@/services/ai/gateway/pricing/refresh-pricing.job';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();
  const result = await refreshModelPricing();

  // 207 lorsque certains modèles restent sans tarif : le lot a partiellement
  // abouti et une saisie manuelle est attendue en administration.
  const status = result.status === 'failed' ? 500 : result.status === 'partial' ? 207 : 200;
  return NextResponse.json(result, { status });
}
