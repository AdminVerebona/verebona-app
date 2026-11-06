/**
 * Lot 113L — ticket #711 : revue IA du rattachement (parties pures, sans base).
 * Corpus d'évaluation du circuit code : faux positifs (adresse de destinataire,
 * de livraison, identifiant secondaire), vrais conflits, multi-biens,
 * ambiguïté, réponses invalides — décisions lues dans la sortie du MODÈLE,
 * jamais une règle sémantique du code.
 */
import { describe, expect, it } from 'vitest';
import {
  attachmentOriginOf, attachmentReviewKey, attachmentReviewVariables, buildAttachmentIndices, decideAttachmentReview, maskIdentifierValues,
  reusableDecision, reviewContextSufficient, reviewNeeded, reviewUnitContexts, unitMatchesOf, type ReviewSourceUnit,
} from '../model';
import { promptCarriesAttachmentReview, T3_ATTACHMENT_REVIEW_CONTRACT } from '../contract';
import { T3LinkAmbiguityOutput } from '../../../master/t3-contract';
import type { AssetIdentifierRecord } from '../../identifiers';

const MAISON = 14;
const VELO = 18;
const records: AssetIdentifierRecord[] = [
  { assetId: MAISON, family: 'IMMOBILIER', values: { address1: '12 rue des Lilas', postalCode: '69003', city: 'Lyon' } },
  { assetId: VELO, family: 'VEHICULE', values: {} },
];
const unit = (unitId: string, ordinal: number, text: string, kind = 'TEXT_BLOCK'): ReviewSourceUnit => ({ unitId, kind, page: 1, ordinal, parentUnitId: null, text, label: null, value: null });
const UNITES = [
  unit('page:1:block:1', 1, 'Assureur Démo'),
  unit('page:1:block:2', 2, 'M. Jean Fourche\n12 r. des Lilas 69003 Lyon'),
  unit('page:1:field:1', 3, 'Assurance : VELO', 'LABEL_VALUE'),
  unit('page:1:block:3', 4, 'Votre attestation d’assurance pour votre VELO CARGO'),
  unit('page:2:block:1', 5, 'Conditions générales'),
];
const sortie = (o: Record<string, unknown>) => T3LinkAmbiguityOutput.parse({ task: 'LINK_AMBIGUITY', matches: [], ...o });

describe('L113L — indices et contexte', () => {
  it('L113L-U-01 — une adresse d’un autre bien est un INDICE (jamais une conclusion), avec ses unités sources', () => {
    const um = unitMatchesOf(UNITES, records);
    const indices = buildAttachmentIndices({
      currentAssetIds: [VELO], identification: { matches: [{ assetId: MAISON, kind: 'ADDRESS', key: 'address1', via: 'text', normalized: 'x', exclusive: true }] },
      t1Designations: [{ assetId: VELO, confidence: 'certain' }], unitMatches: um,
    });
    expect(indices).toEqual([{ indexId: 1, assetId: MAISON, kind: 'ADDRESS', via: 'text', exclusive: true, currentAsset: false, unitIds: ['page:1:block:2'] }]);
    expect(reviewNeeded(indices)).toBe(true);
    const ctx = reviewUnitContexts(UNITES, indices, records);
    // Le bloc de l'indice ET ses voisines (destinataire, objet assuré) — jamais une page entière.
    expect(ctx.map((u) => u.unitId)).toEqual(['page:1:block:1', 'page:1:block:2', 'page:1:field:1']);
    const bloc = ctx.find((u) => u.unitId === 'page:1:block:2')!;
    expect(bloc.context).toContain('M. Jean Fourche');
    expect(bloc.context).toContain(`[adresse identique à celle du bien candidat ${MAISON}]`);
    expect(bloc.context).not.toMatch(/Lilas/);
    expect(reviewContextSufficient(indices, ctx)).toBe(true);
  });

  it('L113L-U-02 — masquage vérifié : valeur non localisable → texte NON transmis ; aucun indice → texte inchangé', () => {
    expect(maskIdentifierValues('Facture n° 12', records)).toEqual({ text: 'Facture n° 12', masked: 0 });
    const m = maskIdentifierValues('Livraison : 12, Rue des Lilas — 69003 Lyon', records);
    expect(m.text).not.toMatch(/Lilas/);
    expect(m.masked).toBe(1);
    const plaque: AssetIdentifierRecord[] = [{ assetId: 3, family: 'VEHICULE', values: { registrationNumber: 'AB-123-CD' } }];
    expect(maskIdentifierValues('Véhicule prêté AB 123 CD', plaque).text).toBe('Véhicule prêté [immatriculation identique à celle du bien candidat 3]');
  });

  it('L113L-U-03 — indices du bien actuel conservés (le modèle les pèse), désignation T1 d’un autre bien = indice ; revue inutile sans autre bien', () => {
    const i = buildAttachmentIndices({
      currentAssetIds: [VELO], identification: { matches: [{ assetId: VELO, kind: 'SERIAL', key: 'serialNumber', via: 'fact', normalized: 'x', exclusive: true }] },
      t1Designations: [{ assetId: MAISON, confidence: 'certain' }, { assetId: 99, confidence: 'probable' }], unitMatches: new Map(),
    });
    expect(i.map((x) => [x.assetId, x.kind, x.currentAsset])).toEqual([[MAISON, 'T1_DESIGNATION', false], [VELO, 'SERIAL', true]]);
    expect(reviewContextSufficient(i, [])).toBe(true);
    expect(reviewNeeded(buildAttachmentIndices({ currentAssetIds: [VELO], identification: { matches: [] }, t1Designations: [], unitMatches: new Map() }))).toBe(false);
  });

  it('L113L-U-04 — contexte insuffisant (indice sans texte lisible) : pas d’appel', () => {
    const i = buildAttachmentIndices({
      currentAssetIds: [VELO], identification: { matches: [{ assetId: MAISON, kind: 'ADDRESS', key: 'address1', via: 'fact', normalized: 'x', exclusive: true }] },
      t1Designations: [], unitMatches: new Map(),
    });
    expect(reviewContextSufficient(i, [])).toBe(false);
  });

  it('L113L-U-05 — variables : contrat, rattachement actuel, indices et unités ; faits sensibles exclus ; aucune valeur d’adresse', () => {
    const indices = buildAttachmentIndices({
      currentAssetIds: [VELO], identification: { matches: [{ assetId: MAISON, kind: 'ADDRESS', key: 'address1', via: 'text', normalized: 'x', exclusive: true }] },
      t1Designations: [], unitMatches: unitMatchesOf(UNITES, records),
    });
    const v = attachmentReviewVariables({
      subject: {
        fileId: 120, title: 'Attestation d’assurance', documentType: 'INSURANCE_CERTIFICATE', documentDate: '2026-01-15', supplier: 'Assureur Démo',
        description: null, multiAssetDeclared: false,
        facts: [
          { canonicalKey: 'address1', label: 'Adresse', value: '12 rue des Lilas', excerpt: '12 rue des Lilas', targetAssetId: null },
          { canonicalKey: null, label: 'Objet assuré', value: 'VELO CARGO', excerpt: 'Marque du véhicule : VELO CARGO', targetAssetId: VELO },
        ],
      },
      candidates: [
        { assetId: MAISON, name: 'Maison', family: 'IMMOBILIER', subtype: null, identifiers: {}, t1: null, current: false, factCount: 0 },
        { assetId: VELO, name: 'Vélo Jean Fourche', family: 'VEHICULE', subtype: null, identifiers: {}, t1: { confidence: 'certain', score: 0.97, reason: 'VELO CARGO' }, current: true, factCount: 1 },
      ],
      indices, units: reviewUnitContexts(UNITES, indices, records), currentAssetIds: [VELO], origin: 'HISTORICAL', records,
    });
    const tout = JSON.stringify(v);
    expect(tout).not.toMatch(/Lilas/);
    expect(tout).not.toContain('contrôle serveur');
    const ctx = JSON.parse(v.SUBJECT_CONTEXT as string);
    expect(ctx.attachmentReview).toMatchObject({ contract: T3_ATTACHMENT_REVIEW_CONTRACT, currentAssetIds: [VELO], currentAttachment: 'HISTORICAL' });
    expect(ctx.facts.map((f: { key: string }) => f.key)).toEqual(['Objet assuré']);
    expect(String(v.RELATION_TYPE).startsWith('DOCUMENT_ASSET')).toBe(true);
    expect((v.CANDIDATES as Array<{ description: string }>)[1].description).toContain('RATTACHEMENT ACTUEL');
  });
});

describe('L113L — décision du modèle (contrat t3-document-attachment-review-v1)', () => {
  const base = { currentAssetIds: [VELO], candidateIds: [MAISON, VELO], indexIds: [1], unitIds: ['page:1:block:2'], contract: true };

  it('L113L-U-10 — faux positif (adresse de destinataire / livraison) : KEEP_CURRENT → confirmé, aucune carte', () => {
    expect(decideAttachmentReview(sortie({ attachmentReview: { decision: 'KEEP_CURRENT', concernedAssetIds: [VELO], citedIndexIds: [1], reason: 'Adresse du destinataire.' } }), base))
      .toEqual({ kind: 'CONFIRMED', reason: 'Adresse du destinataire.', source: 'AI' });
  });

  it('L113L-U-11 — vrai conflit : ARBITRATE fondé sur une preuve citée ; sans preuve citée → arbitrage non justifié', () => {
    const ok = decideAttachmentReview(sortie({
      matches: [{ candidateId: MAISON, score: 0.9, confidence: 'certain', reason: 'bien assuré' }],
      attachmentReview: { decision: 'ARBITRATE', concernedAssetIds: [MAISON], citedUnitIds: ['page:1:block:2'], reason: 'Le bien assuré est la maison.' },
    }), base);
    expect(ok).toMatchObject({ kind: 'ARBITRATE', suggestedAssetId: MAISON, ambiguous: false, citedUnitIds: ['page:1:block:2'] });
    expect(decideAttachmentReview(sortie({ attachmentReview: { decision: 'ARBITRATE', concernedAssetIds: [MAISON], reason: 'Intuition.' } }), base))
      .toMatchObject({ kind: 'NO_DECISION', reasonCode: 'UNSUPPORTED_ARBITRATION' });
  });

  it('L113L-U-12 — ambiguïté réelle : les deux biens concernés → arbitrage ambigu (une seule carte, choix neutres)', () => {
    expect(decideAttachmentReview(sortie({ attachmentReview: { decision: 'ARBITRATE', concernedAssetIds: [VELO, MAISON], citedIndexIds: [1], reason: 'Lieu non établi.' } }), base))
      .toMatchObject({ kind: 'ARBITRATE', suggestedAssetId: MAISON, ambiguous: true });
  });

  it('L113L-U-13 — multi-biens : MULTIPLE exige le bien actuel et un autre bien certain dans matches', () => {
    const m = sortie({
      documentScope: 'MULTIPLE', matches: [{ candidateId: MAISON, score: 0.9, confidence: 'certain', reason: 'habitation' }, { candidateId: VELO, score: 0.9, confidence: 'certain', reason: 'vélo' }],
      attachmentReview: { decision: 'MULTIPLE', concernedAssetIds: [VELO, MAISON], citedIndexIds: [1], reason: 'Contrat des deux biens.' },
    });
    expect(decideAttachmentReview(m, base)).toEqual({ kind: 'MULTI_ASSET', assetIds: [MAISON], reason: 'Contrat des deux biens.' });
    expect(decideAttachmentReview(sortie({ attachmentReview: { decision: 'MULTIPLE', concernedAssetIds: [VELO, MAISON], reason: 'x' } }), base))
      .toMatchObject({ kind: 'NO_DECISION', reasonCode: 'INCONSISTENT_OUTPUT' });
  });

  it('L113L-U-14 — réponse invalide : section absente, monde fermé violé, incohérence → aucune décision (jamais un conflit)', () => {
    expect(decideAttachmentReview(sortie({}), base)).toEqual({ kind: 'NO_DECISION', reasonCode: 'REVIEW_OUTPUT_MISSING' });
    expect(decideAttachmentReview(sortie({ attachmentReview: { decision: 'KEEP_CURRENT', concernedAssetIds: [77], reason: 'x' } }), base))
      .toMatchObject({ reasonCode: 'CLOSED_WORLD_VIOLATION' });
    expect(decideAttachmentReview(sortie({ attachmentReview: { decision: 'KEEP_CURRENT', citedUnitIds: ['page:9:block:9'], reason: 'x' } }), base))
      .toMatchObject({ reasonCode: 'CLOSED_WORLD_VIOLATION' });
    expect(decideAttachmentReview(sortie({ attachmentReview: { decision: 'KEEP_CURRENT', concernedAssetIds: [MAISON], reason: 'x' } }), base))
      .toMatchObject({ reasonCode: 'INCONSISTENT_OUTPUT' });
    expect(decideAttachmentReview(sortie({ matches: [{ candidateId: 77, score: 1, confidence: 'certain', reason: 'x' }], attachmentReview: { decision: 'KEEP_CURRENT', reason: 'x' } }), base))
      .toMatchObject({ reasonCode: 'CLOSED_WORLD_VIOLATION' });
  });
});

describe('L113L — sans le bloc 22 (lecture de matches)', () => {
  const base = { currentAssetIds: [VELO], candidateIds: [MAISON, VELO], indexIds: [1], unitIds: [], contract: false };
  const m = (id: number, score: number, confidence: 'certain' | 'probable' = 'certain') => ({ candidateId: id, score, confidence, reason: `r${id}` });
  it('L113L-U-20 — identifiant secondaire : bien actuel en tête → confirmé, aucune priorité à la correspondance brute', () => {
    expect(decideAttachmentReview(sortie({ matches: [m(VELO, 0.95), m(MAISON, 0.4)] }), base)).toMatchObject({ kind: 'CONFIRMED' });
  });
  it('L113L-U-21 — autre bien certain seul au-dessus du seuil → arbitrage ; égalité réelle → arbitrage ambigu ; rien de certain → aucune décision', () => {
    expect(decideAttachmentReview(sortie({ matches: [m(MAISON, 0.92)] }), base)).toMatchObject({ kind: 'ARBITRATE', suggestedAssetId: MAISON, ambiguous: false });
    expect(decideAttachmentReview(sortie({ matches: [m(MAISON, 0.88), m(VELO, 0.85)] }), base)).toMatchObject({ kind: 'ARBITRATE', ambiguous: true });
    expect(decideAttachmentReview(sortie({ matches: [m(MAISON, 0.92, 'probable')] }), base)).toMatchObject({ kind: 'NO_DECISION', reasonCode: 'INSUFFICIENT_EVIDENCE' });
    expect(decideAttachmentReview(sortie({ matches: [] }), base)).toMatchObject({ kind: 'NO_DECISION', reasonCode: 'INSUFFICIENT_EVIDENCE' });
  });
  it('L113L-U-22 — multi-biens déclaré, actuel et autre certains → multi-biens', () => {
    expect(decideAttachmentReview(sortie({ documentScope: 'MULTIPLE', matches: [m(VELO, 0.9), m(MAISON, 0.9)] }), base)).toMatchObject({ kind: 'MULTI_ASSET', assetIds: [MAISON] });
  });
});

describe('L113L — mémoire, contrat, origine', () => {
  const k = (over: Partial<Parameters<typeof attachmentReviewKey>[0]> = {}) => attachmentReviewKey({
    currentAssetIds: [VELO], origin: 'HISTORICAL', indices: [{ indexId: 1, assetId: MAISON, kind: 'ADDRESS', via: 'text', exclusive: true, currentAsset: false, unitIds: ['u'] }],
    units: [{ unitId: 'u', page: 1, kind: 'TEXT_BLOCK', label: null, context: 'M. Jean Fourche [adresse]', indexIds: [1] }],
    candidates: [{ assetId: MAISON, name: 'Maison' }, { assetId: VELO, name: 'Vélo' }], contract: true, aiConfigSignature: 'sig', ...over,
  });
  it('L113L-U-30 — clé stable sans élément nouveau (réanalyse TCO, ordinaire) ; nouvelle preuve, autre rattachement, autre prompt → clé différente', () => {
    expect(k()).toBe(k());
    expect(k({ units: [{ unitId: 'u2', page: 1, kind: 'TEXT_BLOCK', label: null, context: 'M.  JEAN Fourche [adresse]', indexIds: [1] }] })).toBe(k());
    expect(k({ units: [{ unitId: 'u', page: 1, kind: 'TEXT_BLOCK', label: null, context: 'Bien assuré : [adresse]', indexIds: [1] }] })).not.toBe(k());
    expect(k({ currentAssetIds: [MAISON] })).not.toBe(k());
    expect(k({ aiConfigSignature: 'autre' })).not.toBe(k());
    expect(k({ contract: false })).not.toBe(k());
  });
  it('L113L-U-31 — décisions réutilisables : jamais une panne ni une réponse invalide', () => {
    expect(reusableDecision({ kind: 'CONFIRMED', reason: 'x', source: 'AI' })).toBe(true);
    expect(reusableDecision({ kind: 'NO_DECISION', reasonCode: 'INSUFFICIENT_EVIDENCE' })).toBe(true);
    expect(reusableDecision({ kind: 'NO_DECISION', reasonCode: 'TECHNICAL_FAILURE' })).toBe(false);
    expect(reusableDecision({ kind: 'NO_DECISION', reasonCode: 'REVIEW_OUTPUT_MISSING' })).toBe(false);
  });
  it('L113L-U-32 — marqueur du contrat ; origine du rattachement', () => {
    expect(promptCarriesAttachmentReview(`… ${T3_ATTACHMENT_REVIEW_CONTRACT} …`)).toBe(true);
    expect(promptCarriesAttachmentReview('BRANCHE TASK = LINK_AMBIGUITY')).toBe(false);
    expect(attachmentOriginOf({ userEdited: true, userLinkAssetIds: [], columnIsAutomatic: false, columnAssetId: 1 })).toBe('USER');
    expect(attachmentOriginOf({ userEdited: false, userLinkAssetIds: [], columnIsAutomatic: false, columnAssetId: 1 })).toBe('HISTORICAL');
    expect(attachmentOriginOf({ userEdited: false, userLinkAssetIds: [], columnIsAutomatic: true, columnAssetId: 1 })).toBe('AUTOMATIC');
  });
  it('L113L-U-33 — contrat de sortie : section attachmentReview acceptée et conservée par le schéma (jamais retirée en silence)', () => {
    const o = sortie({ attachmentReview: { decision: 'KEEP_CURRENT', concernedAssetIds: [VELO], indexRoles: [{ indexId: 1, role: 'adresse du destinataire' }], reason: 'x' } });
    expect(o.attachmentReview?.decision).toBe('KEEP_CURRENT');
    expect(() => T3LinkAmbiguityOutput.parse({ task: 'LINK_AMBIGUITY', matches: [], attachmentReview: { decision: 'MOVE', reason: 'x' } })).toThrow();
  });
});
