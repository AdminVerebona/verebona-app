/**
 * GET /api/admin/communications/email-logs — e-mails transactionnels : statut
 * d'envoi, livraison, cause technique, identifiant Resend (lot 57A).
 * Query : ?type=<gabarit>&recipient=<adresse ou partie>&problems=1&limit=
 *         ?config=1 : configuration d'envoi effective (expéditeur, clé et
 *         secret de webhook PRÉSENTS ou non — jamais leur valeur, gabarits).
 *         ?annualRenewal=1 : état du rappel J−7 des abonnements annuels (lot
 *         68C) — début de couverture, demandes par statut, décisions du jour.
 * Réservé aux administrateurs ; recherche journalisée ; aucun jeton renvoyé.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, sessionErrorResponse } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { getTransactionalEmailConfig, searchTransactionalEmails } from '@/services/admin/transactional-email-logs.service';

export async function GET(request: NextRequest) {
  let adminId: number;
  try {
    adminId = await requireAdmin(request);
  } catch (error) {
    return sessionErrorResponse(error);
  }
  const url = new URL(request.url);
  // Configuration d'envoi effective (lecture seule, sans valeur secrète).
  if (url.searchParams.get('config') === '1') {
    try {
      return NextResponse.json({ config: await getTransactionalEmailConfig() });
    } catch (error) {
      console.error('[admin/communications/email-logs] config :', error);
      return NextResponse.json({ code: 'EMAIL_CONFIG_LOAD_FAILED', message: 'Configuration d’envoi illisible.' }, { status: 500 });
    }
  }
  if (url.searchParams.get('annualRenewal') === '1') {
    try {
      const { getAnnualRenewalOverview } = await import('@/services/billing/annual-renewal-reminder.service');
      return NextResponse.json({ annualRenewal: await getAnnualRenewalOverview() });
    } catch (error) {
      console.error('[admin/communications/email-logs] annualRenewal :', error);
      return NextResponse.json({ code: 'ANNUAL_RENEWAL_LOAD_FAILED', message: 'État du rappel de renouvellement illisible.' }, { status: 500 });
    }
  }
  const query = {
    type: url.searchParams.get('type'),
    recipient: url.searchParams.get('recipient'),
    problemsOnly: url.searchParams.get('problems') === '1',
    limit: Number(url.searchParams.get('limit') ?? 50),
  };
  try {
    const result = await searchTransactionalEmails(query);
    await logAdminAction({
      adminId,
      action: 'EMAIL_LOG_SEARCH',
      targetType: 'EMAIL_LOG',
      targetId: null,
      result: 'SUCCESS',
      // Critères sans l'adresse complète (journal d'audit minimal).
      details: { type: query.type ?? null, recipientFilter: !!query.recipient, problemsOnly: query.problemsOnly, results: result.logs.length },
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[admin/communications/email-logs] GET :', error);
    return NextResponse.json({ code: 'EMAIL_LOGS_LOAD_FAILED', message: 'Impossible de charger le suivi des e-mails.' }, { status: 500 });
  }
}
