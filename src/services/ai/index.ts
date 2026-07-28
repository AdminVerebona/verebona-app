/**
 * Point d'entrée du domaine IA — CDC §5.
 *
 * Toute consommation de l'IA dans l'application passe par ce module. Les cinq
 * usages sont les seuls points d'entrée métier ; la gateway est le seul point
 * d'accès technique au fournisseur.
 */
export { AiGateway } from './gateway/ai-gateway';
export { AiGatewayError, isAiGatewayError } from './gateway/errors';
export type { AiGatewayRequest, AiGatewayResponse, AiAttachment } from './gateway/types';

export {
  AI_USE_CASES, AI_OPERATIONS, getOperation, listActiveUseCases,
  listLlmOperations, listOperationsByUseCase, syncAiRegistry, assertAiRegistryStartup,
} from './registry';
export type { AiUseCaseCode, AiOperationDefinition } from './registry';

export { recordEvidence, getActiveEvidence, supersedeEvidence } from './evidence/field-evidence.service';
export type { EvidenceValue, FieldEvidence, FieldOrigin } from './evidence/evidence.types';

export {
  AI_FLAGS, getFlagMode, isEnabled, isShadow, shouldRunNewEngine, shouldWrite,
  shouldRunLegacy, snapshotFlags,
} from './flags/ai-feature-flags';
export type { AiFlag, FlagMode } from './flags/ai-feature-flags';

export { getAiProvider, setAiProvider, FakeProvider } from './gateway/providers';
