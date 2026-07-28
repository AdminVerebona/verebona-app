/**
 * Tests du score d'autorité — CDC §4.2.7.
 *
 * L'ordre d'autorité conditionne tous les arbitrages du lot 3 : il doit être
 * vérifié explicitement, pas supposé.
 */
import { describe, it, expect } from 'vitest';
import { computeAuthorityScore } from '../../evidence/authority-score';

describe('ordre d\'autorité documentaire', () => {
  it('place l\'acte authentique au-dessus du compromis, lui-même au-dessus de l\'annonce', () => {
    const acte = computeAuthorityScore({ documentType: 'ACTE_AUTHENTIQUE' });
    const compromis = computeAuthorityScore({ documentType: 'COMPROMIS_VENTE' });
    const annonce = computeAuthorityScore({ documentType: 'ANNONCE_COMMERCIALE' });
    expect(acte).toBeGreaterThan(compromis);
    expect(compromis).toBeGreaterThan(annonce);
  });

  it('place le certificat d\'immatriculation au-dessus de l\'assurance, puis de la facture', () => {
    expect(computeAuthorityScore({ documentType: 'CERTIFICAT_IMMATRICULATION' }))
      .toBeGreaterThan(computeAuthorityScore({ documentType: 'CONTRAT_ASSURANCE' }));
    expect(computeAuthorityScore({ documentType: 'CONTRAT_ASSURANCE' }))
      .toBeGreaterThan(computeAuthorityScore({ documentType: 'FACTURE' }));
  });

  it('place le mesurage légal au-dessus du DPE, lui-même au-dessus de l\'annonce', () => {
    expect(computeAuthorityScore({ documentType: 'MESURAGE_LEGAL' }))
      .toBeGreaterThan(computeAuthorityScore({ documentType: 'DPE' }));
    expect(computeAuthorityScore({ documentType: 'DPE' }))
      .toBeGreaterThan(computeAuthorityScore({ documentType: 'ANNONCE_COMMERCIALE' }));
  });

  it('décote une source web par rapport au même type en document', () => {
    expect(computeAuthorityScore({ documentType: 'FACTURE', isWebLink: true }))
      .toBeLessThan(computeAuthorityScore({ documentType: 'FACTURE' }));
  });

  it('retombe sur AUTRE pour un type inconnu, sans échouer', () => {
    const score = computeAuthorityScore({ documentType: 'TYPE_INEXISTANT' });
    expect(score).toBe(computeAuthorityScore({ documentType: 'AUTRE' }));
  });
});
