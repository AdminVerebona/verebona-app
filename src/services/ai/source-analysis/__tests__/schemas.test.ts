/**
 * Tests des schémas de sortie — CDC §5.3.
 *
 * « Absence de persistance d'une sortie brute invalide. » Ces tests vérifient
 * que le contrôle bloque précisément les sorties qui ont causé les défauts
 * constatés à l'audit : dates non normalisées, valeurs sans preuve.
 */
import { describe, it, expect } from 'vitest';
import { ExtractSourceOutput, IdentifyEntitiesOutput, GroupSourcesOutput } from '../schemas';

describe('ExtractSourceOutput', () => {
  it('exige un extrait justificatif non vide pour chaque champ', () => {
    const bad = ExtractSourceOutput.safeParse({
      fields: [{ fieldKey: 'mileage', value: 120_000, confidence: 'certain', excerpt: '' }],
    });
    expect(bad.success).toBe(false);
  });

  it('refuse une date non normalisée', () => {
    const bad = ExtractSourceOutput.safeParse({
      documentDate: { value: '14/03/2026', confidence: 'certain', excerpt: 'le 14/03/2026' },
      fields: [],
    });
    expect(bad.success).toBe(false);
  });

  it('refuse un SIRET mal formé', () => {
    const bad = ExtractSourceOutput.safeParse({
      supplier: { name: 'EDF', siret: '123', confidence: 'certain', excerpt: 'EDF' },
      fields: [],
    });
    expect(bad.success).toBe(false);
  });

  it('refuse un niveau de confiance hors domaine', () => {
    const bad = ExtractSourceOutput.safeParse({
      fields: [{ fieldKey: 'x', value: 1, confidence: 'high', excerpt: 'e' }],
    });
    expect(bad.success).toBe(false);
  });

  it('accepte une source sans contenu exploitable', () => {
    const ok = ExtractSourceOutput.safeParse({ hasExploitableContent: false, fields: [] });
    expect(ok.success).toBe(true);
  });
});

describe('IdentifyEntitiesOutput', () => {
  it('accepte un identifiant nul accompagné d\'un libellé brut', () => {
    const ok = IdentifyEntitiesOutput.safeParse({
      equipments: [{
        entityId: null, rawLabel: 'Chaudière', score: 0.6,
        confidence: 'probable', reason: 'absente du compte', excerpt: 'Chaudière Viessmann',
      }],
    });
    expect(ok.success).toBe(true);
  });

  it('refuse un identifiant négatif ou nul', () => {
    const bad = IdentifyEntitiesOutput.safeParse({
      assets: [{ entityId: 0, score: 1, confidence: 'certain', reason: 'r', excerpt: 'e' }],
    });
    expect(bad.success).toBe(false);
  });

  it('refuse un score hors intervalle', () => {
    const bad = IdentifyEntitiesOutput.safeParse({
      assets: [{ entityId: 3, score: 1.4, confidence: 'certain', reason: 'r', excerpt: 'e' }],
    });
    expect(bad.success).toBe(false);
  });
});

describe('GroupSourcesOutput', () => {
  it('refuse un groupe vide', () => {
    expect(GroupSourcesOutput.safeParse({ groups: [[]] }).success).toBe(false);
  });

  it('refuse un indice négatif', () => {
    expect(GroupSourcesOutput.safeParse({ groups: [[-1]] }).success).toBe(false);
  });
});
