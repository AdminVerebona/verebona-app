import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { BackupService } from '@/services/backup-service';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);

    const backups = await BackupService.listBackups();

    const lastBackupDate = backups.length > 0 ? new Date(backups[0].lastModified) : null;
    const now = new Date();
    const hoursSinceLastBackup = lastBackupDate 
      ? (now.getTime() - lastBackupDate.getTime()) / (1000 * 60 * 60)
      : null;

    const status = hoursSinceLastBackup === null 
      ? 'error' 
      : hoursSinceLastBackup > 48 
        ? 'error' 
        : hoursSinceLastBackup > 24 
          ? 'warning' 
          : 'ok';

    return NextResponse.json({
      status,
      lastBackupDate: lastBackupDate?.toISOString() || null,
      hoursSinceLastBackup: hoursSinceLastBackup ? Math.round(hoursSinceLastBackup) : null,
      backups,
      totalBackups: backups.length,
    });
  } catch (error: unknown) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error listing backups:', error);
    return NextResponse.json(
      { error: 'Erreur lors de la récupération des backups', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAdmin(request);

    const result = await BackupService.runBackup('manual-admin');

    return NextResponse.json(result);
  } catch (error: unknown) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error creating backup:', error);
    return NextResponse.json(
      { error: 'Erreur lors de la création du backup', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

