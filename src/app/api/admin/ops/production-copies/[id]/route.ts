import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE, opsError } from '../../_shared';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/admin/ops/production-copies/[id] — lot 102C.
 *   { action: 'close', reason }    annule une autorisation non utilisée, ou
 *                                  clôt une copie de base détectée à tort ;
 *   { action: 'purge-now', reason } avance l'échéance d'une copie active à
 *                                  maintenant (purge au prochain passage de
 *                                  la tâche quotidienne `daily-production-copies`).
 * Motif obligatoire ; journal d'audit `PRODUCTION_COPY_CLOSE`.
 */
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const id = Number((await ctx.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ code: 'INVALID_ID', message: 'Identifiant invalide.' }, { status: 400, headers: NO_STORE });
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body?.action;
  if (action !== 'close' && action !== 'purge-now') {
    return NextResponse.json({ code: 'INVALID_ACTION', message: 'Action attendue : close ou purge-now.' }, { status: 400, headers: NO_STORE });
  }
  try {
    const { pgClient } = await import('@/db');
    const [admin] = await pgClient<{ email: string }[]>`SELECT email FROM users WHERE id = ${g.adminId}`;
    const { closeProductionCopy, ProductionCopyError } = await import('@/services/admin/production-copies/production-copies.service');
    try {
      const copy = await closeProductionCopy({
        id, reason: typeof body?.reason === 'string' ? body.reason : '', purgeNow: action === 'purge-now',
        admin: { id: g.adminId, email: admin?.email ?? `user:${g.adminId}` },
      });
      return NextResponse.json({ copy }, { headers: NO_STORE });
    } catch (e) {
      if (e instanceof ProductionCopyError) return NextResponse.json({ code: e.code, message: e.message }, { status: e.status, headers: NO_STORE });
      throw e;
    }
  } catch (e) {
    return opsError(e, 'copies de données réelles (clôture)', 'PRODUCTION_COPY_CLOSE_FAILED');
  }
}
