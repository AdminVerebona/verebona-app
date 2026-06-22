import { NextRequest, NextResponse } from 'next/server';
import { BackupService } from '@/services/backup-service';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  // Si un secret est configuré, on vérifie l'autorisation
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await BackupService.runBackup('automatic-cron');
    
    return NextResponse.json({
      message: 'Backup completed successfully',
      ...result
    });
  } catch (error: unknown) {
    console.error('Cron backup error:', error);
    return NextResponse.json(
      { 
        error: 'Backup failed', 
        details: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    );
  }
}
