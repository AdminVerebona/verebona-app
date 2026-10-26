import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { parseDiagRequest, zipFileName, type DiagRequest } from '@/services/admin/diagnostics-export/model';
import { guardAdmin, NO_STORE } from '../ops/_shared';

export const dynamic = 'force-dynamic';
// Lot 81C : génération exhaustive en flux (aucun plafond de volume) ; délai par requête appliqué par PostgreSQL.
export const maxDuration = 900;

/**
 * GET /api/admin/diagnostics — BO › Dashboard › Supervision › « Diagnostics »
 * (lots 77C, 81C, 88A, 91A).
 *
 * Lot 91A : UN diagnostic, UN moteur. `scope=global` (défaut) = « Ensemble de
 * l'application », niveau maximal (tous les comptes, tables transversales) ;
 * `scope=account|user|asset|document|operation` + `id` = FILTRE du même
 * moteur (volume réduit, jamais une information absente du global) ;
 * `reinforced=1` ; les anciens paramètres `from`, `to`, `period`,
 * `treatments` sont ignorés (historique complet, tous traitements) ;
 *   sans `format`  → JSON { manifest, report, files } (consultation, copie) :
 *                    génération complète SANS conservation du contenu
 *                    (statut et intégrité de chaque fichier) — journalisé
 *                    `TECH_DIAGNOSTIC_VIEW` ;
 *   `format=zip`   → archive ZIP générée ici EN FLUX (données JSON par lots,
 *                    rapport TXT et manifeste en dernier : statut COMPLETE /
 *                    PARTIAL / FAILED, SHA-256 de chaque fichier) —
 *                    journalisé `TECH_DIAGNOSTIC_EXPORT`.
 *
 * Chaque génération est suivie (`admin_export_generations`) : RUNNING puis
 * COMPLETE / PARTIAL / FAILED avec erreur exploitable ; une interruption
 * (client parti, erreur) n'est jamais présentée comme complète.
 *
 * Sécurité : administrateurs seulement (`requireAdmin`, rôle relu en base) ;
 * GET uniquement, lecture seule (transaction REPEATABLE READ READ ONLY) ;
 * masquage complet avant sortie ; toute demande — réussie, refusée ou en
 * échec — est journalisée ; réponses jamais mises en cache.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const sp = request.nextUrl.searchParams;
  const format = sp.get('format');
  if (format !== null && format !== 'zip') {
    return NextResponse.json({ error: 'Format inconnu (zip).', code: 'INVALID_FORMAT' }, { status: 400, headers: NO_STORE });
  }
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const audit = (result: 'SUCCESS' | 'FAILURE' | 'DENIED', req: Partial<DiagRequest> | null, details: Record<string, unknown>) => logAdminAction({
    adminId: g.adminId, adminEmail, action: format ? 'TECH_DIAGNOSTIC_EXPORT' : 'TECH_DIAGNOSTIC_VIEW', targetType: 'TECH_DIAGNOSTIC',
    targetId: req?.id ?? null, result,
    details: { scope: req?.scope ?? sp.get('scope'), id: req?.id ?? null, reinforced: req?.reinforced ?? false, format: format ?? 'json', ...details },
  });

  const parsed = parseDiagRequest(sp);
  if (!parsed.ok) {
    await audit('FAILURE', null, { code: parsed.code });
    return NextResponse.json({ error: parsed.message, code: parsed.code }, { status: 400, headers: NO_STORE });
  }
  const req = parsed.value;
  const { DiagBusyError, DiagTargetNotFoundError } = await import('@/services/admin/diagnostics-export/collect');
  const { startGeneration, finishGeneration } = await import('@/services/admin/export-generations');
  const failure = async (e: unknown) => {
    if (e instanceof DiagTargetNotFoundError) {
      await audit('FAILURE', req, { code: 'TARGET_NOT_FOUND' });
      return NextResponse.json({ error: e.message, code: 'TARGET_NOT_FOUND' }, { status: 404, headers: NO_STORE });
    }
    if (e instanceof DiagBusyError) {
      await audit('FAILURE', req, { code: 'BUSY' });
      return NextResponse.json({ error: 'Un diagnostic est déjà en cours de génération. Réessayez dans un instant.', code: 'BUSY' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '30' } });
    }
    const code = (e as { code?: string })?.code;
    console.error('[admin/diagnostics] génération :', (e as Error)?.message ?? e);
    await audit('FAILURE', req, { code: code ?? 'GENERATION_FAILED' });
    if (code === '57014') return NextResponse.json({ error: 'Lecture trop longue (délai base dépassé) : réessayez ou ciblez un objet.', code: 'READ_TIMEOUT' }, { status: 503, headers: NO_STORE });
    return NextResponse.json({ error: 'Génération impossible (voir le journal du serveur).', code: 'GENERATION_FAILED' }, { status: 500, headers: NO_STORE });
  };
  const fileStats = (m: { files: Array<{ count?: number; expected?: number | null; batches?: number; status?: string }> }) => ({
    rowsExpected: m.files.reduce((n, f) => n + (f.expected ?? 0), 0),
    rowsExported: m.files.reduce((n, f) => n + (f.expected !== undefined && f.expected !== null ? (f.count ?? 0) : 0), 0),
    batches: m.files.reduce((n, f) => n + (f.batches ?? 0), 0),
  });

  if (!format) {
    // Consultation : génération complète (statuts, intégrité) en flux de réponse — des espaces (JSON valide)
    // sont émis toutes les 15 s pendant la génération : aucun délai de premier octet, même sur « tout l'historique ».
    const { withDiagnosticPlan, previewPlan } = await import('@/services/admin/diagnostics-export/collect');
    const { responseStream } = await import('@/services/admin/account-data/stream-response');
    const { describeError } = await import('@/services/admin/account-data/export');
    let ready!: (v: { generationId: string } | { error: unknown }) => void;
    const planned = new Promise<{ generationId: string } | { error: unknown }>((r) => { ready = r; });
    const out = responseStream();
    let started: string | null = null;
    void withDiagnosticPlan(req, { adminUserId: g.adminId }, async (plan) => {
      started = plan.generationId;
      await startGeneration({ id: plan.generationId, kind: 'TECH_DIAGNOSTIC', mode: 'consultation', adminUserId: g.adminId, targetType: req.scope, targetId: req.id, targetAccountId: plan.perimeter.accountIds[0] ?? null, perimeter: { ...req } });
      ready({ generationId: plan.generationId });
      const keepAlive = setInterval(() => { out.sink.write(' ').catch(() => undefined); }, 15_000);
      let v: Awaited<ReturnType<typeof previewPlan>>;
      try { v = await previewPlan(plan); } finally { clearInterval(keepAlive); }
      const m = v.manifest;
      const bytes = v.files.reduce((n, f) => n + f.bytes, 0);
      await finishGeneration(plan.generationId, { status: m.status ?? 'COMPLETE', snapshotAt: m.snapshot?.at, pgSnapshot: m.snapshot?.snapshot, ...fileStats(m), bytes, files: v.files.length, sections: m.files, error: m.status === 'COMPLETE' ? null : m.warnings.join(' ; ') });
      await audit('SUCCESS', req, { generationId: plan.generationId, status: m.status, bytes, files: v.files.length, warnings: m.warnings.length, unavailable: m.unavailable.length, accounts: m.target.accountIds });
      await out.sink.write(JSON.stringify(v));
      out.end();
    }).catch(async (e) => {
      ready({ error: e });
      if (started) {
        console.error('[admin/diagnostics] consultation interrompue :', (e as Error)?.message ?? e);
        await finishGeneration(started, { status: 'FAILED', error: describeError(e) });
        await audit('FAILURE', req, { generationId: started, code: (e as { code?: string })?.code ?? 'GENERATION_FAILED' });
      }
      out.abort(e);
    });
    const p = await planned;
    if ('error' in p) return failure(p.error);
    return new Response(out.body, { status: 200, headers: { ...NO_STORE, 'Content-Type': 'application/json; charset=utf-8', 'X-Verebona-Diagnostic-Id': p.generationId } });
  }

  // ZIP en flux : la session de lecture reste ouverte pendant la transmission.
  const { withDiagnosticPlan } = await import('@/services/admin/diagnostics-export/collect');
  const { streamDiagnosticZip } = await import('@/services/admin/diagnostics-export/zip');
  const { responseStream } = await import('@/services/admin/account-data/stream-response');
  const { describeError } = await import('@/services/admin/account-data/export');
  const generatedAt = new Date();
  // Le plan (périmètre, décomptes) est établi AVANT la réponse : une cible inconnue répond 404, jamais un ZIP vide.
  let ready!: (v: { fileName: string; generationId: string } | { error: unknown }) => void;
  const planned = new Promise<{ fileName: string; generationId: string } | { error: unknown }>((r) => { ready = r; });
  const out = responseStream();
  let started: { id: string; fileName: string } | null = null;
  void withDiagnosticPlan(req, { adminUserId: g.adminId, now: () => generatedAt }, async (plan) => {
    const fileName = zipFileName({ request: { ...req, scopeLabel: '' }, generatedAt: generatedAt.toISOString(), generationId: plan.generationId });
    started = { id: plan.generationId, fileName };
    await startGeneration({ id: plan.generationId, kind: 'TECH_DIAGNOSTIC', mode: 'zip', adminUserId: g.adminId, targetType: req.scope, targetId: req.id, targetAccountId: plan.perimeter.accountIds[0] ?? null, perimeter: { ...req } });
    ready({ fileName, generationId: plan.generationId });
    const o = await streamDiagnosticZip(plan, out.node, generatedAt);
    if (!o.ok) {
      plan.fail(o.error);
      await finishGeneration(plan.generationId, { status: 'FAILED', bytes: o.bytes, error: `${o.clientGone ? 'client parti avant la fin du téléchargement — ' : ''}${describeError(o.error)}`, fileName });
      await audit('FAILURE', req, { generationId: plan.generationId, fileName, code: o.clientGone ? 'CLIENT_GONE' : 'ARCHIVE_FAILED', zipBytes: o.bytes });
      out.abort(o.error);
      return;
    }
    const { manifest: m } = plan.result();
    await finishGeneration(plan.generationId, { status: m.status ?? 'COMPLETE', snapshotAt: m.snapshot?.at, pgSnapshot: m.snapshot?.snapshot, ...fileStats(m), bytes: o.bytes, files: plan.entries.length, sections: m.files, error: m.status === 'COMPLETE' ? null : m.warnings.join(' ; '), fileName });
    await audit('SUCCESS', req, { generationId: plan.generationId, fileName, status: m.status, zipBytes: o.bytes, files: plan.entries.length, warnings: m.warnings.length, unavailable: m.unavailable.length, accounts: m.target.accountIds });
    out.end();
  }).catch(async (e) => {
    ready({ error: e });
    const st = started as { id: string; fileName: string } | null;
    if (st) {
      // Erreur après le début de la transmission : génération FAILED, flux interrompu (jamais un ZIP « complet »).
      console.error('[admin/diagnostics] archive interrompue :', (e as Error)?.message ?? e);
      await finishGeneration(st.id, { status: 'FAILED', error: describeError(e), fileName: st.fileName });
      await audit('FAILURE', req, { generationId: st.id, fileName: st.fileName, code: (e as { code?: string })?.code ?? 'ARCHIVE_FAILED' });
    }
    out.abort(e);
  });
  const p = await planned;
  if ('error' in p) return failure(p.error);
  return new Response(out.body, {
    status: 200,
    headers: {
      ...NO_STORE,
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${p.fileName}"`,
      'X-Content-Type-Options': 'nosniff',
      'X-Verebona-Diagnostic-Id': p.generationId,
    },
  });
}
