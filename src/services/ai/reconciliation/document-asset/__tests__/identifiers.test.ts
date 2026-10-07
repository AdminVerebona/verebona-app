/**
 * Lot 31B — identifiants canoniques et correspondance déterministe
 * document → bien (ticket T1 §2, §3, §6 ; ticket T3 §4). Fonctions pures.
 */
import { describe, expect, it } from 'vitest';
import {
  isPromptSafeKey, matchSignals, normalizeAddress, promptIdentifiers, resolveAssetByIdentifiers,
  type AssetIdentifierRecord,
} from '../identifiers';
import { identifierRecordOf } from '../asset-identifiers.repository';

const maison: AssetIdentifierRecord = {
  assetId: 42, family: 'IMMOBILIER', values: { address1: '12 rue Exemple', postalCode: '69003', city: 'Lyon' },
};
const studio: AssetIdentifierRecord = {
  assetId: 43, family: 'IMMOBILIER', values: { address1: '8 avenue Jean Jaurès', postalCode: '69007', city: 'Lyon' },
};
const polo: AssetIdentifierRecord = {
  assetId: 50, family: 'VEHICULE', values: { registrationNumber: 'AB-123-CD', vin: 'WVWZZZ6RZEY123456', make: 'Volkswagen', model: 'Polo' },
};
const kangoo: AssetIdentifierRecord = { assetId: 51, family: 'VEHICULE', values: { registrationNumber: 'EF-456-GH', make: 'Renault' } };
const tv: AssetIdentifierRecord = { assetId: 60, family: 'OBJECT', values: { serialNumber: 'SN-0098-7712', brand: 'Sony' } };

const texte = (...t: string[]) => ({ facts: [], texts: t });

describe('normalisation (ticket T1 §3)', () => {
  it('casse, accents, espaces, ponctuation et abréviations de voie maîtrisées', () => {
    const attendu = normalizeAddress('12 rue de la République');
    for (const v of ['12 Rue de la Republique', '12 RUE DE LA REPUBLIQUE', '12, rue  de la République.', 'n° 12 r. de la république']) {
      expect(normalizeAddress(v)).toBe(attendu);
    }
    expect(normalizeAddress('8 av. Jean-Jaurès')).toBe(normalizeAddress('8 avenue Jean Jaures'));
  });
  it('aucune équivalence incertaine : articles conservés, numéro différent = autre adresse', () => {
    expect(normalizeAddress('12 rue de la Paix')).not.toBe(normalizeAddress('12 rue Paix'));
    expect(resolveAssetByIdentifiers([maison], texte('14 rue Exemple, 69003 Lyon')).assetIds).toEqual([]);
  });
});

describe('correspondance déterministe — biens immobiliers', () => {
  it('T1-LINK-01 — adresse exacte : un seul bien, certain', () => {
    const r = resolveAssetByIdentifiers([maison, studio], texte('Facture — 12 rue Exemple, 69003 Lyon'));
    expect(r.uniqueAssetId).toBe(42);
    expect(r.matches).toEqual([expect.objectContaining({ assetId: 42, kind: 'ADDRESS', via: 'text', exclusive: true })]);
  });
  it('T1-LINK-01 — adresse lue dans un FAIT T1 (address1)', () => {
    const r = resolveAssetByIdentifiers([maison, studio], { facts: [{ canonicalKey: 'address1', value: '12 rue Exemple 69003 Lyon' }], texts: [] });
    expect(r).toMatchObject({ uniqueAssetId: 42, matches: [expect.objectContaining({ via: 'fact' })] });
  });
  it('T1-LINK-02 — adresse normalisée (accents, casse)', () => {
    const rep: AssetIdentifierRecord = { assetId: 7, family: 'IMMOBILIER', values: { address1: '12 Rue de la République' } };
    expect(resolveAssetByIdentifiers([rep, studio], texte('Logement situé au 12 rue de la republique')).uniqueAssetId).toBe(7);
  });
  it('même rue, AUTRE code postal juste après : pas de rattachement', () => {
    expect(resolveAssetByIdentifiers([maison], texte('12 rue Exemple, 75011 Paris')).assetIds).toEqual([]);
    // Fait « code postal » contraire : pas de rattachement non plus.
    expect(resolveAssetByIdentifiers([maison], { facts: [{ canonicalKey: 'postalCode', value: '75011' }], texts: ['12 rue Exemple'] }).assetIds).toEqual([]);
  });
  it('correspondance partielle (ticket T1 §6) : la ville seule ne désigne aucun bien', () => {
    const r = resolveAssetByIdentifiers([maison, studio], texte('Avis de taxe — LYON 69000', 'Lyon'));
    expect(r).toMatchObject({ assetIds: [], uniqueAssetId: null, ambiguous: false });
  });
  it('A OU B : deux biens à la même adresse — ambiguïté, valeur non exclusive', () => {
    const parking: AssetIdentifierRecord = { assetId: 44, family: 'IMMOBILIER', values: { address1: '12 rue Exemple', postalCode: '69003' } };
    const r = resolveAssetByIdentifiers([maison, parking], texte('12 rue Exemple 69003 Lyon'));
    expect(r).toMatchObject({ uniqueAssetId: null, ambiguous: true, multiAssetCandidate: false, assetIds: [42, 44] });
  });
});

describe('correspondance déterministe — véhicules et objets', () => {
  it('T1-LINK-03 — immatriculation : AB-123-CD / AB123CD / AB 123 CD', () => {
    for (const t of ['Véhicule AB123CD', 'immat. AB 123 CD', 'plaque ab-123-cd']) {
      expect(resolveAssetByIdentifiers([polo, kangoo], texte(t)).uniqueAssetId).toBe(50);
    }
  });
  it('VIN exact (fait T1 ou texte)', () => {
    expect(resolveAssetByIdentifiers([polo, kangoo], { facts: [{ canonicalKey: 'vin', value: 'wvwzzz6rzey123456' }], texts: [] }).uniqueAssetId).toBe(50);
    expect(resolveAssetByIdentifiers([polo, kangoo], texte('VIN : WVWZZZ6RZEY123456')).uniqueAssetId).toBe(50);
  });
  it('numéro de série exact, séparateurs tolérés', () => {
    expect(resolveAssetByIdentifiers([tv, polo], texte('N° de série : SN 0098 7712')).uniqueAssetId).toBe(60);
    expect(resolveAssetByIdentifiers([tv], texte('Série SN-0098-7713')).assetIds).toEqual([]);
  });
  it('A ET B possible : deux biens désignés chacun par SA valeur', () => {
    const r = resolveAssetByIdentifiers([polo, kangoo], texte('Flotte : AB-123-CD et EF-456-GH'));
    expect(r).toMatchObject({ assetIds: [50, 51], ambiguous: true, multiAssetCandidate: true, uniqueAssetId: null });
  });
  it('marque / modèle seuls ne rattachent jamais', () => {
    expect(resolveAssetByIdentifiers([polo, kangoo], texte('Volkswagen Polo, Renault')).assetIds).toEqual([]);
  });
});

describe('données sensibles (règle du lot 29)', () => {
  it('l’adresse (sensible au registre) n’est jamais transmissible ; code postal et ville le sont', () => {
    expect(isPromptSafeKey('address1')).toBe(false);
    expect(isPromptSafeKey('postalCode')).toBe(true);
    expect(promptIdentifiers(maison)).toEqual({ postalCode: '69003', city: 'Lyon' });
    expect(promptIdentifiers(polo)).toEqual({ registrationNumber: 'AB-123-CD', vin: 'WVWZZZ6RZEY123456', make: 'Volkswagen', model: 'Polo' });
  });
  it('les signaux de correspondance ne citent jamais la valeur', () => {
    const r = resolveAssetByIdentifiers([maison], texte('12 rue Exemple 69003'));
    const s = matchSignals(r, 42).join(' ');
    expect(s).toMatch(/adresse/);
    expect(s).not.toMatch(/Exemple/i);
  });
  it('identifiants lus dans la fiche canonique (clé, alias, colonne miroir)', () => {
    const rec = identifierRecordOf({
      id: 9, account_id: 1, category: 'IMMOBILIER', address: '3 place Bellecour', postal_code: '69002', city: null,
      key_characteristics: JSON.stringify({ ville: 'Lyon', surface: 80 }),
    });
    expect(rec).toEqual({ assetId: 9, family: 'IMMOBILIER', values: { address1: '3 place Bellecour', postalCode: '69002', city: 'Lyon' } });
    const v = identifierRecordOf({ id: 3, account_id: 1, category: 'VEHICULE', registration_number: 'AB-123-CD', key_characteristics: null });
    expect(v.values).toEqual({ registrationNumber: 'AB-123-CD' });
  });
});
