/**
 * CDC 15 T2-39 (lot 15) — `asset-fields.ts` devient une VUE du registre
 * (`assistantWritable`). Parité stricte avec la liste historique (copie figée
 * du tag lot14b) : mêmes clés, libellés, types, unités, sections par famille
 * et formulations reconnues.
 */
import { describe, it, expect } from 'vitest';
import { ASSISTANT_ASSET_FIELDS, findAssetField, type AssetFieldDefinition } from '../asset-fields';
import { CANONICAL_FIELDS } from '@/services/canonical/registry';

const FIGEE: AssetFieldDefinition[] = [
  {
    key: 'acquisitionDate', label: 'Date d’achat', type: 'date',
    sections: { IMMOBILIER: 'common', VEHICULE: 'common', OBJET: 'common' },
    aliases: ["date d'achat", "date d'acquisition", 'date achat', 'date acquisition', "achete le", "acquis le"],
  },
  {
    key: 'acquisitionPrice', label: 'Prix d’achat', type: 'number', unit: '€',
    sections: { IMMOBILIER: 'common', VEHICULE: 'common', OBJET: 'common' },
    aliases: ["prix d'achat", "prix d'acquisition", 'prix achat', "cout d'achat"],
  },
  {
    key: 'estimatedValue', label: 'Valeur estimée', type: 'number', unit: '€',
    sections: { IMMOBILIER: 'valuation', VEHICULE: 'valuation', OBJET: 'valuation' },
    aliases: ['valeur estimee', 'valeur actuelle', 'estimation', 'valeur'],
  },
  {
    key: 'nextInspection', label: 'Prochain contrôle technique', type: 'date',
    sections: { VEHICULE: 'vehicle_insurance' },
    aliases: ['prochain controle technique', 'date du controle technique', 'controle technique', 'prochain ct'],
  },
  {
    key: 'insuranceExpiry', label: 'Échéance de l’assurance', type: 'date',
    sections: { IMMOBILIER: 'insurance', VEHICULE: 'vehicle_insurance', OBJET: 'insurance' },
    aliases: ["echeance de l'assurance", "echeance d'assurance", "fin d'assurance", "date d'echeance de l'assurance"],
  },
  {
    key: 'insurer', label: 'Assureur', type: 'text',
    sections: { IMMOBILIER: 'insurance', VEHICULE: 'vehicle_insurance', OBJET: 'insurance' },
    aliases: ['assureur', 'compagnie d\'assurance'],
  },
  {
    key: 'mileage', label: 'Kilométrage', type: 'number', unit: 'km',
    sections: { VEHICULE: 'vehicle_usage' },
    aliases: ['kilometrage', 'compteur', 'nombre de kilometres'],
  },
  {
    key: 'registrationNumber', label: 'Immatriculation', type: 'text',
    sections: { VEHICULE: 'vehicle_identification' },
    aliases: ['immatriculation', "plaque d'immatriculation", 'plaque'],
  },
  {
    key: 'firstRegistrationDate', label: 'Date de première immatriculation', type: 'date',
    sections: { VEHICULE: 'vehicle_technical' },
    aliases: ['date de premiere immatriculation', 'premiere immatriculation', 'date de mise en circulation', 'mise en circulation'],
  },
];

const parCle = <T extends { key: string }>(l: T[]) => [...l].sort((a, b) => a.key.localeCompare(b.key));

describe('T2-39 — catalogue des champs des commandes = registre', () => {
  it('parité avec la liste historique (clés, libellés, types, unités, sections, formulations)', () => {
    expect(parCle(ASSISTANT_ASSET_FIELDS)).toEqual(parCle(FIGEE));
  });
  it('ordre EXACT de la liste historique (départage des alias), définitions comprises', () => {
    expect(ASSISTANT_ASSET_FIELDS.map((f) => f.key)).toEqual(FIGEE.map((f) => f.key));
    expect(ASSISTANT_ASSET_FIELDS).toEqual(FIGEE);
  });
  it('deux alias de même longueur : le premier champ de la liste gagne, quel que soit l’ordre du message', () => {
    // « kilometrage » et « prochain ct » : 11 caractères chacun.
    expect('kilometrage'.length).toBe('prochain ct'.length);
    expect(findAssetField('kilométrage et prochain CT de la Clio')?.def.key).toBe('nextInspection');
    expect(findAssetField('prochain CT et kilométrage de la Clio')?.def.key).toBe('nextInspection');
    // « valeur » et « plaque » : 6 caractères — valeur estimée vient avant.
    expect(findAssetField('la plaque et la valeur de la Polo')?.def.key).toBe('estimatedValue');
  });
  it('exactement les champs assistantWritable du registre', () => {
    expect(ASSISTANT_ASSET_FIELDS.map((f) => f.key).sort())
      .toEqual(CANONICAL_FIELDS.filter((d) => d.assistantWritable).map((d) => d.key).sort());
  });
  it('mêmes champs reconnus dans un message qu’avant', () => {
    for (const [msg, key] of [
      ['mets la date d’achat de la Polo au 25/05/2021', 'acquisitionDate'],
      ['change le prochain contrôle technique de la Clio', 'nextInspection'],
      ['le kilométrage de la Clio est 45 000 km', 'mileage'],
      ['valeur estimée de la maison 300 000 €', 'estimatedValue'],
      ["l'assureur de la Polo en MAIF", 'insurer'],
    ] as const) expect(findAssetField(msg)?.def.key, msg).toBe(key);
  });
});
