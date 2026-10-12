import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { detectCrossAccountRelations } from '@/services/security/cross-account/detection';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/cross-account — contrôle « Relations intercomptes »
 * (lot 49, ticket SEC-P0 §5) pour BO › Exploitation : nombre par type,
 * comptes concernés, identifiants techniques. LECTURE SEULE (transaction
 * READ ONLY) : rien n'est corrigé ni supprimé. Administrateur seulement.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    return NextResponse.json(await detectCrossAccountRelations(), { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'relations intercomptes', 'OPS_CROSS_ACCOUNT_FAILED');
  }
}
