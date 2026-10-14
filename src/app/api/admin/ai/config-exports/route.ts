/**
 * /api/admin/ai/config-exports — lot 54 (54C), « Exporter la configuration ».
 *
 * GET  : configuration active (version, révision), dernier export et si la
 *        configuration a changé depuis ; historique des exports (date,
 *        version, révision, auteur, empreinte SHA-256 du fichier).
 * POST : construit À L'INSTANT le fichier de la configuration active
 *        enregistrée (dernière révision), le valide, l'enregistre (texte exact,
 *        immuable) et le rend : `{ fileName, content, export, warnings }`.
 *        Aucune active : 409 NO_ACTIVE_VERSION. Fichier invalide : 422
 *        EXPORT_INVALID, rien n'est enregistré ni rendu. Ne modifie pas la
 *        version active ; aucune opération en production.
 */
import { NextRequest, NextResponse } from 'next/server';
import { exportActiveConfiguration, exportStatus, listExports } from '@/services/ai/config/config-export.service';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const environment = getAiEnvironment();
    const [status, exports] = await Promise.all([exportStatus(environment), listExports(environment, 20)]);
    return NextResponse.json({ environment, ...status, exports });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-exports');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const r = await exportActiveConfiguration(guard.ctx.adminUserId);
    return NextResponse.json({
      fileName: r.record.fileName, content: r.content, export: r.record, warnings: r.warnings,
    }, { status: 201 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-exports');
  }
}
