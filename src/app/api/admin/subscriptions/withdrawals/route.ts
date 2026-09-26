/**
 * GET /api/admin/subscriptions/withdrawals?accountId=N — CDC Back-Office V1 SUB-015.
 *
 * Les rétractations appartiennent à l'univers Abonnements & paiements et sont
 * visibles depuis la fiche Compte, sans onglet séparé. Lecture seule : le
 * traitement relève du parcours de rétractation (CDC dédié), pas du BO.
 * Aucune donnée de paiement détaillée ni identifiant Stripe (SUB-012).
 */
import { NextRequest, NextResponse } from 'next/server';
import { pgClient } from '@/db';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';

const STATUS_LABELS: Record<string, string> = {
  received: 'Reçue',
  manual_review: 'En revue',
  processing: 'En cours de traitement',
  completed: 'Traitée',
  failed: 'Échec du traitement',
  rejected: 'Rejetée',
};

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }

  const accountId = Number(new URL(request.url).searchParams.get('accountId'));
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    return NextResponse.json({ code: 'INVALID_ACCOUNT_ID', message: 'Compte invalide.' }, { status: 400 });
  }

  try {
    const rows = await pgClient.unsafe<Array<Record<string, unknown>>>(
      `SELECT id, public_reference, requested_at, confirmed_at, effective_at, status,
              amount_refunded, currency
         FROM withdrawal_requests
        WHERE account_id = $1
        ORDER BY requested_at DESC`,
      [accountId],
    );
    return NextResponse.json({
      withdrawals: rows.map((r) => ({
        id: Number(r.id),
        reference: String(r.public_reference),
        requestedAt: r.requested_at,
        effectiveAt: r.effective_at ?? r.confirmed_at ?? null,
        status: String(r.status),
        statusLabel: STATUS_LABELS[String(r.status)] ?? String(r.status),
        amountRefundedCents: Number(r.amount_refunded ?? 0),
        currency: String(r.currency ?? 'eur'),
      })),
    });
  } catch (error) {
    console.error('[admin/subscriptions/withdrawals] GET :', error);
    return NextResponse.json({ code: 'WITHDRAWALS_LOAD_FAILED', message: 'Impossible de charger les rétractations.' }, { status: 500 });
  }
}
