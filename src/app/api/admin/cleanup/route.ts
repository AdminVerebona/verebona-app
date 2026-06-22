import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { runCleanupJob, getCleanupStats } from '@/lib/cleanup-job';
import { apiError } from '@/lib/api-errors';
import { requireAdmin } from '@/lib/auth-guards';

/**
 * GET /api/admin/cleanup
 * Récupère les statistiques de cleanup sans exécuter le job
 */
export async function GET(request: NextRequest) {
  try {
    // ✅ CORRECTION: Utiliser requireAdmin() au lieu de lire x-user-id
    await requireAdmin(request); // Throws si pas admin

    // Get cleanup stats
    const stats = await getCleanupStats();

    return NextResponse.json({
      stats: {
        totalSoftDeleted: stats.totalSoftDeleted,
        eligibleForCleanup: stats.eligibleForCleanup,
        estimatedSpaceReclaim: stats.estimatedSpaceReclaim,
        estimatedSpaceReclaimMB: (stats.estimatedSpaceReclaim / 1024 / 1024).toFixed(2),
      },
      retentionDays: 30,
      nextCleanupWindow: 'Manual trigger or cron job',
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('GET /api/admin/cleanup error:', error);
    return apiError(500, 'INTERNAL_SERVER_ERROR', 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'));
  }
}

/**
 * POST /api/admin/cleanup
 * Exécute le job de cleanup
 */
export async function POST(request: NextRequest) {
  try {
    // ✅ CORRECTION: Utiliser requireAdmin() au lieu de lire x-user-id
    const authenticatedUserId = await await requireAdmin(request); // Throws si pas admin

    // Run cleanup job
    
    const result = await runCleanupJob();


    return NextResponse.json({
      success: result.success,
      result: {
        filesProcessed: result.filesProcessed,
        filesDeletedFromS3: result.filesDeletedFromS3,
        filesDeletedFromDB: result.filesDeletedFromDB,
        errors: result.errors,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        durationMs: result.duration,
      },
    }, { status: 200 });

  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    
    console.error('POST /api/admin/cleanup error:', error);
    return apiError(500, 'INTERNAL_SERVER_ERROR', 'Internal server error: ' + (error instanceof Error ? error.message : 'Unknown error'));
  }
}