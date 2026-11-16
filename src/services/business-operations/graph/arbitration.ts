/**
 * ASSOCIER PAR INFÉRENCE, OU DEMANDER (carte Trello #744, CDC « Opérations /
 * Agenda V2.0 » §4, §5, §8, §20 ; AC13, AC14, AC17).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POINT D'ENTRÉE DES TRAITEMENTS (T3, T4, reprise) POUR ASSOCIER DEUX
 * ÉVÉNEMENTS DE RÉFÉRENCE
 *
 * La façade d'écriture (`operation-write.facade.ts`) ne tranche jamais à la
 * place de l'utilisateur : quand une inférence veut associer deux événements
 * que l'utilisateur avait refusé d'associer, en citant une preuve que ce refus
 * ne connaissait pas, elle n'écrit rien et répond « arbitrage requis ».
 *
 * Un traitement qui appellerait la façade directement perdrait cette demande.
 * Il appelle donc CETTE fonction : même commande, même résultat, et — sur
 * « arbitrage requis » seulement — la question est posée dans « À traiter »
 * (`to-process/operation-relation-cards.ts`), une fois, sur un justificatif
 * réel. La réponse de l'utilisateur repasse par la façade.
 *
 * Aucune règle n'est ajoutée ici : ni décision, ni écriture, ni appel IA. Le
 * geste de l'utilisateur (écran, Assistant) n'a pas besoin de ce détour : il
 * ne reçoit jamais « arbitrage requis ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { OperationWriteResult } from './model';
import type { AssociateOperationsInput, OperationRelationData, OperationWriteContext } from '../operation-write.facade';

/** Suite donnée à un « arbitrage requis » : la carte posée (ou la raison pour laquelle aucune ne l'est). */
export interface ArbitrationFollowUp {
  status: 'POSTED' | 'UPDATED' | 'ALREADY_ANSWERED' | 'NO_ANCHOR' | 'NOT_APPLICABLE' | 'SKIPPED' | 'FAILED';
  actionId?: number;
  reason?: string;
}

export type AssociateOrAskResult = OperationWriteResult<OperationRelationData> & {
  /** Présent seulement quand la façade a répondu « arbitrage requis ». */
  arbitration?: ArbitrationFollowUp;
};

/**
 * Associe deux événements de référence par la façade ; sur « arbitrage
 * requis », pose la question dans « À traiter ». Ne lève jamais (comme la
 * façade) : une carte non posée est rendue telle quelle (`arbitration.status`),
 * le résultat de la commande reste celui de la façade.
 */
export async function associateOperationsOrAsk(ctx: OperationWriteContext, input: AssociateOperationsInput): Promise<AssociateOrAskResult> {
  const { associateOperations } = await import('../operation-write.facade');
  const r = await associateOperations(ctx, input);
  if (r.status !== 'ARBITRATION_REQUIRED' || r.code !== 'NEW_EVIDENCE_AFTER_REFUSAL') return r;
  const relationId = (r.data as { relationId?: unknown } | undefined)?.relationId;
  if (typeof relationId !== 'number') return { ...r, arbitration: { status: 'NOT_APPLICABLE', reason: 'RELATION_UNKNOWN' } };
  try {
    const { requestOperationRelationArbitration } = await import('@/services/to-process/operation-relation-cards');
    const arbitration = await requestOperationRelationArbitration(ctx.accountId, {
      fromOperationId: input.fromOperationId, toOperationId: input.toOperationId, nature: input.nature,
      evidence: input.evidence ?? [], relationId,
    });
    return { ...r, arbitration };
  } catch (e) {
    console.error(`[operation-write] arbitrage requis non transmis à « À traiter » (compte ${ctx.accountId}) :`, (e as Error).message);
    return { ...r, arbitration: { status: 'FAILED', reason: 'TECHNICAL_FAILURE' } };
  }
}
