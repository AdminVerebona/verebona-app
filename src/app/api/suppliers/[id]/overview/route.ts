/**
 * GET /api/suppliers/[id]/overview — fiche fournisseur (page `/fournisseurs/[id]`).
 *
 * Mêmes règles d'accès que les biens : compte actif de la session, objet du
 * compte seulement. Un fournisseur d'un autre compte, supprimé ou inexistant
 * rend 404 — sans distinction, pour ne rien révéler. Les objets liés sont
 * re-filtrés sur le compte (voir `supplier-detail.service`). L'IBAN n'est
 * jamais rendu ici.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { getSupplierDetail } from '@/services/suppliers/supplier-detail.service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');

  const { id } = await params;
  // Identifiant strictement numérique : « 12abc » ou « 1e3 » ne sont pas acceptés.
  if (!/^\d{1,10}$/.test(id)) return apiError(400, 'INVALID_INPUT', 'Valid supplier ID required');

  const detail = await getSupplierDetail(session.currentAccountId, Number(id));
  if (!detail) return apiError(404, 'NOT_FOUND', 'Supplier not found');
  return NextResponse.json(detail);
}
