/**
 * POST /api/admin/ai/config-imports/preview — lot 86B (VER-07, DEC-03).
 *
 * `{ content }` → prévisualisation, SANS AUCUNE ÉCRITURE : identité du
 * fichier, traitements couverts, écarts avec l'active, modifications locales
 * écrasées, exclusions / gels levés, promotions remises à zéro, modèles
 * réautorisés, réglages non importés, contrôles (bloquants ou non) et
 * empreinte `base` à renvoyer à la confirmation. Format retiré ou illisible :
 * 422 avec un message explicite.
 */
import { NextRequest, NextResponse } from 'next/server';
import { previewImport } from '@/services/ai/config/config-import.service';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const body = (await req.json().catch(() => ({}))) as { content?: unknown };
    return NextResponse.json(await previewImport(typeof body.content === 'string' ? body.content : ''));
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-imports/preview');
  }
}
