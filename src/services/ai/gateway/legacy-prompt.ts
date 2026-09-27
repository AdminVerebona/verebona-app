/**
 * Appel d'un module historique à travers la passerelle — plan de retrait
 * WF-41 (E-05) ; CDC BO IA PROV-UI-05, WF-21, OPS-011, OPS-008, WF-07, WF-08.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE REMPLACE
 *
 * `provider/legacy-gemini-access.ts` (supprimé) donnait aux modules Gemini
 * antérieurs à la passerelle le minimum exigible : la clé du BO et la garde
 * d'exploitation. Ils restaient hors trace, hors coût, hors disjoncteur et
 * sur des modèles codés en dur.
 *
 * Ils passent désormais par `AiGateway.execute`, chacun sous une opération
 * déclarée du référentiel (`legacy_*`, `operations.ts`). Ils y gagnent tout ce
 * que la passerelle porte : trace d'exécution, coût et jetons, arrêt d'urgence
 * et état du traitement (`AI_BLOCKED`), disjoncteur, clé du BO, modèles et
 * plafonds de la version de configuration figée de leur traitement.
 *
 * Ce qui NE change PAS : le prompt (composé par le module à partir de son
 * gabarit, relayé tel quel par le prompt technique `legacy_*_v1`) et
 * l'analyse de la réponse (rendue brute, `outputFormat: 'text'`). Le filtre
 * `accept` reprend le critère qui, dans l'ancien module, faisait passer au
 * modèle suivant (réponse vide, JSON illisible) : la passerelle le traite
 * comme une sortie invalide, récupérable.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AiGateway } from './ai-gateway';
import type { AiAttachment, AiGatewayResponse } from './types';
import type { AiUseCaseCode } from '../registry/use-cases';

/** Variable unique des prompts techniques de relais (`legacy_*_v1.txt`). */
export const LEGACY_PROMPT_VARIABLE = 'LEGACY_PROMPT';

export interface LegacyPromptCall {
  useCaseCode: AiUseCaseCode;
  operationCode: string;
  accountId: number;
  userId?: number;
  sourceIds?: number[];
  /** `ai_operation.id` ouvert par l'appelant (AiUsageTracker), s'il y en a un. */
  parentOperationId?: number;
  /** Prompt complet, composé par le module historique. */
  prompt: string;
  attachments?: AiAttachment[];
  /**
   * Réponse exploitable ? `false` = sortie invalide : la passerelle passe au
   * modèle suivant de la chaîne. Absent : toute réponse est acceptée.
   */
  accept?: (text: string) => boolean;
  /** Nombre de tentatives de l'ancien module (1 = aucun repli). */
  maxModelAttempts?: number;
  firstModelIndex?: number;
  /** Plafond de sortie de l'ancien module ; ne peut que réduire la config. */
  maxOutputTokensCap?: number;
  /** Surcharge ponctuelle du mode JSON natif déclaré par l'opération. */
  jsonResponse?: boolean;
}

/**
 * Exécute un prompt historique et rend la réponse BRUTE (`data`).
 *
 * Clé d'idempotence unique par appel : l'ancien module appelait le modèle à
 * chaque fois, et ses variables ne décrivent pas toujours l'entrée (les
 * pièces jointes n'entrent pas dans la clé dérivée) — une clé dérivée
 * risquerait de servir la réponse d'un autre document.
 *
 * Lève les erreurs de la passerelle telles quelles, `AI_BLOCKED` compris :
 * chaque appelant garde son propre repli.
 */
export async function executeLegacyPrompt(call: LegacyPromptCall): Promise<AiGatewayResponse<string>> {
  const accept = call.accept ?? (() => true);
  const schema = z.string().refine((text) => accept(text), { message: 'réponse inexploitable' });

  return AiGateway.execute<string>({
    useCaseCode: call.useCaseCode,
    operationCode: call.operationCode,
    accountId: call.accountId,
    userId: call.userId,
    sourceIds: call.sourceIds,
    parentOperationId: call.parentOperationId,
    promptVariables: { [LEGACY_PROMPT_VARIABLE]: call.prompt },
    attachments: call.attachments,
    outputSchema: schema,
    idempotencyKey: randomUUID().replace(/-/g, ''),
    maxModelAttempts: call.maxModelAttempts,
    firstModelIndex: call.firstModelIndex,
    maxOutputTokensCap: call.maxOutputTokensCap,
    jsonResponse: call.jsonResponse,
  });
}
