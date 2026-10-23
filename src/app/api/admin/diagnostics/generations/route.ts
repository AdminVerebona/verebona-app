import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE } from '../../ops/_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/diagnostics/generations — lot 81C : suivi des générations
 * d'export du BO (diagnostics techniques, « Données du compte » et, lot 82E,
 * exports complets de recette) : statut
 * RUNNING / COMPLETE / PARTIAL / FAILED, lignes attendues / exportées, lots,
 * octets, bilan par section ou fichier, erreur. Liste paginée (`page`,
 * `pageSize` ≤ 100 ; toutes les pages accessibles), `kind` facultatif.
 * Administrateurs seulement ; lecture seule ; jamais mis en cache.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const sp = request.nextUrl.searchParams;
  const kind = sp.get('kind');
  const { listGenerations, EXPORT_KINDS } = await import('@/services/admin/export-generations');
  if (kind !== null && !(EXPORT_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: `Type inconnu (${EXPORT_KINDS.join(', ')}).`, code: 'INVALID_KIND' }, { status: 400, headers: NO_STORE });
  }
  try {
    const r = await listGenerations({ page: Number(sp.get('page') ?? 1) || 1, pageSize: Number(sp.get('pageSize') ?? 20) || 20, kind: kind as never });
    return NextResponse.json(r, { headers: NO_STORE });
  } catch (e) {
    console.error('[admin/diagnostics] générations :', (e as Error)?.message ?? e);
    return NextResponse.json({ error: 'Lecture impossible.', code: 'READ_FAILED' }, { status: 500, headers: NO_STORE });
  }
}
