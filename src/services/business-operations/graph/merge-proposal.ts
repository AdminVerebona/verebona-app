/**
 * DEMANDER UNE FUSION, NE PAS LA DÉCIDER (carte Trello #744, CDC « Opérations /
 * Agenda V2.0 » §7, §8, §20 ; AC11, AC12, AC16, AC17).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POINT D'ENTRÉE DES TRAITEMENTS (T3, reprise) POUR UN DOUBLON PROBABLE
 *
 * CDC §7 : « la fusion automatique exige preuves convergentes, absence de
 * contradiction importante, non-contournement des refus et conservation des
 * données protégées ; un score IA seul est insuffisant » — et AC12 : « conflits
 * utilisateurs ou similarité insuffisante : pas de fusion automatique ».
 *
 * La fusion automatique autorisée garde son chemin EXISTANT
 * (`BusinessOperationRepository.mergeOperations`, appelée par la consolidation
 * sur référence commune ou série). Tout le reste passe par une CARTE : un
 * traitement appelle CETTE fonction, la question est posée une fois dans
 * « À traiter » (`to-process/operation-merge-cards.ts`), et la réponse est
 * appliquée par la façade d'écriture.
 *
 * Aucune règle n'est ajoutée ici : ni décision, ni écriture, ni appel IA.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { FactField, MergeCardOutcome } from '@/services/to-process/operation-merge-cards';
import type { GraphEvidence } from './model';
import type { OperationWriteContext } from '../operation-write.facade';

export interface MergeProposalInput {
  operationAId: number;
  operationBId: number;
  /** Preuves de la même réalité réunies par le traitement (au moins une : un score seul ne suffit pas). */
  evidence: readonly GraphEvidence[];
}

export interface FactProposalInput {
  operationAId: number;
  operationBId: number;
  field: FactField;
  evidence?: readonly GraphEvidence[];
}

export interface GraphProposalResult {
  /** ASKED : la question est posée (ou mise à jour) ; NOT_ASKED : rien n'est demandé (détail dans `card.status`). */
  status: 'ASKED' | 'NOT_ASKED';
  card?: MergeCardOutcome;
}

const suite = (card: MergeCardOutcome): GraphProposalResult =>
  ({ status: card.status === 'POSTED' || card.status === 'UPDATED' ? 'ASKED' : 'NOT_ASKED', card });

/**
 * Demande « même événement de référence, ou deux ? ». N'écrit jamais, ne
 * fusionne jamais ; ne lève jamais (le passage suivant redemandera).
 */
export async function proposeReferenceEventMerge(ctx: OperationWriteContext, input: MergeProposalInput): Promise<GraphProposalResult> {
  if (!ctx || typeof ctx.accountId !== 'number') return { status: 'NOT_ASKED', card: { status: 'NOT_APPLICABLE', reason: 'INVALID_REQUEST' } };
  try {
    // CDC §7 et AC46 (recette #744) : une SÉPARATION décidée par l'utilisateur ne se rejoue pas contre lui —
    // la question « même événement de référence ? » n'est plus posée sur une paire qu'il a scindée
    // (`wasSplitApart`, motif `USER_SPLIT`). Il reste libre de fusionner lui-même depuis la page.
    if (typeof input?.operationAId === 'number' && typeof input?.operationBId === 'number') {
      const { wasSplitApart } = await import('./read');
      if (await wasSplitApart(ctx.accountId, input.operationAId, input.operationBId)) {
        return { status: 'NOT_ASKED', card: { status: 'NOT_APPLICABLE', reason: 'USER_SPLIT_APART' } };
      }
    }
    const { requestReferenceEventMergeArbitration } = await import('@/services/to-process/operation-merge-cards');
    return suite(await requestReferenceEventMergeArbitration(ctx.accountId, {
      operationAId: input?.operationAId, operationBId: input?.operationBId, evidence: input?.evidence ?? [],
    }));
  } catch (e) {
    console.error(`[operation-write] fusion probable non transmise à « À traiter » (compte ${ctx.accountId}) :`, (e as Error).message);
    return { status: 'NOT_ASKED', card: { status: 'FAILED', reason: 'TECHNICAL_FAILURE' } };
  }
}

/**
 * Demande « quel fait est correct ? » entre deux événements de référence
 * associés. N'écrit jamais ; ne lève jamais.
 */
export async function proposeReferenceEventFact(ctx: OperationWriteContext, input: FactProposalInput): Promise<GraphProposalResult> {
  if (!ctx || typeof ctx.accountId !== 'number') return { status: 'NOT_ASKED', card: { status: 'NOT_APPLICABLE', reason: 'INVALID_REQUEST' } };
  try {
    const { requestReferenceEventFactArbitration } = await import('@/services/to-process/operation-merge-cards');
    return suite(await requestReferenceEventFactArbitration(ctx.accountId, {
      operationAId: input?.operationAId, operationBId: input?.operationBId, field: input?.field,
      ...(input?.evidence ? { evidence: input.evidence } : {}),
    }));
  } catch (e) {
    console.error(`[operation-write] fait contradictoire non transmis à « À traiter » (compte ${ctx.accountId}) :`, (e as Error).message);
    return { status: 'NOT_ASKED', card: { status: 'FAILED', reason: 'TECHNICAL_FAILURE' } };
  }
}
