/**
 * Lot 104A (P1-F) — propagation des suppressions de production vers les copies
 * de données réelles (BO › Exploitation › Sauvegardes et recette ›
 * « Copies de données réelles »).
 *
 * GET  : configuration (clé et adresse présentes — jamais leur valeur), état
 *        du dernier échange, « prête » ou non (condition d'import).
 * POST : « Vérifier la propagation » — lit les suppressions de production et
 *        purge les comptes copiés correspondants (même fonction que la tâche
 *        `production-deletion-signals`). Journal d'administration.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE, opsError } from '../../_shared';

export const dynamic = 'force-dynamic';

async function snapshot() {
  const [svc, signals] = await Promise.all([
    import('@/services/admin/production-copies/deletion-propagation.service'),
    import('@/services/admin/production-copies/deletion-signals'),
  ]);
  const [state, readiness] = await Promise.all([svc.readPropagationState(), svc.deletionPropagationReadiness()]);
  return {
    keyStatus: signals.signalKeyStatus(),
    sourceConfigured: signals.signalSourceUrl() !== null,
    maxAgeHours: signals.readinessMaxAgeHours(),
    state,
    readiness,
  };
}

export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    return NextResponse.json(await snapshot(), { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'propagation des suppressions (lecture)', 'DELETION_PROPAGATION_READ_FAILED');
  }
}

export async function POST(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const { syncProductionDeletionSignals } = await import('@/services/admin/production-copies/deletion-propagation.service');
    const report = await syncProductionDeletionSignals({ trigger: 'bo' });
    const { pgClient } = await import('@/db');
    const [admin] = await pgClient<{ email: string }[]>`SELECT email FROM users WHERE id = ${g.adminId}`;
    const { logAdminAction } = await import('@/lib/admin-audit');
    await logAdminAction({
      adminId: g.adminId, adminEmail: admin?.email ?? `user:${g.adminId}`, action: 'PRODUCTION_COPY_DELETION_SYNC', targetType: 'PRODUCTION_COPY',
      targetId: null, result: report.issues.length === 0 ? 'SUCCESS' : 'FAILURE',
      details: { status: report.status, entries: report.entries, matched: report.matched, purged: report.purged, failed: report.failed, issues: report.issues.map((i) => i.code) },
    });
    return NextResponse.json({ report, ...(await snapshot()) }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'propagation des suppressions (vérification)', 'DELETION_PROPAGATION_SYNC_FAILED');
  }
}
