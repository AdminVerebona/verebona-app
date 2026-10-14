/**
 * POST /api/admin/ai/config-packages/import — SUPPRIMÉ (lot 54).
 *
 * Plus aucun mécanisme de publication ou de déploiement de configuration
 * entre environnements depuis le BO : la production se paramètre
 * indépendamment, à partir du fichier « Exporter la configuration ». Les
 * packages déjà préparés restent consultables (GET /config-packages). 410.
 */
import { NextRequest } from 'next/server';
import { requireAdminContext, removedWorkflow } from '../../config-versions/_shared';

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  return removedWorkflow('Importer un package', 'la production se paramètre à partir du fichier « Exporter la configuration ».');
}
