/**
 * Une génération d'export des exécutions IA — lot 84D (EXP-03, EXP-04, R28, R64).
 *
 *   GET  : suivi (statut, signe de vie, interruption, point de reprise) et,
 *          une fois terminée, le manifeste stocké (fichiers, attendu /
 *          exporté, SHA-256, volumes ZIP) et les fichiers téléchargeables ;
 *   POST { action: 'resume' } : REPRISE d'une génération interrompue à son
 *          dernier point de reprise (droits revérifiés, journalisée) ;
 *          409 si elle est encore en cours ou terminée.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';
import type { ExportResumeState } from '@/services/ai/business-execution/export-model';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    const gen = await import('@/services/admin/export-generations');
    const g = await gen.getGeneration(id).catch(() => null);
    if (!g || g.kind !== 'AI_EXECUTIONS_EXPORT') return NextResponse.json({ error: 'Export introuvable.', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
    const st = await gen.readResumeState<ExportResumeState>(id);
    const { readExecutionsManifest, executionsDownloadables } = await import('@/services/ai/business-execution/export');
    const manifest = g.status === 'RUNNING' || !st?.done ? null : await readExecutionsManifest(id).catch(() => null);
    return NextResponse.json({
      generation: g, manifest, downloadables: executionsDownloadables(manifest),
      resume: st ? { cursorAt: st.cursorAt, partsWritten: st.nextPart - 1, executionsWritten: st.totals.executions.exported, done: st.done, resumes: st.resumes.length } : null,
      resumable: !!st && !st.done && (g.status !== 'RUNNING' || g.interrupted),
    }, { headers: NO_STORE });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/business-executions/exports/[id]');
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: unknown };
  if (body?.action !== 'resume') return NextResponse.json({ error: 'Action inconnue.', code: 'INVALID_ACTION' }, { status: 400, headers: NO_STORE });
  const { resumeExecutionsExport, ExportNotResumableError, ExecutionsExportBusyError } = await import('@/services/ai/business-execution/export');
  try {
    const r = await resumeExecutionsExport({ id: guard.ctx.adminUserId }, id);
    return NextResponse.json(r, { status: 202, headers: NO_STORE });
  } catch (e) {
    if (e instanceof ExportNotResumableError) {
      const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'SENSITIVE_CONTENT_FORBIDDEN' ? 403 : 409;
      return NextResponse.json({ error: e.message, code: e.code }, { status, headers: NO_STORE });
    }
    if (e instanceof ExecutionsExportBusyError) return NextResponse.json({ error: e.message, code: e.code, activeId: e.activeId }, { status: 409, headers: NO_STORE });
    return toErrorResponse(e, 'POST /api/admin/ai/business-executions/exports/[id]');
  }
}
