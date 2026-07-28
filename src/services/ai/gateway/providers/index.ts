/**
 * Sélection du fournisseur actif — CDC §5.2.
 *
 * Le fournisseur est injectable : les tests substituent `FakeProvider` sans
 * modifier une ligne de code métier.
 */
import type { AiProvider } from './provider.port';
import { GeminiProvider } from './gemini.provider';

let _provider: AiProvider = new GeminiProvider();

export function getAiProvider(): AiProvider {
  return _provider;
}

/** Réservé aux tests et au futur changement de fournisseur. */
export function setAiProvider(p: AiProvider): void {
  _provider = p;
}

export type { AiProvider, ProviderCallInput, ProviderCallOutput } from './provider.port';
export { GeminiProvider } from './gemini.provider';
export { FakeProvider } from './fake.provider';
