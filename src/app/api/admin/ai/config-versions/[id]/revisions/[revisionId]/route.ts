/**
 * GET /api/admin/ai/config-versions/[id]/revisions/[revisionId] — lot 54.
 *
 * Contenu COMPLET d'une révision (instantané) et ses écarts avec le dernier
 * état enregistré de la version — à consulter avant de la restaurer.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRevision, getVersion } from '@/services/ai/config/config-version.repository';
import { diffVersions, renderDiff } from '@/services/ai/config/config-diff.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../_shared';

type Ref = { versionNumber: number } | null | undefined;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; revisionId: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id, revisionId } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);
  const revId = parseVersionId(revisionId);
  if (revId === null) return invalidId(revisionId);

  try {
    const [rev, version] = await Promise.all([getRevision(revId), getVersion(versionId)]);
    if (!rev || !version || rev.versionId !== versionId) {
      return NextResponse.json({ error: 'REVISION_NOT_FOUND', message: 'Révision introuvable pour cette version.' }, { status: 404 });
    }
    const diff = diffVersions(version.entries, rev.snapshot.entries);
    const courants = (version.masterPrompts ?? {}) as Record<string, Ref>;
    const figes = rev.snapshot.masterPrompts as Record<string, Ref>;
    const masterPromptChanges = [...new Set([...Object.keys(courants), ...Object.keys(figes)])]
      .map((t) => {
        const avant = courants[t] ?? null;
        const apres = figes[t] ?? null;
        return { treatment: t, current: avant ? `v${avant.versionNumber}` : null, revision: apres ? `v${apres.versionNumber}` : null };
      })
      .filter((c) => c.current !== c.revision);
    return NextResponse.json({
      revision: rev,
      isCurrent: version.currentRevisionId === rev.id,
      diffWithCurrent: { ...diff, text: renderDiff(diff), masterPromptChanges },
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-versions/[id]/revisions/[revisionId]');
  }
}
