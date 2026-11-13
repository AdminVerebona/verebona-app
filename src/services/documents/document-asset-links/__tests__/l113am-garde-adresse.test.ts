/**
 * Lot 113AM (Trello #739) — une adresse de correspondance ne rattache jamais
 * un document à la Maison. Règles PURES : garde d'admission partagée, rôle des
 * adresses, preuves T1 / T3 / revue, rattrapage BO (déclaration, rapport).
 * Comportement sur base réelle : `src/test/e2e/scenarios/l113am-rattachement-adresse.e2e.ts`.
 */
import { describe, expect, it } from 'vitest';
import { admitDocumentAssetLink, isUnqualifiedAddress, justificationDigest, type LinkProof } from '../admission';
import {
  adjacentAddressRole, admissibleIdentification, qualifyAddressMatches, qualifiedIdentification,
} from '@/services/ai/reconciliation/document-asset/address-roles';
import { resolveAssetByIdentifiers, type AssetIdentifierRecord } from '@/services/ai/reconciliation/document-asset/identifiers';
import { attachmentReviewLinkJustification, candidateProofs, documentAssetLinkJustification } from '@/services/ai/reconciliation/document-asset/link-justification';
import { addressQualifiedBuild, ADDRESS_NOT_PROPERTY_CONTEXT } from '@/services/ai/reconciliation/document-asset/context';
import { CITY_POSTAL_CONTEXT, type CandidateBuildResult } from '@/services/ai/reconciliation/document-asset/candidate-builder';
import { computeMasterDocumentLinks, justifyMasterDocumentLinks } from '@/services/ai/source-analysis/master/document-links';
import { mergeIdentifierCandidates, withLinkProofs } from '@/services/ai/source-analysis/steps/analyze-document.step';
import type { ProjectedFact } from '@/services/ai/source-analysis/master/t1-contract';
import { backfillDefinition, validateBackfillRequest } from '@/services/admin/ops/backfill/definitions';
import { summarizeBackfill } from '@/services/admin/ops/backfill/report-format';

const MAISON = 14;
const VELO = 18;
const VOITURE = 21;
const records: AssetIdentifierRecord[] = [
  { assetId: MAISON, family: 'IMMOBILIER', values: { address1: '12 rue des Lilas', postalCode: '69003', city: 'Lyon' } },
  { assetId: VELO, family: 'OBJECT', values: {} },
  { assetId: VOITURE, family: 'VEHICULE', values: { registrationNumber: 'AB-123-CD' } },
];
const qualifier = (texts: string[], facts: Parameters<typeof qualifyAddressMatches>[0]['facts'] = []) => {
  const res = resolveAssetByIdentifiers(records, { facts: facts.map((f) => ({ canonicalKey: f.canonicalKey, value: f.value })), texts });
  return { res, q: qualifyAddressMatches({ records, matches: res.matches, facts, texts }) };
};

describe('113AM — garde d’admission partagée (un seul prédicat)', () => {
  it('décision de l’utilisateur : toujours admise, jamais rejugée', () => {
    expect(admitDocumentAssetLink('USER', null)).toMatchObject({ admitted: true, reasonCode: 'USER_DECISION' });
  });
  it('écriture automatique sans justification : refusée (fail-closed)', () => {
    expect(admitDocumentAssetLink('AI', undefined)).toMatchObject({ admitted: false, reasonCode: 'NO_JUSTIFICATION' });
  });
  it('adresse de correspondance seule : refusée ADDRESS_NOT_QUALIFIED ; un bien de même adresse ne suffit jamais', () => {
    for (const role of ['CORRESPONDENCE', 'DELIVERY', 'ISSUER', 'DOCUMENT_PARTY', 'UNQUALIFIED', 'OTHER_ASSET_LOCATION'] as const) {
      const d = admitDocumentAssetLink('AI', { step: 'T1_PROJECTION', rule: 'X', proofs: [{ kind: 'IDENTIFIER', identifierKind: 'ADDRESS', addressRole: role }] });
      expect(d, role).toMatchObject({ admitted: false, reasonCode: 'ADDRESS_NOT_QUALIFIED' });
      expect(d.rejected[0].why).toBe('ADDRESS_NOT_QUALIFIED');
    }
    // Adresse sans rôle renseigné : jamais présumée « lieu du bien ».
    expect(isUnqualifiedAddress({ kind: 'IDENTIFIER', identifierKind: 'ADDRESS' })).toBe(true);
  });
  it('adresse « lieu du bien », fait ciblé, désignation du modèle, identifiant, référence : admis (preuve décisive tracée)', () => {
    const admis = (p: LinkProof) => admitDocumentAssetLink('AI', { step: 'T3_DOCUMENT_ASSET', rule: 'X', proofs: [p] });
    expect(admis({ kind: 'IDENTIFIER', identifierKind: 'ADDRESS', addressRole: 'PROPERTY_LOCATION' })).toMatchObject({ admitted: true, reasonCode: 'PROOF' });
    expect(admis({ kind: 'FACT_TARGET' }).admitted).toBe(true);
    expect(admis({ kind: 'MODEL_DESIGNATION' }).admitted).toBe(true);
    expect(admis({ kind: 'IDENTIFIER', identifierKind: 'REGISTRATION' }).admitted).toBe(true);
    expect(admis({ kind: 'SHARED_REFERENCE' }).admitted).toBe(true);
    expect(admis({ kind: 'CONTEXT', detail: 'CATEGORY_SUBTYPE' })).toMatchObject({ admitted: false, reasonCode: 'NO_ADMISSIBLE_PROOF' });
    const d = admitDocumentAssetLink('AI', { step: 'T1_PROJECTION', rule: 'X', proofs: [{ kind: 'IDENTIFIER', identifierKind: 'ADDRESS', addressRole: 'CORRESPONDENCE' }, { kind: 'FACT_TARGET' }] });
    expect(d).toMatchObject({ admitted: true, decisiveProof: { kind: 'FACT_TARGET' } });
  });
  it('décision IA / revue / identité : admise seulement si elle repose sur autre chose qu’une adresse non qualifiée (ni sa ville / son code postal)', () => {
    const adresse: LinkProof = { kind: 'IDENTIFIER', identifierKind: 'ADDRESS', addressRole: 'CORRESPONDENCE' };
    const villeCp: LinkProof = { kind: 'CONTEXT', identifierKind: 'ADDRESS', detail: 'CONTEXTUAL_MATCH' };
    for (const kind of ['AI_DECISION', 'AI_REVIEW', 'IDENTITY_GROUP'] as const) {
      expect(admitDocumentAssetLink('AI', { step: 'OTHER', rule: 'X', proofs: [{ kind, support: [adresse, villeCp] }] }), kind)
        .toMatchObject({ admitted: false, reasonCode: 'ADDRESS_NOT_QUALIFIED' });
      expect(admitDocumentAssetLink('AI', { step: 'OTHER', rule: 'X', proofs: [{ kind, support: [adresse, { kind: 'CONTEXT', detail: 'EXACT_NAME' }] }] }).admitted, kind).toBe(true);
    }
  });
  it('empreinte de la justification : stable, sans aucune valeur lue', () => {
    const j = { step: 'T1_PROJECTION' as const, rule: 'R', proofs: [{ kind: 'IDENTIFIER' as const, identifierKind: 'ADDRESS', addressRole: 'CORRESPONDENCE' as const }] };
    expect(justificationDigest(j)).toBe(justificationDigest(structuredClone(j)));
    expect(justificationDigest(j)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('113AM — rôle des adresses lu dans les sorties T1 (aucune règle par fournisseur, type ou mot-clé nouveau)', () => {
  it('libellé qui précède immédiatement l’adresse (même ligne, sinon ligne précédente)', () => {
    expect(adjacentAddressRole('Adresse du bien :')).toBe('PROPERTY_LOCATION');
    expect(adjacentAddressRole('Souscripteur :')).toBe('CORRESPONDENCE');
    expect(adjacentAddressRole('Adresse de facturation')).toBe('CORRESPONDENCE');
    expect(adjacentAddressRole('Adresse de livraison :')).toBe('DELIVERY');
    // Un libellé suivi d'autre chose ne qualifie pas l'adresse (le libellé doit la précéder immédiatement).
    expect(adjacentAddressRole('Bien assuré : VELO CARGO')).toBeNull();
    expect(adjacentAddressRole('')).toBeNull();
  });
  it('doc 126 : adresse du souscripteur / destinataire = adresse de la Maison → CORRESPONDENCE ou rôle non établi, jamais « lieu du bien »', () => {
    expect(qualifier(['Souscripteur :\n12 rue des Lilas 69003 Lyon']).q)
      .toEqual([{ assetId: MAISON, role: 'CORRESPONDENCE', source: 'TEXT_LABEL', via: 'text' }]);
    expect(qualifier(['M. Jean Fourche\n12 rue des Lilas 69003 Lyon\nVéhicule assuré : VELO']).q[0].role).toBe('UNQUALIFIED');
    expect(qualifier(['Bien assuré : VELO CARGO\n12 rue des Lilas 69003 Lyon']).q[0].role).toBe('UNQUALIFIED');
  });
  it('libellé de champ « … : » (même ligne ou ligne précédente), mots outils tolérés', () => {
    expect(qualifier(['Adresse du bien loué : 12 rue des Lilas 69003 Lyon']).q[0].role).toBe('PROPERTY_LOCATION');
    expect(qualifier(['Chantier au 12 rue des Lilas 69003 Lyon']).q[0].role).toBe('PROPERTY_LOCATION');
    expect(qualifier(['Lieu d’intervention | 12 rue des Lilas 69003 Lyon']).q[0].role).toBe('PROPERTY_LOCATION');
    expect(qualifier(['Adresse de facturation : 12 rue des Lilas 69003 Lyon', 'Adresse du bien : 4 avenue Foch 69006 Lyon']).q[0].role).toBe('CORRESPONDENCE');
    expect(qualifier(['Souscripteur : M. Jean Fourche\n12 rue des Lilas 69003 Lyon']).q[0].role).toBe('UNQUALIFIED');
    expect(qualifier(['Intervention 12 rue des Lilas 69003 Lyon']).q[0].role).toBe('UNQUALIFIED');
  });
  it('taxe foncière / travaux : « Adresse du bien : 12 rue des Lilas » → PROPERTY_LOCATION', () => {
    expect(qualifier(['Adresse du bien : 12 rue des Lilas 69003 Lyon']).q[0]).toMatchObject({ role: 'PROPERTY_LOCATION', source: 'TEXT_LABEL' });
    expect(qualifier(['Lieu des travaux :\n12 rue des Lilas 69003 Lyon']).q[0].role).toBe('PROPERTY_LOCATION');
  });
  it('sortie structurée T1 prioritaire : fait address1 ciblé sur la Maison / sur un autre bien / sur le fournisseur', () => {
    const fait = (targetType: string, targetEntityId: number | null) => [{ canonicalKey: 'address1', value: '12 rue des Lilas', targetType, targetEntityId }];
    expect(qualifier([], fait('ASSET', MAISON)).q[0]).toMatchObject({ role: 'PROPERTY_LOCATION', source: 'FACT_TARGET' });
    expect(qualifier(['Adresse du bien : 12 rue des Lilas 69003 Lyon'], fait('ASSET', VELO)).q[0]).toMatchObject({ role: 'OTHER_ASSET_LOCATION' });
    expect(qualifier([], fait('SUPPLIER', 3)).q[0].role).toBe('ISSUER');
    expect(qualifier([], fait('DOCUMENT', null)).q[0].role).toBe('DOCUMENT_PARTY');
    expect(qualifier([], [{ canonicalKey: 'address1', value: '12 rue des Lilas', label: 'Adresse du souscripteur', targetType: null, targetEntityId: null }]).q[0].role).toBe('CORRESPONDENCE');
  });
  it('identification admissible : l’adresse non qualifiée est retirée, l’immatriculation reste ; unicité recalculée', () => {
    const texts = ['Adresse de facturation : 12 rue des Lilas 69003 Lyon', 'Véhicule AB-123-CD'];
    const res = resolveAssetByIdentifiers(records, { facts: [], texts });
    expect(res.assetIds).toEqual([MAISON, VOITURE]);
    expect(res.ambiguous).toBe(true);
    const a = admissibleIdentification({ records, resolution: res, facts: [], texts });
    expect(a.resolution).toMatchObject({ assetIds: [VOITURE], uniqueAssetId: VOITURE, ambiguous: false });
    expect(a.excluded).toEqual([expect.objectContaining({ assetId: MAISON, role: 'CORRESPONDENCE' })]);
    expect(qualifiedIdentification(res, [{ assetId: MAISON, role: 'PROPERTY_LOCATION', source: 'TEXT_LABEL', via: 'text' }]).resolution.assetIds).toEqual([MAISON, VOITURE]);
  });
});

describe('113AM — T1 : plus de candidat serveur ni de lien vers la Maison sur une adresse de correspondance', () => {
  const velo = { entityId: VELO, confidence: 'certain' as const, score: 0.97, reason: 'désignation lue', excerpt: 'VELO', verified: true };
  it('scénario doc 126 : avant (identification brute) la Maison devenait candidat vérifié certain → MENTIONED ; après : vélo seul', () => {
    const texts = ['Souscripteur : M. Jean Fourche', '12 rue des Lilas 69003 Lyon', 'Véhicule assuré : VELO'];
    const brute = resolveAssetByIdentifiers(records, { facts: [], texts });
    const avant = mergeIdentifierCandidates([velo], brute);
    expect(computeMasterDocumentLinks({ facts: [], assetCandidates: avant, documentAssetId: VELO, knownAssetId: VELO }).map((l) => [l.assetId, l.role]))
      .toEqual([[VELO, 'PRIMARY'], [MAISON, 'MENTIONED']]); // ← lien #331
    const a = admissibleIdentification({ records, resolution: brute, facts: [], texts });
    const apres = withLinkProofs(mergeIdentifierCandidates([velo], a.resolution), [velo], a.resolution, a.qualifications);
    const entrees = { facts: [] as ProjectedFact[], assetCandidates: apres, documentAssetId: VELO, knownAssetId: VELO };
    const liens = justifyMasterDocumentLinks(computeMasterDocumentLinks(entrees), entrees);
    expect(liens.map((l) => [l.assetId, l.role])).toEqual([[VELO, 'PRIMARY']]);
    expect(liens[0].justification?.proofs.map((p) => p.kind)).toEqual(['KNOWN_TARGET', 'MODEL_DESIGNATION']);
  });
  it('défense en profondeur : un candidat serveur historique sans détail de preuve est refusé par la garde', () => {
    const serveur = { entityId: MAISON, confidence: 'certain' as const, score: 1, reason: 'identifiant canonique exact (contrôle serveur)', excerpt: '', verified: true };
    const entrees = { facts: [] as ProjectedFact[], assetCandidates: [velo, serveur], documentAssetId: VELO, knownAssetId: VELO };
    const maison = justifyMasterDocumentLinks(computeMasterDocumentLinks(entrees), entrees).find((l) => l.assetId === MAISON)!;
    expect(maison.role).toBe('MENTIONED');
    expect(admitDocumentAssetLink('AI', maison.justification)).toMatchObject({ admitted: false, reasonCode: 'ADDRESS_NOT_QUALIFIED' });
  });
  it('taxe foncière : adresse « lieu du bien » → candidat vérifié, bien du document, lien admis', () => {
    const texts = ['Avis de taxe foncière', 'Adresse du bien : 12 rue des Lilas 69003 Lyon'];
    const a = admissibleIdentification({ records, resolution: resolveAssetByIdentifiers(records, { facts: [], texts }), facts: [], texts });
    expect(a.resolution.uniqueAssetId).toBe(MAISON);
    const cands = withLinkProofs(mergeIdentifierCandidates([], a.resolution), [], a.resolution, a.qualifications);
    const entrees = { facts: [] as ProjectedFact[], assetCandidates: cands, documentAssetId: MAISON, knownAssetId: null };
    const [l] = justifyMasterDocumentLinks(computeMasterDocumentLinks(entrees), entrees);
    expect(l).toMatchObject({ assetId: MAISON, role: 'PRIMARY' });
    expect(admitDocumentAssetLink('AI', l.justification)).toMatchObject({ admitted: true, decisiveProof: { kind: 'IDENTIFIER', addressRole: 'PROPERTY_LOCATION' } });
  });
});

describe('113AM — T3 : Candidate Builder, décision, revue #711', () => {
  const build = (texts: string[]): CandidateBuildResult => {
    const identification = resolveAssetByIdentifiers(records, { facts: [], texts });
    return {
      identification, testedSources: [], deterministicMatches: identification.matches.map((m) => `${m.assetId}:${m.kind}`),
      candidates: [{ assetId: MAISON, sources: ['STRONG_IDENTIFIER', 'CONTEXTUAL_MATCH'], evidenceSignals: ['adresse du bien identique à celle du document (contrôle serveur exact)'], contextSignals: [CITY_POSTAL_CONTEXT], distinctiveNameMatch: false }],
    };
  };
  const sources = (texts: string[]) => ({ texts: texts.map((text) => ({ origin: 'TRANSCRIPTION', zone: 'BODY', text })), facts: [] }) as never;
  it('candidat né de la seule adresse de facturation (et de sa ville / son code postal) : retiré, aucun rattachement déterministe', () => {
    const t = ['Adresse de facturation : 12 rue des Lilas 69003 Lyon'];
    const b = addressQualifiedBuild(build(t), sources(t), { records } as never);
    expect(b.identification.assetIds).toEqual([]);
    expect(b.candidates).toEqual([]);
    expect(b.identificationWithIndices?.assetIds).toEqual([MAISON]);
  });
  it('adresse « lieu du bien » : conservée telle quelle', () => {
    const t = ['Adresse du bien : 12 rue des Lilas 69003 Lyon'];
    const b = addressQualifiedBuild(build(t), sources(t), { records } as never);
    expect(b.identification.uniqueAssetId).toBe(MAISON);
    expect(b.candidates[0].sources).toContain('STRONG_IDENTIFIER');
  });
  it('candidat qui garde une autre source : conservé, adresse requalifiée en simple indice', () => {
    const t = ['Facturation : 12 rue des Lilas 69003 Lyon'];
    const base = build(t);
    base.candidates[0].sources.push('FACT_TARGET');
    const b = addressQualifiedBuild(base, sources(t), { records } as never);
    expect(b.candidates[0].sources).toEqual(['FACT_TARGET']);
    expect(b.candidates[0].contextSignals).toContain(ADDRESS_NOT_PROPERTY_CONTEXT);
  });
  it('décision IA dont le candidat ne repose que sur l’adresse : refusée ; avec un fait ciblé : admise', () => {
    const identification = resolveAssetByIdentifiers(records, { facts: [], texts: ['Souscripteur : 12 rue des Lilas 69003 Lyon'] });
    const quals = [{ assetId: MAISON, role: 'CORRESPONDENCE' as const, source: 'TEXT_LABEL' as const, via: 'text' as const }];
    const cand = { assetId: MAISON, name: 'Maison', family: 'IMMOBILIER', subtype: null, identifiers: {}, serverSignals: [], t1: null, currentRole: null,
      sources: ['STRONG_IDENTIFIER', 'CONTEXTUAL_MATCH'] as never, contextSignals: [CITY_POSTAL_CONTEXT] };
    const j = documentAssetLinkJustification({ assetId: MAISON, decision: { kind: 'APPLY', assetId: MAISON, score: 0.9, reason: 'AI', method: 'AI' }, branch: 'STRUCTURED',
      candidates: [cand], identification, qualifications: quals, facts: [], texts: [] });
    expect(admitDocumentAssetLink('AI', j)).toMatchObject({ admitted: false, reasonCode: 'ADDRESS_NOT_QUALIFIED' });
    const j2 = documentAssetLinkJustification({ assetId: MAISON, decision: { kind: 'APPLY', assetId: MAISON, score: 0.9, reason: 'AI', method: 'AI' }, branch: 'STRUCTURED',
      candidates: [{ ...cand, sources: ['STRONG_IDENTIFIER', 'FACT_TARGET'] as never }], identification, qualifications: quals, facts: [], texts: [] });
    expect(admitDocumentAssetLink('AI', j2).admitted).toBe(true);
    expect(candidateProofs({ assetId: MAISON, candidate: cand, identification, qualifications: quals }).map((p) => p.kind)).toEqual(['IDENTIFIER', 'CONTEXT']);
  });
  it('recherche sémantique (aucun candidat structuré) : la décision IA s’appuie sur les biens PRÉSENTÉS par le serveur → admise', () => {
    // Régression trouvée par L57B-T3 (TC02, TC15, TC16) : sans les candidats présentés, la décision n'avait aucun appui.
    const decision = { kind: 'APPLY' as const, assetId: VOITURE, score: 0.85, reason: 'historique fournisseur fourni par le serveur', method: 'AI' as const };
    const presente = { assetId: VOITURE, name: 'Voiture', family: 'VEHICULE', subtype: null, identifiers: [], serverSignals: ['historique fournisseur : 2 document(s)'],
      contextSignals: ['vocabulaire commun avec le document : forfait'], t1: null, currentRole: null, sources: ['CONTEXTUAL_MATCH'] } as never;
    const sans = documentAssetLinkJustification({ assetId: VOITURE, decision, branch: 'SEMANTIC', candidates: [], identification: { matches: [] }, qualifications: [], facts: [], texts: [] });
    expect(admitDocumentAssetLink('AI', sans).admitted).toBe(false);
    const avec = documentAssetLinkJustification({ assetId: VOITURE, decision, branch: 'SEMANTIC', candidates: [presente], identification: { matches: [] }, qualifications: [], facts: [], texts: [] });
    expect(admitDocumentAssetLink('AI', avec).admitted).toBe(true);
  });
  it('revue #711 multi-biens : bien désigné par la seule adresse de correspondance → lien SECONDARY refusé', () => {
    const indices = [{ assetId: MAISON, kind: 'ADDRESS' }];
    expect(admitDocumentAssetLink('AI', attachmentReviewLinkJustification({ assetId: MAISON, indices, facts: [], modelCandidate: false, addressRole: 'CORRESPONDENCE', reviewKey: 'k' })).admitted).toBe(false);
    expect(admitDocumentAssetLink('AI', attachmentReviewLinkJustification({ assetId: MAISON, indices, facts: [{ targetType: 'ASSET', targetEntityId: MAISON }], modelCandidate: false, addressRole: 'CORRESPONDENCE', reviewKey: 'k' })).admitted).toBe(true);
    expect(admitDocumentAssetLink('AI', attachmentReviewLinkJustification({ assetId: VOITURE, indices: [{ assetId: VOITURE, kind: 'REGISTRATION' }], facts: [], modelCandidate: false, addressRole: 'UNQUALIFIED', reviewKey: 'k' })).admitted).toBe(true);
  });
});

describe('113AM — rattrapage BO « liens automatiques fondés sur une adresse de correspondance »', () => {
  it('déclaré en fin de catalogue (n° 22), simuler / appliquer / restaurer, motif obligatoire pour écrire, filtre compte', () => {
    expect(backfillDefinition('document-address-links')).toMatchObject({ order: 22, actions: ['simulate', 'apply', 'restore'], accountFilter: true });
    expect(validateBackfillRequest({ script: 'document-address-links', action: 'apply' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' });
    expect(validateBackfillRequest({ script: 'document-address-links', action: 'simulate' })).toMatchObject({ ok: true });
  });
  it('rapport : compteurs, échantillons sans adresse, restauration', () => {
    const rapport = {
      mode: 'simulate', runId: null, disabled: null, accounts: 1, examined: 3, kept: { proven: 2, noAddressMatch: 0, noKnowledge: 0 }, erroneous: 1, repaired: 0,
      derived: { reconciled: 0, resolutionRequested: 0, failed: 0 }, more: false,
      samples: [{ accountId: 13, fileId: 126, assetId: 14, linkId: 331, origin: 'AI', role: 'MENTIONED', addressRole: 'CORRESPONDENCE', repaired: false }],
    };
    const s = summarizeBackfill('document-address-links', 'simulate', null, { result: rapport });
    expect(s.headline).toMatch(/1 lien\(s\) automatique\(s\) fondé\(s\) sur une adresse/);
    expect(s.conflicts.samples[0]).toBe('compte 13 · document 126 · bien 14 · lien 331 (AI, MENTIONED) — adresse : destinataire / souscripteur / facturation');
    expect(s.restorable).toBe(false);
    const r = summarizeBackfill('document-address-links', 'restore', null, { result: { runId: 'x', restored: 1, skipped: 0 } });
    expect(r.headline).toMatch(/1 lien\(s\) remis/);
  });
});
