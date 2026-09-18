/**
 * CDC BO IA VER-010 à VER-013 — contenu du package de mise en production.
 *
 * Ce qu'un package transporte décide de ce qui arrive en production. Le VER-011
 * en exclut secrets, credentials, états opérationnels, file, exécutions et
 * Emergency Stop — une exclusion qu'aucun filtre ne garantit dans la durée :
 * il suffirait qu'une colonne runtime soit ajoutée à la table de configuration
 * et recopiée machinalement.
 *
 * Ce test fige donc la liste des clés transportées. Son échec n'est pas une
 * gêne : c'est le signal qu'un champ nouveau doit être examiné avant de voyager.
 */
import { describe, it, expect } from 'vitest';
import { buildPayload } from '../config-package.service';
import { emptyTreatmentConfig } from '../config-types';
import { TREATMENTS } from '../treatments';

const entries = () => TREATMENTS.map((t) => ({
  ...emptyTreatmentConfig(t),
  prompt: `prompt ${t}`,
  primaryModel: 'gemini-3.1-flash-lite',
  reasoningPrimary: 'standard' as const,
  maxOutputTokens: 800,
}));

describe('contenu transporté', () => {
  it('porte les cinq traitements', () => {
    const p = buildPayload('preprod', 4, 'lot agenda', entries());
    expect(p.entries.map((e) => e.treatment)).toEqual([...TREATMENTS]);
  });

  it('ne transporte que des champs de configuration (VER-011)', () => {
    const p = buildPayload('preprod', 4, null, entries());
    // Liste mise à jour le 18/09/2026 avec `cascade`, après vérification qu'il
    // s'agit bien de configuration et non d'un état runtime. C'est le seul
    // motif légitime de modifier cette assertion.
    expect(Object.keys(p.entries[0]).sort()).toEqual([
      'cascade', 'fallback1', 'fallback2', 'guardrails', 'maxOutputTokens',
      'primaryModel', 'prompt', 'reasoningFallback1', 'reasoningFallback2',
      'reasoningPrimary', 'treatment', 'triggers',
    ]);
  });

  it('écarte tout champ étranger ajouté à la ligne source', () => {
    // Extraire champ par champ, plutôt que recopier la ligne : une colonne
    // ajoutée demain n'entre pas dans le package sans décision.
    const pollue = entries().map((e) => ({ ...e, apiKey: 'secret', queueState: 'running' }));
    const p = buildPayload('preprod', 1, null, pollue as never);
    expect(JSON.stringify(p)).not.toContain('secret');
    expect(JSON.stringify(p)).not.toContain('queueState');
  });

  it('porte sa provenance et son numéro', () => {
    // Sans eux, impossible de détecter une collision ni de savoir d'où vient
    // ce qu'on s'apprête à activer en production.
    const p = buildPayload('preprod', 12, 'refonte T2', entries());
    expect(p.sourceEnvironment).toBe('preprod');
    expect(p.visibleNumber).toBe(12);
    expect(p.label).toBe('refonte T2');
    expect(p.schemaVersion).toBe('ai-config-package-v1');
  });

  it('est une copie, indépendante de la source', () => {
    // VER-010 : le package reste valable même si l'Active préproduction évolue.
    const source = entries();
    const p = buildPayload('preprod', 1, null, source);
    source[0].prompt = 'modifié après coup';
    expect(p.entries[0].prompt).toBe('prompt T1');
  });
});
