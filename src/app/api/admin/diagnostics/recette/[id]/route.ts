import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE } from '../../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/diagnostics/recette/:id — lot 82E : une génération d'export
 * de recette (suivi) et, une fois terminée, son manifeste stocké (fichiers,
 * lignes attendues / exportées, SHA-256, totaux par table) et la liste des
 * fichiers téléchargeables. Administrateurs seulement ; jamais mis en cache.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const { id } = await params;
  const { getGeneration } = await import('@/services/admin/export-generations');
  const gen = await getGeneration(id).catch(() => null);
  if (!gen || gen.kind !== 'RECETTE_EXPORT') return NextResponse.json({ error: 'Export introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
  const [{ readRecetteManifest }, { recetteDownloadables }] = await Promise.all([
    import('@/services/admin/diagnostics-export/recette'), import('@/services/admin/diagnostics-export/recette-download'),
  ]);
  try {
    const manifest = gen.status === 'RUNNING' ? null : await readRecetteManifest(id);
    return NextResponse.json({ generation: gen, manifest, downloadables: recetteDownloadables(manifest) }, { headers: NO_STORE });
  } catch (e) {
    console.error('[admin/recette] détail :', (e as Error)?.message ?? e);
    return NextResponse.json({ generation: gen, manifest: null, downloadables: [], error: 'Manifeste illisible dans le stockage.' }, { headers: NO_STORE });
  }
}
