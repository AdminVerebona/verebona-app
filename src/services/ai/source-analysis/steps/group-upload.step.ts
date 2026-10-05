/**
 * T1 master, branche GROUP_UPLOAD (opération `t1_group_upload`) — CDC 15
 * §23, P-T1-01.
 *
 * Un seul fichier ⇒ aucun appel ; sortie modèle corrigée par
 * `sanitizeGroups` (chaque index exactement une fois, aucun fichier perdu) ;
 * échec non bloquant ⇒ chaque fichier forme son propre document (§11.4).
 * Lot 16b-3 : l'ancienne étape `groupSources` (`group_sources`) est supprimée.
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { T1GroupUploadOutput, T1_MASTER_PROMPT_CODE } from '../master/t1-contract';
import { buildGroupUploadVariables } from '../master/prompt-context';
import { emptyTrace, mergeTrace } from '../trace';
import type { SourceInput, AiOperationTrace } from '../types';

export const T1_GROUP_UPLOAD_OPERATION = 't1_group_upload';

export interface GroupSourcesResult {
  /** Groupes d'INDICES dans `input.sourceIds` ; chaque index exactement une fois. */
  groups: number[][];
  trace: AiOperationTrace;
}

/**
 * Corrige une sortie modèle imparfaite : indices hors bornes, doublons,
 * fichiers oubliés. Aucun fichier ne doit disparaître du traitement (§11.4).
 */
export function sanitizeGroups(groups: number[][], count: number): number[][] {
  const seen = new Set<number>();
  const cleaned: number[][] = [];

  for (const group of groups) {
    const valid = group.filter((i) => Number.isInteger(i) && i >= 0 && i < count && !seen.has(i));
    valid.forEach((i) => seen.add(i));
    if (valid.length > 0) cleaned.push(valid);
  }

  // Tout indice oublié par le modèle forme son propre groupe.
  for (let i = 0; i < count; i++) {
    if (!seen.has(i)) cleaned.push([i]);
  }

  return cleaned.length > 0 ? cleaned : [[0]];
}

export async function groupUpload(input: SourceInput): Promise<GroupSourcesResult> {
  const count = input.sourceIds.length;
  const trace = emptyTrace();
  if (count <= 1) return { groups: [[0]], trace };

  try {
    const res = await AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS',
      operationCode: T1_GROUP_UPLOAD_OPERATION,
      task: 'GROUP_UPLOAD',
      masterPromptCode: T1_MASTER_PROMPT_CODE,
      accountId: input.accountId,
      userId: input.userId,
      sourceIds: input.sourceIds,
      promptVariables: buildGroupUploadVariables(input),
      attachments: (input.contentUrls ?? []).map((url, i) => ({
        url, mimeType: input.mimeTypes[i] ?? 'application/pdf', displayName: input.displayNames[i],
      })),
      outputSchema: T1GroupUploadOutput,
    });
    return { groups: sanitizeGroups(res.data.groups, count), trace: mergeTrace(trace, res, T1_GROUP_UPLOAD_OPERATION) };
  } catch (err) {
    console.warn('[t1_group_upload] échec non bloquant :', (err as Error).message);
    return { groups: input.sourceIds.map((_, i) => [i]), trace };
  }
}
