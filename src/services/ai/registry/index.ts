/**
 * Point d'entrée du référentiel IA — CDC §5.1.
 */
export {
  AI_USE_CASE_CODES, AI_USE_CASES, isAiUseCaseCode, listActiveUseCases,
} from './use-cases';
export type { AiUseCaseCode, AiUseCaseDefinition } from './use-cases';

export {
  AI_OPERATIONS, getOperation, listLlmOperations, listOperationsByUseCase,
  isMasterOperation, listMasterTasks, listMasterPrompts,
} from './operations';
export type { AiOperationCode, AiOperationDefinition, MasterMigrationTarget } from './operations';

export { syncAiRegistry } from './registry.repository';

import { assertPricingReady } from '../gateway/cost-catalog';
import { AI_OPERATIONS, isMasterOperation, type AiOperationDefinition } from './operations';
import { isAiUseCaseCode } from './use-cases';

/**
 * Contrôles de cohérence du référentiel, exécutés au démarrage. Synchrone :
 * ne dépend que du code. Le contrôle des tarifs est séparé ci-dessous.
 */
export function assertAiRegistryStartup(): void {
  for (const op of Object.values(AI_OPERATIONS)) {
    if (!isAiUseCaseCode(op.useCaseCode)) {
      throw new Error(`[ai-registry] Opération « ${op.operationCode} » rattachée à un usage inconnu : ${op.useCaseCode}`);
    }
    if (op.provider !== 'none' && !op.promptCode && op.outputSchema !== 'none' && !op.dynamicPrompt) {
      throw new Error(
        `[ai-registry] Opération « ${op.operationCode} » : appel modèle sans prompt versionné. ` +
        'Déclarez un `promptCode`, ou `dynamicPrompt: true` si le prompt est fourni à l\'appel.',
      );
    }
    // Exemption de masquage (§5.6) : réservée aux prompts historiques relayés.
    if (op.unredactedVariables?.length && !op.legacyPrompt) {
      throw new Error(
        `[ai-registry] Opération « ${op.operationCode} » : \`unredactedVariables\` n'est admis que pour un prompt historique relayé (\`legacyPrompt\`).`,
      );
    }
    assertMasterDeclaration(op);
  }
}

/**
 * Cohérence des déclarations « prompt maître » (CDC 15 §22.3, §29.1, ARCH-03).
 *
 * · une opération master déclare `masterPromptCode` ET `task`, et son
 *   `promptCode` EST le master (une entrée prompt par traitement) ;
 * · un master n'est ni relayé (`legacyPrompt`) ni dynamique ;
 * · toutes les opérations master d'un usage partagent le même master ;
 * · `migratesTo` d'une opération historique pointe vers une opération master
 *   existante, de même usage, même master et même TASK.
 */
export function assertMasterDeclaration(op: AiOperationDefinition): void {
  const où = `[ai-registry] Opération « ${op.operationCode} »`;
  if (Boolean(op.masterPromptCode) !== Boolean(op.task)) {
    throw new Error(`${où} : \`masterPromptCode\` et \`task\` vont ensemble (CDC 15 §22.2).`);
  }
  if (op.masterPromptCode) {
    if (op.promptCode !== op.masterPromptCode) {
      throw new Error(`${où} : \`promptCode\` doit être le master « ${op.masterPromptCode} » (CDC 15 §29.1).`);
    }
    if (op.legacyPrompt || op.dynamicPrompt) {
      throw new Error(`${où} : un prompt maître n'est ni relayé ni dynamique.`);
    }
    const autres = Object.values(AI_OPERATIONS).filter(
      (o) => o.useCaseCode === op.useCaseCode && o.masterPromptCode && o.masterPromptCode !== op.masterPromptCode,
    );
    if (autres.length > 0) {
      throw new Error(`${où} : un seul prompt maître par traitement (CDC 15 §22), trouvé aussi « ${autres[0].masterPromptCode} ».`);
    }
  }
  if (op.migratesTo) {
    const cible = AI_OPERATIONS[op.migratesTo.operationCode];
    if (!cible || !isMasterOperation(cible)
      || cible.useCaseCode !== op.useCaseCode
      || cible.masterPromptCode !== op.migratesTo.masterPromptCode
      || cible.task !== op.migratesTo.task) {
      throw new Error(
        `${où} : \`migratesTo\` incohérent (${op.migratesTo.masterPromptCode} / ${op.migratesTo.task} → ` +
        `${op.migratesTo.operationCode}) — l'opération master cible doit exister avec ce master et cette TASK.`,
      );
    }
  }
}

/**
 * Contrôle des tarifs — CDC Assistant §15.14. Asynchrone : les tarifs sont des
 * données d'exploitation lues en base, plus des constantes du code.
 */
export async function assertAiPricingStartup(): Promise<void> {
  await assertPricingReady();
}
