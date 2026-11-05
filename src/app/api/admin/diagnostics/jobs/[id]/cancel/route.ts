import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { guardAdmin, NO_STORE } from '../../../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/diagnostics/jobs/:id/cancel — lot 107G : annule un
 * diagnostic en file (CANCELLED immédiat) ou demande l'arrêt d'un diagnostic
 * en cours (lot 111C : le worker la lit en quelques secondes, interrompt la
 * requête SQL en cours, s'arrête à la prochaine écriture, fichiers et envois
 * incomplets supprimés, CANCELLED motif ADMIN_CANCELLED). Journalisé ; jamais
 * mis en cache.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return NextResponse.json({ error: 'Diagnostic introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const { cancelDiagnosticJob } = await import('@/services/admin/diagnostic-jobs/repository');
  const r = await cancelDiagnosticJob(id, g.adminId);
  await logAdminAction({
    adminId: g.adminId, adminEmail, action: 'TECH_DIAGNOSTIC_JOB', targetType: 'TECH_DIAGNOSTIC', targetId: null,
    result: r === 'CANCELLED' || r === 'REQUESTED' ? 'SUCCESS' : 'FAILURE', details: { operation: 'cancel', jobId: id, outcome: r },
  });
  if (r === 'NOT_FOUND') return NextResponse.json({ error: 'Diagnostic introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
  if (r === 'NOT_ACTIVE') return NextResponse.json({ error: 'Génération déjà terminée.', code: 'NOT_ACTIVE' }, { status: 409, headers: NO_STORE });
  return NextResponse.json({ jobId: id, outcome: r }, { status: 202, headers: NO_STORE });
}
