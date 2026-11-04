/**
 * GET /api/suppliers/[id]/iban — lot 109B : consultation PROTÉGÉE de l'IBAN.
 *
 * La fiche n'affiche l'IBAN que masqué ; ce point d'accès rend la valeur en
 * clair sur action volontaire (« Afficher »), pour un fournisseur du compte
 * de la session seulement (autre compte, inexistant ou supprimé : 404, sans
 * distinction). Réponse jamais mise en cache ; aucune valeur journalisée.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '@/db';
import { suppliers } from '@/db/schema';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    const { id } = await params;
    if (!/^\d{1,10}$/.test(id)) return apiError(400, 'INVALID_INPUT', 'Valid supplier ID required');

    const [row] = await db
      .select({ iban: suppliers.iban, ibanHolderName: suppliers.ibanHolderName })
      .from(suppliers)
      .where(and(eq(suppliers.id, Number(id)), eq(suppliers.accountId, session.currentAccountId), ne(suppliers.status, 'deleted')))
      .limit(1);
    if (!row) return apiError(404, 'NOT_FOUND', 'Supplier not found');

    return NextResponse.json(
      { iban: row.iban ?? null, ibanHolderName: row.ibanHolderName ?? null },
      { headers: { 'Cache-Control': 'no-store, private' } },
    );
  } catch (err) {
    return SessionService.handleSessionError(err);
  }
}
