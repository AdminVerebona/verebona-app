/**
 * POST /api/admin/ai/config-versions/[id]/demote — SUPPRIMÉ (lot 54).
 *
 * Plus de version « À tester » ni de « Brouillon » : pour revenir en
 * arrière, réactiver une autre version ou restaurer une révision. Rend 410.
 */
import { NextRequest } from 'next/server';
import { requireAdminContext, removedWorkflow } from '../../_shared';

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  return removedWorkflow('Revenir en brouillon', 'réactivez une autre version ou restaurez une révision depuis l’historique.');
}
