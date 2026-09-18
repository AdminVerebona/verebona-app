/**
 * GET /api/admin/ai/config-versions/[id]/diff — CDC BO IA VER-003, WF-02.
 *
 * Diff complet contre l'Active de l'environnement, accompagné des contrôles.
 * Le WF-02 affiche les deux sur le même écran avant de demander confirmation :
 * les rendre ensemble évite un second aller-retour, et surtout évite d'afficher
 * un diff sans dire qu'il ne passera pas les contrôles.
 */
import { NextRequest, NextResponse } from 'next/server';
import { diffAgainstActive, checkVersion } from '@/services/ai/config/config-version.service';
import { renderDiff } from '@/services/ai/config/config-diff.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const { diff, version, active } = await diffAgainstActive(versionId);
    const validation = await checkVersion(versionId);

    return NextResponse.json({
      versionId: version.id,
      versionStatus: version.status,
      activeVersionId: active?.id ?? null,
      activeVisibleNumber: active?.visibleNumber ?? null,
      diff,
      text: renderDiff(diff),
      validation,
      // Ce que l'écran doit savoir avant de proposer le bouton : promouvoir une
      // version identique à l'Active n'a pas d'objet, et une version en échec
      // de contrôle ne transitera pas (WF-02).
      promotable: !diff.identical && validation.valid && version.status === 'DRAFT',
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-versions/[id]/diff');
  }
}
