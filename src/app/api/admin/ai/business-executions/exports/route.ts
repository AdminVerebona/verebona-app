/**
 * Exports groupés et volumineux des exécutions IA — lot 84D (CDC Pilotage IA
 * V2 P3 : EXP-01 à EXP-05, R27, R28, R63, R64 ; décision PO 15).
 *
 *   GET  : générations (suivi `admin_export_generations`, kind
 *          AI_EXECUTIONS_EXPORT : statut, totaux, signe de vie, interruption)
 *          et droit de l'administrateur courant aux contenus sensibles ;
 *   POST : { mêmes paramètres que le journal (`days` | `from`/`to`, `treatment`,
 *          `outcome`, `nature`, `origin`, `accountId`), contenusSensibles? }
 *          → 202 { generationId } : génération EN TÂCHE DE FOND (mêmes
 *          exécutions que la carte / la liste filtrée), fichiers stockés ;
 *          409 si un export est déjà en cours ; 403 si les contenus sensibles
 *          sont demandés sans l'habilitation existante — refus journalisé ;
 *          503 sans stockage.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';
import { parseJournalFilter } from '@/services/ai/business-execution/journal';
import { isModelOutputAccessAllowed } from '@/services/ai/telemetry/model-output-access';
import { logAdminAction } from '@/lib/admin-audit';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const { listGenerations } = await import('@/services/admin/export-generations');
    const sp = req.nextUrl.searchParams;
    const r = await listGenerations({ kind: 'AI_EXECUTIONS_EXPORT', page: Number(sp.get('page') ?? 1) || 1, pageSize: Number(sp.get('pageSize') ?? 10) || 10 });
    return NextResponse.json({ ...r, canIncludeSensitiveContent: isModelOutputAccessAllowed(guard.ctx.adminUserId) }, { headers: NO_STORE });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/business-executions/exports');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sensitive = body?.contenusSensibles === true;
  const params = new URLSearchParams();
  for (const k of ['days', 'from', 'to', 'treatment', 'outcome', 'nature', 'origin', 'accountId']) {
    const v = body?.[k];
    if (typeof v === 'string' || typeof v === 'number') params.set(k, String(v));
  }
  const f = parseJournalFilter(params);
  if (sensitive && !isModelOutputAccessAllowed(guard.ctx.adminUserId)) {
    await logAdminAction({
      adminId: guard.ctx.adminUserId, action: 'AI_EXECUTIONS_EXPORT', targetType: 'AI_EXECUTIONS_EXPORT', targetId: null, result: 'DENIED',
      details: { scope: 'groupe', contenusSensibles: true, code: 'SENSITIVE_CONTENT_FORBIDDEN', perimetre: Object.fromEntries(params) },
    });
    return NextResponse.json({ error: 'Contenus sensibles réservés aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).', code: 'SENSITIVE_CONTENT_FORBIDDEN' }, { status: 403, headers: NO_STORE });
  }
  const { isS3Configured } = await import('@/lib/s3-config');
  if (!isS3Configured()) return NextResponse.json({ error: 'Stockage OVH non configuré : export impossible.', code: 'STORAGE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  const { startExecutionsExport, ExecutionsExportBusyError } = await import('@/services/ai/business-execution/export');
  try {
    const r = await startExecutionsExport({ id: guard.ctx.adminUserId }, f, { sensitive });
    return NextResponse.json(r, { status: 202, headers: NO_STORE });
  } catch (e) {
    if (e instanceof ExecutionsExportBusyError) return NextResponse.json({ error: e.message, code: e.code, activeId: e.activeId }, { status: 409, headers: NO_STORE });
    return toErrorResponse(e, 'POST /api/admin/ai/business-executions/exports');
  }
}
