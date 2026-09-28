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
import { currentStartupVerdict, resetModelStartupForTests } from './core/model-startup-check';

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
 * Verdict du contrôle de démarrage (§15.14), consulté par la route des
 * messages.
 *
 * Le contrôle COMPLET (registre de modèles : alias, autorisation, prix,
 * sorties structurées) s'exécute au démarrage (`instrumentation-node.ts`) et
 * à chaque changement de configuration du BO IA (`runAssistantStartupCheck`) :
 * son verdict fait foi. Sans lui (tests, instance qui n'a pas encore fini de
 * démarrer), le contrôle statique des limites V1 est appliqué ici, une fois.
 */
export function ensureAssistantStartupChecked(): { ok: true } | { ok: false; error: string } {
  const complet = currentStartupVerdict();
  if (complet) return complet;
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

export { runAssistantStartupCheck, lastValidRegistry } from './core/model-startup-check';

/** Réservé aux tests. */
export function resetStartupCheckForTests(): void {
  startupVerdict = null;
  resetModelStartupForTests();
}
