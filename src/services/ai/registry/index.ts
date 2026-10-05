/**
 * Point d'entrée du référentiel IA — CDC §5.1.
 */
export {
  AI_USE_CASE_CODES, AI_USE_CASES, isAiUseCaseCode, listActiveUseCases,
} from './use-cases';
export type { AiUseCaseCode, AiUseCaseDefinition } from './use-cases';

export {
  AI_OPERATIONS, getOperation, listLlmOperations, listOperationsByUseCase,
  isMasterOperation, listMasterTasks, listMasterPrompts, isTargetArchitectureOperation, listNonTargetOperations,
} from './operations';
export type { AiOperationCode, AiOperationDefinition } from './operations';

export { syncAiRegistry } from './registry.repository';

import { assertPricingReady } from '../gateway/cost-catalog';
import { AI_OPERATIONS, isTargetArchitectureOperation, type AiOperationDefinition } from './operations';
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
    // Lot 16b : architecture cible seule — tout appel modèle passe par un
    // prompt maître, sauf l'évaluation d'une version candidate (`dynamicPrompt`).
    if (op.active && !isTargetArchitectureOperation(op)) {
      throw new Error(
        `[ai-registry] Opération « ${op.operationCode} » : appel modèle hors prompt maître. Les étapes historiques `
        + 'et relais legacy sont retirés (lot 16b) : déclarez une branche du master du traitement.',
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
 * · un master n'est pas dynamique ;
 * · toutes les opérations master d'un usage partagent le même master.
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
    if (op.dynamicPrompt) {
      throw new Error(`${où} : un prompt maître n'est pas dynamique.`);
    }
    const autres = Object.values(AI_OPERATIONS).filter(
      (o) => o.useCaseCode === op.useCaseCode && o.masterPromptCode && o.masterPromptCode !== op.masterPromptCode,
    );
    if (autres.length > 0) {
      throw new Error(`${où} : un seul prompt maître par traitement (CDC 15 §22), trouvé aussi « ${autres[0].masterPromptCode} ».`);
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
