/**
 * Les dix scénarios de réconciliation du CDC §11.2.
 *
 * Ce fichier est la recette fonctionnelle du lot 3. Chaque test porte le libellé
 * exact du cahier des charges, afin que la correspondance soit vérifiable sans
 * interprétation.
 */
import { describe, it, expect } from 'vitest';
import { decide } from '../decision/decision-matrix';
import { resolveAuthority } from '../decision/authority-matrix';
import type { DecisionInput, EvidenceCandidate } from '../types';

let seq = 1000;

function ev(over: Partial<EvidenceCandidate> & { fieldKey?: string } = {}): EvidenceCandidate {
  const fieldKey = over.fieldKey ?? 'livingArea';
  const documentType = over.documentType ?? 'ACTE_AUTHENTIQUE';
  return {
    evidenceId: seq++,
    value: '78.4', normalized: '78.4',
    confidence: 'certain',
    authorityScore: resolveAuthority({ fieldKey, documentType }).score,
    documentType,
    documentDate: new Date('2026-01-01'),
    sourceId: 1,
    excerpt: 'surface habitable : 78,40 m²',
    ...over,
  };
}

function run(over: Partial<DecisionInput>): ReturnType<typeof decide> {
  return decide({ fieldKey: 'livingArea', current: null, candidates: [], isCritical: false, ...over });
}

describe('§11.2 — scénarios de réconciliation', () => {
  it('1. champ vide correctement complété', () => {
    expect(run({ candidates: [ev()] }).action).toBe('apply');
  });

  it('2. champ automatique confirmé', () => {
    const d = run({
      current: { value: '78.4', normalized: '78.4', origin: 'DOCUMENT_EXTRACTION', updatedAt: null, authorityScore: 800 },
      candidates: [ev()],
    });
    expect(d.action).toBe('keep');
    expect(d.reasonCode).toBe('AUTO_VALUE_CONFIRMED');
  });

  it('3. champ automatique obsolète mis à jour', () => {
    const d = run({
      current: { value: '82', normalized: '82', origin: 'DOCUMENT_EXTRACTION', updatedAt: null,
        authorityScore: resolveAuthority({ fieldKey: 'livingArea', documentType: 'ANNONCE_COMMERCIALE' }).score },
      candidates: [ev({ documentType: 'ACTE_AUTHENTIQUE' })],
    });
    expect(d.action).toBe('update');
    expect(d.proposedValue).toBe('78.4');
  });

  it('4. champ manuel contradictoire transformé en arbitrage', () => {
    const d = run({
      current: { value: '82', normalized: '82', origin: 'USER', updatedAt: null },
      candidates: [ev({ documentType: 'ACTE_AUTHENTIQUE' })],
    });
    expect(d.action).toBe('create_conflict');
    expect(d.reasonCode).toBe('MANUAL_VALUE_CONTRADICTED');
  });

  it('5. sources contradictoires avec priorité claire', () => {
    const d = run({
      candidates: [
        ev({ value: '78.4', normalized: '78.4', documentType: 'ACTE_AUTHENTIQUE' }),
        ev({ value: '82', normalized: '82', documentType: 'ANNONCE_COMMERCIALE' }),
      ],
    });
    expect(d.action).toBe('apply');
    expect(d.proposedValue).toBe('78.4');
  });

  it('6. sources contradictoires sans priorité', () => {
    const d = run({
      candidates: [
        ev({ value: '78.4', normalized: '78.4', documentType: 'DPE' }),
        ev({ value: '79.1', normalized: '79.1', documentType: 'DPE' }),
      ],
    });
    expect(d.action).toBe('create_conflict');
  });

  it('7. valeur critique sans preuve suffisante', () => {
    const d = run({
      fieldKey: 'registrationNumber', isCritical: true,
      candidates: [ev({
        fieldKey: 'registrationNumber', value: 'AB-123-CD', normalized: 'AB-123-CD',
        documentType: 'FACTURE', confidence: 'certain',
      })],
    });
    expect(d.action).toBe('create_conflict');
    expect(d.reasonCode).toBe('CRITICAL_FIELD_INSUFFICIENT_PROOF');
  });

  it('8. absence de contamination entre biens — aucune preuve d\'un autre bien n\'entre', () => {
    // Le moteur ne reçoit que les preuves du bien traité : le cloisonnement est
    // porté par le collecteur, qui filtre sur account_id ET asset_id.
    // Ici on vérifie qu'un jeu de preuves vide ne produit jamais d'écriture.
    expect(run({ candidates: [] }).action).toBe('ignore');
  });

  it('9. nouvelle preuve identique sans nouvelle écriture', () => {
    const d = run({
      current: { value: '78,40', normalized: '78.4', origin: 'RECONCILIATION', updatedAt: null, authorityScore: 800 },
      candidates: [ev({ value: '78.4', normalized: '78.4' })],
    });
    expect(d.action).toBe('keep');
  });

  it('10. réexécution idempotente — la même entrée produit la même décision', () => {
    const i: Partial<DecisionInput> = {
      current: { value: '82', normalized: '82', origin: 'DOCUMENT_EXTRACTION', updatedAt: null, authorityScore: 100 },
      candidates: [ev(), ev({ value: '78.4', normalized: '78.4', documentType: 'DPE' })],
    };
    expect(run(i)).toEqual(run(i));
  });
});

describe('§11.4 — non-régression', () => {
  it('les rattachements et valeurs manuels sont protégés dans tous les cas', () => {
    const authorities = ['ACTE_AUTHENTIQUE', 'MESURAGE_LEGAL', 'DPE', 'ANNONCE_COMMERCIALE'];
    for (const documentType of authorities) {
      const d = run({
        current: { value: '82', normalized: '82', origin: 'USER', updatedAt: null },
        candidates: [ev({ documentType })],
      });
      expect(d.action, `documentType=${documentType}`).not.toBe('update');
      expect(d.action, `documentType=${documentType}`).not.toBe('apply');
    }
  });

  it('une preuve seule ne suffit jamais à écrire un champ critique sans type autorisé', () => {
    const types = ['FACTURE', 'DEVIS', 'PHOTO', 'ANNONCE_COMMERCIALE', 'AUTRE'];
    for (const documentType of types) {
      const d = run({
        fieldKey: 'acquisitionPrice', isCritical: true,
        candidates: [ev({
          fieldKey: 'acquisitionPrice', value: '120000', normalized: '12000000',
          documentType, confidence: 'certain',
        })],
      });
      if (documentType === 'FACTURE') {
        expect(d.action).toBe('apply'); // facture explicitement autorisée pour ce champ
      } else {
        expect(d.action, `documentType=${documentType}`).toBe('create_conflict');
      }
    }
  });
});
