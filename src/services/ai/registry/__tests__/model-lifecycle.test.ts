/**
 * Lot 35B — statut fournisseur (règle isolée) : Preview informatif,
 * Experimental exclu, fondé sur un champ structuré quand il existe.
 */
import { describe, it, expect } from 'vitest';
import { providerLifecycle, structuredLifecycle } from '../model-lifecycle';

describe('CAT-12 — statut fournisseur', () => {
  it('champ structuré : il fait foi, même contre le nom', () => {
    expect(providerLifecycle({ model: 'gemini-9-flash', launchStage: 'EXPERIMENTAL' })).toEqual({ status: 'experimental', basis: 'structured' });
    expect(providerLifecycle({ model: 'gemini-9-flash-preview', launchStage: 'GA' })).toEqual({ status: 'stable', basis: 'structured' });
    expect(providerLifecycle({ model: 'gemini-9-flash', launchStage: 'LAUNCH_STAGE_PREVIEW' }).status).toBe('preview');
    expect(structuredLifecycle('DEPRECATED')).toBe('deprecated');
    expect(structuredLifecycle('INCONNU')).toBeNull();
  });

  it('sans champ structuré : convention de nommage publiée par Google', () => {
    expect(providerLifecycle({ model: 'gemini-2.0-flash-exp' })).toEqual({ status: 'experimental', basis: 'name_rule' });
    expect(providerLifecycle({ model: 'gemini-exp-1206' }).status).toBe('experimental');
    expect(providerLifecycle({ model: 'gemini-9-flash', displayName: 'Gemini 9 Flash Experimental' }).status).toBe('experimental');
    expect(providerLifecycle({ model: 'gemini-3.1-pro-preview' }).status).toBe('preview');
    expect(providerLifecycle({ model: 'gemini-2.5-flash-preview-09-2025' }).status).toBe('preview');
    expect(providerLifecycle({ model: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash Preview' }).status).toBe('preview');
  });

  it('pas de faux positif sur un nom anodin', () => {
    for (const m of ['gemini-3.8-flash', 'gemini-3.8-live-extended-thinking', 'gemini-3.5-flash-lite', 'gemini-2.5-pro']) {
      expect(providerLifecycle({ model: m }).status, m).toBe('stable');
    }
    // La description n'est pas lue (texte libre) : seul le libellé l'est.
    expect(providerLifecycle({ model: 'gemini-9', description: 'Replaces our experimental model' }).status).toBe('stable');
  });
});
