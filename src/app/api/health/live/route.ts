import { NextResponse } from 'next/server';
import { getBuildIdentity } from '@/lib/runtime-identity';
import { NO_STORE_HEADERS } from '@/lib/health/probes';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health/live — VITALITÉ (APP-PERF-37).
 *
 * Aucune entrée/sortie : ni base, ni stockage, ni migration. Toujours 200
 * tant que le processus répond. Une dépendance en panne ne doit jamais
 * déclencher de redémarrage : c'est le rôle de `/api/health/ready` de retirer
 * l'instance du trafic. Expose l'identité du déploiement (commit Scalingo).
 */
export function GET() {
  const id = getBuildIdentity();
  return NextResponse.json(
    {
      status: 'ok',
      version: id.version,
      commit: id.commit ?? undefined,
      commitSource: id.commitSource ?? undefined,
      container: id.container ?? undefined,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: NO_STORE_HEADERS },
  );
}
