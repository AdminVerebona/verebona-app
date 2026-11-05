import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { guardAdmin, NO_STORE } from '../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * Lot 107G — DIAGNOSTICS DURABLES (BO › Supervision › Diagnostics).
 *
 *   POST { scope, id?, reinforced? } (+ en-tête `Idempotency-Key`) →
 *        202 { jobId, status, duplicate, requestId } : la demande est
 *        ENREGISTRÉE (ligne QUEUED de `admin_export_generations`) et le
 *        worker est réveillé — RIEN n'est généré dans cette requête.
 *        Double clic ou requête rejouée (même clé) → même travail
 *        (`duplicate: true`) ; diagnostic ciblé identique en cours → même
 *        travail. Lot 111C : un diagnostic GLOBAL nouvellement demandé
 *        REMPLACE les demandes globales actives (`replaced`), et la réponse
 *        dit tout de suite pourquoi il attend (`wait` : worker désactivé,
 *        indisponible, autre diagnostic…) — avec alerte BO si la cause est
 *        une configuration.
 *   GET  → liste légère paginée des diagnostics (`page`, `pageSize` ≤ 100,
 *        `status`) : statut, phase, progression, tentatives, dernière erreur.
 *
 * Administrateurs seulement (`requireAdmin`) ; demande journalisée
 * (`TECH_DIAGNOSTIC_JOB`) ; réponses jamais mises en cache.
 */
export async function POST(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const requestId = randomUUID();
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const { parseDiagRequest } = await import('@/services/admin/diagnostics-export/model');
  const parsed = parseDiagRequest({ get: (k: string) => (body[k] === undefined || body[k] === null ? null : String(body[k])) });
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) => logAdminAction({
    adminId: g.adminId, adminEmail, action: 'TECH_DIAGNOSTIC_JOB', targetType: 'TECH_DIAGNOSTIC', targetId: parsed.ok ? parsed.value.id : null, result,
    details: { requestId, operation: 'create', ...(parsed.ok ? parsed.value : { scope: body.scope ?? null }), ...details },
  });
  if (!parsed.ok) {
    await audit('FAILURE', { code: parsed.code });
    return NextResponse.json({ error: parsed.message, code: parsed.code, requestId }, { status: 400, headers: NO_STORE });
  }
  const { parseIdempotencyKey } = await import('@/services/admin/diagnostic-jobs/state');
  try {
    const { enqueueDiagnosticJob } = await import('@/services/admin/diagnostic-jobs/repository');
    const r = await enqueueDiagnosticJob({
      adminUserId: g.adminId, request: parsed.value, requestId,
      idempotencyKey: parseIdempotencyKey(request.headers.get('idempotency-key')),
    });
    await audit('SUCCESS', { jobId: r.job.id, duplicate: r.duplicate, status: r.job.status, replaced: r.replaced.map((x) => ({ id: x.id, from: x.previousStatus, outcome: x.outcome })) });
    const { nudgeDiagnosticWorker } = await import('@/services/admin/diagnostic-jobs/worker');
    nudgeDiagnosticWorker();
    // Lot 111C : raison d'attente lue dans les battements PERSISTÉS de toutes les instances ;
    // cause de configuration (worker désactivé, aucun conteneur worker) → alerte BO immédiate.
    const sup = await import('@/services/admin/diagnostic-jobs/supervision');
    const wait = r.job.status === 'QUEUED' ? await sup.diagnosticJobWait(r.job.id) : null;
    if (wait?.diagnosis.alert) void sup.superviseDiagnosticQueue();
    return NextResponse.json({
      jobId: r.job.id, status: r.job.status, duplicate: r.duplicate, requestId, replaced: r.replaced,
      wait: wait ? { reason: wait.diagnosis.reason, label: wait.label, detail: wait.diagnosis.detail, action: wait.action, blockingJobId: wait.diagnosis.blockingJobId } : null,
    }, { status: 202, headers: { ...NO_STORE, 'X-Request-Id': requestId } });
  } catch (e) {
    const { sanitizeErrorMessage } = await import('@/services/admin/diagnostic-jobs/state');
    const code = (e as { code?: string })?.code === '42703' ? 'MIGRATION_MISSING' : 'ENQUEUE_FAILED';
    console.error(`[diagnostic-job] ${JSON.stringify({ event: 'enqueue-failed', requestId, code, message: sanitizeErrorMessage(e) })}`);
    await audit('FAILURE', { code });
    return NextResponse.json({
      error: code === 'MIGRATION_MISSING' ? 'Migrations 1035 / 1200 non appliquées : demande impossible (voir Exploitation › Migrations).' : 'Demande non enregistrée (voir le journal du serveur).',
      code, requestId,
    }, { status: code === 'MIGRATION_MISSING' ? 503 : 500, headers: NO_STORE });
  }
}

export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const sp = request.nextUrl.searchParams;
  const status = sp.get('status');
  if (status !== null && !['QUEUED', 'RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED', 'CANCELLED'].includes(status)) {
    return NextResponse.json({ error: 'Statut inconnu.', code: 'INVALID_STATUS' }, { status: 400, headers: NO_STORE });
  }
  try {
    const { listGenerations } = await import('@/services/admin/export-generations');
    const r = await listGenerations({ kind: 'TECH_DIAGNOSTIC', status, page: Number(sp.get('page') ?? 1) || 1, pageSize: Number(sp.get('pageSize') ?? 20) || 20 });
    return NextResponse.json(r, { headers: NO_STORE });
  } catch (e) {
    const { sanitizeErrorMessage } = await import('@/services/admin/diagnostic-jobs/state');
    console.error('[diagnostic-job] liste :', sanitizeErrorMessage(e));
    return NextResponse.json({ error: 'Chargement de la liste impossible (voir le journal du serveur).', code: 'LIST_LOAD_FAILED' }, { status: 500, headers: NO_STORE });
  }
}
