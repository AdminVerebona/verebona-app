/**
 * Registre des outils — CDC Assistant §4.3.3 et §4.3.4.
 *
 * Vérifie les invariants structurels : lecture seule, périmètre de compte
 * obligatoire, catalogue exploitable par le modèle.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerReadTools, registerTool, listTools, getTool, describeToolsForModel, executeTool,
} from '../tools/tool-registry';
import { assertValidContext, AccountScopeViolation } from '../tools/account-scope';
import { ALL_READ_TOOLS } from '../tools/read-tools';
import { ASSISTANT_LIMITS, clampExcerpt } from '../tools/tool.port';
import type { AssistantTool } from '../tools/tool.port';

beforeEach(() => registerReadTools());

describe('les neuf outils du §4.3.4', () => {
  it('sont tous enregistrés', () => {
    expect(listTools()).toHaveLength(9);
  });

  it.each([
    'searchAssets', 'getAssetDetails', 'searchDocuments', 'getDocumentEvidence',
    'searchAgenda', 'searchSuppliers', 'searchEquipments', 'getFieldHistory',
    'getOpenInconsistencies',
  ])('%s est disponible', (name) => {
    expect(getTool(name)).not.toBeNull();
  });

  it('ne portent aucun verbe d\'écriture — lecture seule stricte', () => {
    for (const tool of ALL_READ_TOOLS) {
      expect(tool.name).toMatch(/^(search|get|list|find)/);
    }
  });

  it('exposent tous une description exploitable par le modèle', () => {
    for (const tool of listTools()) {
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});

describe('refus d\'enregistrement', () => {
  const fake = (name: string, description = 'une description suffisamment longue'): AssistantTool<never, unknown> => ({
    name, description, parameters: {},
    async execute() { return { data: null, sources: [], truncated: false }; },
  });

  it('refuse un outil dont le nom suggère une écriture', () => {
    expect(() => registerTool(fake('createAsset'))).toThrow(/lecture seule/);
    expect(() => registerTool(fake('deleteDocument'))).toThrow(/lecture seule/);
    expect(() => registerTool(fake('sendEmail'))).toThrow(/lecture seule/);
  });

  it('refuse un doublon de nom', () => {
    expect(() => registerTool(fake('searchAssets'))).toThrow(/déjà enregistré/);
  });

  it('refuse une description insuffisante', () => {
    expect(() => registerTool(fake('searchThings', 'court'))).toThrow(/description/);
  });
});

describe('sélection d\'outil par le modèle', () => {
  it('refuse un outil inventé plutôt que de le rapprocher d\'un existant', async () => {
    await expect(
      executeTool('searchAsset', {}, { accountId: 1, userId: 1, maxResults: 5 }),
    ).rejects.toThrow(/inconnu/);
  });

  it('produit un catalogue lisible, sans donnée de compte', () => {
    const catalogue = describeToolsForModel();
    expect(catalogue).toContain('searchAssets');
    expect(catalogue).toContain('paramètres');
    // Le catalogue décrit des capacités, jamais un contenu.
    expect(catalogue).not.toMatch(/\d{4,}/);
  });
});

describe('périmètre de compte', () => {
  it.each([0, -1, NaN, 1.5])('refuse un accountId invalide (%s)', (accountId) => {
    expect(() => assertValidContext('test', { accountId, userId: 1, maxResults: 5 }))
      .toThrow(AccountScopeViolation);
  });

  it('refuse un plafond de résultats absurde', () => {
    expect(() => assertValidContext('test', { accountId: 1, userId: 1, maxResults: 0 }))
      .toThrow(AccountScopeViolation);
  });
});

describe('plafonds du budget par demande (§31.2)', () => {
  it('correspondent aux valeurs du cahier des charges', () => {
    expect(ASSISTANT_LIMITS.maxSourcesRetrieved).toBe(8);
    expect(ASSISTANT_LIMITS.maxSourcesDisplayed).toBe(5);
    expect(ASSISTANT_LIMITS.maxExcerptChars).toBe(1500);
    expect(ASSISTANT_LIMITS.maxDisplayedExcerptChars).toBe(240);
    expect(ASSISTANT_LIMITS.maxAiCallsPerMessage).toBe(2);
    expect(ASSISTANT_LIMITS.maxInputTokens).toBe(12_000);
    expect(ASSISTANT_LIMITS.maxOutputTokens).toBe(500);
  });

  it('tronque les extraits avant transmission au modèle', () => {
    expect(clampExcerpt('x'.repeat(5000)).length).toBeLessThanOrEqual(1501);
    expect(clampExcerpt('court')).toBe('court');
    expect(clampExcerpt(null)).toBe('');
  });
});
