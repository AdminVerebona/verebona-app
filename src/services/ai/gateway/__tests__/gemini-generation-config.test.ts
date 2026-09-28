/**
 * GEN-011 (température fixée dans le code) et projection du niveau de
 * raisonnement administré sur les réglages Gemini (§2.1).
 */
import { describe, it, expect } from 'vitest';
import { buildGenerationConfig, thinkingConfigFor, GEMINI_TEMPERATURE } from '../providers/gemini-generation-config';

describe('température (GEN-011)', () => {
  it('très basse, constante du code, toujours transmise', () => {
    expect(GEMINI_TEMPERATURE).toBe(0);
    expect(buildGenerationConfig({ model: 'gemini-3.5-flash' })).toEqual({ temperature: 0 });
  });
  it('le plafond de sortie administré est conservé', () => {
    expect(buildGenerationConfig({ model: 'x', maxOutputTokens: 800 })).toEqual({ temperature: 0, maxOutputTokens: 800 });
  });
});

describe('niveau de raisonnement', () => {
  it('standard ou absent : défaut du modèle, rien de transmis', () => {
    expect(thinkingConfigFor('gemini-3.5-flash', 'standard')).toBeUndefined();
    expect(thinkingConfigFor('gemini-3.5-flash', null)).toBeUndefined();
  });
  it('Gemini 3 : thinkingLevel', () => {
    expect(thinkingConfigFor('gemini-3.5-flash', 'minimal')).toEqual({ thinkingLevel: 'low' });
    expect(thinkingConfigFor('gemini-3.1-pro-preview', 'étendu')).toEqual({ thinkingLevel: 'high' });
    expect(thinkingConfigFor('gemini-3-flash-preview', 'minimal')).toEqual({ thinkingLevel: 'low' });
  });
  it('Gemini 2.5 : budget dans les bornes du modèle (Pro ne descend pas sous 128)', () => {
    expect(thinkingConfigFor('gemini-2.5-pro', 'minimal')).toEqual({ thinkingBudget: 128 });
    expect(thinkingConfigFor('gemini-2.5-flash', 'minimal')).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfigFor('gemini-2.5-flash-lite', 'étendu')).toEqual({ thinkingBudget: 24_576 });
  });
  it('famille sans raisonnement : rien plutôt qu’un paramètre refusé', () => {
    expect(thinkingConfigFor('gemini-2.0-flash', 'étendu')).toBeUndefined();
  });
  it('assemblé dans generationConfig', () => {
    expect(buildGenerationConfig({ model: 'gemini-2.5-pro', reasoning: 'étendu' }))
      .toEqual({ temperature: 0, thinkingConfig: { thinkingBudget: 32_768 } });
  });
});
