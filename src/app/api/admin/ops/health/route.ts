import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { getAdminHealth } from '@/services/admin/ops/health-admin.service';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/health — diagnostic DÉTAILLÉ de `/api/health` pour
 * l'administrateur connecté (page « Exploitation », lot 25) : sa session
 * suffit, aucun jeton `x-health-token` n'est demandé ni lu. Compléments :
 * migrations et index, variables retirées (noms), identité du déploiement.
 * Aucun secret, aucune valeur de variable, aucune URL signée.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    return NextResponse.json(await getAdminHealth(), { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'santé', 'OPS_HEALTH_FAILED');
  }
}
