import { NextResponse } from 'next/server';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { NO_STORE_HEADERS, probeDatabase, probeSchema } from '@/lib/health/probes';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health/ready — DISPONIBILITÉ CRITIQUE (APP-PERF-37, APP-PERF-16).
 *
 *   200 { status: 'ready' }       base joignable ET migrations critiques
 *                                 appliquées (`degraded: true` si seuls des
 *                                 index optionnels manquent) ;
 *   503 { status: 'not_ready' }   `reasons` : DATABASE_UNAVAILABLE,
 *                                 DATABASE_TIMEOUT, SCHEMA_NOT_READY.
 *
 * Bornée (≈ 1,75 s au pire, contrôles en parallèle et partagés). Le stockage
 * n'y figure pas (dépendance optionnelle — voir `/api/health`). Aucun message
 * SQL : codes, compteurs et nom du premier fichier en cause seulement.
 */
export async function GET() {
  const [base, schema] = await Promise.all([probeDatabase(), probeSchema()]);
  const reasons: string[] = [];
  if (base.status !== 'ok') reasons.push(base.status === 'timeout' ? 'DATABASE_TIMEOUT' : 'DATABASE_UNAVAILABLE');
  if (!schema.ready) reasons.push('SCHEMA_NOT_READY');
  const ready = reasons.length === 0;
  return NextResponse.json(
    {
      status: ready ? 'ready' : 'not_ready',
      ...(ready && schema.phase === 'degraded' ? { degraded: true } : {}),
      ...(reasons.length ? { reasons } : {}),
      commit: getBuildIdentity().commit ?? undefined,
      checks: {
        database: { status: base.status, responseTime: base.responseTime },
        schema: {
          phase: schema.phase,
          pendingCritical: schema.pendingCritical,
          pendingOptional: schema.pendingOptional,
          ...(schema.firstFailure ? { firstFailure: schema.firstFailure } : {}),
        },
      },
      timestamp: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: NO_STORE_HEADERS },
  );
}
