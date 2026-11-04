/**
 * GET /api/suppliers/[id]/sections/[section]?offset=&limit= — lot 109B.
 *
 * Page suivante d'une section de la fiche fournisseur (`documents`, `assets`,
 * `equipments`), avec son TOTAL EXACT : la fiche charge progressivement tous
 * les objets associés, sans plafond silencieux. Mêmes règles d'accès que
 * `/overview` : compte de la session, fournisseur d'un autre compte = 404.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { isSupplierSection } from '@/lib/suppliers/supplier-fiche-config';
import { listSupplierSection } from '@/services/suppliers/supplier-detail.service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; section: string }> },
) {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

  const { id, section } = await params;
  if (!/^\d{1,10}$/.test(id)) return apiError(400, 'INVALID_INPUT', 'Valid supplier ID required');
  if (!isSupplierSection(section)) return apiError(400, 'INVALID_INPUT', 'Unknown section');

  const sp = new URL(request.url).searchParams;
  const page = await listSupplierSection(session.currentAccountId, Number(id), section, {
    offset: sp.get('offset'), limit: sp.get('limit'),
  });
  if (!page) return apiError(404, 'NOT_FOUND', 'Supplier not found');
  return NextResponse.json(page);
}
