/**
 * GET /api/cron/gdpr-exports-purge — suppression des archives « Mes données »
 * expirées (GDP-022, `GDPR_EXPORT_RETENTION_HOURS`).
 *
 * Quotidienne. Planifiée en interne par `daily-maintenance-scheduler`
 * (démarré dans `instrumentation.ts`) ; cette route permet un déclenchement
 * externe ou manuel, idempotent.
 *
 * Protégée par CRON_SECRET (Authorization: Bearer <secret>). Secret absent :
 * refus — sans ce garde, l'en-tête `Bearer undefined` suffirait.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { purgeAllExpiredExports } from '@/services/gdpr/gdpr-export.service';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();
  try {
    return NextResponse.json(await purgeAllExpiredExports());
  } catch (error) {
    console.error('[cron/gdpr-exports-purge]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
