/**
 * GET /api/admin/subscriptions/payments?page=N — CDC Back-Office V1 §7.3.
 *
 * Historique des paiements : date, montant (devise de la transaction, UX-007),
 * statut, compte et offre associés (SUB-009). Un échec est identifié sans
 * motif technique (SUB-010). Lien « Ouvrir dans Stripe » (SUB-011) sans
 * identifiant (SUB-012) ; jamais de lien vers la facture (SUB-013).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { getPaymentsPage } from '@/services/admin/subscriptions.service';

const PAGE_SIZE = 25;

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const page = Math.max(1, Number.parseInt(new URL(request.url).searchParams.get('page') ?? '1', 10) || 1);
  try {
    return NextResponse.json(await getPaymentsPage(page, PAGE_SIZE));
  } catch (error) {
    console.error('[admin/subscriptions/payments] GET :', error);
    return NextResponse.json(
      { code: 'PAYMENTS_LOAD_FAILED', message: 'Impossible de charger l’historique des paiements.' },
      { status: 500 },
    );
  }
}
