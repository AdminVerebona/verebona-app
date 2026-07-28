/**
 * Table de vérité du moteur de décision — CDC §4.2.4.
 *
 * Les onze situations de la matrice sont couvertes une à une, dans l'ordre du
 * cahier des charges. Ce fichier est la preuve de conformité du critère
 * d'acceptation n°8 et, surtout, du n°11 : « une valeur manuelle contradictoire
 * n'est jamais écrasée silencieusement ».
 */
import { describe, it, expect } from 'vitest';
import { decide } from '../decision/decision-matrix';
import type { DecisionInput, EvidenceCandidate, CurrentValue } from '../types';
import type { FieldOrigin, EvidenceConfidence } from '../../evidence/evidence.types';

let seq = 1;

function evidence(over: Partial<EvidenceCandidate> = {}): EvidenceCandidate {
  return {
    evidenceId: seq++,
    value: '120000',
    normalized: '120000',
    confidence: 'certain' as EvidenceConfidence,
    authorityScore: 100,
    documentType: 'ACTE_AUTHENTIQUE',
    documentDate: new Date('2026-01-01'),
    sourceId: 1,
    excerpt: 'prix de vente : 120 000 euros',
    ...over,
  };
}

function current(over: Partial<CurrentValue> = {}): CurrentValue {
  return {
    value: '110000', normalized: '110000',
    origin: 'DOCUMENT_EXTRACTION' as FieldOrigin,
    updatedAt: new Date('2025-06-01'),
    authorityScore: 60,
    sourceDate: new Date('2025-06-01'),
    ...over,
  };
}

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return { fieldKey: 'notes', current: null, candidates: [], isCritical: false, ...over };
}

describe('§4.2.4 — les onze situations de la matrice', () => {
  it('1. champ vide + preuve unique explicite et autorisée → application automatique', () => {
    const d = decide(input({ candidates: [evidence()] }));
    expect(d.action).toBe('apply');
    expect(d.reasonCode).toBe('EMPTY_FIELD_SINGLE_CERTAIN');
    expect(d.deterministic).toBe(true);
  });

  it('2. champ vide + preuve probable → revue ciblée, pas d\'écriture', () => {
    const d = decide(input({ candidates: [evidence({ confidence: 'probable' })] }));
    expect(d.action).toBe('request_ai_review');
    expect(d.reasonCode).toBe('AMBIGUOUS_EVIDENCE');
  });

  it('3. champ automatique + preuve plus autoritaire → mise à jour automatique', () => {
    const d = decide(input({
      current: current({ authorityScore: 40 }),
      candidates: [evidence({ authorityScore: 100 })],
    }));
    expect(d.action).toBe('update');
    expect(d.reasonCode).toBe('AUTO_VALUE_BETTER_AUTHORITY');
  });

  it('3 bis. champ automatique + preuve plus récente à autorité égale → mise à jour', () => {
    const d = decide(input({
      current: current({ authorityScore: 75, sourceDate: new Date('2024-01-01') }),
      candidates: [evidence({ authorityScore: 75, documentDate: new Date('2026-01-01') })],
    }));
    expect(d.action).toBe('update');
    expect(d.reasonCode).toBe('AUTO_VALUE_MORE_RECENT');
  });

  it('4. champ automatique + preuve contradictoire de même autorité → conflit', () => {
    const d = decide(input({
      current: current({ authorityScore: 75, sourceDate: new Date('2026-06-01') }),
      candidates: [evidence({ authorityScore: 75, documentDate: new Date('2026-01-01') })],
    }));
    expect(d.action).toBe('create_conflict');
    expect(d.reasonCode).toBe('EQUAL_AUTHORITY_DIVERGENCE');
  });

  it('5. champ manuel + même valeur confirmée → conservation et rattachement de la preuve', () => {
    const d = decide(input({
      current: current({ origin: 'USER', value: '120000', normalized: '120000' }),
      candidates: [evidence()],
    }));
    expect(d.action).toBe('keep');
    expect(d.reasonCode).toBe('MANUAL_VALUE_CONFIRMED');
    expect(d.evidenceIds.length).toBeGreaterThan(0);
  });

  it('6. champ manuel + valeur différente → conflit, jamais d\'écrasement', () => {
    const d = decide(input({
      current: current({ origin: 'USER', authorityScore: 0 }),
      candidates: [evidence({ authorityScore: 1000 })],
    }));
    expect(d.action).toBe('create_conflict');
    expect(d.reasonCode).toBe('MANUAL_VALUE_CONTRADICTED');
    expect(d.action).not.toBe('update');
  });

  it('7. deux sources contradictoires avec règle d\'autorité claire → source prioritaire', () => {
    const d = decide(input({
      candidates: [
        evidence({ value: '120000', normalized: '120000', authorityScore: 1000, documentType: 'ACTE_AUTHENTIQUE' }),
        evidence({ value: '115000', normalized: '115000', authorityScore: 950, documentType: 'COMPROMIS_VENTE' }),
      ],
    }));
    expect(d.action).toBe('apply');
    expect(d.proposedValue).toBe('120000');
  });

  it('8. deux sources contradictoires sans règle permettant de trancher → conflit', () => {
    const d = decide(input({
      candidates: [
        evidence({ value: '120000', normalized: '120000', authorityScore: 60 }),
        evidence({ value: '115000', normalized: '115000', authorityScore: 60 }),
      ],
    }));
    expect(d.action).toBe('create_conflict');
    expect(d.reasonCode).toBe('NO_AUTHORITY_RULE');
    // Les preuves des DEUX valeurs sont référencées : l'utilisateur doit voir
    // les deux documents pour arbitrer (§4.2.9).
    expect(d.evidenceIds.length).toBeGreaterThanOrEqual(2);
  });
});

describe('§4.2.6 — champs critiques, quatre conditions cumulatives', () => {
  const critical = { fieldKey: 'registrationNumber', isCritical: true };

  it('applique lorsque les quatre conditions sont réunies', () => {
    const d = decide(input({
      ...critical,
      candidates: [evidence({
        value: 'AB-123-CD', normalized: 'AB-123-CD',
        documentType: 'CERTIFICAT_IMMATRICULATION',
        confidence: 'certain', excerpt: 'immatriculation AB-123-CD',
      })],
    }));
    expect(d.action).toBe('apply');
  });

  it('refuse sur un type de document non autorisé, même avec une confiance certaine', () => {
    const d = decide(input({
      ...critical,
      candidates: [evidence({
        value: 'AB-123-CD', normalized: 'AB-123-CD',
        documentType: 'FACTURE', confidence: 'certain',
      })],
    }));
    expect(d.action).toBe('create_conflict');
    expect(d.reasonCode).toBe('CRITICAL_FIELD_INSUFFICIENT_PROOF');
  });

  it('refuse sur une confiance seulement probable', () => {
    const d = decide(input({
      ...critical,
      candidates: [evidence({
        normalized: 'AB-123-CD', documentType: 'CARTE_GRISE', confidence: 'probable',
      })],
    }));
    expect(d.action).toBe('create_conflict');
  });

  it('refuse en l\'absence d\'extrait justificatif', () => {
    const d = decide(input({
      ...critical,
      candidates: [evidence({
        normalized: 'AB-123-CD', documentType: 'CARTE_GRISE', confidence: 'certain', excerpt: '',
      })],
    }));
    expect(d.action).toBe('create_conflict');
  });

  it('refuse pour un champ critique sans liste de types autorisée — le silence vaut refus', () => {
    const d = decide(input({
      fieldKey: 'champSensibleInconnu', isCritical: true,
      candidates: [evidence({ normalized: 'X', documentType: 'ACTE_AUTHENTIQUE' })],
    }));
    expect(d.action).toBe('create_conflict');
  });
});

describe('protection des valeurs humaines — critère d\'acceptation n°11', () => {
  it.each<FieldOrigin>(['USER', 'ADMIN'])(
    'n\'écrase jamais une valeur d\'origine %s, quelle que soit l\'autorité de la preuve',
    (origin) => {
      const d = decide(input({
        current: current({ origin, authorityScore: 0 }),
        candidates: [evidence({ authorityScore: 1000, confidence: 'certain' })],
      }));
      expect(['create_conflict', 'keep']).toContain(d.action);
      expect(d.action).not.toBe('update');
      expect(d.action).not.toBe('apply');
    },
  );

  it.each<FieldOrigin>(['DOCUMENT_EXTRACTION', 'RECONCILIATION', 'IMPORT', 'SYSTEM_RULE'])(
    'accepte de remplacer une valeur d\'origine %s sur meilleure preuve',
    (origin) => {
      const d = decide(input({
        current: current({ origin, authorityScore: 30 }),
        candidates: [evidence({ authorityScore: 100 })],
      }));
      expect(d.action).toBe('update');
    },
  );
});

describe('abstentions', () => {
  it('ne fait rien sans preuve', () => {
    expect(decide(input()).action).toBe('ignore');
  });

  it('ignore une preuve non normalisable plutôt que d\'écrire une valeur douteuse', () => {
    const d = decide(input({ candidates: [evidence({ normalized: null })] }));
    expect(d.action).toBe('ignore');
    expect(d.reasonCode).toBe('UNNORMALIZABLE_VALUE');
  });

  it('conserve la valeur en place face à une preuve nettement plus faible', () => {
    const d = decide(input({
      current: current({ authorityScore: 100 }),
      candidates: [evidence({ authorityScore: 25 })],
    }));
    expect(d.action).toBe('keep');
    expect(d.reasonCode).toBe('WEAKER_EVIDENCE');
  });
});

describe('propriétés générales du moteur', () => {
  it('est déterministe : deux exécutions identiques donnent le même résultat', () => {
    const i = input({ current: current(), candidates: [evidence(), evidence({ authorityScore: 80 })] });
    expect(decide(i)).toEqual(decide(i));
  });

  it('ne prend jamais de décision d\'écriture sans référencer au moins une preuve', () => {
    const writes = ['apply', 'update'];
    const cases = [
      input({ candidates: [evidence()] }),
      input({ current: current({ authorityScore: 20 }), candidates: [evidence()] }),
    ];
    for (const c of cases) {
      const d = decide(c);
      if (writes.includes(d.action)) expect(d.evidenceIds.length).toBeGreaterThan(0);
    }
  });

  it('ne déclenche jamais d\'appel modèle : au plus une demande de revue', () => {
    const d = decide(input({ candidates: [evidence({ confidence: 'probable' })] }));
    expect(d.deterministic).toBe(true);
    expect(d.action).toBe('request_ai_review');
  });
});
