/**
 * POST /api/admin/ai/provider/[id]/reveal — CDC BO IA SCR-10.
 *
 * Rend le secret en clair, sur demande explicite.
 *
 * ── POURQUOI UNE ROUTE, ET POURQUOI EN POST ────────────────────────────────
 * Le SCR-10 autorise l'affichage en clair. Le faire dans la route de liste
 * enverrait pourtant le credential à chaque chargement de l'écran — dans les
 * caches, les outils de développement ouverts, les captures d'écran.
 *
 * Une route séparée fait de la révélation un geste, et un POST évite qu'elle
 * atterrisse dans un historique de navigation ou un journal d'accès, comme le
 * ferait une URL en GET.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSecret } from '@/services/ai/provider/credential.repository';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const credentialId = parseVersionId(id);
  if (credentialId === null) return invalidId(id);

  try {
    const secret = await getSecret(credentialId);
    if (!secret) return NextResponse.json({ error: 'CREDENTIAL_NOT_FOUND' }, { status: 404 });

    console.info(`[provider] Clé ${credentialId} révélée par l'administrateur ${guard.ctx.adminUserId}.`);
    return NextResponse.json({ secret });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/provider/[id]/reveal');
  }
}
