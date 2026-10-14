/**
 * POST /api/admin/ai/config-versions/[id]/promote — SUPPRIMÉ (lot 54).
 *
 * Le statut « À tester » n'existe plus : une version est active ou non, et
 * la version active reste modifiable. Rend 410 avec le geste de remplacement.
 */
import { NextRequest } from 'next/server';
import { requireAdminContext, removedWorkflow } from '../../_shared';

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  return removedWorkflow('Mettre à l’essai', 'utilisez « Activer en préproduction » sur la version.');
}
