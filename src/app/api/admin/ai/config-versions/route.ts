/**
 * /api/admin/ai/config-versions — CDC BO IA WF-01, SCR-01.
 *
 * GET  : liste les versions de l'environnement, la plus récente d'abord.
 * POST : crée un Brouillon dérivé de l'Active (WF-01).
 *
 * Plusieurs Brouillons peuvent coexister (VER-001) : la création n'en vérifie
 * aucun autre. C'est voulu — deux administrateurs préparent parfois deux
 * évolutions distinctes, et les faire se marcher dessus n'aiderait personne.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listVersions, getActiveVersion } from '@/services/ai/config/config-version.repository';
import { startDraft } from '@/services/ai/config/config-version.service';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { requireAdminContext, toErrorResponse } from './_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    const environment = getAiEnvironment();
    const [versions, active] = await Promise.all([
      listVersions(environment),
      getActiveVersion(environment),
    ]);

    return NextResponse.json({
      environment,
      activeVersionId: active?.id ?? null,
      versions,
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-versions');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    const body = await req.json().catch(() => ({}));
    const label = typeof body.label === 'string' && body.label.trim() !== ''
      ? body.label.trim().slice(0, 200)
      : null;

    const draft = await startDraft(guard.ctx.adminUserId, label ?? undefined);
    return NextResponse.json(draft, { status: 201 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions');
  }
}
