export * from './assistant-model-provider';
export * from './fake-provider';
export * from './gemini-genai-provider';

import type { AssistantModelProvider } from './assistant-model-provider';
import { GeminiGenAIProvider } from './gemini-genai-provider';

let _provider: AssistantModelProvider | null = null;

/** Fabrique du provider actif. Injectable pour les tests (§25.5). */
export function getAssistantProvider(): AssistantModelProvider {
  if (!_provider) _provider = new GeminiGenAIProvider();
  return _provider;
}
export function setAssistantProvider(p: AssistantModelProvider): void {
  _provider = p;
}
