/**
 * Lot 32C — PO 8 / PO 10 : incohérence de rattachement Document → Bien,
 * action « À traiter » LINK-ASSET-CONFLICT (sans base ; chaîne complète :
 * `l32c-rattrapage-rattachement.e2e.ts`).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));
const { PROCESSING_RULES, RULE_PRODUCERS, checkRulesCatalog, documentBridgeRules, getRule } = await import('../rules-catalog');
const {
  ASSET_CONFLICT_RULE, assetConflictProposals, assetConflictQuestion, parseAssetConflictChoice,
} = await import('../document-asset-conflict');
const { selectDisplayedProposals } = await import('../action-model');
const { attachmentIndicesOf, detectAssetContradiction } = await import('@/services/ai/source-analysis/steps/analyze-document.step');

const ident = (o: Partial<{ uniqueAssetId: number | null; assetIds: number[]; matches: Array<{ assetId: number; kind: string }> }>) => ({
  uniqueAssetId: null, assetIds: [], matches: [], ...o,
}) as never;
const cand = (entityId: number, confidence: 'certain' | 'probable' = 'certain') => ({
  entityId, confidence, score: 0.95, reason: 'lu', excerpt: '', verified: true,
});

describe('PO8 — règle déclarée au catalogue « À traiter »', () => {
  it('LINK-ASSET-CONFLICT : DOCUMENT, relation dédiée, producteur réel, « Ignorer » autorisé, jamais de complétion', () => {
    const r = getRule(ASSET_CONFLICT_RULE)!;
    expect(r).toMatchObject({
      targetType: 'DOCUMENT', relationKey: 'assetConflict', completePriority: null, allowNotApplicable: true, producer: 'T3_ASSET_CONFLICT',
    });
    expect(RULE_PRODUCERS.T3_ASSET_CONFLICT.module).toBe('src/services/to-process/document-asset-conflict.ts');
    expect(checkRulesCatalog()).toEqual([]);
    // Distincte de LINK-ASSET (rattachement manquant) : une carte chacune, jamais confondues.
    expect(PROCESSING_RULES.filter((x) => x.relationKey === 'assetConflict')).toHaveLength(1);
    expect(documentBridgeRules().map((x) => x.code)).not.toContain(ASSET_CONFLICT_RULE);
  });
});

describe('PO8 / PO10 — détection : le choix utilisateur prévaut, l’incohérence est remontée', () => {
  // Lot 113L (ticket #711, décision PO) : aligné — l'adresse exacte d'un autre bien n'est PLUS une
  // incohérence en soi (base IDENTIFIER supprimée) ; c'est un INDICE soumis à la revue IA du rattachement
  // (`attachmentIndicesOf`, `attachment-review`), qui décide si un arbitrage est nécessaire.
  it('PO8 (lot 113L) : document rattaché à A contenant l’adresse exacte de B → indice transmis, jamais une incohérence automatique', () => {
    const c = detectAssetContradiction({
      knownAssetId: 1, identification: ident({ uniqueAssetId: 2, assetIds: [2], matches: [{ assetId: 2, kind: 'ADDRESS' }] }),
      modelAssets: [], multiAssetDeclared: false,
    });
    expect(c).toBeNull();
    expect(attachmentIndicesOf({ knownAssetId: 1, identification: ident({ matches: [{ assetId: 2, kind: 'ADDRESS' }] }) }))
      .toEqual({ assetIds: [2], kinds: ['ADDRESS'] });
    expect(attachmentIndicesOf({ knownAssetId: 1, identification: ident({ matches: [{ assetId: 1, kind: 'ADDRESS' }] }) })).toBeNull();
  });

  it('adresse de A elle-même, ou identifiants de plusieurs biens : aucune incohérence certaine', () => {
    expect(detectAssetContradiction({ knownAssetId: 1, identification: ident({ uniqueAssetId: 1, assetIds: [1] }), modelAssets: [], multiAssetDeclared: false })).toBeNull();
    expect(detectAssetContradiction({ knownAssetId: 1, identification: ident({ assetIds: [1, 2] }), modelAssets: [cand(2)], multiAssetDeclared: false })).toBeNull();
    expect(detectAssetContradiction({ knownAssetId: 1, identification: ident({ assetIds: [2, 3] }), modelAssets: [], multiAssetDeclared: false })).toBeNull();
  });

  it('PO10 : (ré)analyse certaine désignant un AUTRE bien (candidat unique certain) → incohérence (base ANALYSIS)', () => {
    expect(detectAssetContradiction({ knownAssetId: 1, identification: ident({}), modelAssets: [cand(2)], multiAssetDeclared: false }))
      .toEqual({ assetId: 2, basis: 'ANALYSIS', kinds: [] });
  });

  it('PO10 : rien si l’analyse n’est pas certaine, cite aussi A, hésite entre plusieurs biens, ou déclare un document multi-biens', () => {
    const k = { knownAssetId: 1, identification: ident({}) };
    expect(detectAssetContradiction({ ...k, modelAssets: [cand(2, 'probable')], multiAssetDeclared: false })).toBeNull();
    expect(detectAssetContradiction({ ...k, modelAssets: [cand(1), cand(2)], multiAssetDeclared: false })).toBeNull();
    expect(detectAssetContradiction({ ...k, modelAssets: [cand(2), cand(3)], multiAssetDeclared: false })).toBeNull();
    expect(detectAssetContradiction({ ...k, modelAssets: [cand(2)], multiAssetDeclared: true })).toBeNull();
    expect(detectAssetContradiction({ ...k, modelAssets: [{ ...cand(2), verified: false }], multiAssetDeclared: false })).toBeNull();
  });
});

describe('PO8 — carte : libellé clair, trois choix, aucune valeur sensible', () => {
  // Lot 113L (ticket #711) : aligné — plus aucune formulation qui fait d'une mention une preuve
  // (« contient l'adresse de … ») : la carte dit ce que l'analyse conclut, ou l'ambiguïté réelle.
  it('question explicite (jamais « contient l’adresse de … », jamais la valeur) ', () => {
    for (const basis of ['AI_REVIEW', 'IDENTIFIER', 'ANALYSIS'] as const) {
      expect(assetConflictQuestion({ basis, kinds: ['ADDRESS'], currentName: 'Maison A', suggestedName: 'Maison B' }))
        .toBe('Ce document est rattaché à « Maison A » mais l’analyse indique qu’il concerne « Maison B ». Quel bien garder ?');
    }
    expect(assetConflictQuestion({ basis: 'AI_REVIEW', currentName: 'Vélo', suggestedName: 'Maison', ambiguous: true }))
      .toBe('Ce document est rattaché à « Vélo », mais son contenu pourrait aussi concerner « Maison ». Quel bien garder ?');
  });

  it('lot 113L : raison de l’arbitrage sur la proposition de déplacement ; « Ignorer » et un déplacement ambigu jamais mis en avant', () => {
    const p = assetConflictProposals({ currentAssetId: 1, suggestedAssetId: 2, currentName: 'A', suggestedName: 'B', basis: 'AI_REVIEW', reason: 'Le bien assuré est B.' });
    expect(p[0]).toMatchObject({ value: 'MOVE:2', sourceContext: { label: 'Le bien assuré est B.' } });
    expect(p[0]).not.toHaveProperty('emphasis');
    expect(p[1]).toMatchObject({ value: 'IGNORE', emphasis: 'neutral' });
    expect(assetConflictProposals({ currentAssetId: 1, suggestedAssetId: 2, currentName: 'A', suggestedName: 'B', basis: 'AI_REVIEW', ambiguous: true })[0])
      .toMatchObject({ emphasis: 'neutral', sourceContext: { label: 'Analyse du document' } });
  });

  it('les trois choix sont AFFICHÉS : rattacher à B, ignorer, garder A (valeur actuelle)', () => {
    const shown = selectDisplayedProposals(assetConflictProposals({ currentAssetId: 1, suggestedAssetId: 2, currentName: 'Maison A', suggestedName: 'Maison B', basis: 'IDENTIFIER' }));
    expect(shown.map((p) => [p.value, p.label, p.isCurrentValue ?? false])).toEqual([
      ['MOVE:2', 'Rattacher à « Maison B »', false],
      ['IGNORE', 'Ignorer', false],
      ['KEEP', 'Garder « Maison A »', true],
    ]);
  });

  it('choix reçus : seul le bien de la carte est accepté pour un déplacement (requête forgée refusée)', () => {
    const ctx = { suggestedAssetId: 2 };
    expect(parseAssetConflictChoice('KEEP', ctx)).toEqual({ kind: 'KEEP' });
    expect(parseAssetConflictChoice('IGNORE', ctx)).toEqual({ kind: 'IGNORE' });
    expect(parseAssetConflictChoice('MOVE:2', ctx)).toEqual({ kind: 'MOVE', assetId: 2 });
    expect(parseAssetConflictChoice('MOVE:3', ctx)).toBeNull();
    expect(parseAssetConflictChoice(2, ctx)).toBeNull();
    expect(parseAssetConflictChoice('MOVE:2;DROP', ctx)).toBeNull();
  });
});
