import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * Lot 102C — copies de données réelles hors production (BO › Exploitation ›
 * Sauvegardes et recette › « Copies de données réelles »).
 *
 * GET  : registre (copies autorisées, actives, en purge, purgées, closes),
 *        environnement courant, durées paramétrées.
 * POST { backupId, reason } : AUTORISE explicitement l'import d'un point de
 *        restauration provenant d'un autre environnement (sinon refusé par
 *        défaut à la restauration). Motif obligatoire ; journal d'audit
 *        `PRODUCTION_COPY_AUTHORIZE`. Administrateurs seulement.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const [{ listProductionCopies }, rules] = await Promise.all([
      import('@/services/admin/production-copies/production-copies.service'),
      import('@/services/admin/production-copies/rules'),
    ]);
    const environment = rules.currentEnvironmentName();
    return NextResponse.json({
      items: await listProductionCopies(),
      environment,
      production: rules.isProductionEnvironment(environment),
      retentionDays: rules.copyRetentionDays(),
      authorizationHours: rules.authorizationValidityHours(),
    }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'copies de données réelles (lecture)', 'PRODUCTION_COPIES_LIST_FAILED');
  }
}

export async function POST(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const backupId = typeof body?.backupId === 'string' ? body.backupId.trim() : '';
  if (!/^[0-9a-f-]{8,64}$/i.test(backupId)) {
    return NextResponse.json({ code: 'INVALID_BACKUP_ID', message: 'Identifiant de point de restauration invalide.' }, { status: 400, headers: NO_STORE });
  }
  try {
    const { pgClient } = await import('@/db');
    const [admin] = await pgClient<{ email: string }[]>`SELECT email FROM users WHERE id = ${g.adminId}`;
    const { authorizeRestoreImport, ProductionCopyError } = await import('@/services/admin/production-copies/production-copies.service');
    try {
      const copy = await authorizeRestoreImport({
        backupId, reason: typeof body?.reason === 'string' ? body.reason : '', admin: { id: g.adminId, email: admin?.email ?? `user:${g.adminId}` },
      });
      return NextResponse.json({ copy }, { status: 201, headers: NO_STORE });
    } catch (e) {
      if (e instanceof ProductionCopyError) {
        return NextResponse.json({ code: e.code, message: e.message }, { status: e.status, headers: NO_STORE });
      }
      throw e;
    }
  } catch (e) {
    return opsError(e, 'copies de données réelles (autorisation)', 'PRODUCTION_COPY_AUTHORIZE_FAILED');
  }
}
