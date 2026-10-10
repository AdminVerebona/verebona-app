/**
 * GET /api/cron/ai/refresh-model-pricing
 *
 * Rafraîchit le catalogue tarifaire (déclenchement manuel, `CRON_SECRET`).
 * Lot 35B : même implémentation que la synchronisation du catalogue IA
 * (`syncPricingCatalog` — page officielle Google, historique, UNKNOWN jamais
 * inventé), déjà exécutée toutes les 6 h par la tâche planifiée
 * `ai-catalog-sync` : aucun planificateur externe n'est nécessaire.
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

  // 207 lorsque certains modèles restent sans tarif connu (UNKNOWN) : ils
  // restent utilisables, leurs coûts sont marqués non calculables.
  const status = result.status === 'failed' ? 500 : result.status === 'partial' ? 207 : 200;
  return NextResponse.json(result, { status });
}
