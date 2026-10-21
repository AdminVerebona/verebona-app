import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { isCategory } from '@/services/admin/account-data/model';
import { listAccountData, parseListQuery } from '@/services/admin/account-data/lists';
import { guardAdmin, NO_STORE, readError, resolveAccount } from '../_shared';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string; category: string }> };

/**
 * GET /api/admin/accounts/:id/data/:category?q=&sort=&dir=&page=&pageSize=&state=
 * — BO › fiche compte › « Données du compte » (lot 75N) : liste paginée côté
 * serveur d'une des six catégories (biens, equipements, pieces, documents,
 * echeances, operations), recherche par nom / référence / identifiant, tri et
 * filtre d'état en liste blanche, compteurs réels. Lecture seule.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const p = await params;
  if (!isCategory(p.category)) {
    return NextResponse.json({ error: 'Catégorie inconnue.', code: 'INVALID_CATEGORY' }, { status: 400, headers: NO_STORE });
  }
  try {
    const acc = await resolveAccount(p.id);
    if (!acc.ok) return acc.response;
    const result = await listAccountData(acc.accountId, p.category, parseListQuery(p.category, request.nextUrl.searchParams));
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (e) {
    return readError(e, `liste ${p.category}`);
  }
}
