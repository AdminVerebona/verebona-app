/**
 * GEN-011 / lot 85C (CDC Pilotage IA V2 P4, INV-03, décision 09) : la
 * température et le raisonnement transmis viennent de la FICHE DE CAPACITÉS
 * du modèle (références documentées par identifiant exact), plus d'une
 * déduction par le nom. Les modèles en service gardent exactement les
 * réglages transmis depuis le lot 52B.
 */
import { describe, it, expect } from 'vitest';
import { buildGenerationConfig, describeGenerationConfig } from '../providers/gemini-generation-config';

describe('température (GEN-011 → profil par famille, décision 09)', () => {
  it('famille documentée : 0, comme avant', () => {
    expect(buildGenerationConfig({ model: 'gemini-3.5-flash' })).toEqual({ temperature: 0 });
    expect(buildGenerationConfig({ model: 'gemini-2.5-pro' })).toEqual({ temperature: 0 });
  });
  it('modèle sans fiche : aucune température inventée, le plafond de sortie administré est conservé', () => {
    expect(buildGenerationConfig({ model: 'x', maxOutputTokens: 800 })).toEqual({ maxOutputTokens: 800 });
  });
});

describe('niveau de raisonnement (références documentées, inchangées)', () => {
  const tc = (model: string, reasoning: 'minimal' | 'standard' | 'étendu' | null) => buildGenerationConfig({ model, reasoning }).thinkingConfig;
  it('standard ou absent : défaut du modèle, rien de transmis', () => {
    expect(tc('gemini-3.5-flash', 'standard')).toBeUndefined();
    expect(tc('gemini-3.5-flash', null)).toBeUndefined();
  });
  it('fiche « niveaux » : thinkingLevel', () => {
    expect(tc('gemini-3.5-flash', 'minimal')).toEqual({ thinkingLevel: 'low' });
    expect(tc('gemini-3.1-pro-preview', 'étendu')).toEqual({ thinkingLevel: 'high' });
    expect(tc('gemini-3-flash-preview', 'minimal')).toEqual({ thinkingLevel: 'low' });
  });
  it('fiche « budget » : dans les bornes du modèle (Pro ne descend pas sous 128)', () => {
    expect(tc('gemini-2.5-pro', 'minimal')).toEqual({ thinkingBudget: 128 });
    expect(tc('gemini-2.5-flash', 'minimal')).toEqual({ thinkingBudget: 0 });
    expect(tc('gemini-2.5-flash-lite', 'étendu')).toEqual({ thinkingBudget: 24_576 });
  });
  it('modèle sans fiche : rien plutôt qu’un paramètre deviné', () => {
    expect(tc('gemini-2.0-flash', 'étendu')).toBeUndefined();
  });
  it('assemblé dans generationConfig, décrit à l’identique pour la trace', () => {
    expect(buildGenerationConfig({ model: 'gemini-2.5-pro', reasoning: 'étendu' }))
      .toEqual({ temperature: 0, thinkingConfig: { thinkingBudget: 32_768 } });
    expect(describeGenerationConfig({ model: 'gemini-2.5-pro', reasoning: 'étendu' })).toMatchObject({ thinkingConfig: 'budget 32768', temperature: 0, refused: null });
  });
  it('paramètres déjà résolus (passerelle) : transmis tels quels', () => {
    expect(buildGenerationConfig({ model: 'peu-importe', reasoning: 'étendu', generation: { temperature: null, maxOutputTokens: 77, thinking: { thinkingLevel: 'x' } } }))
      .toEqual({ maxOutputTokens: 77, thinkingConfig: { thinkingLevel: 'x' } });
  });
});
