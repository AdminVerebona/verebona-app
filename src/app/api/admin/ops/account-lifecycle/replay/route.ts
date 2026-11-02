import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { guardAdmin, NO_STORE, opsError } from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/ops/account-lifecycle/replay — lot 102A : REJOUE les
 * suppressions de compte du registre après une restauration (un compte
 * supprimé après le point de sauvegarde ne doit jamais réapparaître).
 *
 * Corps : `{ confirm: true }` (registre en base) ou
 * `{ confirm: true, registry: <fichier téléchargé avant la restauration> }`
 * (restauration par l'hébergeur : le registre en base a été remonté dans le
 * temps). Même moteur de purge que la suppression d'origine ; idempotent.
 * Journalisé. Administrateurs seulement.
 */
export async function POST(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  let body: { confirm?: unknown; registry?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400, headers: NO_STORE });
  }
  if (body.confirm !== true) {
    return NextResponse.json({ error: 'Confirmation requise.', code: 'CONFIRMATION_REQUIRED' }, { status: 400, headers: NO_STORE });
  }
  try {
    const { parseRegistryEntries, replayDeletionRegistry } = await import('@/services/account/deletion-registry.service');
    let entries;
    if (body.registry !== undefined) {
      try {
        entries = parseRegistryEntries(body.registry);
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message, code: 'REGISTRY_INVALID' }, { status: 400, headers: NO_STORE });
      }
    }
    const report = await replayDeletionRegistry({ entries });
    await logAdminAction({
      adminId: g.adminId, action: 'DELETION_REGISTRY_REPLAY', targetType: 'DELETION_REGISTRY', targetId: null,
      result: report.failures.length > 0 ? 'FAILURE' : 'SUCCESS',
      details: { examined: report.examined, replayed: report.replayed, imported: report.imported, failures: report.failures.length, fromFile: entries !== undefined },
    });
    return NextResponse.json({ report }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'rejeu des suppressions', 'DELETION_REGISTRY_REPLAY_FAILED');
  }
}
