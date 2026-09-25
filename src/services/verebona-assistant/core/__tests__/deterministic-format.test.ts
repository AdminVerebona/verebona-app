/** Formatage déterministe T2 : chaque forme de réponse attendue par le ticket. */
import { describe, expect, it } from 'vitest';
import * as F from '../deterministic-format';
import { decideDocumentHit, decideFacts, decideStructured, requiresSynthesis, sanitizeThresholds } from '../sufficiency';

const T = { database: 0.5, text: 0.6 };

describe('formats', () => {
  it('valeur, date, montant, statut', () => {
    expect(F.formatAttributeValue({ subject: 'Chaudière', attribute: 'puissance', value: F.formatQuantity(24, 'kW') }))
      .toBe('La puissance de votre chaudière est de 24 kW.');
    expect(F.formatAttributeValue({ subject: 'Chaudière', attribute: 'numéro de série', value: '7723001' }))
      .toBe('Le numéro de série de votre chaudière est de 7723001.');
    expect(F.formatDateFr('2026-11-14')).toBe('14 novembre 2026');
    expect(F.formatAmountCents(489000)).toBe('4 890,00 €');
    expect(F.formatStatus('statut du bien', 'en service')).toBe('Statut du bien : en service.');
  });

  it('compteur, liste, échéance, relation, calcul, absence', () => {
    expect(F.formatCount('document', 84)).toBe('Vous avez 84 documents.');
    expect(F.formatCount('échéance', 0, 'à venir')).toBe('Vous n’avez aucune échéance à venir.');
    expect(F.formatList('Vous avez 3 biens', ['A', 'B', 'C'])).toBe('Vous avez 3 biens : A, B et C.');
    expect(F.formatDeadline('votre assurance habitation', '2026-11-14', '2026-09-25'))
      .toBe('Votre assurance habitation arrive à échéance le 14 novembre 2026 (dans 50 jours).');
    expect(F.formatRelation('ce document', 'est rattaché à', 'Maison Caen')).toBe('Ce document est rattaché à Maison Caen.');
    expect(F.formatSum('total', 489000, 3)).toBe('Total : 4 890,00 € (3 documents).');
    expect(F.formatNoResult('aucune échéance', 'correspondant à ce bien')).toBe('Je n’ai trouvé aucune échéance correspondant à ce bien.');
  });

  it('conflit : les deux valeurs et leurs sources', () => {
    expect(F.formatConflict('cette échéance', [{ value: '14 novembre', source: 'Contrat' }, { value: '30 novembre', source: 'Avenant' }]))
      .toMatch(/^J’ai trouvé deux valeurs différentes pour cette échéance : 14 novembre \(Contrat\) et 30 novembre \(Avenant\)\./);
  });
});

describe('suffisance', () => {
  it('champ exact : suffisant immédiatement', () => {
    expect(decideStructured('exact', T).status).toBe('SUFFICIENT_STRUCTURED');
  });
  it('un fait « probable » isolé reste sous le seuil ; cinq sources concordantes le franchissent', () => {
    const one = decideFacts([{ comparable: '24|kw', confidence: 'probable', matchedTerms: 2, sourceKey: 'doc_1' }], 2, { ...T, text: 0.7 });
    expect(one.status).toBe('INSUFFICIENT');
    const five = decideFacts([1, 2, 3, 4, 5].map((i) => ({ comparable: '24|kw', confidence: 'probable', matchedTerms: 2, sourceKey: `doc_${i}` })), 2, { ...T, text: 0.7 });
    expect(five.status).toBe('SUFFICIENT_RETRIEVAL');
  });
  it('valeurs contradictoires : CONFLICTING', () => {
    const d = decideFacts([
      { comparable: '24|kw', confidence: 'certain', matchedTerms: 2, sourceKey: 'doc_1' },
      { comparable: '28|kw', confidence: 'certain', matchedTerms: 2, sourceKey: 'doc_2' },
    ], 2, T);
    expect(d.status).toBe('CONFLICTING');
  });
  it('recherche faiblement pertinente ou ambiguë : escalade avec motif', () => {
    expect(decideDocumentHit([{ score: 0.3 }], T).reason).toBe('LOW_RELEVANCE');
    expect(decideDocumentHit([{ score: 1 }, { score: 0.95 }], T).reason).toBe('AMBIGUOUS_TARGET');
    expect(decideDocumentHit([{ score: 1 }, { score: 0.5 }], T).status).toBe('SUFFICIENT_RETRIEVAL');
  });
  it('synthèse détectée, seuils bornés', () => {
    expect(requiresSynthesis('Explique-moi l’évolution des dépenses')).toBe(true);
    expect(requiresSynthesis('Combien ai-je de documents ?')).toBe(false);
    expect(sanitizeThresholds({ database: 3, text: 0.8 })).toEqual({ database: 0.5, text: 0.8 });
  });
});
