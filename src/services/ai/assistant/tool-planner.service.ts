/**
 * Sélection des outils — opération `understand_request`, CDC Assistant §4.3.4.
 *
 * ⚠️ CE SERVICE N'EST APPELÉ PAR PERSONNE, ET SON CONTRAT N'EST PLUS CELUI DU
 * PROMPT STOCKÉ.
 *
 * Deux conceptions d'assistant coexistent dans le dépôt : celle-ci, par outils,
 * et celle de `services/verebona-assistant`, par intentions — la seule branchée
 * sur `/api/verebona/messages`. Les deux appelaient la MÊME opération
 * `understand_request`, donc le même prompt, en attendant deux sorties
 * incompatibles : `{ tools, ambiguous }` ici, `{ intent, confidence }` là-bas.
 *
 * Le prompt servait cette conception-ci. Conséquence constatée en préproduction
 * le 18/09/2026 : toute classification du chemin vivant échouait sur
 * « Sortie non conforme au schéma. intent : Invalid input », et l'assistant
 * répondait qu'il manquait d'éléments à chaque question non reconnue par les
 * règles déterministes.
 *
 * Le prompt a été aligné sur le consommateur réel. `answerQuestion`, qui est le
 * seul appelant de ce fichier, n'a lui-même aucun appelant : l'ensemble est du
 * code mort, à supprimer au lot de nettoyage. Le réactiver supposerait de lui
 * donner une opération et un prompt propres.
 *
 * Le modèle reçoit le CATALOGUE des outils et la question. Il ne reçoit jamais
 * de données du compte à cette étape : c'est ce qui distingue cette conception
 * de l'ancienne recherche intelligente, qui sérialisait le contexte du compte
 * avant même de savoir ce qui était utile (§5.6).
 */
import { z } from 'zod';
import { AiGateway } from '../gateway/ai-gateway';
import { describeToolsForModel, getTool } from './tools/tool-registry';

const ToolPlanOutput = z.object({
  tools: z.array(z.object({
    name: z.string().min(1).max(60),
    params: z.record(z.string(), z.unknown()).default({}),
  })).max(4).default([]),
  /** Le modèle signale lui-même qu'il ne comprend pas la demande. */
  ambiguous: z.boolean().default(false),
  clarification: z.string().max(300).optional(),
});

export interface ToolPlan {
  calls: Array<{ name: string; params: Record<string, unknown> }>;
  ambiguous: boolean;
  clarification?: string;
}

export async function planTools(
  question: string,
  accountId: number,
  userId: number,
): Promise<ToolPlan> {
  const res = await AiGateway.execute({
    useCaseCode: 'INTELLIGENT_ASSISTANT',
    operationCode: 'understand_request',
    accountId,
    userId,
    promptVariables: {
      QUESTION: question,
      TOOLS: describeToolsForModel(),
      TODAY: new Date().toISOString().slice(0, 10),
    },
    outputSchema: ToolPlanOutput,
  });

  // Un outil inventé par le modèle est écarté, jamais deviné ni rapproché.
  const calls = res.data.tools.filter((t) => {
    if (getTool(t.name)) return true;
    console.warn(`[assistant] outil inconnu proposé : « ${t.name} » — ignoré`);
    return false;
  });

  return {
    calls,
    ambiguous: res.data.ambiguous || calls.length === 0,
    clarification: res.data.clarification,
  };
}
