/**
 * Point d'entrée du module assistant Verebona.
 * Réexporte les contrats, registres, config et l'orchestrateur.
 *
 * Nettoyage (audit assistant, « dérive d'architecture ») : `providers/`
 * (GatewayAssistantProvider, FakeProvider) n'était sur aucun chemin
 * d'exécution — les adaptateurs appellent la passerelle via
 * `core/ai-call-budget.executeWithinBudget`, seul point d'appel modèle. Le
 * réexport laissait croire à un provider « actif » : supprimé.
 */
export * from './types';
export * from './registries';
export * from './config/assistant-config';
export { runAssistant } from './core/assistant-orchestrator.service';
export type { OrchestratorPorts } from './core/assistant-orchestrator.service';

import { assertConfigAtStartup } from './config/assistant-config';
import { AI_OPERATIONS } from '@/services/ai/registry/operations';

/**
 * Contrôle de démarrage — CDC §15.14.
 *
 * Configuration assistant (limites V1) ET modèles réellement appelés par la
 * passerelle (`AI_OPERATIONS`) : pas d'alias « latest », pas de modèle Pro,
 * escalade distincte du modèle par défaut.
 */
export function assertAssistantStartup(): void {
  assertConfigAtStartup(undefined, AI_OPERATIONS);
}

let startupVerdict: { ok: true } | { ok: false; error: string } | null = null;

/**
 * Contrôle de démarrage exécuté UNE fois par processus, au premier message.
 *
 * `instrumentation.ts` (hors du périmètre de ce lot) devrait l'appeler au
 * boot ; en attendant, la route des messages l'appelle : une configuration
 * invalide est journalisée bruyamment et l'assistant refuse les demandes
 * (503) plutôt que de tourner hors des limites V1 — le reste de
 * l'application n'est pas affecté.
 */
export function ensureAssistantStartupChecked(): { ok: true } | { ok: false; error: string } {
  if (startupVerdict) return startupVerdict;
  try {
    assertAssistantStartup();
    startupVerdict = { ok: true };
  } catch (e) {
    console.error('[verebona-assistant] CONTRÔLE DE DÉMARRAGE EN ÉCHEC (§15.14) :', (e as Error).message);
    startupVerdict = { ok: false, error: (e as Error).message };
  }
  return startupVerdict;
}

/** Réservé aux tests. */
export function resetStartupCheckForTests(): void {
  startupVerdict = null;
}
