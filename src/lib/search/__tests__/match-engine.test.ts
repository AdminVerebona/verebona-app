/**
 * Lot 33 — moteur de correspondance T2 (ticket « T2 Recherche : empêcher
 * les faux positifs »). Cas A à G du ticket (SRCH-A…G) sur plusieurs
 * familles (biens, documents, échéances, équipements), types de match et
 * raisons de rejet.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateCandidate, parseSearchQuery, queryFromTerms, rankEligible, runSearchPipeline, SEARCH_FIELDS,
  type SearchCandidate, type SearchPolicy,
} from '../match-engine';
import { tokenizeQuery } from '@/services/verebona-assistant/core/query-terms';

const BARRE: SearchPolicy = { requireAllTokens: true };
const ASSISTANT: SearchPolicy = { requireAllTokens: false };

const bien = (id: number, name: string, over: Partial<SearchCandidate['fields']> = {}, tax: SearchCandidate['assetTaxonomy'] = { family: 'VEHICULE', subtype: 'Voiture' }): SearchCandidate => ({
  entityType: 'asset', entityId: id, displayName: name, fields: { name, ...over }, assetTaxonomy: tax, retrievalStrategy: 'test',
});
const doc = (id: number, title: string, over: Partial<SearchCandidate['fields']> = {}): SearchCandidate => ({
  entityType: 'document', entityId: id, displayName: title, fields: { title, ...over }, retrievalStrategy: 'test',
});
const echeance = (id: number, title: string, over: Partial<SearchCandidate['fields']> = {}): SearchCandidate => ({
  entityType: 'agenda_item', entityId: id, displayName: title, fields: { title, ...over }, retrievalStrategy: 'test',
});
const noms = (q: string, cands: SearchCandidate[], policy = BARRE) => runSearchPipeline(parseSearchQuery(q), cands, policy).results.map((r) => r.candidate.displayName);

describe('SRCH — cas du ticket', () => {
  it('SRCH-A — correspondance exacte : « Polo » ✅, « Cupra » ❌ (même catégorie, « polo » dans une trace de provenance et des notes)', () => {
    const polo = bien(1, 'Polo');
    const cupra = bien(2, 'Cupra', {
      address: '8 impasse de l’Écluse, 69300 Caluire', city: 'Caluire',
      // Champs NON déclarés (trace de la fiche canonique, notes, équipements) : jamais matchés.
      mileage__source: 'Facture entretien VW Polo', notes: 'remplace la Polo', equipmentList: 'housse Polo',
    } as never);
    const r = runSearchPipeline(parseSearchQuery('polo'), [cupra, polo], BARRE);
    expect(r.results.map((x) => x.candidate.displayName)).toEqual(['Polo']);
    expect(r.results[0]).toMatchObject({ matchedField: 'name', matchedValue: 'Polo', matchType: 'EXACT', rank: 1 });
    const rejet = r.rejected.find((x) => x.candidate.entityId === 2)!;
    expect(rejet.rejectionReason).toBe('NO_MATCHING_FIELD');
    expect(rejet.matchedField).toBeNull();
    // Même verdict côté assistant (politique « un mot suffit »).
    expect(noms('polo', [cupra, polo], ASSISTANT)).toEqual(['Polo']);
  });

  it('SRCH-B — même catégorie (biens immobiliers) : « Annecy » → Maison Annecy ✅, Maison Lyon ❌', () => {
    const tax = { family: 'IMMOBILIER', subtype: 'Maison' };
    expect(noms('Annecy', [bien(1, 'Maison Lyon', { city: 'Lyon' }, tax), bien(2, 'Maison Annecy', { city: 'Annecy' }, tax)])).toEqual(['Maison Annecy']);
    // Plusieurs mots : « maison annecy » ne fait pas remonter Maison Lyon (mot manquant).
    const r = runSearchPipeline(parseSearchQuery('maison annecy'), [bien(1, 'Maison Lyon', {}, tax), bien(2, 'Maison Annecy', {}, tax)], BARRE);
    expect(r.results.map((x) => x.candidate.displayName)).toEqual(['Maison Annecy']);
    expect(r.rejected[0].rejectionReason).toBe('PARTIAL_MATCH');
  });

  it('SRCH-C — documents du même bien : « toiture » → Facture toiture ✅, Contrat assurance ❌', () => {
    const r = runSearchPipeline(parseSearchQuery('toiture'), [
      doc(1, 'Facture toiture', { documentType: 'FACTURE', assetName: 'Maison Lyon' }),
      doc(2, 'Contrat assurance', { documentType: 'CONTRAT', assetName: 'Maison Lyon' }),
    ], BARRE);
    expect(r.results.map((x) => x.candidate.displayName)).toEqual(['Facture toiture']);
    expect(r.results[0]).toMatchObject({ matchedField: 'title', matchType: 'EXACT_TOKEN' });
  });

  it('SRCH-D — relation indirecte : seul le document qui contient X ; le bien lié ne propage rien', () => {
    const q = parseSearchQuery('Toyota');
    const r = runSearchPipeline(q, [
      doc(1, 'Scan 0001', { content: 'carnet d’entretien toyota yaris 2019' , assetName: 'Garage' }),
      doc(2, 'Facture plomberie', { assetName: 'Garage' }),
      // Document d'un bien qui porte le mot : relation seule.
      doc(3, 'Attestation', { assetName: 'Toyota Yaris' }),
      // Voisin produit par propagation (même bien que le doc 1).
      { ...doc(4, 'Relevé'), propagatedFrom: { entityType: 'document', entityId: 1 } },
    ], BARRE);
    expect(r.results.map((x) => x.candidate.entityId)).toEqual([1]);
    expect(r.results[0]).toMatchObject({ matchedField: 'content', matchType: 'EXACT_TOKEN' });
    const raisons = Object.fromEntries(r.rejected.map((x) => [x.candidate.entityId, x.rejectionReason]));
    expect(raisons).toEqual({ 2: 'NO_MATCHING_FIELD', 3: 'RELATION_ONLY', 4: 'CROSS_ENTITY_PROPAGATION' });
    // La relation COMPLÈTE une correspondance directe (« facture garage »).
    const f = runSearchPipeline(parseSearchQuery('facture garage'), [doc(2, 'Facture plomberie', { assetName: 'Garage' })], BARRE);
    expect(f.results[0]).toMatchObject({ matchedField: 'title', eligibilityReason: 'DIRECT_MATCH_WITH_QUALIFIER' });
  });

  it('SRCH-E — faute légère : « poloo » → Polo ✅ (FUZZY), sans proximité textuelle réelle ❌', () => {
    const r = runSearchPipeline(parseSearchQuery('poloo'), [bien(1, 'Polo'), bien(2, 'Golf'), bien(3, 'Cupra'), bien(4, 'Pole position')], BARRE);
    expect(r.results.map((x) => x.candidate.displayName)).toEqual(['Polo']);
    expect(r.results[0].matchType).toBe('FUZZY');
    // 4 lettres : aucune faute tolérée (« polo » ≠ « golf », « pole »).
    const p = runSearchPipeline(parseSearchQuery('polo'), [bien(2, 'Golf'), bien(4, 'Pole')], BARRE);
    expect(p.results).toEqual([]);
    expect(p.rejected.find((x) => x.candidate.entityId === 4)!.rejectionReason).toBe('FUZZY_SCORE_TOO_LOW');
    // Échéances : « controle technqiue » (inversion) retrouve « Contrôle technique ».
    expect(noms('controle technqiue', [echeance(1, 'Contrôle technique Polo'), echeance(2, 'Vidange')])).toEqual(['Contrôle technique Polo']);
  });

  it('SRCH-F — catégorie explicite : « voitures » → biens de catégorie Voiture ; jamais pour un nom de bien', () => {
    const cands = [
      bien(1, 'Polo'), bien(2, 'Cupra'),
      bien(3, 'Yamaha', {}, { family: 'VEHICULE', subtype: 'Moto' }),
      bien(4, 'Maison Lyon', {}, { family: 'IMMOBILIER', subtype: 'Maison' }),
    ];
    const r = runSearchPipeline(parseSearchQuery('voitures'), cands, BARRE);
    expect(r.results.map((x) => x.candidate.displayName).sort()).toEqual(['Cupra', 'Polo']);
    expect(r.results.every((x) => x.matchType === 'CATEGORY' && x.eligibilityReason === 'EXPLICIT_CATEGORY_QUERY')).toBe(true);
    // Documents : « factures » → type documentaire FACTURE.
    expect(noms('factures', [doc(1, 'Scan 12', { documentType: 'FACTURE' }), doc(2, 'Scan 13', { documentType: 'CONTRAT' })])).toEqual(['Scan 12']);
    // Requête sur un NOM : la catégorie ne fait rien remonter seule.
    const n = runSearchPipeline(parseSearchQuery('voiture polo'), cands, BARRE);
    expect(n.results.map((x) => x.candidate.displayName)).toEqual(['Polo']);
    expect(n.rejected.find((x) => x.candidate.displayName === 'Cupra')!.rejectionReason).toBe('CATEGORY_ONLY');
    // Côté assistant aussi : la catégorie seule n'est pas un match.
    const a = runSearchPipeline(parseSearchQuery('facture voiture'), cands, ASSISTANT);
    expect(a.results).toEqual([]);
    expect(a.rejected.find((x) => x.candidate.displayName === 'Polo')!.rejectionReason).toBe('CATEGORY_ONLY');
  });

  it('SRCH-G — aucune correspondance : terme absent → 0 résultat, pas de « proches » artificiels', () => {
    const cands = [bien(1, 'Polo'), bien(2, 'Cupra'), doc(3, 'Facture toiture'), echeance(4, 'Contrôle technique')];
    const r = runSearchPipeline(parseSearchQuery('zanzibar'), cands, BARRE);
    expect(r.results).toEqual([]);
    expect(r.rejected.every((x) => x.rejectionReason === 'NO_MATCHING_FIELD')).toBe(true);
    expect(runSearchPipeline(parseSearchQuery('zanzibar'), cands, ASSISTANT).results).toEqual([]);
  });
});

describe('SRCH — types de match, champs autorisés, sémantique, ranking', () => {
  it('SRCH-TYPES — EXACT, EXACT_TOKEN, PREFIX, NORMALIZED, ALIAS ; identifiant normalisé', () => {
    const t = (q: string, c: SearchCandidate) => evaluateCandidate(parseSearchQuery(q), c, BARRE);
    expect(t('Volkswagen Polo', bien(1, 'Volkswagen Polo')).matchType).toBe('EXACT');
    expect(t('polo', bien(1, 'Volkswagen Polo')).matchType).toBe('EXACT_TOKEN');
    expect(t('volks', bien(1, 'Volkswagen Polo')).matchType).toBe('PREFIX');
    expect(t('annecy', bien(1, 'Maison Annécy')).matchType).toBe('NORMALIZED');
    expect(t('factures', doc(1, 'Facture entretien')).matchType).toBe('NORMALIZED');
    expect(t('vw polo', doc(1, 'Facture entretien Volkswagen Polo'))).toMatchObject({ eligible: true, matchedField: 'title' });
    expect(t('vw', doc(1, 'Facture entretien Volkswagen Polo')).matchType).toBe('ALIAS');
    const plaque = t('ab123cd', bien(1, 'Polo', { registrationNumber: 'AB-123-CD' }));
    expect(plaque).toMatchObject({ matchedField: 'registrationNumber', matchedValue: 'AB-123-CD', matchType: 'NORMALIZED' });
    // Un identifiant n'est jamais partiel.
    expect(t('ab12', bien(1, 'Polo', { registrationNumber: 'AB-123-CD' })).eligible).toBe(false);
  });

  it('SRCH-CHAMPS — seuls les champs déclarés produisent un match (notes, état, moteur ignorés)', () => {
    expect(SEARCH_FIELDS.asset.map((f) => f.field)).not.toContain('notes');
    const c = bien(1, 'Cupra', { notes: 'remplace la polo', engineInfo: 'polo', generalCondition: 'polo' } as never);
    expect(evaluateCandidate(parseSearchQuery('polo'), c, BARRE)).toMatchObject({ eligible: false, rejectionReason: 'NO_MATCHING_FIELD', matchedField: null });
  });

  it('SRCH-SEM — sémantique : faible similarité rejetée, forte admise seulement si la politique l’autorise', () => {
    const c = { ...doc(1, 'Facture automobile'), fields: { title: 'Note garage' }, semanticScore: 0.5 };
    expect(evaluateCandidate(parseSearchQuery('facture voiture'), c, ASSISTANT).rejectionReason).toBe('SEMANTIC_SCORE_TOO_LOW');
    const fort = { ...c, semanticScore: 0.9 };
    expect(evaluateCandidate(parseSearchQuery('facture voiture'), fort, ASSISTANT).rejectionReason).toBe('SEMANTIC_SCORE_TOO_LOW');
    expect(evaluateCandidate(parseSearchQuery('facture voiture'), fort, { ...ASSISTANT, allowSemantic: true })).toMatchObject({ eligible: true, matchType: 'SEMANTIC', matchedField: 'semantic' });
  });

  it('SRCH-RANK — éligibilité puis ranking : un score élevé ne rattrape pas un rejet ; trace complète', () => {
    const q = parseSearchQuery('polo');
    const evals = [bien(2, 'Cupra'), bien(1, 'Polo'), bien(3, 'Polo GTI')].map((c) => evaluateCandidate(q, c, BARRE));
    // Un rejet maquillé avec un score élevé reste hors du classement.
    evals[0] = { ...evals[0], rawScore: 99 };
    const ranked = rankEligible(evals);
    expect(ranked.map((r) => r.candidate.displayName)).toEqual(['Polo', 'Polo GTI']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
    expect(ranked[0].normalizedScore).toBe(1);
    const { trace } = runSearchPipeline(q, [bien(2, 'Cupra'), bien(1, 'Polo')], BARRE);
    expect(trace[0]).toMatchObject({
      query: 'polo', entityId: 1, entityType: 'asset', displayName: 'Polo', matchedField: 'name', matchedValue: 'Polo', matchType: 'EXACT',
      retrievalStrategy: 'test', eligibilityDecision: 'ELIGIBLE', eligibilityReason: 'EXACT_VALUE', rank: 1,
    });
    expect(trace[1]).toMatchObject({ entityId: 2, rejected: true, rejectionReason: 'NO_MATCHING_FIELD', eligibilityDecision: 'REJECTED', rank: null });
  });

  it('SRCH-TERMS — termes de l’assistant (query-terms) : mêmes règles d’éligibilité', () => {
    const q = queryFromTerms(tokenizeQuery('retrouve la facture de la Polo'));
    expect(q.tokens.map((t) => t.norm)).toEqual(['facture', 'polo']);
    expect(evaluateCandidate(q, bien(2, 'Cupra', { notes: 'remplace la Polo' } as never), ASSISTANT).eligible).toBe(false);
    expect(evaluateCandidate(q, bien(3, 'Apolon'), ASSISTANT).eligible).toBe(false);
    expect(evaluateCandidate(q, doc(1, 'Facture entretien Polo'), ASSISTANT)).toMatchObject({ eligible: true, matchedField: 'title' });
  });
});

describe('SRCH — relation explicitement autorisée', () => {
  it('SRCH-D-REL — échéance : le « bien concerné » est un champ autorisé (ticket §5) ; document : jamais seul', () => {
    const r = runSearchPipeline(parseSearchQuery('polo'), [
      echeance(1, 'Contrôle technique', { assetNames: ['Polo'] }),
      echeance(2, 'Ramonage', { assetNames: ['Maison Lyon'] }),
      doc(3, 'Attestation', { assetName: 'Polo' }),
    ], BARRE);
    expect(r.results.map((x) => x.candidate.entityId)).toEqual([1]);
    expect(r.results[0]).toMatchObject({ matchedField: 'assetNames', matchType: 'RELATIONAL', eligibilityReason: 'AUTHORIZED_RELATION' });
    expect(r.rejected.find((x) => x.candidate.entityId === 3)!.rejectionReason).toBe('RELATION_ONLY');
  });
});
