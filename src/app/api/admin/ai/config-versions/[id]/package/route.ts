/**
 * POST /api/admin/ai/config-versions/[id]/package — SUPPRIMÉ (lot 54).
 *
 * Plus aucun mécanisme de publication vers la production : la configuration
 * active s'exporte en un fichier autonome (« Exporter la configuration »,
 * POST /api/admin/ai/config-exports), qui sert au paramétrage indépendant de
 * la production. Rend 410.
 */
import { NextRequest } from 'next/server';
import { requireAdminContext, removedWorkflow } from '../../_shared';

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  return removedWorkflow('Préparer pour MEP', 'utilisez « Exporter la configuration ».');
}
