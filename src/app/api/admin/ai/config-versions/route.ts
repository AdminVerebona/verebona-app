/**
 * /api/admin/ai/config-versions — lot 54 (54C), refonte des versions.
 *
 * GET  : versions de l'environnement (active d'abord), numéro, état, révision
 *        courante, dernière modification. `?deleted=only` : versions
 *        supprimées (récupérables).
 * POST : nouvelle version NON active — `{ label?, description? }` (copie de
 *        la configuration active), `{ sourceVersionId }` (dupliquer) ou
 *        `{ sourceRevisionId }` (repartir d'une révision, version supprimée
 *        comprise).
 */
import { NextRequest, NextResponse } from 'next/server';
import { listVersions, getActiveVersion } from '@/services/ai/config/config-version.repository';
import { createConfigVersion } from '@/services/ai/config/config-version.service';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { stateLabel } from '@/services/ai/config/version-state-machine';
import { requireAdminContext, toErrorResponse } from './_shared';

const texte = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;
const entier = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    const environment = getAiEnvironment();
    const deleted = new URL(req.url).searchParams.get('deleted') === 'only' ? 'only' : 'exclude';
    const [versions, active] = await Promise.all([
      listVersions(environment, 200, { deleted }),
      getActiveVersion(environment),
    ]);
    return NextResponse.json({
      environment,
      activeVersionId: active?.id ?? null,
      versions: versions.map((v) => ({ ...v, stateLabel: stateLabel(v.status, environment) })),
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-versions');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const version = await createConfigVersion(guard.ctx.adminUserId, {
      label: texte(body.label, 200),
      description: texte(body.description, 2000),
      sourceVersionId: entier(body.sourceVersionId),
      sourceRevisionId: entier(body.sourceRevisionId),
    });
    return NextResponse.json(version, { status: 201 });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions');
  }
}
