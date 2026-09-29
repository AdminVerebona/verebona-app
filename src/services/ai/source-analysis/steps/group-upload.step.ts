/**
 * T1 master, branche GROUP_UPLOAD (opération `t1_group_upload`) — CDC 15
 * §23, P-T1-01.
 *
 * Même contrat que l'étape historique `groupSources` : un seul fichier ⇒
 * aucun appel ; sortie modèle corrigée par `sanitizeGroups` (chaque index
 * exactement une fois, aucun fichier perdu) ; échec non bloquant ⇒ chaque
 * fichier forme son propre document (§11.4).
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { T1GroupUploadOutput, T1_MASTER_PROMPT_CODE } from '../master/t1-contract';
import { buildGroupUploadVariables } from '../master/prompt-context';
import { sanitizeGroups, type GroupSourcesResult } from './group-sources.step';
import { emptyTrace, mergeTrace } from '../trace';
import type { SourceInput } from '../types';

export const T1_GROUP_UPLOAD_OPERATION = 't1_group_upload';

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
