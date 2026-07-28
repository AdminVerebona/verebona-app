/**
 * Tests de la matrice d'autorité — CDC §4.2.7.
 *
 * « La matrice doit être versionnée et testable. »
 * Les cinq ordres explicitement cités par le CDC sont vérifiés ici. Si une
 * décision métier modifie un ordre, ces tests échouent : c'est le comportement
 * recherché.
 */
import { describe, it, expect } from 'vitest';
import { resolveAuthority, isAuthorizedForCriticalField, getAuthorityMatrix } from '../decision/authority-matrix';
import { AUTHORITY_EQUIVALENCE_MARGIN } from '../decision/confidence';

function score(fieldKey: string, documentType: string): number {
  return resolveAuthority({ fieldKey, documentType }).score;
}

describe('les cinq ordres du §4.2.7', () => {
  it('prix d\'achat immobilier : acte > compromis > autre document', () => {
    expect(score('acquisitionPrice', 'ACTE_AUTHENTIQUE'))
      .toBeGreaterThan(score('acquisitionPrice', 'COMPROMIS_VENTE'));
    expect(score('acquisitionPrice', 'COMPROMIS_VENTE'))
      .toBeGreaterThan(score('acquisitionPrice', 'FACTURE'));
  });

  it('immatriculation : certificat > assurance > facture d\'entretien', () => {
    expect(score('registrationNumber', 'CERTIFICAT_IMMATRICULATION'))
      .toBeGreaterThan(score('registrationNumber', 'CONTRAT_ASSURANCE'));
    expect(score('registrationNumber', 'CONTRAT_ASSURANCE'))
      .toBeGreaterThan(score('registrationNumber', 'RAPPORT_ENTRETIEN'));
  });

  it('prime d\'assurance : avis d\'échéance > contrat initial', () => {
    expect(score('insurancePremium', 'AVIS_ECHEANCE'))
      .toBeGreaterThan(score('insurancePremium', 'CONTRAT_ASSURANCE'));
  });

  it('surface : acte ou mesurage légal > DPE > annonce commerciale', () => {
    expect(score('livingArea', 'ACTE_AUTHENTIQUE')).toBeGreaterThan(score('livingArea', 'DPE'));
    expect(score('livingArea', 'MESURAGE_LEGAL')).toBeGreaterThan(score('livingArea', 'DPE'));
    expect(score('livingArea', 'DPE')).toBeGreaterThan(score('livingArea', 'ANNONCE_COMMERCIALE'));
  });

  it('fin de garantie : certificat > facture avec durée > estimation', () => {
    expect(score('warrantyEndDate', 'CERTIFICAT_GARANTIE'))
      .toBeGreaterThan(score('warrantyEndDate', 'FACTURE'));
    expect(score('warrantyEndDate', 'FACTURE'))
      .toBeGreaterThan(score('warrantyEndDate', 'DEVIS'));
  });
});

describe('robustesse de la matrice', () => {
  it('une règle explicite domine toujours l\'autorité de base', () => {
    // Le compromis a une autorité de base inférieure à celle du certificat
    // d'immatriculation ; sur le prix d'achat, il doit malgré tout l'emporter.
    expect(score('acquisitionPrice', 'COMPROMIS_VENTE'))
      .toBeGreaterThan(score('acquisitionPrice', 'CERTIFICAT_IMMATRICULATION'));
  });

  it('les champs alias partagent l\'ordre de leur champ de référence', () => {
    expect(score('landArea', 'MESURAGE_LEGAL')).toBe(score('livingArea', 'MESURAGE_LEGAL'));
    expect(score('vin', 'CARTE_GRISE')).toBe(score('registrationNumber', 'CARTE_GRISE'));
  });

  it('retombe sur l\'autorité de base pour un champ sans ordre explicite', () => {
    expect(score('notes', 'ACTE_AUTHENTIQUE')).toBeGreaterThan(score('notes', 'DEVIS'));
  });

  it('INVARIANT — deux rangs consécutifs d\'un ordre explicite sont départageables', () => {
    // Sans cet écart, une divergence entre un acte notarié et un compromis de
    // vente produirait un arbitrage utilisateur au lieu d'être tranchée par la
    // règle du §4.2.7. Ce test a détecté ce défaut lors de la première
    // exécution : l'écart valait exactement la marge d'équivalence.
    expect(getAuthorityMatrix().rankStep).toBeGreaterThan(AUTHORITY_EQUIVALENCE_MARGIN);

    for (const [field, order] of Object.entries(getAuthorityMatrix().fieldOrders)) {
      for (let i = 0; i < order.length - 1; i++) {
        const gap = resolveAuthority({ fieldKey: field, documentType: order[i] }).score
          - resolveAuthority({ fieldKey: field, documentType: order[i + 1] }).score;
        expect(gap, `${field} : ${order[i]} vs ${order[i + 1]}`)
          .toBeGreaterThan(AUTHORITY_EQUIVALENCE_MARGIN);
      }
    }
  });

  it('expose sa version, pour tracer les décisions passées', () => {
    expect(getAuthorityMatrix().version).toMatch(/^v\d/);
    expect(resolveAuthority({ fieldKey: 'livingArea', documentType: 'DPE' }).rule)
      .toContain(getAuthorityMatrix().version);
  });
});

describe('types autorisés pour les champs critiques', () => {
  it('accepte la carte grise pour une immatriculation', () => {
    expect(isAuthorizedForCriticalField('registrationNumber', 'CARTE_GRISE')).toBe(true);
  });

  it('refuse une facture pour une immatriculation', () => {
    expect(isAuthorizedForCriticalField('registrationNumber', 'FACTURE')).toBe(false);
  });

  it('refuse tout type pour un champ critique sans liste — le silence vaut refus', () => {
    expect(isAuthorizedForCriticalField('champInconnu', 'ACTE_AUTHENTIQUE')).toBe(false);
  });

  it('refuse un type absent ou nul', () => {
    expect(isAuthorizedForCriticalField('acquisitionPrice', null)).toBe(false);
  });
});
