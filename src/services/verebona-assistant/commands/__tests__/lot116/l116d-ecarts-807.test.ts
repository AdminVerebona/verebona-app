/**
 * Carte #807 (lot 116D) — Assistant T2, écarts résiduels : analyse des demandes et règles pures (sans base).
 * Les écritures, la concurrence et l'isolation sont prouvées sur PostgreSQL réel (`l116d-t2-ecarts-807.e2e.ts`).
 */
import { describe, expect, it } from 'vitest';
import { EQUIPMENT_FICHE_FIELDS } from '@/lib/asset-detail-rules';
import { SUPPLIER_EDITABLE_FIELDS } from '@/services/suppliers/supplier-validation';
import { SUPPLIER_COMMAND_FIELDS, WRITE_COMMAND_CATALOG } from '../../catalog';
import { labelKey, parseAmountCents, parseLabelledValues, parseTimeFr } from '../../labelled-values';
import { parseCommand, parseCommands } from '../../parser';
import { AGENDA_LABELS, EQUIPMENT_LABELS, SUPPLIER_LABELS } from '../../rich-edit-labels';
import { agendaDiff, equipmentDiff, interpretEquipmentValues, redactActionsForTrace, type EquipmentFullState } from '../../rich-edits';

const TODAY = '2026-11-17';

describe('L116D-U01 — liste « libellé valeur »', () => {
  it('libellés reconnus en début de liste et après un séparateur ; valeurs reprises telles qu’écrites', () => {
    expect(parseLabelledValues('marque Viessmann, modèle Vitodens 200 et numéro de série VS-778-A', EQUIPMENT_LABELS)).toEqual([
      { key: 'brand', raw: 'Viessmann' }, { key: 'modelName', raw: 'Vitodens 200' }, { key: 'serialNumber', raw: 'VS-778-A' },
    ]);
    expect(parseLabelledValues('adresse : 12 rue de la Paix ; code postal 75002 ; ville Paris', SUPPLIER_LABELS)).toEqual([
      { key: 'addressLine1', raw: '12 rue de la Paix' }, { key: 'postalCode', raw: '75002' }, { key: 'city', raw: 'Paris' },
    ]);
  });
  it('un mot de libellé au milieu d’une valeur ou entre guillemets reste dans la valeur ; « aucune » efface', () => {
    expect(parseLabelledValues('marque Honda Type R, type Voiture', EQUIPMENT_LABELS)).toEqual([{ key: 'brand', raw: 'Honda Type R' }, { key: 'type', raw: 'Voiture' }]);
    expect(parseLabelledValues('description « marque, modèle et type à vérifier », heure 9h', AGENDA_LABELS)).toEqual([
      { key: 'description', raw: 'marque, modèle et type à vérifier' }, { key: 'startTime', raw: '9h' },
    ]);
    expect(parseLabelledValues('marque aucune', EQUIPMENT_LABELS)).toEqual([{ key: 'brand', raw: null }]);
  });
  it('ce qui ne commence pas par un libellé n’est pas une liste', () => {
    expect(parseLabelledValues('3 rue des Lilas, ville Paris', SUPPLIER_LABELS)).toBeNull();
    expect(labelKey('le numéro de série', EQUIPMENT_LABELS)).toBe('serialNumber');
    expect(labelKey('l’adresse e-mail', SUPPLIER_LABELS)).toBe('email');
    expect(labelKey('couleur', EQUIPMENT_LABELS)).toBeNull();
  });
  it('montants et heures', () => {
    expect([parseAmountCents('2 500 €'), parseAmountCents('1 800,50 euros'), parseAmountCents('12.5'), parseAmountCents('beaucoup'), parseAmountCents('-3')]).toEqual([250000, 180050, 1250, null, null]);
    expect([parseTimeFr('14h30'), parseTimeFr('9 h'), parseTimeFr('09:05'), parseTimeFr('25h'), parseTimeFr('midi')]).toEqual(['14:30', '09:00', '09:05', null, null]);
  });
});

describe('L116D-U02 — alignement sur les fiches existantes (aucune liste locale divergente)', () => {
  it('fournisseur : les champs de l’Assistant sont exactement ceux de la fiche, tous nommables', () => {
    expect([...SUPPLIER_COMMAND_FIELDS].sort()).toEqual([...SUPPLIER_EDITABLE_FIELDS].sort());
    expect(new Set(SUPPLIER_LABELS.map((l) => l.key))).toEqual(new Set(SUPPLIER_EDITABLE_FIELDS));
  });
  it('équipement : chaque champ de la fiche est nommable ; le catalogue porte UPDATE_EQUIPMENT, par la façade de l’écran', () => {
    const cles = new Set<string>(EQUIPMENT_LABELS.map((l) => l.key));
    for (const f of EQUIPMENT_FICHE_FIELDS) expect(cles.has(f.key), f.key).toBe(true);
    for (const k of ['name', 'type', 'category', 'status', 'purchasePriceCents', 'estimatedValueCents', 'room', 'asset']) expect(cles.has(k), k).toBe(true);
    expect(WRITE_COMMAND_CATALOG.UPDATE_EQUIPMENT).toMatchObject({ service: 'structure-write.facade.updateEquipmentForAccount', requiresWriteAccess: true });
    expect(WRITE_COMMAND_CATALOG.UPDATE_AGENDA_ITEM.service).toBe('AgendaWriteService.updateAgendaItem');
  });
  it('E09 : aucune commande autonome de déplacement dans le catalogue fermé', () => {
    expect(Object.keys(WRITE_COMMAND_CATALOG).filter((k) => /MOVE|TRANSFER|DEPLAC/.test(k))).toEqual([]);
  });
});

describe('L116D-U03 — demandes reconnues', () => {
  it('E01 : modifier un équipement (plusieurs champs, un champ, effacement, déplacement, pièce)', () => {
    expect(parseCommand('Modifie l’équipement Chaudière de la maison : marque Viessmann, statut en panne', TODAY)).toEqual({
      command: 'UPDATE_EQUIPMENT', targetWords: ['chaudiere'], assetWords: ['maison'], assetFromContext: false,
      values: [{ key: 'brand', raw: 'Viessmann' }, { key: 'status', raw: 'en panne' }],
    });
    expect(parseCommand('Mets le prix d’achat de l’équipement Chaudière à 2 500 €', TODAY)).toMatchObject({ command: 'UPDATE_EQUIPMENT', targetWords: ['chaudiere'], values: [{ key: 'purchasePriceCents', raw: '2 500 €' }] });
    expect(parseCommand('Efface le numéro de série de l’équipement Chaudière', TODAY)).toMatchObject({ command: 'UPDATE_EQUIPMENT', values: [{ key: 'serialNumber', raw: null }] });
    expect(parseCommand('Déplace l’équipement Cave à vin vers le Studio', TODAY)).toMatchObject({ command: 'UPDATE_EQUIPMENT', targetWords: ['cave', 'vin'], values: [{ key: 'asset', raw: 'Studio' }] });
    expect(parseCommand('Mets l’équipement Chaudière dans la pièce Cellier', TODAY)).toMatchObject({ command: 'UPDATE_EQUIPMENT', values: [{ key: 'room', raw: 'Cellier' }] });
  });
  it('E01 : les formes existantes ne changent pas (créer, renommer, retirer)', () => {
    expect(parseCommand('Renomme l’équipement Chaudière en Chaudière gaz', TODAY)).toMatchObject({ command: 'RENAME_EQUIPMENT' });
    expect(parseCommand('Retire l’équipement Chaudière', TODAY)).toMatchObject({ command: 'ARCHIVE_EQUIPMENT' });
    expect(parseCommand('Ajoute un équipement Chaudière dans la pièce Cellier de la maison', TODAY)).toEqual({
      command: 'CREATE_EQUIPMENT', name: 'Chaudière', roomWords: ['cellier'], assetWords: ['maison'], assetFromContext: false,
    });
    expect(parseCommand('Quelle est la marque de l’équipement Chaudière ?', TODAY)).toBeNull();
  });
  it('E02 : créer un équipement avec les informations fournies', () => {
    expect(parseCommand('Ajoute un équipement Chaudière dans la maison : marque Viessmann, prix d’achat 2 500 €', TODAY)).toEqual({
      command: 'CREATE_EQUIPMENT', name: 'Chaudière', roomWords: [], assetWords: ['maison'], assetFromContext: false,
      values: [{ key: 'brand', raw: 'Viessmann' }, { key: 'purchasePriceCents', raw: '2 500 €' }],
    });
  });
  it('E03 : modifier une échéance sur plusieurs champs ; les formes existantes ne changent pas', () => {
    expect(parseCommand('Modifie l’échéance Vidange du 12 mars 2031 : description Apporter le carnet, heure de début 9h30, situation a eu lieu', TODAY)).toMatchObject({
      command: 'UPDATE_AGENDA_ITEM', itemWords: ['vidange'], itemDate: '2031-03-12',
      values: [{ key: 'description', raw: 'Apporter le carnet' }, { key: 'startTime', raw: '9h30' }, { key: 'situation', raw: 'eu lieu' }],
    });
    expect(parseCommand('Reporte l’échéance Vidange au 20 mars 2031', TODAY)).toMatchObject({ command: 'UPDATE_AGENDA_ITEM', newDate: '2031-03-20', newTitle: null });
    expect(parseCommand('Supprime l’échéance Vidange', TODAY)).toMatchObject({ command: 'DELETE_AGENDA_ITEM' });
  });
  it('E04 : fournisseur — adresse, identifiants, IBAN ; les formes existantes ne changent pas', () => {
    expect(parseCommand('Modifie le fournisseur Plomberie Durand : adresse 12 rue de la Paix, ville Paris, IBAN FR76 3000 6000 0112 3456 7890 189', TODAY)).toMatchObject({
      command: 'UPDATE_SUPPLIER', supplierWords: ['plomberie', 'durand'],
      values: [{ key: 'addressLine1', raw: '12 rue de la Paix' }, { key: 'city', raw: 'Paris' }, { key: 'iban', raw: 'FR76 3000 6000 0112 3456 7890 189' }],
    });
    expect(parseCommand('Efface le SIRET du fournisseur Durand', TODAY)).toEqual({ command: 'UPDATE_SUPPLIER', supplierWords: ['durand'], field: 'siret', value: null, clear: true });
    expect(parseCommand('Change l’e-mail du fournisseur Durand en contact@durand.fr', TODAY)).toEqual({ command: 'UPDATE_SUPPLIER', supplierWords: ['durand'], field: 'email', value: 'contact@durand.fr', clear: false });
  });
  it('E05 / E09 : sinistre déclarable ; déplacement d’un document = demande traduite en deux gestes ; « opération » compris', () => {
    expect(parseCommand('Déclare un sinistre « Dégât des eaux » réalisé hier pour la maison', TODAY)).toMatchObject({ command: 'CREATE_REFERENCE_EVENT', typeCode: 'CLAIM', status: 'REALIZED' });
    expect(parseCommand('Déplace le document Facture Norauto de l’intervention Vidange vers l’intervention Freins', TODAY)).toMatchObject({
      command: 'DOCUMENT_REFERENCE_EVENT_TRANSFER_REQUEST', documentWords: ['facture', 'norauto'],
      from: { typeCode: 'INTERVENTION', words: ['vidange'] }, to: { typeCode: 'INTERVENTION', words: ['freins'] },
    });
    expect(parseCommand('Déplace le document Facture Norauto vers l’opération Freins', TODAY)).toMatchObject({ command: 'DOCUMENT_REFERENCE_EVENT_TRANSFER_REQUEST', from: null, to: { typeCode: null, words: ['freins'] } });
    expect(parseCommand('Supprime l’opération Vidange', TODAY)).toMatchObject({ command: 'INVALIDATE_REFERENCE_EVENT', target: { typeCode: null, words: ['vidange'] } });
    expect(parseCommands('Retire le document Facture Norauto de l’intervention Vidange puis rattache le document Facture Norauto à l’intervention Freins', TODAY)?.map((s) => [s.draft.command, s.dependsOnPrevious]))
      .toEqual([['UNLINK_DOCUMENT_REFERENCE_EVENT', false], ['LINK_DOCUMENT_REFERENCE_EVENT', true]]);
  });
});

describe('L116D-U04 — règles pures', () => {
  const etat: EquipmentFullState = {
    id: 7, name: 'Chaudière', assetId: 1, assetName: 'Maison', roomId: 4, roomName: 'Cellier', type: null, category: null, status: 'EN_SERVICE',
    energyUsage: null, purchasePriceCents: 250000, estimatedValueCents: null,
    fiche: { brand: 'Viessmann', modelName: null, serialNumber: null }, documents: 0, agenda: 0, updatedAt: '1', version: 'v',
  };
  it('équipement : seul ce qui CHANGE est transmis à la façade et annoncé', () => {
    const d = equipmentDiff(etat, { status: 'EN_PANNE', purchasePriceCents: 250000, fiche: { brand: 'Viessmann', serialNumber: 'AB-1' } }, undefined, undefined);
    expect(d.body).toEqual({ status: 'EN_PANNE', fiche: { serialNumber: 'AB-1' } });
    expect(d.lines).toEqual(['Statut : En service → En panne', 'Numéro de série : (vide) → AB-1']);
    expect(equipmentDiff(etat, {}, null, 9)).toMatchObject({ body: { newAssetId: 9, substructureId: null }, moved: true, roomChanged: true });
    expect(equipmentDiff(etat, {}, 4, 1)).toMatchObject({ body: {}, moved: false, roomChanged: false });
  });
  it('équipement : valeurs interprétées selon les règles de la fiche ; refus dits', () => {
    expect(interpretEquipmentValues([{ key: 'status', raw: 'en réparation' }, { key: 'estimatedValueCents', raw: '1 800 €' }, { key: 'powerKw', raw: '24 kW' }, { key: 'room', raw: null }]))
      .toEqual({ requested: { status: 'EN_REPARATION', estimatedValueCents: 180000, fiche: { powerKw: 24 } }, room: null });
    expect(interpretEquipmentValues([{ key: 'name', raw: null }])).toEqual({ needInfo: 'Le nom d’un équipement ne peut pas être vide.' });
    expect(interpretEquipmentValues([{ key: 'cop', raw: '99' }])).toMatchObject({ needInfo: expect.stringMatching(/COP : valeur invalide/) });
  });
  it('Agenda : les liens sont AJOUTÉS à ceux de l’échéance relue, jamais écrasés', () => {
    const item = {
      id: 3, title: 'Vidange', description: null, startDate: '2031-03-12', startTime: null, endDate: null, endTime: null, noDeadline: false, situation: 'A_PREVOIR',
      assetLinks: [{ id: 1, assetId: 10, assetName: 'Clio' }], fileLinks: [], roomLinks: [], equipmentLinks: [],
    } as unknown as Parameters<typeof agendaDiff>[0];
    const d = agendaDiff(item, { title: 'Vidange', startTime: '09:30', addAssetIds: [10, 11] }, { assets: ['Polo'] });
    expect(d.input).toEqual({ startTime: '09:30', assetIds: [10, 11] });
    expect(d.lines).toEqual(['Heure de début : aucune → 09:30', 'Bien ajouté : Polo']);
  });
  it('E04 : une trace ne porte jamais un IBAN en clair', () => {
    const action = {
      actionId: 'a1', command: 'UPDATE_SUPPLIER' as const, targets: [], dependsOn: [], preview: '', effects: [],
      params: { kind: 'supplier_update' as const, supplierId: 1, patch: { iban: 'FR7630006000011234567890189', city: 'Paris' }, expectedVersion: 'v', banking: true as const },
    };
    const trace = JSON.stringify(redactActionsForTrace([action]));
    expect(trace).not.toContain('FR7630006000011234567890189');
    expect(trace).toContain('FR76 •••• •••• 0189');
    expect(trace).toContain('Paris');
  });
});
