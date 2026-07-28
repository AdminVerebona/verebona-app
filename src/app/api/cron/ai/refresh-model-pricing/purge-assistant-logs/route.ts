/**
 * GET /api/cron/ai/purge-assistant-logs
 *
 * Purge quotidienne — CDC Assistant §24.1, critère d'acceptation n°20.
 * Protégée par `CRON_SECRET`, comme les autres tâches planifiées du dépôt.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { purgeAssistantData } from '@/services/ai/assistant/retention/purge-assistant-logs.job';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  try {
    const report = await purgeAssistantData();
    return NextResponse.json(report);
  } catch (e) {
    // Une purge en échec doit être visible : la conservation des données est
    // un engagement, pas une tâche de fond silencieuse.
    console.error('[purge-assistant] échec :', (e as Error).message);
    return NextResponse.json({ error: 'PURGE_FAILED', message: (e as Error).message }, { status: 500 });
  }
}
