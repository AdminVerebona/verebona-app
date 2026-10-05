/**
 * PATCH /api/admin/ai/accounts/[accountId]/quota
 *
 * Dérogation du compte au PLAFOND MENSUEL DE COÛT IA de son offre (lot 22,
 * chantier A) — admin uniquement, action auditée dans la même transaction
 * (`ai_admin_audit_log`, visible dans l'onglet Audit du compte). Compte
 * inexistant : 404.
 *
 * Avant le lot 22, cette route écrivait un quota documentaire annuel
 * (`ai_usage_account_counter`) que plus rien ne lisait depuis la suppression
 * d'`ai-usage-tracker` : une modification sans effet. Elle fixe désormais la
 * dérogation lue par la passerelle (`account-cost-cap`) :
 *
 *   { monthlyCostCapMicros: number | null, reason?: string }
 *     · entier ≥ 1 : plafond propre au compte (micro-USD par mois civil) ;
 *     · 0          : aucun plafond pour ce compte ;
 *     · null       : dérogation retirée, le plafond de l'offre s'applique.
 *
 * Les travaux reportés pour plafond sont remis en file (un plafond relevé
 * n'attend pas le 1er). Rend l'état du plafond après modification.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { requireAdmin } from '@/lib/auth-guards';
import {
  COST_CAP_MAX_MICROS, getAccountCostCapStatus, setAccountCostCapOverride,
} from '@/services/ai/gateway/account-cost-cap';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string }> }
) {
  try {
    // Garde serveur commune à /api/admin (CDC BO GEN-002, BO IA GEN-013).
    let adminUserId: number;
    try {
      adminUserId = await requireAdmin(request);
    } catch (e) {
      return SessionService.handleSessionError(e);
    }
    const session = await SessionService.getSession(request);

    const { accountId: accountIdStr } = await params;
    if (!/^\d+$/.test(accountIdStr)) return NextResponse.json({ error: 'ID invalide' }, { status: 400 });
    const accountId = Number(accountIdStr);

    const body = (await request.json().catch(() => null)) as { monthlyCostCapMicros?: unknown; reason?: unknown } | null;
    if (!body || typeof body !== 'object' || !('monthlyCostCapMicros' in body)) {
      return NextResponse.json(
        { error: 'INVALID_BODY', message: '`monthlyCostCapMicros` requis (entier ≥ 0 en micro-USD, ou null pour revenir au plafond de l’offre).' },
        { status: 400 },
      );
    }
    // Validation stricte : un nombre entier (jamais une chaîne), mêmes bornes
    // que le réglage d'offre.
    const v = body.monthlyCostCapMicros;
    if (v !== null && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= COST_CAP_MAX_MICROS)) {
      return NextResponse.json(
        { error: 'INVALID_VALUE', message: `Plafond invalide : entier de 0 à ${COST_CAP_MAX_MICROS} (micro-USD) ou null.` },
        { status: 400 },
      );
    }
    if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
      return NextResponse.json({ error: 'INVALID_VALUE', message: '`reason` doit être un texte.' }, { status: 400 });
    }
    const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 1000) : null;

    // Dérogation et audit dans une même transaction.
    const issue = await setAccountCostCapOverride(accountId, v as number | null, { id: adminUserId, email: session.email ?? null }, reason);
    if (!issue) return NextResponse.json({ error: 'NOT_FOUND', message: 'Compte introuvable.' }, { status: 404 });

    const costCap = await getAccountCostCapStatus(accountId, { withSpent: true }).catch(() => null);
    return NextResponse.json({ success: true, costCap });
  } catch (error: any) {
    console.error('[PATCH /api/admin/ai/accounts/[accountId]/quota]', error);
    return NextResponse.json({ error: 'Erreur serveur' }, { status: 500 });
  }
}
