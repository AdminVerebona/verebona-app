import { NextResponse } from 'next/server';
import { acquireJobLock, releaseJobLock } from '@/lib/job-lock';
import { runDatabaseBackup } from '@/services/backup/database-backup.service';
import { reportBackupFailure, resolveBackupFailure } from '@/services/admin/anomaly.service';

/**
 * GET /api/cron/backup — sauvegarde déclenchée par un planificateur externe.
 * Protégée par CRON_SECRET. Un bail de 2 h empêche deux sauvegardes simultanées.
 */
export const maxDuration = 900;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const bail = await acquireJobLock('database-backup-run', 2 * 60 * 60 * 1000);
  if (!bail) {
    return NextResponse.json({ error: 'BACKUP_IN_PROGRESS' }, { status: 409 });
  }
  try {
    const manifest = await runDatabaseBackup('cron');
    await resolveBackupFailure();
    return NextResponse.json({ success: true, manifest });
  } catch (e) {
    console.error('[cron/backup] échec :', e);
    await reportBackupFailure('cron', e);
    return NextResponse.json({ error: 'BACKUP_FAILED', message: (e as Error).message }, { status: 500 });
  } finally {
    await releaseJobLock(bail);
  }
}
