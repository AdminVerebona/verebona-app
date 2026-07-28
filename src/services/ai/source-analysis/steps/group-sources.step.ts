/**
 * Étape 4 — regroupement de fichiers (opération `group_sources`).
 *
 * CDC §4.1.7 : « Le regroupement de fichiers est une étape interne, pas un
 * usage IA autonome. » Il n'existe donc ni route, ni service, ni entrée de
 * référentiel réglementaire pour cette fonction (critère d'acceptation n°7).
 *
 * Déterminisme d'abord : un seul fichier ⇒ aucun appel modèle.
 */
import { AiGateway } from '../../gateway/ai-gateway';
import { GroupSourcesOutput } from '../schemas';
import type { SourceInput, AiOperationTrace } from '../types';
import { emptyTrace, mergeTrace } from '../trace';

export interface GroupSourcesResult {
  /** Groupes d'indices dans `input.sourceIds`. */
  groups: number[][];
  trace: AiOperationTrace;
}

export async function groupSources(input: SourceInput): Promise<GroupSourcesResult> {
  const count = input.sourceIds.length;
  const trace = emptyTrace();

  // Cas déterministes : aucun appel modèle (CDC §3.2, « n'utiliser un LLM que
  // lorsqu'il apporte une valeur réelle »).
  if (count <= 1) {
    return { groups: [[0]], trace };
  }

  try {
    const res = await AiGateway.execute({
      useCaseCode: 'SOURCE_ANALYSIS',
      operationCode: 'group_sources',
      accountId: input.accountId,
      userId: input.userId,
      sourceIds: input.sourceIds,
      promptVariables: {
        COUNT: String(count),
        FILENAMES: input.displayNames.map((n, i) => `[${i}] ${n}`).join('\n'),
      },
      attachments: buildAttachments(input),
      outputSchema: GroupSourcesOutput,
    });

    const groups = sanitizeGroups(res.data.groups, count);
    return { groups, trace: mergeTrace(trace, res, 'group_sources') };
  } catch (err) {
    // Repli sûr : chaque fichier constitue son propre document. Le regroupement
    // est une optimisation, jamais un prérequis (§11.4 : les tâches non
    // critiques échouent sans bloquer le document principal).
    console.warn('[group_sources] échec non bloquant :', (err as Error).message);
    return { groups: input.sourceIds.map((_, i) => [i]), trace };
  }
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

function buildAttachments(input: SourceInput) {
  if (!input.contentUrls) return [];
  return input.contentUrls.map((url, i) => ({
    url,
    mimeType: input.mimeTypes[i] ?? 'application/pdf',
    displayName: input.displayNames[i],
  }));
}
