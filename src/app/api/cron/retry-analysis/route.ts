/**
 * GET /api/cron/retry-analysis
 * Relance l'analyse IA sur les documents en échec ou bloqués.
 * Protégé par CRON_SECRET (même pattern que les autres crons).
 *
 * Usage cron (Vercel, crontab, etc.) :
 *   GET /api/cron/retry-analysis
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Peut aussi être appelé manuellement pour forcer un tour immédiat.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runAnalysisRecovery } from '@/services/document-ai/analysis-recovery.service';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runAnalysisRecovery();
  return NextResponse.json({ ok: true, ...result });
}
