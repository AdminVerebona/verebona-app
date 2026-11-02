import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/account-lifecycle — lot 102A : BO › Exploitation ›
 * « Cycle de vie des comptes ». Supervision des états restreints (par motif :
 * purges programmées, à 7 jours, en retard, exécutées / annulées / en échec
 * sur 30 jours), suppressions demandées au-delà du plafond technique, durées
 * en vigueur, dernières entrées du registre des suppressions (identifiants
 * internes seulement). Lecture seule. Administrateurs seulement.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const [{ getLifecycleSupervision }, { latestRegistryEntries, registryRetentionDays }, { LIFECYCLE_DURATIONS }] = await Promise.all([
      import('@/services/account/restricted-state.service'),
      import('@/services/account/deletion-registry.service'),
      import('@/lib/account-lifecycle/retention-policy'),
    ]);
    const [supervision, latest] = await Promise.all([getLifecycleSupervision(), latestRegistryEntries(20)]);
    return NextResponse.json({
      supervision,
      durations: { ...LIFECYCLE_DURATIONS, registryRetentionDays: registryRetentionDays() },
      latest,
      generatedAt: new Date().toISOString(),
    }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'cycle de vie des comptes (lecture)', 'ACCOUNT_LIFECYCLE_LOAD_FAILED');
  }
}
