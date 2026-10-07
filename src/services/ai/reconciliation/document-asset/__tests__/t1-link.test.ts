/**
 * Lot 31B — ticket T1 (identifiants canoniques, mono-bien) et articulation
 * avec « À traiter » (ticket T3 §9). Tests sans base.
 */
import { describe, expect, it, vi } from 'vitest';

// Le pipeline n'est importé que pour `computeFinalState` : aucun accès S3.
vi.mock('@/services/ai/source-analysis/adapters', () => ({ getSourceAdapter: () => null }));
import { describeEntities } from '@/services/ai/source-analysis/master/prompt-context';
import { mergeIdentifierCandidates } from '@/services/ai/source-analysis/steps/analyze-document.step';
import { computeMasterDocumentLinks } from '@/services/ai/source-analysis/master/document-links';
import { computeFinalState } from '@/services/ai/source-analysis/pipeline';
import { planDocumentRule } from '@/services/to-process/document-rule-bridge';
import { getRule } from '@/services/to-process/rules-catalog';
import { resolveAssetByIdentifiers, type AssetIdentifierRecord } from '../identifiers';
import type { AnalysisContext, SourceAnalysisResult } from '@/services/ai/source-analysis/types';

const caps = { rooms: true, equipments: true } as never;

describe('ENTITY_CONTEXT — identifiants canoniques discriminants par famille (ticket T1, cause 1)', () => {
  const ctx = {
    accountId: 1, userId: 1, linkedAssetId: null, rooms: [], equipments: [], existingTitles: [],
    assets: [
      { id: 42, name: 'Maison', category: 'IMMOBILIER', subtype: 'maison' },
      { id: 50, name: 'Polo', category: 'VEHICULE', subtype: null },
      { id: 60, name: 'TV', category: 'OBJECT', subtype: null },
      { id: 70, name: 'Sans fiche', category: 'IMMOBILIER', subtype: null },
    ],
    assetIdentifiers: [
      { assetId: 42, family: 'IMMOBILIER', values: { address1: '12 rue Exemple', postalCode: '69003', city: 'Lyon' } },
      { assetId: 50, family: 'VEHICULE', values: { registrationNumber: 'AB-123-CD', vin: 'WVWZZZ6RZEY123456', make: 'VW', model: 'Polo' } },
      { assetId: 60, family: 'OBJECT', values: { serialNumber: 'SN-1', brand: 'Sony', modelName: 'Bravia' } },
    ],
  } as unknown as AnalysisContext;

  it('immobilier : code postal + ville ; véhicule : immatriculation, VIN, marque, modèle ; objet : n° de série, marque, modèle', () => {
    const { assets } = JSON.parse(describeEntities(ctx, caps)) as { assets: Array<Record<string, unknown>> };
    expect(assets[0]).toEqual({ id: 42, name: 'Maison', family: 'IMMOBILIER', subtype: 'maison', postalCode: '69003', city: 'Lyon' });
    expect(assets[1]).toEqual({ id: 50, name: 'Polo', family: 'VEHICULE', subtype: null, registrationNumber: 'AB-123-CD', vin: 'WVWZZZ6RZEY123456', make: 'VW', model: 'Polo' });
    expect(assets[2]).toEqual({ id: 60, name: 'TV', family: 'OBJECT', subtype: null, serialNumber: 'SN-1', brand: 'Sony', modelName: 'Bravia' });
    // Bien sans identifiant : aucune clé vide émise, jamais la fiche entière.
    expect(assets[3]).toEqual({ id: 70, name: 'Sans fiche', family: 'IMMOBILIER', subtype: null });
  });
  it('règle du lot 29 : l’adresse (champ sensible) n’est JAMAIS transmise au modèle', () => {
    expect(describeEntities(ctx, caps)).not.toMatch(/Exemple|address1/);
  });
});

describe('résolution déterministe dans T1 — priorité aux identifiants exacts (ticket T1 §4, §8)', () => {
  const recs: AssetIdentifierRecord[] = [
    { assetId: 42, family: 'IMMOBILIER' as const, values: { address1: '12 rue Exemple', postalCode: '69003' } },
    { assetId: 43, family: 'IMMOBILIER' as const, values: { address1: '8 avenue Foch' } },
  ];
  it('T1-LINK-01 — correspondance unique : candidat vérifié certain ajouté (le modèle n’avait rien trouvé)', () => {
    const r = resolveAssetByIdentifiers(recs, { facts: [], texts: ['12 rue Exemple, 69003 Lyon'] });
    expect(mergeIdentifierCandidates([], r)).toEqual([
      expect.objectContaining({ entityId: 42, confidence: 'certain', score: 1, verified: true }),
    ]);
  });
  it('un identifiant exact prime sur une interprétation contradictoire du modèle', () => {
    const r = resolveAssetByIdentifiers(recs, { facts: [], texts: ['12 rue Exemple'] });
    const fusion = mergeIdentifierCandidates([
      { entityId: 43, confidence: 'certain', score: 0.9, reason: 'nom', excerpt: '', verified: true },
      { entityId: 42, confidence: 'probable', score: 0.5, reason: 'ville', excerpt: 'Lyon', verified: true },
    ], r);
    expect(fusion.find((c) => c.entityId === 42)).toMatchObject({ confidence: 'certain', score: 1 });
    expect(fusion.find((c) => c.entityId === 43)).toMatchObject({ confidence: 'certain', score: 0.9 });
  });
});

describe('liens N-N : la cardinalité ne conditionne plus le lien (ticket T1, cause 2)', () => {
  const fait = (id: number) => ({ target: { targetType: 'ASSET', targetEntityId: id, targetEntityLabel: null, targetConfidence: 'certain' } }) as never;
  it('T1-LINK-04 — candidat unique certain : PRIMARY, confiance 1, même sans autre bien', () => {
    expect(computeMasterDocumentLinks({
      facts: [], assetCandidates: [{ entityId: 42, confidence: 'certain', score: 0.97, reason: '', excerpt: '', verified: true }],
      documentAssetId: 42, knownAssetId: null,
    })).toEqual([{ assetId: 42, role: 'PRIMARY', confidence: 1 }]);
  });
  it('1, 2 ou N biens : même moteur', () => {
    const n = computeMasterDocumentLinks({ facts: [fait(42), fait(43), fait(44)], assetCandidates: [], documentAssetId: 42, knownAssetId: null });
    expect(n.map((l) => [l.assetId, l.role])).toEqual([[42, 'PRIMARY'], [43, 'SECONDARY'], [44, 'SECONDARY']]);
  });
  it('T1-LINK-05 — sans bien certain : aucun PRIMARY inventé', () => {
    const l = computeMasterDocumentLinks({
      facts: [], documentAssetId: null, knownAssetId: null,
      assetCandidates: [42, 43].map((entityId) => ({ entityId, confidence: 'probable' as const, score: 0.6, reason: '', excerpt: '', verified: true })),
    });
    expect(l.map((x) => x.role)).toEqual(['MENTIONED', 'MENTIONED']);
  });
});

describe('VALIDATION_REQUIRED seulement après l’échec de T3 (ticket T3 §9)', () => {
  const ambigu = { warnings: [{ code: 'AMBIGUOUS_ASSET', message: '' }] } as unknown as SourceAnalysisResult;
  it('T3DOC-14 — T1 ambigu, aucun bien certain : ANALYZED (T3 reprend), même avec des propositions', () => {
    expect(computeFinalState(ambigu, 3, null)).toBe('ANALYZED');
  });
  it('bien principal certain + multi-biens avec propositions : comportement historique conservé', () => {
    const multi = { warnings: [{ code: 'MULTI_ASSET_DOCUMENT', message: '' }] } as unknown as SourceAnalysisResult;
    expect(computeFinalState(multi, 2, 42)).toBe('VALIDATION_REQUIRED');
    expect(computeFinalState(multi, 0, 42)).toBe('ANALYZED');
  });
});

describe('« À traiter » LINK-ASSET : aucune question avant T3 (ticket T3 §9)', () => {
  const rule = getRule('LINK-ASSET')!;
  const vide = { value: null, values: [], userValidated: false };
  it('analyse sans bien certain, confiée à T3 : ni écriture ni question', () => {
    const plan = planDocumentRule({
      rule, state: vide, mode: 'analysis', relevant: true, mayCreate: true, deferredToT3: true,
      proposals: [{ value: 42, label: 'Maison', confidence: 0.6 }, { value: 43, label: 'Studio', confidence: 0.6 }],
    });
    expect(plan).toEqual({ kind: 'NONE', reason: 'DEFERRED_TO_T3' });
  });
  it('un bien déjà rattaché clôt toujours la question', () => {
    expect(planDocumentRule({ rule, state: { value: 42, values: [42], userValidated: false }, mode: 'analysis', relevant: true, proposals: [], deferredToT3: true }))
      .toEqual({ kind: 'RESOLVE', reason: 'ALREADY_SATISFIED' });
  });
  it('libellé de la question : « À quel bien rattacher ce document ? »', () => {
    expect(rule.question).toBe('À quel bien rattacher ce document ?');
  });
});
