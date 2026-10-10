/**
 * Lot 34E — ticket « T3 — réconciliation continue des documents non résolus » :
 * Candidate Builder serveur, découverte ≠ décision, empreinte du contexte.
 * Tests unitaires PURS (aucune base) ; la chaîne complète est couverte sur
 * base réelle par `l34e-reconciliation-continue.e2e.ts` (T3D-xx, T3C-xx).
 */
import { describe, expect, it } from 'vitest';
import {
  buildDocumentAssetCandidates, CANDIDATE_SOURCES, isDistinctiveName, isStrongName, type CandidateBuildInput,
} from '../candidate-builder';
import { buildMatchingIndex, indexAsset, type IndexedAsset, type IndexedEntity } from '../matching-index';
import { documentAssetContextFingerprint } from '../context';
import {
  decideContextualDeterministic, decideDeterministic, DOCUMENT_ASSET_PROMPT_MAX_CANDIDATES, hasEvidence, promptCandidates,
  type DocumentAssetCandidate,
} from '../decision';
import { normalizeText } from '../identifiers';
import type { DocumentKnowledgeSources, DocumentSourceFact } from '../document-sources';
import { documentKnowledgeDigest, registerDocumentSourceProvider, documentSourceProviders } from '../document-sources';

const bien = (id: number, name: string, o: Partial<IndexedAsset> = {}): IndexedAsset => ({
  assetId: id, name, normalizedName: normalizeText(name), aliases: [], family: o.family ?? 'IMMOBILIER', category: o.category ?? 'IMMOBILIER',
  subtype: o.subtype ?? null, record: { assetId: id, family: o.family ?? 'IMMOBILIER', values: o.record?.values ?? {} },
  brandModel: o.brandModel ?? null, city: o.city ?? null, postalCode: o.postalCode ?? null, ...o,
});
const doc = (p: { title?: string; body?: string; facts?: Partial<DocumentSourceFact>[]; multiAsset?: boolean }): DocumentKnowledgeSources => {
  const texts = [
    ...(p.title ? [{ origin: 'EXTRACTION', zone: 'TITLE' as const, text: p.title }] : []),
    ...(p.body ? [{ origin: 'TRANSCRIPTION', zone: 'BODY' as const, text: p.body }] : []),
  ];
  const facts = (p.facts ?? []).map((f) => ({
    origin: 'FACTS', canonicalKey: null, label: null, subject: null, value: null, excerpt: null, targetType: null, targetEntityId: null,
    periodStart: null, periodEnd: null, ...f,
  }));
  const extraction = { extractedAt: '2026-10-01T10:00:00.000Z', title: p.title ?? null, description: null, documentType: 'FACTURE', documentDate: '2026-09-01', supplier: null, multiAsset: p.multiAsset ?? false };
  return { accountId: 1, fileId: 10, origins: ['EXTRACTION'], extraction, texts, facts, digest: documentKnowledgeDigest({ extraction, texts, facts }) };
};
const build = (assets: IndexedAsset[], sources: DocumentKnowledgeSources, o: Partial<CandidateBuildInput> & { entities?: IndexedEntity[]; refs?: Map<string, Map<number, Set<number>>> } = {}) =>
  buildDocumentAssetCandidates({
    index: buildMatchingIndex(1, assets, o.entities ?? [], o.refs ?? new Map()),
    sources, state: o.state ?? { secondaryAssetIds: [], mentionedAssetIds: [] }, t1Candidates: o.t1Candidates ?? [], fileId: 10,
  });
/** Candidats prêts pour la décision (comme `computeDocumentAssetContext`). */
const pourDecision = (r: ReturnType<typeof build>, assets: IndexedAsset[]): DocumentAssetCandidate[] => r.candidates.map((b) => {
  const a = assets.find((x) => x.assetId === b.assetId)!;
  return {
    assetId: a.assetId, name: a.name, family: a.family, subtype: a.subtype, identifiers: {}, serverSignals: b.evidenceSignals,
    contextSignals: b.contextSignals, sources: b.sources, distinctiveNameMatch: b.distinctiveNameMatch, t1: null, currentRole: null,
  };
});

describe('noms discriminants ou génériques', () => {
  it('« Maison de Valence », « Polo » désignent un bien ; « Maison », « Maison 1 », « Ma voiture » non', () => {
    for (const n of ['Maison de Valence', 'Polo', 'MacBook Pro', 'Chaudière Viessmann']) expect(isDistinctiveName(normalizeText(n)), n).toBe(true);
    for (const n of ['Maison', 'Maison 1', 'Ma voiture', 'Appartement']) expect(isDistinctiveName(normalizeText(n)), n).toBe(false);
    expect(isStrongName(normalizeText('Maison de Valence'))).toBe(true);
    expect(isStrongName(normalizeText('Polo'))).toBe(false);
  });
});

describe('T3D-01 — T1 sans candidat, nom exact disponible : le Candidate Builder retrouve le bien', () => {
  const assets = [bien(1, 'Maison de Valence', { subtype: 'Maison' }), bien(2, 'Appartement de Lyon', { subtype: 'Appartement' })];
  const r = build(assets, doc({ title: "Contrat d'assurance – Maison de Valence" }), { t1Candidates: [] });

  it('candidat EXACT_NAME tracé (provenance), sans T1', () => {
    expect(r.candidates.map((c) => c.assetId)).toEqual([1]);
    expect(r.candidates[0].sources).toEqual(['EXACT_NAME', 'CATEGORY_SUBTYPE']);
    expect(r.candidates[0].evidenceSignals[0]).toMatch(/nom du bien cité dans le titre/);
    expect(r.testedSources).toEqual(expect.arrayContaining(['STRONG_IDENTIFIER', 'EXACT_NAME', 'ALIAS', 'CATEGORY_SUBTYPE', 'BRAND_MODEL']));
    expect(r.testedSources).not.toContain('T1_CANDIDATE');
  });
  it('nom discriminant unique → résolution DÉTERMINISTE (DISTINCT_NAME), sans IA', () => {
    const c = pourDecision(r, assets);
    expect(decideDeterministic(r.identification, { multiAssetDeclared: false })).toBeNull();
    expect(decideContextualDeterministic(c, r.identification, { multiAssetDeclared: false }))
      .toMatchObject({ kind: 'APPLY', assetId: 1, reason: 'DISTINCT_NAME', method: 'DETERMINISTIC' });
  });
  it('toutes les sources minimales du ticket existent', () => {
    expect(CANDIDATE_SOURCES).toEqual(expect.arrayContaining([
      'STRONG_IDENTIFIER', 'T1_CANDIDATE', 'FACT_TARGET', 'SECONDARY_LINK', 'MENTIONED_ASSET', 'EXACT_NAME', 'ALIAS', 'CATEGORY_SUBTYPE', 'BRAND_MODEL', 'CONTEXTUAL_MATCH',
    ]));
  });
});

describe('T3D-07 — libellé générique « Maison », plusieurs maisons : pas d’auto-rattachement abusif', () => {
  const assets = [bien(1, 'Maison', { subtype: 'Maison' }), bien(2, 'Maison 2', { subtype: 'Maison' }), bien(3, 'Polo', { family: 'VEHICULE', subtype: 'Voiture' })];
  const r = build(assets, doc({ title: 'Facture de travaux maison' }));
  const c = pourDecision(r, assets);
  it('les maisons sont candidates par CATÉGORIE seulement (indice de contexte, jamais une preuve)', () => {
    expect(r.candidates.map((x) => x.assetId)).toEqual([1, 2]);
    for (const x of r.candidates) expect(x.sources).toEqual(['CATEGORY_SUBTYPE']);
    for (const x of c) expect(hasEvidence(x)).toBe(false);
  });
  it('aucune décision déterministe', () => {
    expect(decideDeterministic(r.identification, { multiAssetDeclared: false })).toBeNull();
    expect(decideContextualDeterministic(c, r.identification, { multiAssetDeclared: false })).toBeNull();
  });
});

describe('T3D-08 — plusieurs candidats crédibles : jamais de choix déterministe', () => {
  it('deux biens cités par leur nom → le modèle (ou l’utilisateur) tranche', () => {
    const assets = [bien(1, 'Maison de Valence'), bien(2, 'Maison de Bourg')];
    const r = build(assets, doc({ title: 'Devis toiture Maison de Valence et Maison de Bourg' }));
    expect(r.candidates.map((x) => x.assetId)).toEqual([1, 2]);
    expect(decideContextualDeterministic(pourDecision(r, assets), r.identification, { multiAssetDeclared: false })).toBeNull();
  });
  it('document déclaré multi-biens : jamais de nom distinctif déterministe', () => {
    const assets = [bien(1, 'Maison de Valence')];
    const r = build(assets, doc({ title: 'Maison de Valence', multiAsset: true }));
    expect(decideContextualDeterministic(pourDecision(r, assets), r.identification, { multiAssetDeclared: true })).toBeNull();
  });
});

describe('T3D-04 — identifiant fort : APPLY déterministe si match unique', () => {
  it('immatriculation lue dans un fait → STRONG_IDENTIFIER', () => {
    const assets = [bien(1, 'Polo', { family: 'VEHICULE', record: { assetId: 1, family: 'VEHICULE', values: { registrationNumber: 'AB-123-CD' } } }), bien(2, 'Clio', { family: 'VEHICULE' })];
    const r = build(assets, doc({ title: 'Facture garage', facts: [{ canonicalKey: 'registrationNumber', value: 'AB123CD' }] }));
    expect(r.candidates[0]).toMatchObject({ assetId: 1, sources: ['STRONG_IDENTIFIER'] });
    expect(decideDeterministic(r.identification, { multiAssetDeclared: false })).toMatchObject({ kind: 'APPLY', assetId: 1, method: 'DETERMINISTIC' });
  });
  it('n° de série d’un ÉQUIPEMENT → bien porteur, rapprochement fort', () => {
    const assets = [bien(1, 'Maison A'), bien(2, 'Maison B')];
    const entities: IndexedEntity[] = [{ type: 'EQUIPMENT', id: 7, assetId: 2, name: 'Chaudière', normalizedName: 'chaudiere', serial: 'ABC12345', brandModel: null }];
    const r = build(assets, doc({ title: 'Entretien annuel', body: 'Chaudière n° série ABC12345' }), { entities });
    expect(r.candidates.map((x) => [x.assetId, x.sources])).toEqual([[2, ['STRONG_IDENTIFIER']]]);
    expect(decideDeterministic(r.identification, { multiAssetDeclared: false })).toMatchObject({ kind: 'APPLY', assetId: 2 });
  });
});

describe('T3C-03 — un nouveau document apporte le contexte (référence partagée)', () => {
  it('même n° de contrat qu’un document DÉJÀ rattaché à Polo → candidat SHARED_REFERENCE, résolution déterministe', () => {
    const assets = [bien(1, 'Polo', { family: 'VEHICULE' }), bien(2, 'Cupra', { family: 'VEHICULE' })];
    const refs = new Map([['XYZ778899', new Map([[1, new Set([55])]])]]);
    const r = build(assets, doc({ title: 'Avenant', facts: [{ canonicalKey: 'insuranceContractNumber', value: 'XYZ-778899' }] }), { refs });
    expect(r.candidates[0]).toMatchObject({ assetId: 1, sources: ['SHARED_REFERENCE'] });
    expect(decideContextualDeterministic(pourDecision(r, assets), r.identification, { multiAssetDeclared: false }))
      .toMatchObject({ kind: 'APPLY', assetId: 1, reason: 'SHARED_REFERENCE' });
  });
  it('la référence portée par le SEUL document courant ne compte pas', () => {
    const refs = new Map([['XYZ778899', new Map([[1, new Set([10])]])]]);
    const r = build([bien(1, 'Polo')], doc({ facts: [{ canonicalKey: 'insuranceContractNumber', value: 'XYZ778899' }] }), { refs });
    expect(r.candidates).toEqual([]);
  });
});

describe('autres sources : alias, marque + modèle, liens, faits ciblés, T1', () => {
  it('provenance cumulée et triée', () => {
    const assets = [
      bien(1, 'Voiture de Paul', { family: 'VEHICULE', aliases: ['la petite rouge'], brandModel: 'volkswagen polo' }),
      bien(2, 'Studio', { subtype: 'Appartement' }), bien(3, 'Garage'),
    ];
    const r = build(assets, doc({ title: 'Révision', body: 'Volkswagen Polo — la petite rouge', facts: [{ targetType: 'ASSET', targetEntityId: 3 }] }), {
      state: { secondaryAssetIds: [2], mentionedAssetIds: [] },
      t1Candidates: [{ assetId: 2, confidence: 'probable', score: 0.5, reason: 'r', signals: '' }],
    });
    const par = Object.fromEntries(r.candidates.map((c) => [c.assetId, c.sources]));
    expect(par[1]).toEqual(['ALIAS', 'BRAND_MODEL']);
    expect(par[2]).toEqual(['T1_CANDIDATE', 'SECONDARY_LINK']);
    expect(par[3]).toEqual(['FACT_TARGET']);
  });
  it('NO_CANDIDATE : aucun candidat, sources effectivement testées listées', () => {
    const r = build([bien(1, 'Maison de Valence')], doc({ title: 'Facture fibre' }));
    expect(r.candidates).toEqual([]);
    expect(r.testedSources.length).toBeGreaterThan(5);
  });
});

describe('T3D-11 — bien hors de la limite du contexte IA : retrouvé par le serveur', () => {
  it('la découverte examine TOUS les biens ; seule la liste envoyée au modèle est bornée à 60', () => {
    const assets = Array.from({ length: 150 }, (_, i) => bien(i + 1, `Maison ${i + 1}`, { subtype: 'Maison' }));
    assets.push(bien(151, 'Chalet des Arcs', { subtype: 'Maison' }));
    const r = build(assets, doc({ title: 'Taxe foncière maison — Chalet des Arcs' }));
    expect(r.candidates.length).toBe(151);
    const c = pourDecision(r, assets);
    const envoyes = promptCandidates(c);
    expect(envoyes).toHaveLength(DOCUMENT_ASSET_PROMPT_MAX_CANDIDATES);
    // Le bien nommé, au-delà des 60 premiers identifiants, est en tête de ce qui part au modèle.
    expect(envoyes.map((x) => x.assetId)).toContain(151);
    expect(decideContextualDeterministic(c, r.identification, { multiAssetDeclared: false })).toMatchObject({ kind: 'APPLY', assetId: 151 });
  });
});

describe('T3D-03 / T3D-06 / T3C-04 — empreinte du CONTEXTE pertinent', () => {
  const d = doc({ title: 'Contrat d’assurance – Maison de Valence' });
  const fp = (assets: IndexedAsset[], sources = d) => {
    const r = build(assets, sources);
    const c = pourDecision(r, assets);
    return documentAssetContextFingerprint({
      documentDigest: sources.digest, candidates: c,
      candidateIdentifiers: Object.fromEntries(assets.map((a) => [a.assetId, a.record.values])), matches: r.deterministicMatches,
    });
  };
  const avant = [bien(1, 'Maison 1', { subtype: 'Maison' }), bien(2, 'Appartement de Lyon')];

  it('T3D-06 / T3C-04 — bien SANS rapport ajouté, autre document : même empreinte (aucun appel IA)', () => {
    expect(fp([...avant, bien(3, 'Polo', { family: 'VEHICULE' })])).toBe(fp(avant));
  });
  it('T3D-03 — renommage « Maison 1 » → « Maison de Valence » : empreinte différente (rerun)', () => {
    expect(fp([bien(1, 'Maison de Valence', { subtype: 'Maison' }), avant[1]])).not.toBe(fp(avant));
  });
  it('T3D-05 — nouveau fait (connaissance documentaire) : empreinte différente', () => {
    const d2 = doc({ title: 'Contrat d’assurance – Maison de Valence', facts: [{ canonicalKey: 'registrationNumber', value: 'AB123CD' }] });
    expect(fp(avant, d2)).not.toBe(fp(avant));
  });
  it('sans valeur sensible en clair (adresse hachée)', () => {
    const a = [bien(1, 'Maison de Valence', { record: { assetId: 1, family: 'IMMOBILIER', values: { address1: '12 rue Exemple' } } })];
    expect(fp(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(fp(a)).not.toContain('Exemple');
  });
});

describe('interface de sources documentaires extensible (futures document_source_units)', () => {
  it('un fournisseur SOURCE_UNITS s’enregistre sans refonte ; il entre dans la découverte et l’empreinte', async () => {
    const avant = documentSourceProviders().length;
    registerDocumentSourceProvider({ name: 'SOURCE_UNITS', load: async () => ({ texts: [{ origin: 'SOURCE_UNITS', zone: 'TITLE', text: 'x' }] }) });
    expect(documentSourceProviders().map((p) => p.name)).toContain('SOURCE_UNITS');
    expect(documentSourceProviders().length).toBe(avant + 1);
    const base = doc({ title: 'Facture' });
    expect(documentKnowledgeDigest({ ...base, texts: [...base.texts, { origin: 'SOURCE_UNITS', zone: 'BODY', text: 'Maison de Valence' }] }))
      .not.toBe(base.digest);
  });
});

describe('index de rapprochement', () => {
  it('indexAsset : nom normalisé, alias de la fiche, marque / modèle', () => {
    const a = indexAsset({
      id: 4, name: 'Voiture de Paul', category: 'VEHICULE', subtype: 'Voiture',
      key_characteristics: JSON.stringify({ make: 'Volkswagen', model: 'Polo', aliases: ['La petite rouge'] }),
    } as never);
    expect(a).toMatchObject({ assetId: 4, normalizedName: 'voiture de paul', aliases: ['la petite rouge'], brandModel: 'volkswagen polo' });
  });
});
