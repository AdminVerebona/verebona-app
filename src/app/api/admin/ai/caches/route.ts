/**
 * Caches de l'assistant et de l'IA — CDC Assistant §32.6 (« consulter l'état
 * des caches », « invalider un cache »), §32.7, CA-30 ; lot 23.
 *
 *   GET  : inventaire (nature, version partagée, âge, volumes mesurables,
 *          dernière invalidation : date, auteur, motif).
 *   POST : { cacheId, reason } — invalidation sur toutes les instances,
 *          journalisée (`admin_audit_log`, AI_CACHE_INVALIDATE).
 *
 * Administrateurs du BO seulement. Aucun contenu utilisateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  CacheInvalidationRefused, getCachesState, invalidateAdminCache,
} from '@/services/ai/cache/cache-admin';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(await getCachesState());
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/caches');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => null)) as { cacheId?: unknown; reason?: unknown } | null;
  if (!body) return NextResponse.json({ error: 'INVALID_BODY', message: '`cacheId` et `reason` sont requis.' }, { status: 400 });
  try {
    const r = await invalidateAdminCache({ cacheId: body.cacheId, reason: body.reason, adminId: guard.ctx.adminUserId });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof CacheInvalidationRefused) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    return toErrorResponse(e, 'POST /api/admin/ai/caches');
  }
}
