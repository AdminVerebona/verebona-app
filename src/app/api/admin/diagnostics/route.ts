import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { parseDiagRequest, zipFileName, type DiagRequest } from '@/services/admin/diagnostics-export/model';
import { guardAdmin, NO_STORE } from '../ops/_shared';

export const dynamic = 'force-dynamic';
// Génération bornée (DIAG_LIMITS) ; délai par requête appliqué par PostgreSQL.
export const maxDuration = 120;

/**
 * GET /api/admin/diagnostics — BO › Dashboard › Supervision › « Diagnostics
 * techniques » (lot 77C).
 *
 *   `scope=global|user|asset|document|operation`, `id`, `from`, `to`
 *   (AAAA-MM-JJ, UTC), `treatments=T1,T3,T4`, `reinforced=1` ;
 *   sans `format`  → JSON { manifest, report, files } (consultation, copie)
 *                    — journalisé `TECH_DIAGNOSTIC_VIEW` ;
 *   `format=zip`   → archive ZIP générée ici (rapport TXT, manifeste et
 *                    données JSON) — journalisé `TECH_DIAGNOSTIC_EXPORT`.
 *
 * Sécurité : administrateurs seulement (`requireAdmin`, rôle relu en base) ;
 * GET uniquement, lecture seule (transactions READ ONLY) ; masquage complet
 * avant sortie ; toute demande — réussie, refusée ou en échec — est
 * journalisée ; réponses jamais mises en cache.
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
    details: { scope: req?.scope ?? sp.get('scope'), id: req?.id ?? null, from: req?.from ?? null, to: req?.to ?? null, treatments: req?.treatments ?? null, reinforced: req?.reinforced ?? false, format: format ?? 'json', ...details },
  });

  const parsed = parseDiagRequest(sp);
  if (!parsed.ok) {
    await audit('FAILURE', null, { code: parsed.code });
    return NextResponse.json({ error: parsed.message, code: parsed.code }, { status: 400, headers: NO_STORE });
  }
  const req = parsed.value;
  const { generateDiagnostic, DiagBusyError, DiagTargetNotFoundError, DiagTooLargeError } = await import('@/services/admin/diagnostics-export/collect');
  try {
    const bundle = await generateDiagnostic(req, { adminUserId: g.adminId });
    const base = { generationId: bundle.manifest.generationId, bytes: bundle.totalBytes, files: bundle.files.length, warnings: bundle.manifest.warnings.length, unavailable: bundle.manifest.unavailable.length, accounts: bundle.manifest.target.accountIds };
    if (!format) {
      await audit('SUCCESS', req, base);
      return NextResponse.json({
        manifest: bundle.manifest, report: bundle.report,
        files: bundle.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content) })),
      }, { headers: NO_STORE });
    }
    const { buildDiagnosticZip } = await import('@/services/admin/diagnostics-export/zip');
    const zip = await buildDiagnosticZip(bundle);
    const fileName = zipFileName(bundle.manifest);
    await audit('SUCCESS', req, { ...base, fileName, zipBytes: zip.length });
    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Content-Type-Options': 'nosniff',
        'X-Verebona-Diagnostic-Id': bundle.manifest.generationId,
      },
    });
  } catch (e) {
    if (e instanceof DiagTargetNotFoundError) {
      await audit('FAILURE', req, { code: 'TARGET_NOT_FOUND' });
      return NextResponse.json({ error: e.message, code: 'TARGET_NOT_FOUND' }, { status: 404, headers: NO_STORE });
    }
    if (e instanceof DiagBusyError) {
      await audit('FAILURE', req, { code: 'BUSY' });
      return NextResponse.json({ error: 'Un diagnostic est déjà en cours de génération. Réessayez dans un instant.', code: 'BUSY' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '30' } });
    }
    if (e instanceof DiagTooLargeError) {
      await audit('FAILURE', req, { code: 'TOO_LARGE', bytes: e.bytes });
      return NextResponse.json({ error: 'Diagnostic trop volumineux : réduisez la période, ciblez un objet ou filtrez par traitement.', code: 'TOO_LARGE' }, { status: 413, headers: NO_STORE });
    }
    const code = (e as { code?: string })?.code;
    console.error('[admin/diagnostics] génération :', (e as Error)?.message ?? e);
    await audit('FAILURE', req, { code: code ?? 'GENERATION_FAILED' });
    if (code === '57014') return NextResponse.json({ error: 'Lecture trop longue (délai base dépassé) : réduisez la période ou le périmètre.', code: 'READ_TIMEOUT' }, { status: 503, headers: NO_STORE });
    return NextResponse.json({ error: 'Génération impossible (voir le journal du serveur).', code: 'GENERATION_FAILED' }, { status: 500, headers: NO_STORE });
  }
}
