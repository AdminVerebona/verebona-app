/**
 * POST /api/v2/to-process/[publicId]/resolve — CDC V2.0 §8.5, §8.6, §7.4, §13.5.
 *
 * Trois gestes, une seule route, distingués par `mode` :
 *
 *   · `arbitrate`       applique la valeur retenue et résout l'action ;
 *   · `undo`            restaure la valeur précédente et rouvre la MÊME action ;
 *   · `not_applicable`  clôt l'action lorsque la règle l'autorise.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA VALEUR PRÉCÉDENTE REVIENT AU CLIENT, ET C'EST VOLONTAIRE
 *
 * Le §8.5 promet « Valeur mise à jour — Annuler » : l'annulation doit pouvoir
 * restaurer une valeur que la base ne porte plus. La conserver côté serveur
 * demanderait une table d'annulations, avec sa durée de vie, son nettoyage et
 * ses lignes orphelines — pour un bouton qui vit le temps d'un toast.
 *
 * Le client la garde donc et la renvoie. Le risque est borné : `undo` ne
 * restaure que si la valeur passe la validation du champ, et l'action ciblée
 * appartient déjà au compte de la session.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { emitBusinessEvent } from '@/services/verebona-assistant/events/business-events';
import { SessionService } from '@/lib/session-service';
import { resolveErrorMessage } from '@/lib/to-process-resolve-errors';
import {
  markNotApplicable,
  resolveArbitration,
  undoArbitration,
} from '@/services/to-process/resolve-action.service';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  ALREADY_RESOLVED: 409,
  FIELD_NOT_RESOLVABLE: 422,
  INVALID_VALUE: 400,
  // La situation a changé depuis l'ouverture de la carte (carte périmée).
  STALE: 409,
  FIELD_NOT_APPLICABLE: 422,
};

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ publicId: string }> },
) {
  let session;
  try {
    session = await SessionService.getSession(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const accountId = session.currentAccountId;
  if (!accountId) {
    return NextResponse.json({ error: 'NO_ACCOUNT_SELECTED' }, { status: 400 });
  }

  const { publicId } = await context.params;

  let body: { mode?: string; value?: unknown; previousValue?: unknown };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const mode = body.mode ?? 'arbitrate';

  const result =
    mode === 'undo'
      ? await undoArbitration(accountId, publicId, body.previousValue)
      : mode === 'not_applicable'
        ? await markNotApplicable(accountId, publicId, { userId: session.userId })
        : await resolveArbitration(accountId, publicId, body.value, { userId: session.userId });

  if (!result.ok) {
    // Lot 32 (L32-1) : le code ET un message utile — l'écran l'affiche tel quel.
    // Une carte retirée (sans objet, périmée) change la file : événement émis.
    if (result.error === 'FIELD_NOT_APPLICABLE' || result.error === 'STALE') {
      await emitBusinessEvent({ type: 'TO_PROCESS_ITEM_UPDATED', accountId, entityId: publicId });
    }
    return NextResponse.json(
      { error: result.error, code: result.error, message: resolveErrorMessage(result.error) },
      { status: STATUS[result.error ?? ''] ?? 400 },
    );
  }

  // Un arbitrage utilisateur peut rendre caduques d'autres décisions du
  // compte : contrôle T3 différé (fusionné avec les événements rapprochés).
  if (mode !== 'not_applicable') {
    const { notifyCoherenceEvent } = await import('@/services/ai/reconciliation/account-reconciliation.service');
    notifyCoherenceEvent(accountId, { event: 'arbitration' });
  }

  // CDC Assistant §25.7 : événement métier (caches de l'assistant).
  await emitBusinessEvent({ type: 'TO_PROCESS_ITEM_UPDATED', accountId, entityId: publicId });
  return NextResponse.json({ ok: true, previousValue: result.previousValue });
}
