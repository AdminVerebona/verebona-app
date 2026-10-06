import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { getConfigReport } from '@/services/admin/ops/env-catalog';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/config — variables attendues (`.env.example`) :
 * présentes ou absentes, niveau, courte explication ; variables retirées
 * encore posées. NOMS SEULEMENT, jamais de valeur (lot 25).
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    return NextResponse.json(await getConfigReport(), { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'configuration', 'OPS_CONFIG_FAILED');
  }
}
