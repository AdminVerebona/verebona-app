/**
 * CDC §9.7 et §12 — rapport d'inventaire partagé entre le script et la route.
 *
 * Deux chemins produisent ce rapport : `scripts/ai-inventory.ts` et
 * `/api/cron/ai/inventory`. Ces tests portent sur ce qu'ils partagent — la
 * lecture de la fenêtre et la composition du verdict global —, parce qu'une
 * divergence entre les deux rendrait la preuve du §12 discutable.
 */
import { describe, it, expect } from 'vitest';
import {
  parseWindow, buildDeclaredSection, buildInventoryReport, DEFAULT_WINDOW_DAYS,
} from '../inventory-report';

describe('lecture de la fenêtre', () => {
  it('vaut trente jours par défaut', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
    expect(parseWindow(null)).toBe(30);
    expect(parseWindow(undefined)).toBe(30);
    expect(parseWindow('')).toBe(30);
  });

  it('accepte jours et heures', () => {
    expect(parseWindow('7d')).toBe(7);
    expect(parseWindow('90')).toBe(90);
    expect(parseWindow('90D')).toBe(90);
    expect(parseWindow('12h')).toBe(0.5);
    expect(parseWindow(' 30d ')).toBe(30);
  });

  it('refuse une valeur illisible plutôt que de retomber sur le défaut', () => {
    // Retomber silencieusement sur trente jours produirait un verdict portant
    // sur une période autre que celle demandée, sans que personne le voie.
    expect(parseWindow('abc')).toBeNull();
    expect(parseWindow('-5d')).toBeNull();
    expect(parseWindow('0')).toBeNull();
    expect(parseWindow('30 jours')).toBeNull();
    expect(parseWindow('1e3')).toBeNull();
  });
});

describe('section déclarée', () => {
  it('recense exactement les six usages du référentiel (cinq + mascotte T6)', () => {
    const d = buildDeclaredSection();
    expect(d.activeUseCaseCount).toBe(6);
    expect(d.expectedUseCaseCount).toBe(6);
    expect(d.compliant).toBe(true);
    expect(d.useCases).toHaveLength(6);
  });

  it("joint l'état des drapeaux, sans lequel le rapport ne s'interprète pas", () => {
    const d = buildDeclaredSection();
    expect(Object.keys(d.flags)).toHaveLength(6);
    expect(d.flags).toHaveProperty('AI_INTELLIGENT_ASSISTANT');
  });

  it('distingue les opérations déterministes de celles qui appellent un modèle', () => {
    const d = buildDeclaredSection();
    const assistant = d.useCases.find((u) => u.code === 'INTELLIGENT_ASSISTANT')!;
    expect(assistant.operations.some((o) => o.deterministic)).toBe(true);
    expect(assistant.llmOperationCount).toBeGreaterThan(0);
    expect(assistant.llmOperationCount).toBeLessThan(assistant.operationCount);
  });
});

describe('composition du rapport', () => {
  it("sans section observée, annonce la portée réduite plutôt qu'une conformité pleine", async () => {
    // Le piège : un rapport « conforme » qui n'a contrôlé que la déclaration.
    // `scope` est ce qui empêche de le présenter comme une preuve du §12.
    const r = await buildInventoryReport({ observed: false });
    expect(r.observe).toBeNull();
    expect(r.scope).toBe('declare');
    expect(r.compliant).toBe(true);
  });

  it('horodate le rapport', async () => {
    const r = await buildInventoryReport({ observed: false });
    expect(() => new Date(r.generatedAt).toISOString()).not.toThrow();
  });
});
