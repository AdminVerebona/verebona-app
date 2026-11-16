/**
 * PROPOSER UN RATTACHEMENT D'AGENDA SUPPLÉMENTAIRE, JAMAIS L'ÉCRIRE (carte
 * Trello #744, CDC « Opérations / Agenda V2.0 » §4, §6, §8, §20 ; AC08, AC17 ;
 * DÉCISION DU PO DU 16/11/2026).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POINT D'ENTRÉE DES TRAITEMENTS (T3, T4, reprise)
 *
 * Décision du PO du 16/11/2026 : pour qu'une inférence propose de rattacher un
 * événement de l'Agenda à un SECOND événement de référence, il faut un
 * JUSTIFICATIF COMMUN — un document qui relie les deux. RIEN n'est proposé
 * sans pièce : ni « même bien et dates proches », ni aucune autre heuristique.
 *
 * Et rien n'est ÉCRIT : la décision appartient à l'utilisateur. Un traitement
 * appelle donc CETTE fonction, jamais `linkAgendaItem` de la façade (qui, elle,
 * applique le geste de l'utilisateur). La question est posée une fois dans
 * « À traiter » (`to-process/operation-agenda-link-cards.ts`), portée par
 * l'événement de l'Agenda lui-même, et la réponse repasse par la façade.
 *
 * Aucune règle n'est ajoutée ici : ni décision, ni écriture, ni appel IA. La
 * règle de preuve est en un seul endroit (`sharedJustifications`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AgendaLinkProposalOutcome } from '@/services/to-process/operation-agenda-link-cards';
import type { GraphEvidence } from './model';
import type { OperationWriteContext } from '../operation-write.facade';

export interface ExtraAgendaLinkProposalInput {
  /** Événement de référence auquel le rattachement est proposé. */
  operationId: number;
  agendaItemId: number;
  /** Preuves citées par l'inférence ; la preuve RECEVABLE est de toute façon relue en base. */
  evidence?: readonly GraphEvidence[];
}

export interface ExtraAgendaLinkProposalResult {
  /**
   * PROPOSED : la question est posée (ou mise à jour) dans « À traiter » ;
   * NOT_PROPOSED : rien n'est proposé — le détail est dans `proposal.status`
   * (`NO_SHARED_EVIDENCE` : aucun justificatif commun ; `NOT_APPLICABLE` :
   * déjà rattaché, pas un rattachement supplémentaire, refus de l'utilisateur ;
   * `ALREADY_ANSWERED` : l'utilisateur a déjà répondu sur ces pièces) ;
   * USER_ONLY : acteur utilisateur — son geste passe directement par la façade.
   */
  status: 'PROPOSED' | 'NOT_PROPOSED' | 'USER_ONLY';
  proposal?: AgendaLinkProposalOutcome;
}

/**
 * Propose un rattachement d'Agenda SUPPLÉMENTAIRE par inférence. N'écrit
 * jamais ; ne lève jamais (une question non posée est rendue telle quelle, et
 * le passage suivant du traitement la redemandera).
 */
export async function proposeExtraAgendaLink(ctx: OperationWriteContext, input: ExtraAgendaLinkProposalInput): Promise<ExtraAgendaLinkProposalResult> {
  if (!ctx || typeof ctx.accountId !== 'number' || !ctx.actor) return { status: 'NOT_PROPOSED', proposal: { status: 'NOT_APPLICABLE', reason: 'INVALID_REQUEST' } };
  // Le geste de l'utilisateur n'a pas besoin de ce détour : il écrit par la façade, sans justificatif commun exigé.
  if (ctx.actor.kind === 'USER') return { status: 'USER_ONLY' };
  try {
    const { requestAgendaLinkProposal } = await import('@/services/to-process/operation-agenda-link-cards');
    const proposal = await requestAgendaLinkProposal(ctx.accountId, {
      operationId: input?.operationId, agendaItemId: input?.agendaItemId, ...(input?.evidence ? { evidence: input.evidence } : {}),
    });
    return { status: proposal.status === 'POSTED' || proposal.status === 'UPDATED' ? 'PROPOSED' : 'NOT_PROPOSED', proposal };
  } catch (e) {
    console.error(`[operation-write] rattachement proposé non transmis à « À traiter » (compte ${ctx.accountId}) :`, (e as Error).message);
    return { status: 'NOT_PROPOSED', proposal: { status: 'FAILED', reason: 'TECHNICAL_FAILURE' } };
  }
}
