/**
 * Coordonnées bancaires — décision métier du 28/07/2026 (question 1) croisée
 * avec l'interdiction du CDC Assistant §16.2.
 *
 * Demande métier : stocker l'IBAN lu par l'IA, alimenter la fiche, mettre à
 * jour lorsqu'un document plus récent en indique un autre, et envoyer en
 * arbitrage en cas de doute.
 *
 * Contrainte CDC : ne jamais transmettre de coordonnées bancaires à un modèle.
 *
 * Ces tests vérifient que les deux tiennent ensemble : l'IBAN est extrait et
 * géré, mais sa valeur n'est jamais renvoyée à un modèle pour arbitrage.
 */
import { describe, it, expect } from 'vitest';
import { decide } from '../decision/decision-matrix';
import { resolveAuthority, getAuthorityMatrix } from '../decision/authority-matrix';
import { isCriticalField } from '../decision/critical-fields';
import { isAiExcludedField, canRequestAiReview } from '../decision/ai-exclusion';
import type { DecisionInput, EvidenceCandidate } from '../types';

let seq = 5000;

function iban(over: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    evidenceId: seq++,
    value: 'FR7630004008280001234567890',
    normalized: 'FR7630004008280001234567890',
    confidence: 'certain',
    authorityScore: resolveAuthority({ fieldKey: 'iban', documentType: 'AVIS_ECHEANCE' }).score,
    documentType: 'AVIS_ECHEANCE',
    documentDate: new Date('2026-06-01'),
    sourceId: 1,
    excerpt: 'IBAN : FR76 3000 4008 2800 0123 4567 890',
    ...over,
  };
}

function run(over: Partial<DecisionInput>) {
  return decide({ fieldKey: 'iban', current: null, candidates: [], isCritical: false, ...over });
}

describe('demande métier — l\'IBAN est géré comme une donnée ordinaire', () => {
  it('n\'est plus un champ critique : il peut être écrit automatiquement', () => {
    expect(isCriticalField('iban')).toBe(false);
    expect(run({ candidates: [iban()] }).action).toBe('apply');
  });

  it('est mis à jour lorsqu\'un document plus récent en indique un autre', () => {
    const d = run({
      current: {
        value: 'FR7612345678901234567890123',
        normalized: 'FR7612345678901234567890123',
        origin: 'DOCUMENT_EXTRACTION', updatedAt: null,
        authorityScore: resolveAuthority({ fieldKey: 'iban', documentType: 'CONTRAT_ASSURANCE' }).score,
        sourceDate: new Date('2024-01-01'),
      },
      candidates: [iban({ documentDate: new Date('2026-06-01') })],
    });
    expect(d.action).toBe('update');
    expect(d.reasonCode).toBe('AUTO_VALUE_MORE_RECENT');
  });

  it('ne régresse pas vers un document plus ancien', () => {
    const d = run({
      current: {
        value: 'FR7612345678901234567890123', normalized: 'FR7612345678901234567890123',
        origin: 'DOCUMENT_EXTRACTION', updatedAt: null,
        authorityScore: 500, sourceDate: new Date('2026-06-01'),
      },
      candidates: [iban({ documentDate: new Date('2024-01-01') })],
    });
    expect(d.action).toBe('create_conflict');
  });

  it('la récence prime sur le type de document', () => {
    // Une facture récente doit l'emporter sur un contrat ancien : sur ce champ,
    // le type de document ne crée aucune hiérarchie.
    expect(resolveAuthority({ fieldKey: 'iban', documentType: 'FACTURE' }).score)
      .toBe(resolveAuthority({ fieldKey: 'iban', documentType: 'CONTRAT_ASSURANCE' }).score);
    expect(getAuthorityMatrix().recencyDominantFields).toContain('iban');
  });

  it('en cas de doute, part en arbitrage utilisateur', () => {
    const d = run({
      candidates: [
        iban({ value: 'FR76A', normalized: 'FR76A', documentDate: new Date('2026-01-01') }),
        iban({ value: 'FR76B', normalized: 'FR76B', documentDate: new Date('2026-01-01') }),
      ],
    });
    expect(d.action).toBe('create_conflict');
  });
});

describe('contrainte CDC — la valeur ne repart jamais vers un modèle', () => {
  it.each(['iban', 'bic', 'accountNumber', 'supplierIban', 'bank_account'])(
    '%s est exclu du périmètre modèle',
    (field) => {
      expect(isAiExcludedField(field)).toBe(true);
      expect(canRequestAiReview(field)).toBe(false);
    },
  );

  it('une preuve seulement probable produit un arbitrage, jamais une revue IA', () => {
    const d = run({ candidates: [iban({ confidence: 'probable' })] });
    expect(d.action).toBe('create_conflict');
    expect(d.action).not.toBe('request_ai_review');
  });

  it('un champ ordinaire, lui, peut faire l\'objet d\'une revue ciblée', () => {
    const d = decide({
      fieldKey: 'livingArea', current: null, isCritical: false,
      candidates: [iban({ confidence: 'probable', value: '78', normalized: '78' })],
    });
    expect(d.action).toBe('request_ai_review');
  });
});
