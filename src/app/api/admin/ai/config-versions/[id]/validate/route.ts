/**
 * POST /api/admin/ai/config-versions/[id]/validate — SUPPRIMÉ (lot 54).
 *
 * Plus d'étape « Validé » : l'activation suffit. Rend 410.
 */
import { NextRequest } from 'next/server';
import { requireAdminContext, removedWorkflow } from '../../_shared';

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  return removedWorkflow('Valider et activer', 'utilisez « Activer en préproduction » sur la version.');
}
