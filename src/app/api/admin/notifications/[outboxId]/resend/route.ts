/**
 * POST /api/admin/notifications/[outboxId]/resend  (CDC 3 §20.3 ; D-L, lot 21)
 *
 * Ancienne route de renvoi : elle REMETTAIT EN FILE la ligne d'origine, sans
 * confirmation, sans contrôle de consentement et sans journal. Elle passe
 * désormais par la réémission du §20.3 (nouvelle ligne auditée, consentement
 * vérifié, confirmation explicite `{ confirme: true }` exigée) et chaque
 * tentative est journalisée (`NOTIFICATION_RESEND`).
 */
import { NextRequest } from 'next/server';
import { reemettre, requireAdminContext } from '../../_shared';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ outboxId: string }> },
) {
  const guard = await requireAdminContext(request);
  if (!guard.ok) return guard.response;
  const { outboxId } = await params;
  return reemettre(request, guard, 'NOTIFICATION_RESEND', outboxId);
}
