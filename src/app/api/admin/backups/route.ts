import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { acquireJobLock, releaseJobLock } from '@/lib/job-lock';
import { listDatabaseBackups, runDatabaseBackup } from '@/services/backup/database-backup.service';

export const maxDuration = 900;

function erreurAdmin(error: unknown): Response {
  if (error instanceof Response) return error;
  const message = (error as Error)?.message ?? '';
  if (/admin|forbidden|auth|token/i.test(message)) {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }
  console.error('[admin/backups]', error);
  return NextResponse.json({ error: 'INTERNAL_ERROR', message }, { status: 500 });
}

/** GET /api/admin/backups — sauvegardes disponibles et configuration. */
export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
    const backups = await listDatabaseBackups();
    const derniere = backups[0] ?? null;
    const heures = derniere ? Math.round((Date.now() - new Date(derniere.date).getTime()) / 3_600_000) : null;
    return NextResponse.json({
      backups,
      status: heures === null ? 'error' : heures > 48 ? 'error' : heures > 26 ? 'warning' : 'ok',
      hoursSinceLastBackup: heures,
      config: {
        schedulerEnabled: process.env.BACKUP_DISABLED !== 'true',
        storageConfigured: Boolean(process.env.OVH_S3_ACCESS_KEY_ID && process.env.OVH_S3_SECRET_ACCESS_KEY),
        retentionDays: Math.max(1, Number(process.env.BACKUP_RETENTION_DAYS) || 30),
        bucket: process.env.OVH_S3_BUCKET || 'verebona-files',
      },
    });
  } catch (error) {
    return erreurAdmin(error);
  }
}

/** POST /api/admin/backups — lance une sauvegarde immédiate. */
export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return erreurAdmin(error);
  }
  const bail = await acquireJobLock('database-backup-run', 2 * 60 * 60 * 1000);
  if (!bail) {
    return NextResponse.json(
      { error: 'BACKUP_IN_PROGRESS', message: 'Une sauvegarde est déjà en cours.' },
      { status: 409 },
    );
  }
  try {
    const manifest = await runDatabaseBackup('admin');
    return NextResponse.json({ success: true, manifest });
  } catch (error) {
    console.error('[admin/backups] sauvegarde échouée :', error);
    return NextResponse.json(
      { error: 'BACKUP_FAILED', message: (error as Error).message },
      { status: 500 },
    );
  } finally {
    await releaseJobLock(bail);
  }
}
