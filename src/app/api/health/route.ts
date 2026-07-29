import { NextRequest, NextResponse } from 'next/server';
import { db, getMigrationFailures } from '@/db';
import { sql } from 'drizzle-orm';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: process.env.OVH_S3_REGION || 'gra',
  endpoint: process.env.OVH_S3_ENDPOINT || 'https://s3.gra.io.cloud.ovh.net',
  credentials: {
    accessKeyId: process.env.OVH_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.OVH_S3_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: false,
});

const bucketName = process.env.OVH_S3_BUCKET || 'verebona-files';

interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  commit?: string;
  timestamp: string;
  uptime: number;
  checks: {
    database: {
      status: 'ok' | 'error';
      responseTime?: number;
      error?: string;
    };
    s3: {
      status: 'ok' | 'error';
      responseTime?: number;
      error?: string;
    };
    /**
     * Migrations que le lanceur n'a pas pu appliquer au demarrage.
     *
     * Un schema incomplet ne se voit pas : il se manifeste bien plus tard, par
     * une colonne absente et une erreur 500 incomprehensible. C'est exactement
     * ce qui a rendu la creation de compte impossible. Le rendre visible ici
     * transforme un incident silencieux en alerte de supervision.
     */
    migrations: {
      status: 'ok' | 'error';
      failed?: string[];
    };
  };
}

/**
 * GET /api/health
 * Health check endpoint pour monitoring
 * 
 * Vérifie :
 * - Connexion base de données (SELECT 1)
 * - Connexion S3 (list bucket avec limit 1)
 * 
 * Retourne :
 * - status: 'ok' | 'degraded' | 'down'
 * - version: Version de l'app
 * - checks: Résultats des checks individuels
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();
  
  const result: HealthCheckResult = {
    status: 'ok',
    version: process.env.APP_VERSION || '1.0.0',
    commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT || undefined,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: {
        status: 'ok',
      },
      s3: {
        status: 'ok',
      },
      migrations: {
        status: 'ok',
      },
    },
  };

  // Check 1: Database
  try {
    const dbStart = Date.now();
    await db.execute(sql`SELECT 1`);
    result.checks.database.responseTime = Date.now() - dbStart;
    result.checks.database.status = 'ok';
  } catch (error) {
    console.error('[HEALTH] Database check failed:', error);
    result.checks.database.status = 'error';
    result.checks.database.error = error instanceof Error ? error.message : 'Unknown error';
    result.status = 'degraded';
  }

  // Check 2: S3 (optional - ne pas faire échouer le health check si S3 n'est pas configuré)
  if (process.env.OVH_S3_ACCESS_KEY_ID && process.env.OVH_S3_SECRET_ACCESS_KEY) {
    try {
      const s3Start = Date.now();
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        MaxKeys: 1,
      });
      await s3Client.send(command);
      result.checks.s3.responseTime = Date.now() - s3Start;
      result.checks.s3.status = 'ok';
    } catch (error) {
      console.error('[HEALTH] S3 check failed:', error);
      result.checks.s3.status = 'error';
      result.checks.s3.error = error instanceof Error ? error.message : 'Unknown error';
      result.status = 'degraded';
    }
  } else {
    result.checks.s3.status = 'error';
    result.checks.s3.error = 'S3 credentials not configured';
    // Ne pas marquer comme degraded si S3 n'est simplement pas configuré
  }

  // Check 3: migrations appliquees au demarrage
  const migrationFailures = getMigrationFailures();
  if (migrationFailures.length > 0) {
    result.checks.migrations.status = 'error';
    result.checks.migrations.failed = migrationFailures.map((f) => f.filename);
    result.status = 'degraded';
  }

  // Déterminer le status global
  if (result.checks.database.status === 'error') {
    result.status = 'down';
  } else if (result.checks.migrations.status === 'error') {
    // Schema potentiellement incomplet : degrade, jamais 'ok'.
    result.status = 'degraded';
  } else if (result.checks.s3.status === 'error' && process.env.OVH_S3_ACCESS_KEY_ID) {
    // Seulement degraded si S3 est configuré mais ne répond pas
    result.status = 'degraded';
  }

  // Return appropriate status code
  const statusCode = result.status === 'ok' ? 200 : result.status === 'degraded' ? 200 : 503;

  return NextResponse.json(result, { 
    status: statusCode,
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}