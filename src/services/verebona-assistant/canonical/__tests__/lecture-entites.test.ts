/**
 * Lecture canonique — valeurs d'un équipement / d'une pièce (CDC 15 T1-04,
 * lot 18, R3) : réponse et source de niveau champ, règles pures.
 */
import { describe, it, expect } from 'vitest';
import { assetFieldSource, type CanonicalFieldReading, type CanonicalEntityFieldReading } from '../field-reader';
import { fieldAnswer } from '../structured-answers';

const entite = (over: Partial<CanonicalEntityFieldReading> = {}): CanonicalEntityFieldReading => ({
  target: { type: 'EQUIPMENT', id: 4 }, entityName: 'Chaudière', assetId: 3, key: 'serialNumber', label: 'Numéro de série',
  value: 'SN-77', display: 'SN-77', origin: 'RECONCILIATION', originLabel: 'retenue après rapprochement de vos documents',
  updatedAt: null, from: 'key', sensitive: false,
  evidence: { evidenceId: 9, fileId: 40, documentTitle: 'Facture chaudière', documentDate: '2024-05-02', excerpt: 'N° de série : SN-77', confidence: 'certain' },
  ...over,
});
const lecture = (entities: CanonicalEntityFieldReading[]): CanonicalFieldReading => ({
  assetId: 3, assetName: 'Maison', key: 'serialNumber', label: 'Numéro de série', value: null, display: null,
  origin: null, originLabel: null, updatedAt: null, from: null, evidence: null, openConflict: null, sensitive: false, entities,
});

describe('réponse sur un champ porté par un équipement', () => {
  it('la valeur est rattachée à SON équipement, avec origine et preuve — jamais au bien', () => {
    expect(fieldAnswer(lecture([entite()])))
      .toBe('Numéro de série de Chaudière : SN-77.');
    expect(fieldAnswer(lecture([entite(), entite({ target: { type: 'EQUIPMENT', id: 5 }, entityName: 'Ballon', display: 'B-1', origin: 'USER', originLabel: 'saisie par vous' })])))
      .toContain('Numéro de série de Ballon : B-1.');
  });

  it('source de niveau champ : valeurs par entité, cibles et preuves dans la méta', () => {
    const src = assetFieldSource(lecture([entite()]));
    expect(src.content).toContain('Chaudière : SN-77 (retenue après rapprochement de vos documents, preuve « Facture chaudière »)');
    expect(src.meta?.value).toBeNull();
    expect(JSON.parse(String(src.meta?.entities))).toEqual([
      { type: 'EQUIPMENT', id: 4, name: 'Chaudière', display: 'SN-77', origin: 'RECONCILIATION', evidenceId: 9, evidenceFileId: 40 },
    ]);
  });

  it('pièce : surface', () => {
    const r = lecture([entite({ target: { type: 'ROOM', id: 2 }, entityName: 'Salon', key: 'roomArea', label: 'Surface de la pièce', value: 18.5, display: '18,5 m2', origin: 'USER', originLabel: 'saisie par vous', evidence: null })]);
    expect(fieldAnswer({ ...r, key: 'roomArea', label: 'Surface de la pièce' })).toBe('Surface de la pièce de Salon : 18,5 m2.');
  });
});
