/**
 * Données sensibles — CDC Assistant §16.2 et §29.4.
 *
 * « Ne jamais transmettre à Gemini les coordonnées bancaires. »
 *
 * Croisé avec la décision métier du 28/07/2026 : l'IBAN est extrait et stocké,
 * mais sa valeur ne repart jamais vers un modèle. Ces tests vérifient le second
 * volet — celui que la décision métier ne remet pas en cause.
 */
import { describe, it, expect } from 'vitest';
import { stripSensitiveFields } from '../tools/read-tools';

describe('filtrage des caractéristiques transmises au modèle', () => {
  it('retire les coordonnées bancaires', () => {
    const out = stripSensitiveFields({
      livingArea: '78.4', iban: 'FR7630004008280001234567890', bic: 'BNPAFRPP',
    });
    expect(out.livingArea).toBe('78.4');
    expect(out.iban).toBeUndefined();
    expect(out.bic).toBeUndefined();
  });

  it('retire les variantes de nommage', () => {
    const out = stripSensitiveFields({
      supplierIban: 'FR76…', bank_account: '123', cardNumber: '4970…', notes: 'ok',
    });
    expect(Object.keys(out)).toEqual(['notes']);
  });

  it('retire les clés techniques d\'origine et d\'autorité', () => {
    const out = stripSensitiveFields({
      livingArea: '78.4',
      livingArea__origin: 'RECONCILIATION',
      livingArea__authority: 1000,
      livingArea__sourceDate: '2026-01-01',
    });
    expect(Object.keys(out)).toEqual(['livingArea']);
  });

  it('conserve les caractéristiques ordinaires', () => {
    const out = stripSensitiveFields({
      livingArea: '78.4', registrationNumber: 'AB-123-CD', constructionYear: 1978,
    });
    expect(Object.keys(out).sort()).toEqual(['constructionYear', 'livingArea', 'registrationNumber']);
  });

  it('accepte une entrée absente ou illisible sans échouer', () => {
    expect(stripSensitiveFields(null)).toEqual({});
    expect(stripSensitiveFields('pas du json')).toEqual({});
  });
});
