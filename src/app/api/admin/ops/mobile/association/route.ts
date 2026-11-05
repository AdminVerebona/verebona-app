import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { checkCredentialAssociation } from '@/services/admin/ops/credential-association';
import { guardAdmin, NO_STORE, opsError } from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/mobile/association — lot 111E : contrôle « Association
 * iOS / Android » (remplissage automatique des mots de passe). Relit les
 * variables (NOMS manquants, jamais une valeur secrète) et interroge les
 * fichiers /.well-known publics de l'environnement et la copie du CDN Apple.
 * Lecture seule.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    return NextResponse.json(await checkCredentialAssociation(), { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'association iOS / Android', 'OPS_MOBILE_ASSOCIATION_FAILED');
  }
}
