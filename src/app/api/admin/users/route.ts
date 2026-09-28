/**
 * GET /api/admin/users?q=&sort=&dir=&page= — liste des utilisateurs,
 * CDC Back-Office V1 §6.1 (USR-L01 à USR-L05, GEN-004).
 *
 * Réponse : `summary` (total / actifs / désactivés, USR-L01) et page
 * classique `{ items, page, pageSize, total, totalPages }`. Aucun filtre
 * statut / rôle (USR-L03) ; aucune colonne statut administrateur, rôle,
 * dernière connexion ou date de création (USR-L04).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isSessionError, sessionErrorResponse } from '@/lib/auth-guards';
import { parseListParams } from '@/services/admin/list-params';
import { USER_SORTS, getUserSummary, getUsersPage } from '@/services/admin/user-list.service';

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  try {
    const params = parseListParams(request.nextUrl.searchParams, USER_SORTS, { sort: 'name', dir: 'asc' });
    const [summary, page] = await Promise.all([getUserSummary(), getUsersPage(params)]);
    return NextResponse.json({ summary, ...page, query: params.q || null, sort: params.sort, dir: params.dir });
  } catch (error) {
    if (isSessionError(error)) return sessionErrorResponse(error);
    console.error('[admin/users] GET :', error);
    return NextResponse.json({ code: 'LOAD_FAILED', message: 'Chargement des utilisateurs impossible.' }, { status: 500 });
  }
}
