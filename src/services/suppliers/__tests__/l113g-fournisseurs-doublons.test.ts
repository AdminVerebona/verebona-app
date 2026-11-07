/**
 * Lot 113G (ticket #706) — fournisseurs : création automatique, arbitrage des
 * seuls doublons plausibles, affichage discret (unitaires, purs).
 *
 * L113G-U-PAIR         règle de paire commune : identifiant identique = certain, identifiants contradictoires =
 *                      distinct (sauf même raison sociale), nom exact = certain, nom PROCHE = plausible seulement,
 *                      sinon rien ; un nom similaire seul n'est jamais une certitude ;
 * L113G-U-MATCH        `assessMatch` sur les candidats de la règle commune (new / certain / uncertain) ;
 * L113G-U-ELIGIBILITY  paire à arbitrer : décision « distinctes » respectée, réouverture sur preuve objective
 *                      nouvelle seulement (motif), fusion = sans objet ; paire normalisée non ordonnée ;
 * L113G-U-CARD         carte « S’agit-il du même fournisseur ? » : texte du ticket, Oui / Non seulement,
 *                      libellés conservés à la lecture, informations discriminantes présentes seulement ;
 *                      admissibilité (aucune carte formelle) ;
 * L113G-U-DISPLAY      tiroir document : plus de « Rattachement à confirmer », nom discret en minuscules (CSS),
 *                      lien par identifiant ; fiche fournisseur sans faux « à confirmer » ;
 * L113G-U-REGISTRY     COH-SUPPLIER-IDENTITY en fin de registre, après COH-SUPPLIER-COORDINATES, interdits explicites.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessSupplierPair, distinctDecisionReopenReason, nameSimilarity, pairEvidenceFingerprint, pairKey, sirenOf,
  type SupplierIdentityFacts,
} from '../supplier-identity';
import { assessMatch, normalizeName, type Candidate } from '../supplier-service';
import { pairEligibility, reviewCandidateIds } from '../supplier-identity-reviews';
import {
  isSupplierPairContext, SUPPLIER_IDENTITY_QUESTION, supplierPairProposals,
} from '@/services/to-process/supplier-identity-cards';
import { supplierPairAdmissibility } from '@/services/to-process/producers.service';
import { presentCardLabels } from '@/services/to-process/card-labels';
import { supplierPairFacts } from '@/components/to-process/SupplierPairDetails';
import { COHERENCE_REGISTRY } from '@/services/coherence/registry';
import { COVERAGE_INVENTORY } from '@/services/coherence/registry/coverage';

const lire = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');
const fiche = (id: number, name: string, o: Partial<SupplierIdentityFacts> = {}): SupplierIdentityFacts =>
  ({ id, name, normalizedName: normalizeName(name), siren: null, siret: null, vatNumber: null, ...o });

const RAYNARD = fiche(10, 'RAYNARD TRAITEMENT DU BOIS');
const RAYNARD_SIRET = fiche(11, 'Raynard Traitement du Bois', { siret: '83272432200017' });

describe('L113G-U-PAIR — une seule règle de paire', () => {
  it('identifiant identique (SIREN, SIREN d’un SIRET, TVA) = CERTAIN, quel que soit le nom', () => {
    expect(assessSupplierPair(fiche(1, 'ABC'), fiche(2, 'Société XYZ', { siren: '832724322' }))).toMatchObject({ verdict: 'NONE' });
    expect(assessSupplierPair(fiche(1, 'ABC', { siren: '832 724 322' }), fiche(2, 'XYZ', { siret: '83272432200017' })))
      .toEqual({ verdict: 'CERTAIN', basis: 'IDENTIFIER', score: 100 });
    expect(assessSupplierPair(fiche(1, 'ABC', { vatNumber: 'FR58832724322' }), fiche(2, 'XYZ', { vatNumber: 'fr 58832724322' })).basis).toBe('IDENTIFIER');
    expect(sirenOf({ siren: null, siret: '832 724 322 00017' })).toBe('832724322');
    expect(sirenOf({ siren: '12', siret: '123' })).toBeNull();
  });

  it('identifiants contradictoires : distincts — sauf même raison sociale (plausible, l’utilisateur tranche)', () => {
    expect(assessSupplierPair(fiche(1, 'Raynard Bois', { siren: '832724322' }), fiche(2, 'Raynard Bois Traitement', { siren: '111111111' })))
      .toMatchObject({ verdict: 'DISTINCT', basis: 'CONTRADICTORY' });
    expect(assessSupplierPair(fiche(1, 'Raynard Bois', { siren: '832724322' }), fiche(2, 'RAYNARD BOIS', { siren: '111111111' })))
      .toMatchObject({ verdict: 'PLAUSIBLE', basis: 'NAME_ID_CONFLICT' });
  });

  it('même raison sociale normalisée sans contradiction = certain ; nom PROCHE = plausible, jamais certain', () => {
    expect(assessSupplierPair(RAYNARD, RAYNARD_SIRET)).toMatchObject({ verdict: 'CERTAIN', basis: 'EXACT_NAME' });
    for (const [a, b] of [
      ['Raynard', 'Raynard Traitement du Bois'],
      ['Raynard Traitement Bois', 'Raynard Traitement du Bois 38'],
      ['Plomberie Durandd Services', 'Plomberie Durand Services'],
    ]) {
      const r = assessSupplierPair(fiche(1, a), fiche(2, b));
      expect(r, `${a} / ${b}`).toMatchObject({ verdict: 'PLAUSIBLE', basis: 'SIMILAR_NAME' });
    }
  });

  it('aucun signal crédible : rien (mots courts, mot commun seul, noms différents)', () => {
    for (const [a, b] of [['Garage Martin', 'Garage Dupont'], ['EDF', 'GDF'], ['Leroy Merlin', 'Castorama'], ['Menuiserie Bois', 'Charpente Fils']]) {
      expect(nameSimilarity(normalizeName(a), normalizeName(b)), `${a} / ${b}`).toBe('NONE');
      expect(assessSupplierPair(fiche(1, a), fiche(2, b)).verdict).toBe('NONE');
    }
  });

  it('paire normalisée non ordonnée ; empreinte des preuves sans le nom', () => {
    expect(pairKey(9, 3)).toEqual({ low: 3, high: 9, key: '3:9' });
    expect(pairKey(3, 9).key).toBe(pairKey(9, 3).key);
    const a = fiche(3, 'Raynard'); const b = fiche(9, 'Raynard Bois');
    expect(pairEvidenceFingerprint(a, b)).toBe(pairEvidenceFingerprint(b, a));
    expect(pairEvidenceFingerprint(a, b)).toBe(pairEvidenceFingerprint({ ...a, name: 'Autre nom' }, b));
  });
});

describe('L113G-U-MATCH — rapprochement d’un fournisseur lu', () => {
  const cand = (o: Partial<Candidate>): Candidate => ({ id: 1, publicId: 'p1', name: 'X', normalizedName: 'x', siren: null, siret: null, vatNumber: null, score: 0, ...o });
  it('aucun candidat : nouveau ; identifiant ou nom exact : certain ; nom proche : incertain (jamais certain)', () => {
    expect(assessMatch([])).toBe('new');
    expect(assessMatch([cand({ basis: 'IDENTIFIER', score: 100 })])).toBe('certain');
    expect(assessMatch([cand({ basis: 'EXACT_NAME', score: 80 })])).toBe('certain');
    expect(assessMatch([cand({ basis: 'SIMILAR_NAME', score: 50 })])).toBe('uncertain');
    expect(assessMatch([cand({ basis: 'NAME_ID_CONFLICT', score: 45 })])).toBe('uncertain');
  });
});

describe('L113G-U-ELIGIBILITY — décisions de paire respectées', () => {
  const a = fiche(3, 'Raynard'); const b = fiche(9, 'Raynard Traitement du Bois');
  it('paire plausible non tranchée : à arbitrer ; même fiche ou aucun signal : non', () => {
    expect(pairEligibility(a, b, null)).toMatchObject({ eligible: true, reopenReason: null });
    expect(pairEligibility(a, a, null)).toMatchObject({ eligible: false, reason: 'SAME_SUPPLIER' });
    expect(pairEligibility(a, fiche(4, 'Castorama'), null)).toMatchObject({ eligible: false, reason: 'NOT_PLAUSIBLE' });
  });

  it('« Non » (DISTINCT) : jamais reproposée sur un nom, une réanalyse ou un nouveau document ; « Oui » (SAME) : sans objet', () => {
    const d = { decision: 'DISTINCT' as const, basis: 'SIMILAR_NAME', evidenceFingerprint: pairEvidenceFingerprint(a, b) };
    expect(pairEligibility(a, b, d)).toMatchObject({ eligible: false, reason: 'DECIDED_DISTINCT' });
    expect(pairEligibility({ ...a, siren: '832724322' }, b, d)).toMatchObject({ eligible: false, reason: 'DECIDED_DISTINCT' });
    expect(pairEligibility(a, b, { decision: 'SAME', basis: null, evidenceFingerprint: null })).toMatchObject({ eligible: false, reason: 'DECIDED_SAME' });
  });

  it('réouverture seulement si une preuve OBJECTIVE nouvelle rend la paire certaine par identifiant (motif tracé)', () => {
    const d = { decision: 'DISTINCT' as const, basis: 'SIMILAR_NAME', evidenceFingerprint: pairEvidenceFingerprint(a, b) };
    const a2 = { ...a, siren: '832724322' }; const b2 = { ...b, siret: '83272432200017' };
    expect(pairEligibility(a2, b2, d)).toMatchObject({ eligible: true, reopenReason: 'NEW_MATCHING_IDENTIFIER' });
    // Décision déjà prise en connaissance du même identifiant : respectée.
    const dId = { decision: 'DISTINCT' as const, basis: 'IDENTIFIER', evidenceFingerprint: pairEvidenceFingerprint(a2, b2) };
    expect(distinctDecisionReopenReason(dId, assessSupplierPair(a2, b2), pairEvidenceFingerprint(a2, b2))).toBeNull();
  });

  it('candidats d’une revue : entiers positifs, ordre gardé, sans doublon', () => {
    expect(reviewCandidateIds([5, '7', 5, -1, 'x', 0, 7.5])).toEqual([5, 7]);
    expect(reviewCandidateIds(null)).toEqual([]);
  });
});

describe('L113G-U-CARD — « S’agit-il du même fournisseur ? »', () => {
  it('texte du ticket à l’identique ; Oui / Non seulement ; libellés conservés à la lecture', () => {
    expect(SUPPLIER_IDENTITY_QUESTION).toBe('S’agit-il du même fournisseur ?');
    expect(supplierPairProposals().map((p) => [p.value, p.label])).toEqual([['SAME', 'Oui'], ['DISTINCT', 'Non']]);
    const vue = presentCardLabels({
      targetType: 'SUPPLIER', fieldKey: 'identity', relationKey: null, ruleCode: 'SUPPLIER-IDENTITY', question: SUPPLIER_IDENTITY_QUESTION,
      proposals: supplierPairProposals(), target: { label: 'Raynard' },
    }, SUPPLIER_IDENTITY_QUESTION);
    expect(vue.question).toBe(SUPPLIER_IDENTITY_QUESTION);
    expect(vue.proposals.map((p) => p.label)).toEqual(['Oui', 'Non']);
    expect(JSON.stringify(vue)).not.toMatch(/Opération/);
  });

  it('contexte de paire reconnu seulement s’il est complet', () => {
    expect(isSupplierPairContext({ kind: 'supplier_pair', reviewId: 1, detectedSupplierId: 2, knownSupplierId: 3, basis: 'SIMILAR_NAME', fileIds: [] })).toBe(true);
    expect(isSupplierPairContext({ kind: 'supplier_pair', reviewId: 1, detectedSupplierId: 2 })).toBe(false);
    expect(isSupplierPairContext(null)).toBe(false);
  });

  it('informations discriminantes : présentes seulement, jamais inventées', () => {
    expect(supplierPairFacts({ id: 1, name: 'A', siren: '832724322', city: 'Lyon', documents: 3 })).toEqual(['SIREN 832724322', 'Lyon', '3 documents']);
    expect(supplierPairFacts({ id: 1, name: 'A', siren: null, city: null, documents: 1 })).toEqual(['1 document']);
    expect(supplierPairFacts({ id: 1, name: 'A', siren: null, city: null, documents: 0 })).toEqual([]);
  });

  it('admissibilité : carte seulement pour une paire à trancher ; aucune carte formelle', () => {
    expect(supplierPairAdmissibility({ pair: true, decided: false }).outcome).toBe('CREATE_ACTION');
    expect(supplierPairAdmissibility({ pair: false, decided: false }).outcome).not.toBe('CREATE_ACTION');
    expect(supplierPairAdmissibility({ pair: false, decided: true }).outcome).not.toBe('CREATE_ACTION');
  });
});

describe('L113G-U-DISPLAY — affichage discret, plus de faux « à confirmer »', () => {
  it('tiroir document : aucun « Rattachement à confirmer » ni « (à confirmer) » ; nom en minuscules par CSS, petit ; lien par identifiant', () => {
    const f = lire('src/components/assets/DocumentSupplierField.tsx');
    const code = f.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/Rattachement à confirmer|\(à confirmer\)/);
    expect(code).toMatch(/const LINK_CLS = '[^']*\btext-xs\b[^']*\blowercase\b/);
    expect(code).not.toMatch(/toLowerCase\(\)/); // casse d'origine jamais altérée (affichage CSS seulement)
    expect(code).toMatch(/href=\{supplierHref\(linked\[0\]\.id\)\}/);
  });

  it('fiche fournisseur : plus de « Rattachement à confirmer » déduit de is_confirmed', () => {
    const p = lire('src/app/(dashboard)/fournisseurs/[id]/page.tsx').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(p).not.toMatch(/'Rattachement à confirmer'/);
  });

  it('création automatique : fiabilité réelle conservée (jamais is_confirmed=true pour masquer) et base du lien tracée', () => {
    const s = lire('src/services/suppliers/supplier-from-analysis.ts');
    expect(s).toMatch(/isConfirmed: decision === 'certain'/);
    expect(s).toMatch(/matchBasis:/);
    expect(s).not.toMatch(/isConfirmed: true/);
  });
});

describe('L113G-U-REGISTRY — contrôle de cohérence du stock', () => {
  it('COH-SUPPLIER-IDENTITY en fin de registre, après COH-SUPPLIER-COORDINATES ; couvert par « fournisseurs » ; interdits', () => {
    const ids = COHERENCE_REGISTRY.map((c) => c.id);
    // Lot 113W : COH-DOC-BUSINESS-PERIODS ajouté ensuite, en fin de registre.
    const i = ids.indexOf('COH-SUPPLIER-IDENTITY');
    expect(ids.slice(i - 1, i + 1)).toEqual(['COH-SUPPLIER-COORDINATES', 'COH-SUPPLIER-IDENTITY']);
    const c = COHERENCE_REGISTRY[i];
    expect(c).toMatchObject({ status: 'ACTIVE', version: 1, objectType: 'supplier', domain: 'fournisseurs' });
    expect(c.forbiddenRepairs.join(' ')).toMatch(/fusionner/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/décision de l’utilisateur/);
    expect(c.forbiddenRepairs.join(' ')).toMatch(/is_confirmed/);
    expect(COVERAGE_INVENTORY.find((d) => d.domain === 'fournisseurs')!.checks).toContain('COH-SUPPLIER-IDENTITY');
  });

  it('migration 1470 additive et idempotente ; table déclarée à l’export de diagnostic', () => {
    const m = lire('src/db/migrations/1470_l113g_fournisseurs_doublons.sql');
    expect(m).toMatch(/CREATE TABLE IF NOT EXISTS supplier_identity_decisions/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS match_basis/);
    expect(m).toMatch(/ADD COLUMN IF NOT EXISTS merged_into_supplier_id/);
    expect(m.replace(/^--.*$/gm, '')).not.toMatch(/DROP TABLE|DROP COLUMN/); // retour arrière documenté en commentaire seulement
    expect(lire('src/services/admin/diagnostics-export/coverage.ts')).toMatch(/supplier_identity_decisions:/);
    expect(lire('src/services/admin/diagnostics-export/recette-catalog.ts')).toMatch(/supplier_identity_decisions:/);
  });
});
