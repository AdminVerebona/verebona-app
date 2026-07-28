/**
 * Point d'entrée du référentiel IA — CDC §5.1.
 */
export {
  AI_USE_CASE_CODES, AI_USE_CASES, isAiUseCaseCode, listActiveUseCases,
} from './use-cases';
export type { AiUseCaseCode, AiUseCaseDefinition } from './use-cases';

export {
  AI_OPERATIONS, getOperation, listLlmOperations, listOperationsByUseCase,
} from './operations';
export type { AiOperationCode, AiOperationDefinition } from './operations';

export { syncAiRegistry } from './registry.repository';

import { assertPricingReady } from '../gateway/cost-catalog';
import { AI_OPERATIONS } from './operations';
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
  }
}

/**
 * Contrôle des tarifs — CDC Assistant §15.14. Asynchrone : les tarifs sont des
 * données d'exploitation lues en base, plus des constantes du code.
 */
export async function assertAiPricingStartup(): Promise<void> {
  await assertPricingReady();
}
