/**
 * Export diagnostic des exécutions IA — lot 84D (CDC Pilotage IA V2 P3 :
 * EXP-01 à EXP-05, R27, R28, R63, R64 ; décision PO 15) et carte #802
 * (« un seul ZIP complet et vérifiable, ou un blocage explicite »).
 *
 *   GET  : générations (suivi `admin_export_generations`, kind
 *          AI_EXECUTIONS_EXPORT : statut, totaux, signe de vie, interruption),
 *          droit de l'administrateur courant aux contenus sensibles et
 *          limites techniques en vigueur ;
 *   POST : { scope: 'executions' | 'calls', filtres ACTIFS de l'écran,
 *          contenusSensibles?, action?: 'precheck' }
 *          · filtres lus STRICTEMENT (`parseExportSelection`) : un filtre
 *            inconnu, illisible ou sans traduction → 422 FILTER_NOT_SUPPORTED,
 *            rien n'est lancé (jamais un export plus large ou plus étroit) ;
 *          · `action: 'precheck'` → 200 : précontrôle seul (nombre attendu,
 *            taille estimée, limites, annonces, refus éventuel) — ne crée rien ;
 *          · sinon → précontrôle refait côté serveur, puis 202
 *            { generationId, precheck } : génération EN TÂCHE DE FOND ;
 *            422 SELECTION_TOO_LARGE (message de la carte, cause et limite)
 *            si le précontrôle est négatif — aucune génération créée ;
 *          409 si un export est déjà en cours ; 403 si les contenus sensibles
 *          sont demandés sans l'habilitation existante — refus journalisé ;
 *          503 sans stockage.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../config-versions/_shared';
import { parseExportSelection, unsupportedMessage } from '@/services/ai/business-execution/export-selection';
import { executionsExportLimits } from '@/services/ai/business-execution/export-settings';
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
    return NextResponse.json({ ...r, canIncludeSensitiveContent: isModelOutputAccessAllowed(guard.ctx.adminUserId), limits: executionsExportLimits() }, { headers: NO_STORE });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/business-executions/exports');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sensitive = body?.contenusSensibles === true;
  const precheckOnly = body?.action === 'precheck';
  const sel = parseExportSelection(body && typeof body === 'object' ? body : {});
  const refus = (result: 'DENIED' | 'FAILURE', details: Record<string, unknown>) => logAdminAction({
    adminId: guard.ctx.adminUserId, action: 'AI_EXECUTIONS_EXPORT', targetType: 'AI_EXECUTIONS_EXPORT', targetId: null, result,
    details: { scope: 'groupe', contenusSensibles: sensitive, ...details },
  });
  if (!sel.ok) {
    // Filtre non traduisible : blocage AVANT lancement, dit en clair (jamais un export plus large ou plus étroit).
    if (!precheckOnly) await refus('DENIED', { code: 'FILTER_NOT_SUPPORTED', filtres: sel.unsupported });
    return NextResponse.json({ error: unsupportedMessage(sel.unsupported), code: 'FILTER_NOT_SUPPORTED', unsupported: sel.unsupported }, { status: 422, headers: NO_STORE });
  }
  if (sensitive && !isModelOutputAccessAllowed(guard.ctx.adminUserId)) {
    await refus('DENIED', { code: 'SENSITIVE_CONTENT_FORBIDDEN', perimetre: sel.selection.params });
    return NextResponse.json({ error: 'Contenus sensibles réservés aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).', code: 'SENSITIVE_CONTENT_FORBIDDEN' }, { status: 403, headers: NO_STORE });
  }
  const { isS3Configured } = await import('@/lib/s3-config');
  if (!isS3Configured()) return NextResponse.json({ error: 'Stockage OVH non configuré : export impossible.', code: 'STORAGE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  const ex = await import('@/services/ai/business-execution/export');
  try {
    if (precheckOnly) {
      const precheck = await ex.precheckExecutionsExport(sel.selection, { sensitive });
      return NextResponse.json({ precheck }, { status: 200, headers: NO_STORE });
    }
    const r = await ex.startExecutionsExport({ id: guard.ctx.adminUserId }, sel.selection, { sensitive });
    return NextResponse.json(r, { status: 202, headers: NO_STORE });
  } catch (e) {
    if (e instanceof ex.ExecutionsExportBusyError) return NextResponse.json({ error: e.message, code: e.code, activeId: e.activeId }, { status: 409, headers: NO_STORE });
    if (e instanceof ex.ExportPrecheckRefusedError) {
      return NextResponse.json({ error: e.message, code: 'SELECTION_TOO_LARGE', cause: e.precheck.refusal?.cause ?? null, refusalCode: e.precheck.refusal?.code ?? null, precheck: e.precheck }, { status: 422, headers: NO_STORE });
    }
    return toErrorResponse(e, 'POST /api/admin/ai/business-executions/exports');
  }
}
