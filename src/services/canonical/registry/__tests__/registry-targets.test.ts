/**
 * Cibles des champs du registre — CDC 15 T1-04, lot 13 : champs d'équipement
 * et de pièce déclarés, jamais confondus avec les champs du bien.
 */
import { describe, it, expect } from 'vitest';
import { catalogForPrompts, fieldTargetTypes, getField, listFields } from '..';

describe('registre — cibles', () => {
  it('par défaut un champ vise le bien ; les champs d’équipement le déclarent', () => {
    expect(fieldTargetTypes(getField('registrationNumber')!)).toEqual(['ASSET']);
    for (const k of ['serialNumber', 'brand', 'modelName', 'powerKw', 'acquisitionPrice', 'acquisitionDate',
      'estimatedValue', 'warrantyStartDate', 'warrantyEndDate', 'lastRevision', 'maintenanceDueDate']) {
      expect(fieldTargetTypes(getField(k)!), k).toEqual(['ASSET', 'EQUIPMENT']);
    }
    expect(fieldTargetTypes(getField('roomArea')!)).toEqual(['ROOM']);
  });

  it('listFields : champs du BIEN par défaut (fiche, vue canonique, miroirs) — roomArea exclu', () => {
    expect(listFields().map((d) => d.key)).not.toContain('roomArea');
    expect(listFields('IMMOBILIER', { targetType: 'ROOM' }).map((d) => d.key)).toEqual(['roomArea']);
    expect(listFields(undefined, { targetType: 'EQUIPMENT' }).map((d) => d.key)).toContain('serialNumber');
  });

  it('catalogForPrompts expose la cible dans le contexte de la famille', () => {
    const immo = catalogForPrompts({ family: 'IMMOBILIER' }).fields;
    const cible = (k: string) => immo.find((f) => f.key === k)?.targets;
    // serialNumber : champ d'OBJET pour un bien, mais toujours admis pour un équipement.
    expect(cible('serialNumber')).toEqual(['EQUIPMENT']);
    expect(cible('warrantyEndDate')).toEqual(['ASSET', 'EQUIPMENT']);
    expect(cible('roomArea')).toEqual(['ROOM']);
    expect(cible('livingArea')).toEqual(['ASSET']);
    // Véhicule : pas de pièce.
    expect(catalogForPrompts({ family: 'VEHICULE' }).fields.find((f) => f.key === 'roomArea')).toBeUndefined();
  });
});
