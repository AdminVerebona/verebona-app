export * from './assistant-model-provider';
export * from './fake-provider';
export * from './gateway-provider';

import type { AssistantModelProvider } from './assistant-model-provider';
import { GatewayAssistantProvider } from './gateway-provider';

let _provider: AssistantModelProvider | null = null;

/**
 * Fabrique du provider actif. Injectable pour les tests (§25.5).
 *
 * ⚠️ Le provider par défaut passe par `AiGateway`, jamais par un SDK
 * fournisseur. Le §5.2 du CDC refonte l'exige, et c'est aussi ce qui donne à
 * l'assistant le comptage des jetons, l'imputation du coût, le journal
 * d'opération et le repli fournisseur.
 *
 * `GeminiGenAIProvider` a été retiré : il n'était qu'un stub levant « non
 * implémenté », et l'implémenter aurait figé la dette n° 4 de
 * l'anti-régression — un accès direct au SDK.
 */
export function getAssistantProvider(): AssistantModelProvider {
  if (!_provider) _provider = new GatewayAssistantProvider();
  return _provider;
}
export function setAssistantProvider(p: AssistantModelProvider): void {
  _provider = p;
}
