/**
 * GET /api/admin/ai/config-versions/[id] — CDC BO IA SCR-02 à SCR-06.
 *
 * Rend la version et ses cinq traitements. C'est ce que chargent les onglets
 * T1 à T5, qui pointent tous vers la même version globale (WF-01, GEN-002).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getVersion } from '@/services/ai/config/config-version.repository';
import { isExecutable } from '@/services/ai/config/version-state-machine';
import { unavailableModels } from '@/services/ai/config/config-validation.service';
import { GEMINI_PUBLIC_CATALOG } from '@/services/ai/gateway/pricing/gemini-public-catalog';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const version = await getVersion(versionId);
    if (!version) {
      return NextResponse.json({ error: 'VERSION_NOT_FOUND' }, { status: 404 });
    }

    return NextResponse.json({
      ...version,
      // L'écran doit distinguer « en lecture seule » de « en cours d'exécution » :
      // une Active est les deux, un Brouillon ni l'un ni l'autre, et une version
      // « À tester » s'exécute en préproduction sans être une Active.
      readOnly: version.status !== 'DRAFT',
      executing: isExecutable(version.status, getAiEnvironment()),
      // Calculé, jamais stocké : une marque posée en base se périmerait, et une
      // marque fausse est pire qu'une absence de marque. N'exclut rien — elle
      // nomme le problème pour que l'administrateur décide.
      unavailableModels: unavailableModels(
        version.entries,
        new Set(GEMINI_PUBLIC_CATALOG.map((e) => e.model)),
      ),
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-versions/[id]');
  }
}
