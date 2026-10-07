/**
 * Lot 31B — T3 DOCUMENT_ASSET : décisions déterministes avant / après le
 * prompt maître, variables transmises (ticket T3 §4, §5, §7, §13).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideDeterministic, decideFromAiOutput, documentAssetVariables, DOCUMENT_ASSET_AUTO_THRESHOLD,
  type DocumentAssetCandidate,
} from '../decision';
import { resolveAssetByIdentifiers } from '../identifiers';
import { T3LinkAmbiguityOutput } from '../../master/t3-contract';
import { t1CandidatesOf } from '../queue';

const cand = (o: Partial<DocumentAssetCandidate> & { assetId: number }): DocumentAssetCandidate => ({
  name: `Bien ${o.assetId}`, family: 'IMMOBILIER', subtype: null, identifiers: {}, serverSignals: [], t1: null, currentRole: null, ...o,
});
const prouve = (assetId: number) => cand({ assetId, t1: { confidence: 'probable', score: 0.6, reason: 'désignation lue', signals: `Bien ${assetId}` } });
const sortie = (matches: Array<[number, number, 'certain' | 'probable' | 'conflictual']>, documentScope?: 'SINGLE' | 'MULTIPLE') =>
  T3LinkAmbiguityOutput.parse({
    task: 'LINK_AMBIGUITY', ...(documentScope ? { documentScope } : {}),
    matches: matches.map(([candidateId, score, confidence]) => ({ candidateId, score, confidence, reason: 'signal fourni' })),
  });

describe('T3DOC-04 — résolution déterministe AVANT tout appel modèle', () => {
  const maison = { assetId: 42, family: 'IMMOBILIER' as const, values: { address1: '12 rue Exemple', postalCode: '69003' } };
  const polo = { assetId: 50, family: 'VEHICULE' as const, values: { registrationNumber: 'AB-123-CD' } };
  const kangoo = { assetId: 51, family: 'VEHICULE' as const, values: { registrationNumber: 'EF-456-GH' } };
  it('identifiant exact et unique → APPLY sans IA', () => {
    const d = decideDeterministic(resolveAssetByIdentifiers([maison, polo], { facts: [], texts: ['12 rue Exemple 69003 Lyon'] }), { multiAssetDeclared: false });
    expect(d).toMatchObject({ kind: 'APPLY', assetId: 42, method: 'DETERMINISTIC', score: 1 });
  });
  it('T3DOC-08 — A ET B : identifiants exclusifs dans un document déclaré multi-biens → MULTI_ASSET', () => {
    const r = resolveAssetByIdentifiers([polo, kangoo], { facts: [], texts: ['AB-123-CD / EF-456-GH'] });
    expect(decideDeterministic(r, { multiAssetDeclared: true })).toMatchObject({ kind: 'MULTI_ASSET', assetIds: [50, 51] });
    // Non déclaré multi-biens : le modèle tranche (A OU B possible).
    expect(decideDeterministic(r, { multiAssetDeclared: false })).toBeNull();
  });
  it('aucun identifiant : rien de déterministe', () => {
    expect(decideDeterministic(resolveAssetByIdentifiers([polo], { facts: [], texts: ['facture'] }), { multiAssetDeclared: false })).toBeNull();
  });
});

describe('après le modèle — decideFromAiOutput', () => {
  it('T3DOC-05 — vainqueur clair, certain et prouvé → APPLY', () => {
    const d = decideFromAiOutput(sortie([[7, 0.93, 'certain'], [9, 0.3, 'probable']]), [prouve(7), prouve(9)]);
    expect(d).toMatchObject({ kind: 'APPLY', assetId: 7, method: 'AI' });
  });
  it('T3DOC-06 — impossible de départager (marge insuffisante) → ABSTAIN, candidats conservés', () => {
    const d = decideFromAiOutput(sortie([[7, 0.86, 'certain'], [9, 0.82, 'probable']]), [prouve(7), prouve(9)]);
    expect(d).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'AMBIGUOUS' });
    if (d.kind === 'ABSTAIN') expect(d.ranked.map((r) => r.assetId)).toEqual([7, 9]);
  });
  it('probable seulement, ou sous le seuil → ABSTAIN (jamais de rattachement forcé)', () => {
    expect(decideFromAiOutput(sortie([[7, 0.95, 'probable']]), [prouve(7)])).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'INSUFFICIENT_EVIDENCE' });
    expect(decideFromAiOutput(sortie([[7, DOCUMENT_ASSET_AUTO_THRESHOLD - 0.01, 'certain']]), [prouve(7)])).toMatchObject({ kind: 'ABSTAIN' });
    expect(decideFromAiOutput(sortie([]), [prouve(7), prouve(9)])).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'INSUFFICIENT_EVIDENCE' });
  });
  it('« pas uniquement parce qu’il est seul » : un candidat sans aucune preuve fournie n’est jamais retenu', () => {
    expect(decideFromAiOutput(sortie([[5, 0.95, 'certain']]), [cand({ assetId: 5 })])).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'UNSUPPORTED_CHOICE' });
  });
  it('T3DOC-07 / U1 — aucune invention : un identifiant hors candidats rend toute la réponse inexploitable', () => {
    expect(decideFromAiOutput(sortie([[999, 0.99, 'certain']]), [prouve(7)])).toMatchObject({ kind: 'ABSTAIN', reasonCode: 'CLOSED_WORLD_VIOLATION' });
  });
  it('T3DOC-08 — A ET B déclaré par le modèle, chaque bien certain → MULTI_ASSET ; un seul certain → pas de multi', () => {
    expect(decideFromAiOutput(sortie([[7, 0.9, 'certain'], [9, 0.9, 'certain']], 'MULTIPLE'), [prouve(7), prouve(9)]))
      .toMatchObject({ kind: 'MULTI_ASSET', assetIds: [7, 9] });
    // Même sortie sans documentScope : A OU B, égalité → abstention.
    expect(decideFromAiOutput(sortie([[7, 0.9, 'certain'], [9, 0.9, 'certain']]), [prouve(7), prouve(9)]))
      .toMatchObject({ kind: 'ABSTAIN', reasonCode: 'AMBIGUOUS' });
  });
});

describe('variables du master — T3 ne relit pas le fichier, ne reçoit aucune donnée sensible', () => {
  it('candidats fournis par le serveur, triés, identifiants non sensibles et signaux sans valeur', () => {
    const v = documentAssetVariables({
      title: 'Facture', documentType: 'MAINTENANCE_INVOICE', documentDate: '2026-09-01', supplier: 'Garage', description: null,
      multiAssetDeclared: false,
      facts: [
        { canonicalKey: 'address1', label: 'Adresse', value: '12 rue Exemple', excerpt: '12 rue Exemple' },
        { canonicalKey: 'lastRevision', label: null, value: '2026-09-01', excerpt: 'le 01/09/2026' },
      ],
    }, [
      cand({ assetId: 9, identifiers: { city: 'Lyon', address1: 'NE DOIT PAS PARTIR' }, serverSignals: ['adresse du bien identique à celle du document (contrôle serveur exact)'] }),
      prouve(3),
    ]);
    expect(Object.keys(v).sort()).toEqual(['CANDIDATES', 'CURRENT_STATE', 'EVIDENCES', 'FIELD', 'RELATION_TYPE', 'SUBJECT_CONTEXT']);
    expect(String(v.RELATION_TYPE)).toMatch(/^DOCUMENT_ASSET/);
    expect((v.CANDIDATES as Array<{ candidateId: number }>).map((c) => c.candidateId)).toEqual([3, 9]);
    const tout = JSON.stringify(v);
    expect(tout).not.toMatch(/12 rue Exemple|NE DOIT PAS PARTIR/);
    expect(tout).toMatch(/lastRevision/);
    expect(tout).toMatch(/contrôle serveur/);
  });
  it('T3DOC-13 — le master T3 du dépôt décrit DOCUMENT_ASSET (candidats serveur, aucune invention, manuel jamais remplacé, A OU B / A ET B, abstention)', () => {
    const txt = readFileSync(join(process.cwd(), 'src/services/ai/prompts/reconciliation/t3_master_v1.txt'), 'utf8');
    expect(txt).toMatch(/RELATION DOCUMENT_ASSET/);
    expect(txt).toMatch(/Candidats fournis par le serveur uniquement/);
    expect(txt).toMatch(/jamais remplacé/);
    expect(txt).toMatch(/A OU B/);
    expect(txt).toMatch(/A ET B/);
    expect(txt).toMatch(/Abstention obligatoire/);
    expect(txt).toMatch(/documentScope/);
  });
});

describe('candidats T1 conservés pour T3', () => {
  it('identifiants vérifiés seulement, meilleur score, preuves de T1 (signaux)', () => {
    const c = t1CandidatesOf({ assetCandidates: [
      { entityId: 4, confidence: 'probable', score: 0.6, reason: 'nom lu', excerpt: 'Maison', verified: true },
      { entityId: 4, confidence: 'certain', score: 0.9, reason: 'adresse', excerpt: '12 rue', verified: true },
      { entityId: null, rawLabel: 'Inconnu', confidence: 'probable', score: 0.5, reason: '', excerpt: '', verified: false },
      { entityId: 8, confidence: 'certain', score: 0.9, reason: '', excerpt: '', verified: false },
    ] });
    expect(c).toEqual([{ assetId: 4, confidence: 'certain', score: 0.9, reason: 'adresse', signals: '12 rue' }]);
  });
});
