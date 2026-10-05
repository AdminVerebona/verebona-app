import { NextRequest, NextResponse } from 'next/server';
import { getMigrationFailures } from '@/db';
import { getBuildIdentity } from '@/lib/runtime-identity';
import {
  NO_STORE_HEADERS, isDiagnosticAuthorized, probeDatabase, probeS3, probeSchema,
} from '@/lib/health/probes';

export const dynamic = 'force-dynamic';

interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  commit?: string;
  /** Variable d'où provient le commit (APP_COMMIT, SOURCE_VERSION…). */
  commitSource?: string;
  /** `true` : réponse avec détails (en-tête de diagnostic valide). */
  detailed: boolean;
  timestamp: string;
  uptime: number;
  checks: {
    database: {
      status: 'ok' | 'error';
      responseTime?: number;
      /** Code public (TIMEOUT, UNAVAILABLE) ; message SQL en mode détaillé. */
      error?: string;
    };
    /** Disponibilité critique, même contrat que `/api/health/ready`. */
    readiness: {
      ready: boolean;
      phase: string;
      pendingCritical: number;
      pendingOptional: number;
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
      /** Phase du passage des migrations de ce processus (APP-PERF-16). */
      phase?: string;
      /**
       * Cause de chaque échec.
       *
       * Le lanceur enregistrait déjà message et code ; seuls les noms étaient
       * exposés. Diagnostiquer une chaîne de migrations bloquée imposait donc
       * d'accéder aux journaux du serveur — ce qui n'est pas toujours
       * possible, et jamais immédiat. Le premier échec suffit presque
       * toujours à expliquer les suivants.
       */
      failures?: Array<{ filename: string; code?: string; message?: string }>;
      /**
       * Migration à corriger EN PREMIER.
       *
       * Une chaîne bloquée produit des dizaines d'échecs en cascade : une
       * table absente en fait échouer dix autres qui la référencent. Seul le
       * premier échec, dans l'ordre d'application, désigne la cause réelle.
       */
      firstFailure?: { filename: string; code?: string; message?: string };
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
    /** Diagnostic autorisé : pool PostgreSQL du processus (lot 24, APP-PERF-01). */
    dbPool?: { status: 'ok'; role: string; max: number; maxSource: string } & import('@/db/pool-metrics').PoolMetricsSnapshot;
    assistantRateLimiter?: { status: 'ok' | 'warning'; mode: string; degradedSince: string | null; lastError: string | null };
    helpCorpus?: Omit<import('@/services/verebona-assistant/core/help-corpus.service').HelpCorpusHealth, 'status'> & {
      /** `not_loaded` : aucune lecture du corpus sur cette instance depuis son démarrage. */
      status: 'ok' | 'warning' | 'not_loaded';
      message?: string;
    };
  };
}

/**
 * GET /api/health — DIAGNOSTIC (endpoint historique, conservé pour la
 * transition des sondes ; contrats : `src/lib/health/probes.ts`).
 *
 * Contrôles bornés, en parallèle et partagés entre appels : base (SELECT 1),
 * schéma critique, stockage S3 (appel réseau réel, résultat gardé 30 s).
 *
 * Codes : 200 `ok` | `degraded` (schéma incomplet, S3 configuré mais en
 * échec — l'application sert encore), 503 `down` (base injoignable).
 * Sans en-tête `x-health-token` valide : codes et noms de fichiers seulement,
 * jamais de message SQL, de cause S3 ni de nom de variable.
 */
export async function GET(request: NextRequest) {
  const detailed = isDiagnosticAuthorized(request.headers);
  const id = getBuildIdentity();

  const result: HealthCheckResult = {
    status: 'ok',
    version: id.version,
    commit: id.commit ?? undefined,
    commitSource: id.commitSource ?? undefined,
    detailed,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database: { status: 'ok' },
      readiness: { ready: true, phase: 'idle', pendingCritical: 0, pendingOptional: 0 },
      s3: { status: 'ok' },
      migrations: { status: 'ok' },
      aiPromptArchitecture: { status: 'ok' },
    },
  };

  const [base, schema, s3] = await Promise.all([probeDatabase(), probeSchema(), probeS3()]);

  // Check 1: base
  result.checks.database.responseTime = base.responseTime;
  if (base.status !== 'ok') {
    result.checks.database.status = 'error';
    result.checks.database.error = detailed && base.detail ? `${base.code} : ${base.detail}` : base.code;
  }

  // Check 2: stockage S3 (dépendance optionnelle).
  if (detailed && (s3.configWarnings.length > 0 || s3.configErrors.length > 0)) {
    result.checks.s3.config = { errors: s3.configErrors, warnings: s3.configWarnings };
  }
  if (s3.status === 'ok') {
    result.checks.s3.responseTime = s3.responseTime;
  } else {
    result.checks.s3.status = 'error';
    if (s3.responseTime) result.checks.s3.responseTime = s3.responseTime;
    result.checks.s3.error = !s3.configured
      ? (s3.misconfigured ? 'S3 misconfigured' : 'S3 not configured')
      : detailed && s3.detail ? `${s3.code} (${s3.detail})` : s3.code;
  }

  // Check 3: schéma — migrations du démarrage et disponibilité critique.
  result.checks.readiness = {
    ready: schema.ready, phase: schema.phase,
    pendingCritical: schema.pendingCritical, pendingOptional: schema.pendingOptional,
  };
  const migrationFailures = getMigrationFailures();
  result.checks.migrations.phase = schema.phase;
  if (migrationFailures.length > 0 || !schema.ready) {
    result.checks.migrations.status = 'error';
    if (migrationFailures.length > 0) {
      result.checks.migrations.failed = migrationFailures.map((f) => f.filename);
      // Message tronqué (certaines erreurs PostgreSQL embarquent la requête
      // entière) et réservé au diagnostic autorisé.
      const vue = (f: { filename: string; code?: string; message?: string }) => ({
        filename: f.filename, code: f.code, ...(detailed ? { message: (f.message ?? '').slice(0, 300) } : {}),
      });
      result.checks.migrations.failures = migrationFailures.map(vue);
      // Ordre lexical : le premier échec CRITIQUE est celui qui a rompu la chaîne.
      const premier = migrationFailures.find((f) => f.criticality !== 'optional') ?? migrationFailures[0];
      result.checks.migrations.firstFailure = vue(premier);
    } else if (schema.firstFailure) {
      result.checks.migrations.firstFailure = { ...schema.firstFailure };
    }
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

  // Check 7 (diagnostic autorisé seulement) : pool PostgreSQL de CE processus
  // — attente d'acquisition et temps SQL séparés, agrégats depuis le démarrage
  // (APP-PERF-01 §MESURES). Aucune requête, aucun paramètre, aucune URL.
  if (detailed) {
    try {
      const { getPoolMetrics } = await import('@/db/pool-metrics');
      const { resolvePoolConfig } = await import('@/db/pool-config');
      const c = resolvePoolConfig();
      result.checks.dbPool = { status: 'ok', role: c.role, max: c.max, maxSource: c.maxSource, ...getPoolMetrics().snapshot() };
    } catch {
      /* contrôle indicatif */
    }
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

  // Statut global
  if (result.checks.database.status === 'error') {
    result.status = 'down';
  } else if (!schema.ready || migrationFailures.some((f) => f.criticality !== 'optional')) {
    // Schéma critique incomplet : dégradé, jamais `ok` (readiness à 503).
    result.status = 'degraded';
  } else if (result.checks.s3.status === 'error' && (s3.configured || s3.misconfigured)) {
    // Stockage configuré (même partiellement) mais en échec : dégradé.
    result.status = 'degraded';
  } else if (migrationFailures.length > 0 || schema.phase === 'degraded') {
    // Index optionnels manquants : signalé, service rendu.
    result.status = 'degraded';
  }

  return NextResponse.json(result, {
    status: result.status === 'down' ? 503 : 200,
    headers: NO_STORE_HEADERS,
  });
}
