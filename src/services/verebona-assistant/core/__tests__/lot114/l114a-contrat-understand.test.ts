/**
 * Lot 114A (Trello #753, CDC T2 §12.1, M09) — CONTRAT UNDERSTAND : EXTENSIONS
 * FACULTATIVES.
 *
 *   U01  une sortie SANS les nouveaux champs (prompt antérieur) reste valide ;
 *   U02  une sortie AVEC cardinalité / besoins / dimensions est acceptée et relayée ;
 *   U03  valeurs hors catalogue fermé : sortie refusée (jamais interprétée) ;
 *   U04  aucun champ existant n'a été retiré.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { T2UnderstandOutput } = await import('@/services/ai/assistant/master/t2-contract');
const { toT2Understanding } = await import('@/services/ai/assistant/master/t2-understand');

const base = { mode: 'UNDERSTAND', intent: 'ACCOUNT_SEARCH_ASSET', confidence: 'exact' };

describe('L114A-U — contrat UNDERSTAND', () => {
  it('U01 — sortie d’un prompt antérieur : valide, aucun indice inventé', () => {
    const out = T2UnderstandOutput.parse(base);
    expect(out.scopeCardinality).toBeUndefined();
    const u = toT2Understanding(out);
    expect(u).not.toHaveProperty('scopeCardinality');
    expect(u).not.toHaveProperty('informationNeeds');
    expect(u.interaction.mode).toBe('QUERY');
  });

  it('U02 — indices fournis : acceptés et relayés', () => {
    const out = T2UnderstandOutput.parse({
      ...base, scopeCardinality: 'COLLECTION',
      informationNeeds: [{ code: 'PURCHASE_PRICE', role: 'explicit' }, { code: 'OWNERSHIP_COST', role: 'useful_complement' }],
      unresolvedDimensions: ['target', 'target', 'period'],
    });
    const u = toT2Understanding(out);
    expect(u.scopeCardinality).toBe('COLLECTION');
    expect(u.informationNeeds).toEqual([{ code: 'PURCHASE_PRICE', role: 'explicit' }, { code: 'OWNERSHIP_COST', role: 'useful_complement' }]);
    expect(u.unresolvedDimensions).toEqual(['target', 'period']);
  });

  it('U03 — valeur hors catalogue : refus', () => {
    expect(T2UnderstandOutput.safeParse({ ...base, scopeCardinality: 'PLUSIEURS' }).success).toBe(false);
    expect(T2UnderstandOutput.safeParse({ ...base, unresolvedDimensions: ['prix'] }).success).toBe(false);
  });

  it('U04 — champs historiques conservés', () => {
    const cles = Object.keys(T2UnderstandOutput.shape);
    for (const k of ['mode', 'intent', 'confidence', 'entityHints', 'requestedFacts', 'requestedTopics', 'filters', 'interactionMode', 'suppliedFacts', 'semanticDecision']) {
      expect(cles).toContain(k);
    }
  });
});
