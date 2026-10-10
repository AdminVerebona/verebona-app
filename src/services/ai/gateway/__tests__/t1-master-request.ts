/**
 * Requête de test sur une opération T1 RÉELLE du registre — lot 16b-3.
 *
 * Les tests de la passerelle employaient les opérations d'étapes T1
 * (`classify_document`, `extract_source`…) comme opération « ordinaire ».
 * Elles sont supprimées : ces tests passent par la branche GROUP_UPLOAD du
 * master T1 (`t1_group_upload`, mêmes modèles DOC), avec EXACTEMENT les
 * variables du master (le chargeur refuse toute variable sans emplacement) et
 * une sortie portant le discriminant `task`.
 */
import { z } from 'zod';
import { buildGroupUploadVariables } from '@/services/ai/source-analysis/master/prompt-context';
import { asTestContract } from '../output-resolution/runtime-contract';

export const T1_TEST_OPERATION = 't1_group_upload';

/** Variables complètes du master T1 ; `EXTRACTED_CONTENT` porte le texte de test. */
export function t1TestVariables(contenu = 'facture'): Record<string, string> {
  return {
    ...buildGroupUploadVariables({
      sourceType: 'file', sourceIds: [1], accountId: 1, userId: 1,
      mimeTypes: ['application/pdf'], displayNames: ['facture.pdf'],
    }),
    EXTRACTED_CONTENT: JSON.stringify(contenu),
  };
}

/** Sortie modèle de la branche (discriminant inclus). */
export const t1Out = (o: Record<string, unknown>): string => JSON.stringify({ task: 'GROUP_UPLOAD', ...o });

/**
 * Schéma de test : le discriminant, puis les champs de l'appelant. Lot 34D :
 * déclaré CONTRAT DE TEST (`asTestContract`) — la passerelle refuse sinon un
 * schéma d'appelant différent du contrat du registre (RUNTIME_CONTRACT_MISMATCH).
 */
export function t1Schema<T extends z.ZodRawShape>(shape: T) {
  return asTestContract(z.object({ task: z.literal('GROUP_UPLOAD'), ...shape }));
}
