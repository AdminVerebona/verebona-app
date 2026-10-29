import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { getMobileOpsReport } from '@/services/admin/ops/mobile-ops.service';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/mobile — lot 97 : configuration effective de
 * l'application mobile, fichiers d'association, fournisseur push (configuré
 * ou non — jamais une valeur secrète), appareils et livraisons récentes.
 * Lecture seule.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    return NextResponse.json(await getMobileOpsReport(), { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'application mobile', 'OPS_MOBILE_FAILED');
  }
}
