/**
 * GET /api/cron/hourly-enrichment
 * ──────────────────────────────
 * Traitement IA horaire : relance l'enrichissement et la vérification de cohérence
 * sur tous les biens actifs des comptes Standard et Premium (y compris Duo et Pro),
 * pour maintenir la cohérence avec les nouveaux documents, équipements, pièces
 * et éléments agenda ajoutés.
 *
 * Protégé par CRON_SECRET (header Authorization: Bearer <secret>).
 * Déclenché automatiquement toutes les heures via vercel.json.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runHourlyEnrichment } from '@/services/document-ai/hourly-enrichment.service';

export const maxDuration = 300; // 5 minutes max (traitement déterministe léger)

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('[cron/hourly-enrichment] Démarrage...');
    const result = await runHourlyEnrichment();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error('[cron/hourly-enrichment] Erreur fatale:', error);
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', details: error instanceof Error ? error.message : 'Unknown' },
      { status: 500 }
    );
  }
}
