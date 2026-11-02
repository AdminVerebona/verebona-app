import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { guardAdmin, NO_STORE, opsError } from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/account-lifecycle/registry — lot 102A : téléchargement
 * du registre des suppressions exécutées (JSON, identifiants internes
 * seulement), à faire AVANT une restauration de la base par l'hébergeur
 * (hors application) — docs/exploitation/procedure-restauration-suppressions.md.
 * Journalisé (journal d'administration). Administrateurs seulement.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const { exportDeletionRegistry } = await import('@/services/account/deletion-registry.service');
    const registry = await exportDeletionRegistry();
    await logAdminAction({
      adminId: g.adminId, action: 'DELETION_REGISTRY_DOWNLOAD', targetType: 'DELETION_REGISTRY', targetId: null,
      result: 'SUCCESS', details: { entries: registry.entries.length },
    });
    const stamp = registry.generatedAt.slice(0, 10);
    return new NextResponse(JSON.stringify({ schema: 'verebona.deletion-registry/1', ...registry }, null, 2), {
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="registre-suppressions-${stamp}.json"`,
      },
    });
  } catch (e) {
    return opsError(e, 'registre des suppressions (téléchargement)', 'DELETION_REGISTRY_EXPORT_FAILED');
  }
}
