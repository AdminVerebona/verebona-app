/**
 * Point d'entrée du module assistant Verebona.
 * Réexporte les contrats, registres, config et l'orchestrateur.
 */
export * from './types';
export * from './registries';
export * from './config/assistant-config';
export { runAssistant } from './core/assistant-orchestrator.service';
export type { OrchestratorPorts } from './core/assistant-orchestrator.service';
export { getAssistantProvider, setAssistantProvider } from './providers';

import { assertConfigAtStartup } from './config/assistant-config';
import { assertAliasesResolvable } from './registries/model-registry';

/** À appeler au démarrage (instrumentation.ts) — CDC §15.14. */
export function assertAssistantStartup(): void {
  assertConfigAtStartup();
  assertAliasesResolvable();
}
