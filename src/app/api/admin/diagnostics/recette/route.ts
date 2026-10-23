import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { guardAdmin, NO_STORE } from '../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * Lot 82E — EXPORT COMPLET DE RECETTE (décisions PO C-Q5, C-Q8, §4.2).
 *
 *   GET  : générations d'export de recette (suivi `admin_export_generations`,
 *          kind RECETTE_EXPORT : statut, totaux, signe de vie) et droit de
 *          l'administrateur courant aux contenus sensibles ;
 *   POST : { contenusSensibles?: boolean } → 202 { generationId } : génération
 *          lancée EN TÂCHE DE FOND (tous les comptes, toutes les tables du
 *          périmètre), fichiers stockés pour un téléchargement ultérieur ;
 *          409 si un export de recette est déjà en cours ; 403 si les
 *          contenus sensibles sont demandés sans l'habilitation existante
 *          (`AI_MODEL_OUTPUT_ADMIN_IDS`, décision D15) — refus journalisé.
 *
 * Administrateurs seulement (`requireAdmin`) ; lecture seule de la base ;
 * lancement et téléchargements journalisés ; réponses jamais mises en cache.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const [{ listGenerations }, { isModelOutputAccessAllowed }] = await Promise.all([
      import('@/services/admin/export-generations'), import('@/services/ai/telemetry/model-output-access'),
    ]);
    const sp = request.nextUrl.searchParams;
    const r = await listGenerations({ kind: 'RECETTE_EXPORT', page: Number(sp.get('page') ?? 1) || 1, pageSize: Number(sp.get('pageSize') ?? 20) || 20 });
    return NextResponse.json({ ...r, canIncludeSensitiveContent: isModelOutputAccessAllowed(g.adminId) }, { headers: NO_STORE });
  } catch (e) {
    console.error('[admin/recette] liste :', (e as Error)?.message ?? e);
    return NextResponse.json({ error: 'Lecture impossible.', code: 'READ_FAILED' }, { status: 500, headers: NO_STORE });
  }
}

export async function POST(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const body = (await request.json().catch(() => ({}))) as { contenusSensibles?: unknown };
  const sensitive = body?.contenusSensibles === true;
  const email = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const { isModelOutputAccessAllowed } = await import('@/services/ai/telemetry/model-output-access');
  if (sensitive && !isModelOutputAccessAllowed(g.adminId)) {
    await logAdminAction({ adminId: g.adminId, adminEmail: email, action: 'RECETTE_EXPORT', targetType: 'RECETTE_EXPORT', targetId: null, result: 'DENIED', details: { contenusSensibles: true, code: 'SENSITIVE_CONTENT_FORBIDDEN' } });
    return NextResponse.json({ error: 'Contenus sensibles réservés aux administrateurs habilités (AI_MODEL_OUTPUT_ADMIN_IDS).', code: 'SENSITIVE_CONTENT_FORBIDDEN' }, { status: 403, headers: NO_STORE });
  }
  const { isS3Configured } = await import('@/lib/s3-config');
  if (!isS3Configured()) return NextResponse.json({ error: 'Stockage OVH non configuré : export impossible.', code: 'STORAGE_UNAVAILABLE' }, { status: 503, headers: NO_STORE });
  const { startRecetteExport, RecetteBusyError } = await import('@/services/admin/diagnostics-export/recette');
  try {
    const r = await startRecetteExport({ id: g.adminId, email }, { includeSensitiveContent: sensitive });
    return NextResponse.json(r, { status: 202, headers: NO_STORE });
  } catch (e) {
    if (e instanceof RecetteBusyError) {
      return NextResponse.json({ error: e.message, code: e.code, activeId: e.activeId }, { status: 409, headers: NO_STORE });
    }
    console.error('[admin/recette] lancement :', (e as Error)?.message ?? e);
    return NextResponse.json({ error: 'Lancement impossible (voir le journal du serveur).', code: 'START_FAILED' }, { status: 500, headers: NO_STORE });
  }
}
