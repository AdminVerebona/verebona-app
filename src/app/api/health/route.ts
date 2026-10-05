import { NextRequest, NextResponse } from 'next/server';
import { db, getMigrationFailures } from '@/db';
import { sql } from 'drizzle-orm';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { classifyS3Error, getS3Bucket, getS3Client, s3ConfigDiagnostics } from '@/lib/s3-config';

/** Délai maximal de la sonde de stockage (ms). */
const S3_PROBE_TIMEOUT_MS = 5_000;

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
      /** Variables en cause / incohérences (noms seuls, jamais de valeur). */
      config?: { errors: string[]; warnings: string[] };
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
      /** Noms seuls, pour la compatibilité des sondes existantes. */
      failed?: string[];
      /**
       * Cause de chaque échec.
       *
       * Le lanceur enregistrait déjà message et code ; seuls les noms étaient
       * exposés. Diagnostiquer une chaîne de migrations bloquée imposait donc
       * d'accéder aux journaux du serveur — ce qui n'est pas toujours
       * possible, et jamais immédiat. Le premier échec suffit presque
       * toujours à expliquer les suivants.
       */
      failures?: Array<{ filename: string; code?: string; message: string }>;
      /**
       * Migration à corriger EN PREMIER.
       *
       * Une chaîne bloquée produit des dizaines d'échecs en cascade : une
       * table absente en fait échouer dix autres qui la référencent. Seul le
       * premier échec, dans l'ordre d'application, désigne la cause réelle.
       */
      firstFailure?: { filename: string; code?: string; message: string };
    };
    /**
     * Lot 16b : variables retirées (anciens drapeaux et commutateurs IA)
     * encore posées — ignorées par le code, à supprimer de l'hébergement
     * (`RETIRED_ENV_VARIABLE`). Avertissement : ne dégrade pas le statut
     * global, mais doit être vu en supervision.
     */
    aiPromptArchitecture: {
      status: 'ok' | 'warning';
      warnings?: Array<{ treatment: string | null; code: string; switchName: string; switchMode: string; message: string }>;
    };
    /**
     * Corpus du Centre d'aide lu par l'assistant (CDC Centre d'aide PUB-01,
     * ENV-02) : corpus publié refusé (invalide, autre environnement) ou
     * injoignable → `warning`, avec le corpus réellement servi (dernier
     * valide en mémoire ou en base, ou aucun). Avertissement : ne dégrade pas
     * le statut global.
     */
    /**
     * Limiteur de débit de l'assistant (D-J2) : compteur partagé en base
     * indisponible → repli sur la mémoire de l'instance (`warning`, statut
     * global inchangé : l'assistant reste servi). État en mémoire seulement.
     */
    assistantRateLimiter?: { status: 'ok' | 'warning'; mode: string; degradedSince: string | null; lastError: string | null };
    helpCorpus?: Omit<import('@/services/verebona-assistant/core/help-corpus.service').HelpCorpusHealth, 'status'> & {
      /** `not_loaded` : aucune lecture du corpus sur cette instance depuis son démarrage. */
      status: 'ok' | 'warning' | 'not_loaded';
      message?: string;
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
      aiPromptArchitecture: {
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

  // Check 2: S3 — configuration centrale (APP-PERF-26). Appel RÉSEAU réel
  // (une signature locale ne prouve rien), borné et annulé au délai.
  const s3Diag = s3ConfigDiagnostics();
  // Configuration partielle (au moins une variable posée, ou valeur invalide).
  const s3Touched = !s3Diag.configured
    && (s3Diag.errors.some((e) => e.code !== 'MISSING') || s3Diag.errors.length < 4);
  if (s3Diag.warnings.length > 0 || s3Diag.errors.length > 0) {
    result.checks.s3.config = {
      errors: s3Diag.errors.map((e) => e.message),
      warnings: s3Diag.warnings.map((w) => w.message),
    };
  }
  if (s3Diag.configured) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), S3_PROBE_TIMEOUT_MS);
    try {
      const s3Start = Date.now();
      await getS3Client('interactive').send(
        new ListObjectsV2Command({ Bucket: getS3Bucket(), MaxKeys: 1 }),
        { abortSignal: controller.signal },
      );
      result.checks.s3.responseTime = Date.now() - s3Start;
      result.checks.s3.status = 'ok';
    } catch (error) {
      const info = classifyS3Error(error);
      const kind = controller.signal.aborted ? 'TIMEOUT' : info.kind;
      console.error(`[HEALTH] S3 check failed: ${kind} (${info.name})`);
      result.checks.s3.status = 'error';
      result.checks.s3.error = `${kind} (${info.name}${info.httpStatus ? `, HTTP ${info.httpStatus}` : ''})`;
      result.status = 'degraded';
    } finally {
      clearTimeout(timer);
    }
  } else {
    result.checks.s3.status = 'error';
    result.checks.s3.error = 'S3 not configured';
    // Configuration partielle ou contradictoire : dégradé. Stockage
    // simplement absent (environnement sans S3) : pas dégradé.
    if (s3Touched) result.status = 'degraded';
  }

  // Check 3: migrations appliquees au demarrage
  const migrationFailures = getMigrationFailures();
  if (migrationFailures.length > 0) {
    result.checks.migrations.status = 'error';
    result.checks.migrations.failed = migrationFailures.map((f) => f.filename);

    // Le message est tronqué : certaines erreurs PostgreSQL embarquent la
    // requête entière, ce qui rendrait la réponse illisible.
    result.checks.migrations.failures = migrationFailures.map((f) => ({
      filename: f.filename,
      code: f.code,
      message: (f.message ?? '').slice(0, 300),
    }));

    // Les migrations sont appliquées dans l'ordre lexical : la première en
    // échec est celle qui a rompu la chaîne. Les suivantes en découlent
    // souvent — une table absente en fait échouer toutes celles qui la
    // référencent.
    const premier = migrationFailures[0];
    result.checks.migrations.firstFailure = {
      filename: premier.filename,
      code: premier.code,
      message: (premier.message ?? '').slice(0, 300),
    };

    result.status = 'degraded';
  }

  // Check 4: variables IA retirées encore posées (CDC 15 T2-43 ; lot 16b :
  // drapeaux AI_* et commutateurs supprimés). Ne lève jamais, sans base.
  try {
    const { promptArchitectureWarnings } = await import('@/services/ai/config/prompt-architecture');
    const warnings = await promptArchitectureWarnings();
    if (warnings.length > 0) {
      result.checks.aiPromptArchitecture = { status: 'warning', warnings };
    }
  } catch {
    /* contrôle indicatif : jamais bloquant pour la sonde */
  }

  // Check 6: limiteur de débit partagé de l'assistant (D-J2), état mémoire.
  try {
    const { rateLimiterHealth } = await import('@/lib/verebona/rate-limit');
    const h = rateLimiterHealth();
    result.checks.assistantRateLimiter = { status: h.degraded ? 'warning' : 'ok', mode: h.mode, degradedSince: h.degradedSince, lastError: h.lastError };
  } catch {
    /* contrôle indicatif */
  }

  // Check 5: corpus d'aide de l'assistant (PUB-01). État EN MÉMOIRE
  // seulement : aucun chargement, aucun appel sortant, aucune écriture — la
  // sonde ne doit rien déclencher. Jamais lu sur l'instance : « non chargé ».
  try {
    const { helpCorpusHealth } = await import('@/services/verebona-assistant/core/help-corpus.service');
    const h = helpCorpusHealth();
    result.checks.helpCorpus = h.status === 'unknown'
      ? { ...h, status: 'not_loaded', message: 'Corpus d’aide non chargé sur cette instance (aucune question d’aide depuis le démarrage).' }
      : { ...h, status: h.status };
  } catch {
    /* contrôle indicatif */
  }

  // Déterminer le status global
  if (result.checks.database.status === 'error') {
    result.status = 'down';
  } else if (result.checks.migrations.status === 'error') {
    // Schema potentiellement incomplet : degrade, jamais 'ok'.
    result.status = 'degraded';
  } else if (result.checks.s3.status === 'error' && (s3Diag.configured || s3Touched)) {
    // Seulement degraded si S3 est configuré (même partiellement) mais ne répond pas
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