/**
 * POST /api/admin/ai/provider/[id]/activate — CDC BO IA SCR-10, WF-21.
 *
 * N'active qu'une candidate dont le dernier test est un succès. Le contrôle est
 * dans la condition SQL, pas lu puis vérifié : entre la lecture et l'écriture,
 * un second test pourrait avoir échoué.
 *
 * En cas de refus, l'ancienne clé reste active — c'est la règle du WF-21, et
 * c'est ce qui évite qu'une rotation ratée coupe toute l'IA de l'environnement.
 */
import { NextRequest, NextResponse } from 'next/server';
import { activateCandidate } from '@/services/ai/provider/credential.repository';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const credentialId = parseVersionId(id);
  if (credentialId === null) return invalidId(id);

  try {
    const r = await activateCandidate(credentialId, guard.ctx.adminUserId);
    if (!r.activated) {
      return NextResponse.json(
        {
          error: 'TEST_REQUIRED',
          message: 'Cette clé doit passer un test de connexion réussi avant d’être activée. '
            + 'La clé actuelle reste en service.',
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ activated: true, retiredId: r.previousId });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/provider/[id]/activate');
  }
}
