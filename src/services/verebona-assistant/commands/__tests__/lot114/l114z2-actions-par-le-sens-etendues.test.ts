/**
 * Passage 114Z2 (Trello #753, CDC T2 §9.1, §9.3, annexe A13 — bloc PO n° 40) — ACTIONS COMPRISES PAR LE SENS, étendues
 * aux pièces, équipements, échéances de l'Agenda, événements de référence (W21 à W26), rattachements et création
 * d'un bien. Toujours : indice → formulation directe → analyseur EXISTANT → commande attendue → plan à confirmer.
 *
 *   Z01  pièces et équipements (W04 – W09) ;
 *   Z02  échéances de l'Agenda (W15 – W17), date facultative ;
 *   Z03  événements de référence : déclarer, corriger, supprimer, associer (W21 – W24) ;
 *   Z04  rattachements : document ↔ bien (W13), document → événement (W25), fournisseur → événement (W26), « relation » ;
 *   Z05  création d'un bien (W01) : catégorie du référentiel des biens ;
 *   Z06  indice incomplet, champ inconnu, valeur détournée : rien n'est proposé (jamais un mot pris pour un autre) ;
 *   Z07  déclaration conservée = phrase de l'utilisateur ; catalogue fermé ; vocabulaire.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: { unsafe: vi.fn(async () => []) }, db: {} }));

const { draftsFromActionHints, prepareFromActionHints } = await import('../../action-hints');
const { parseCommand } = await import('../../parser');
const { WRITE_COMMAND_CATALOG } = await import('../../catalog');
type Hint = import('@/services/verebona-assistant/types/contracts').ActionHint;
type Deps = import('../../action-hints').ActionHintsDeps;

const TODAY = '2026-11-13';
const hint = (over: Partial<Hint>): Hint => ({ operation: 'UPDATE', entityType: 'asset', targetHint: null, fieldChanges: [], evidencePhrase: null, ...over });
const ch = (fieldHint: string, value: string | null, unit: string | null = null) => ({ fieldHint, value, unit });
const un = (h: Hint) => draftsFromActionHints([h], TODAY)?.drafts[0] ?? null;
const phrase = (h: Hint) => draftsFromActionHints([h], TODAY)?.phrases[0] ?? null;

describe('L114Z2-Z01 — pièces et équipements', () => {
  it('créer une pièce : `targetHint` est le bien, « nom » le nom donné ; sans bien nommé : « ce bien »', () => {
    expect(un(hint({ operation: 'CREATE', entityType: 'room', targetHint: 'la maison', fieldChanges: [ch('nom', 'Salle de bain')] })))
      .toEqual({ command: 'CREATE_ROOM', name: 'Salle de bain', roomWords: [], assetWords: ['maison'], assetFromContext: false });
    expect(un(hint({ operation: 'CREATE', entityType: 'room', fieldChanges: [ch('nom', 'Cuisine')] })))
      .toEqual({ command: 'CREATE_ROOM', name: 'Cuisine', roomWords: [], assetWords: [], assetFromContext: true });
    // Bien donné à part : `targetHint` est alors le nom.
    expect(un(hint({ operation: 'CREATE', entityType: 'room', targetHint: 'Cuisine', fieldChanges: [ch('bien', 'la maison')] })))
      .toMatchObject({ command: 'CREATE_ROOM', name: 'Cuisine', assetWords: ['maison'] });
  });

  it('renommer, supprimer une pièce ; le bien éventuel est donné à part', () => {
    expect(un(hint({ entityType: 'room', targetHint: 'la pièce Cuisine', fieldChanges: [ch('nom', 'Cuisine d’été')] })))
      .toEqual({ command: 'RENAME_ROOM', targetWords: ['cuisine'], newName: 'Cuisine d’été', assetWords: [], assetFromContext: false });
    expect(un(hint({ entityType: 'room', targetHint: 'Salle de bain', fieldChanges: [ch('nom', 'Salle d’eau'), ch('bien', 'Maison de Lyon')] })))
      .toEqual({ command: 'RENAME_ROOM', targetWords: ['salle', 'bain'], newName: 'Salle d’eau', assetWords: ['maison', 'lyon'], assetFromContext: false });
    expect(un(hint({ operation: 'DELETE', entityType: 'room', targetHint: 'le bureau', fieldChanges: [ch('bien', 'l’appartement')] })))
      .toEqual({ command: 'DELETE_ROOM', targetWords: ['bureau'], assetWords: ['appartement'], assetFromContext: false });
  });

  it('équipement : créer (avec sa pièce), renommer, retirer (archivage)', () => {
    expect(un(hint({ operation: 'CREATE', entityType: 'equipment', targetHint: 'la maison', fieldChanges: [ch('nom', 'Chaudière'), ch('pièce', 'Cellier')] })))
      .toEqual({ command: 'CREATE_EQUIPMENT', name: 'Chaudière', roomWords: ['cellier'], assetWords: ['maison'], assetFromContext: false });
    expect(un(hint({ entityType: 'equipment', targetHint: 'l’équipement Chaudière', fieldChanges: [ch('nom', 'Chaudière gaz')] })))
      .toMatchObject({ command: 'RENAME_EQUIPMENT', targetWords: ['chaudiere'], newName: 'Chaudière gaz' });
    expect(un(hint({ operation: 'DELETE', entityType: 'equipment', targetHint: 'la chaudière' })))
      .toEqual({ command: 'ARCHIVE_EQUIPMENT', targetWords: ['chaudiere'], assetWords: [], assetFromContext: false });
  });
});

describe('L114Z2-Z02 — échéances de l’Agenda', () => {
  it('créer : titre, bien, date FACULTATIVE (aucune date inventée)', () => {
    expect(un(hint({ operation: 'CREATE', entityType: 'agenda_item', targetHint: 'la Clio', fieldChanges: [ch('titre', 'Vidange'), ch('date', '2027-03-12')] })))
      .toEqual({ command: 'CREATE_AGENDA_ITEM', title: 'Vidange', date: '2027-03-12', noDeadline: false, assetWords: ['clio'], assetFromContext: false });
    expect(un(hint({ operation: 'CREATE', entityType: 'agenda_item', targetHint: 'le vélo', fieldChanges: [ch('nom', 'Entretien')] })))
      .toEqual({ command: 'CREATE_AGENDA_ITEM', title: 'Entretien', date: null, noDeadline: false, assetWords: ['velo'], assetFromContext: false });
    expect(un(hint({ operation: 'CREATE', entityType: 'agenda_item', fieldChanges: [ch('nom', 'Contrôle technique')] })))
      .toMatchObject({ command: 'CREATE_AGENDA_ITEM', title: 'Contrôle technique', date: null, assetWords: [] });
  });

  it('déplacer, renommer, supprimer : l’échéance est désignée par ses mots, son bien, sa date', () => {
    expect(un(hint({ entityType: 'agenda_item', targetHint: 'le contrôle technique de la Clio', fieldChanges: [ch('date', '2027-03-20')] })))
      .toEqual({ command: 'UPDATE_AGENDA_ITEM', newDate: '2027-03-20', newTitle: null, itemWords: ['controle', 'technique'], itemDate: null, assetWords: ['clio'], assetFromContext: false });
    expect(un(hint({ entityType: 'agenda_item', targetHint: 'vidange', fieldChanges: [ch('date', '20 mars 2027'), ch('bien', 'la Clio')] })))
      .toMatchObject({ command: 'UPDATE_AGENDA_ITEM', newDate: '2027-03-20', itemWords: ['vidange'], assetWords: ['clio'] });
    expect(un(hint({ entityType: 'agenda_item', targetHint: 'l’échéance vidange', fieldChanges: [ch('titre', 'Révision annuelle')] })))
      .toMatchObject({ command: 'UPDATE_AGENDA_ITEM', newDate: null, newTitle: 'Révision annuelle', itemWords: ['vidange'] });
    expect(un(hint({ operation: 'DELETE', entityType: 'agenda_item', targetHint: 'le rappel vidange de la Clio' })))
      .toMatchObject({ command: 'DELETE_AGENDA_ITEM', scope: 'OCCURRENCE', itemWords: ['vidange'], assetWords: ['clio'] });
  });
});

describe('L114Z2-Z03 — événements de référence', () => {
  it('déclarer (W21) : type, intitulé, situation DITE, date, bien — rien d’inventé', () => {
    expect(un(hint({
      operation: 'CREATE', entityType: 'business_operation', targetHint: 'la Clio',
      fieldChanges: [ch('type', 'intervention'), ch('nom', 'Changement des pneus'), ch('situation', 'a eu lieu'), ch('date', 'hier')],
    }))).toMatchObject({
      command: 'CREATE_REFERENCE_EVENT', typeCode: 'INTERVENTION', status: 'REALIZED', dateText: 'hier', label: 'Changement des pneus', labelQuoted: true,
      implicit: false, assetWords: ['clio'], assetFromContext: false,
    });
    expect(un(hint({
      operation: 'CREATE', entityType: 'business_operation', targetHint: 'ma Clio de Paul',
      fieldChanges: [ch('type', 'Intervention'), ch('intitulé', 'Vidange'), ch('situation', 'réalisée'), ch('date', '2025-03-12')],
    }))).toMatchObject({ command: 'CREATE_REFERENCE_EVENT', dateText: '12/03/2025', label: 'Vidange', assetWords: ['clio', 'paul'] });
    // Situation non dite : elle reste `null` — la préparation posera la question, elle n'est jamais déduite d'une date.
    expect(un(hint({ operation: 'CREATE', entityType: 'business_operation', fieldChanges: [ch('nom', 'Toiture'), ch('date', '2027-06-01')] })))
      .toMatchObject({ command: 'CREATE_REFERENCE_EVENT', typeCode: null, status: null, dateText: '01/06/2027', assetWords: [] });
    expect(un(hint({ operation: 'CREATE', entityType: 'business_operation', fieldChanges: [ch('nom', 'Toiture'), ch('situation', 'à prévoir')] })))
      .toMatchObject({ command: 'CREATE_REFERENCE_EVENT', status: 'ENVISAGED', dateText: null });
  });

  it('corriger (W22) : un champ à la fois', () => {
    expect(un(hint({ entityType: 'business_operation', targetHint: 'l’intervention Vidange de la Clio', fieldChanges: [ch('date', '2025-03-14')] })))
      .toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'date', value: '14/03/2025', target: { typeCode: 'INTERVENTION', words: ['vidange', 'clio'], date: null } });
    expect(un(hint({ entityType: 'business_operation', targetHint: 'Vidange', fieldChanges: [ch('prestataire', 'Garage Martin')] })))
      .toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'provider', value: 'Garage Martin', target: { typeCode: null, words: ['vidange'] } });
    expect(un(hint({ entityType: 'business_operation', targetHint: 'l’intervention Vidange', fieldChanges: [ch('intitulé', 'Vidange et filtres')] })))
      .toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'label', value: 'Vidange et filtres' });
    expect(un(hint({ entityType: 'business_operation', targetHint: 'l’événement de référence Toiture', fieldChanges: [ch('type', 'contrat')] })))
      .toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'type', value: 'contrat', target: { typeCode: null, words: ['toiture'] } });
    expect(un(hint({ entityType: 'business_operation', targetHint: 'l’intervention Freins', fieldChanges: [ch('situation', 'a eu lieu')] })))
      .toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'status', value: 'REALIZED' });
    expect(un(hint({ entityType: 'business_operation', targetHint: 'le contrat Assurance habitation', fieldChanges: [ch('date de fin', '2026-12-31')] })))
      .toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'endDate', value: '31/12/2026', target: { typeCode: 'CONTRACT' } });
    expect(un(hint({ entityType: 'business_operation', targetHint: 'le contrat Assurance habitation', fieldChanges: [ch('date de début', '2024-01-01')] })))
      .toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', field: 'startDate', value: '01/01/2024' });
  });

  it('supprimer (W23) et associer (W24)', () => {
    expect(un(hint({ operation: 'DELETE', entityType: 'business_operation', targetHint: 'l’intervention Vidange de la Clio' })))
      .toEqual({ command: 'INVALIDATE_REFERENCE_EVENT', target: { typeCode: 'INTERVENTION', words: ['vidange', 'clio'], date: null } });
    expect(un(hint({ operation: 'LINK', entityType: 'business_operation', targetHint: 'le financement Prêt auto', fieldChanges: [ch('événement de référence', 'l’achat de la Clio')] })))
      .toEqual({
        command: 'ASSOCIATE_REFERENCE_EVENTS',
        first: { typeCode: 'FINANCING', words: ['pret', 'auto'], date: null }, second: { typeCode: 'ACQUISITION', words: ['clio'], date: null },
      });
  });
});

describe('L114Z2-Z04 — rattachements', () => {
  it('document ↔ bien (W13) : rattacher, détacher', () => {
    expect(un(hint({ operation: 'LINK', entityType: 'document', targetHint: 'le document Garantie', fieldChanges: [ch('bien', 'la Clio')] })))
      .toEqual({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'attach', structureTarget: null, assetWords: ['clio'], assetFromContext: false, documentWords: ['garantie'], documentFromContext: false });
    expect(un(hint({ operation: 'UNLINK', entityType: 'document', targetHint: 'Garantie', fieldChanges: [ch('bien', 'la maison')] })))
      .toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'detach', assetWords: ['maison'], documentWords: ['garantie'] });
  });

  it('document → événement de référence (W25) ; « ce document » quand il n’est pas désigné', () => {
    expect(un(hint({ operation: 'LINK', entityType: 'document', targetHint: 'Facture Norauto', fieldChanges: [ch('événement de référence', 'l’intervention Vidange')] })))
      .toEqual({ command: 'LINK_DOCUMENT_REFERENCE_EVENT', documentWords: ['facture', 'norauto'], documentFromContext: false, target: { typeCode: 'INTERVENTION', words: ['vidange'], date: null } });
    expect(un(hint({ operation: 'LINK', entityType: 'document', fieldChanges: [ch('événement', 'la réparation')] })))
      .toMatchObject({ command: 'LINK_DOCUMENT_REFERENCE_EVENT', documentWords: [], documentFromContext: true, target: { typeCode: null, words: ['reparation'] } });
  });

  it('fournisseur → événement de référence (W26) : prestataire par défaut, intervenant s’il est dit', () => {
    expect(un(hint({ operation: 'LINK', entityType: 'supplier', targetHint: 'le fournisseur Garage Martin', fieldChanges: [ch('événement de référence', 'l’intervention Vidange')] })))
      .toEqual({ command: 'LINK_SUPPLIER_REFERENCE_EVENT', supplierWords: ['garage', 'martin'], role: 'PROVIDER', target: { typeCode: 'INTERVENTION', words: ['vidange'], date: null } });
    expect(un(hint({ operation: 'LINK', entityType: 'supplier', targetHint: 'Garage Martin', fieldChanges: [ch('événement de référence', 'l’intervention Vidange'), ch('rôle', 'intervenant')] })))
      .toMatchObject({ command: 'LINK_SUPPLIER_REFERENCE_EVENT', role: 'INTERVENER' });
  });

  it('« relation » : l’objet rattaché est reconnu au nom qui ouvre sa désignation', () => {
    const vers = [ch('événement de référence', 'intervention Vidange')];
    expect(un(hint({ operation: 'LINK', entityType: 'relation', targetHint: 'le document Facture Norauto', fieldChanges: vers }))).toMatchObject({ command: 'LINK_DOCUMENT_REFERENCE_EVENT' });
    expect(un(hint({ operation: 'LINK', entityType: 'relation', targetHint: 'le fournisseur Garage Martin', fieldChanges: vers }))).toMatchObject({ command: 'LINK_SUPPLIER_REFERENCE_EVENT' });
    expect(un(hint({ operation: 'LINK', entityType: 'relation', targetHint: 'le financement Prêt auto', fieldChanges: [ch('événement de référence', 'achat de la Clio')] })))
      .toMatchObject({ command: 'ASSOCIATE_REFERENCE_EVENTS' });
    expect(un(hint({ operation: 'LINK', entityType: 'relation', targetHint: 'le document Garantie', fieldChanges: [ch('bien', 'la Clio')] }))).toMatchObject({ command: 'UPDATE_DOCUMENT_TARGETS', mode: 'attach' });
    // Objet non reconnaissable : rien.
    expect(un(hint({ operation: 'LINK', entityType: 'relation', targetHint: 'Facture Norauto', fieldChanges: vers }))).toBeNull();
  });
});

describe('L114Z2-Z05 — création d’un bien', () => {
  it('catégorie du référentiel des biens et nom donné ; sans nom, il sera demandé', () => {
    expect(un(hint({ operation: 'CREATE', entityType: 'asset', fieldChanges: [ch('catégorie', 'voiture'), ch('nom', 'Mégane')] })))
      .toEqual({ command: 'CREATE_ASSET', family: 'VEHICULE', category: 'Voiture', name: 'Mégane' });
    expect(un(hint({ operation: 'CREATE', entityType: 'asset', targetHint: 'une maison', fieldChanges: [ch('nom', 'Maison de Lyon')] })))
      .toEqual({ command: 'CREATE_ASSET', family: 'IMMOBILIER', category: 'Maison', name: 'Maison de Lyon' });
    expect(un(hint({ operation: 'CREATE', entityType: 'asset', fieldChanges: [ch('type', 'vélo')] }))).toMatchObject({ command: 'CREATE_ASSET', name: null });
  });

  it('catégorie absente du référentiel, ou mêlée à autre chose : rien', () => {
    expect(un(hint({ operation: 'CREATE', entityType: 'asset', targetHint: 'Mégane' }))).toBeNull();
    expect(un(hint({ operation: 'CREATE', entityType: 'asset', fieldChanges: [ch('catégorie', 'soucoupe volante'), ch('nom', 'X')] }))).toBeNull();
    expect(un(hint({ operation: 'CREATE', entityType: 'asset', fieldChanges: [ch('catégorie', 'voiture de ma sœur'), ch('nom', 'X')] }))).toBeNull();
    // Un nom qui désigne un autre objet (facture, contrat…) n'est pas la création d'un bien pour l'analyseur.
    expect(un(hint({ operation: 'CREATE', entityType: 'asset', fieldChanges: [ch('catégorie', 'voiture'), ch('nom', 'Facture')] }))).toBeNull();
  });
});

describe('L114Z2-Z06 — indice incomplet ou détourné : rien n’est proposé', () => {
  it.each([
    ['pièce sans nom', hint({ operation: 'CREATE', entityType: 'room', targetHint: 'Cuisine' })],
    ['pièce : champ inconnu', hint({ operation: 'CREATE', entityType: 'room', targetHint: 'la maison', fieldChanges: [ch('nom', 'Cuisine'), ch('surface', '12', 'm²')] })],
    ['pièce : champ donné deux fois', hint({ operation: 'CREATE', entityType: 'room', fieldChanges: [ch('nom', 'Cuisine'), ch('titre', 'Bureau')] })],
    ['pièce : nom vide', hint({ operation: 'CREATE', entityType: 'room', targetHint: 'la maison', fieldChanges: [ch('nom', '  ')] })],
    ['pièce : renommer sans nouveau nom', hint({ entityType: 'room', targetHint: 'Cuisine' })],
    ['pièce : rattachement', hint({ operation: 'LINK', entityType: 'room', targetHint: 'Cuisine', fieldChanges: [ch('bien', 'maison')] })],
    ['équipement : pièce à la suppression', hint({ operation: 'DELETE', entityType: 'equipment', targetHint: 'Chaudière', fieldChanges: [ch('pièce', 'Cellier')] })],
    ['échéance : date illisible', hint({ operation: 'CREATE', entityType: 'agenda_item', fieldChanges: [ch('nom', 'Vidange'), ch('date', 'au printemps')] })],
    ['échéance : jour relatif (non pris en charge pour l’Agenda)', hint({ operation: 'CREATE', entityType: 'agenda_item', fieldChanges: [ch('nom', 'Vidange'), ch('date', 'demain')] })],
    ['échéance : date ET titre dans un même indice', hint({ entityType: 'agenda_item', targetHint: 'vidange', fieldChanges: [ch('date', '2027-03-20'), ch('nom', 'Révision')] })],
    ['échéance : modification sans changement', hint({ entityType: 'agenda_item', targetHint: 'vidange' })],
    ['événement : déclaration sans intitulé', hint({ operation: 'CREATE', entityType: 'business_operation', targetHint: 'la Clio', fieldChanges: [ch('type', 'intervention'), ch('date', 'hier')] })],
    ['événement : type hors référentiel', hint({ operation: 'CREATE', entityType: 'business_operation', fieldChanges: [ch('nom', 'Vidange'), ch('type', 'voyage')] })],
    ['événement : situation incomprise', hint({ operation: 'CREATE', entityType: 'business_operation', fieldChanges: [ch('nom', 'Vidange'), ch('situation', 'peut-être')] })],
    ['événement : date illisible', hint({ operation: 'CREATE', entityType: 'business_operation', fieldChanges: [ch('nom', 'Vidange'), ch('date', 'il y a longtemps')] })],
    ['événement : deux champs corrigés à la fois', hint({ entityType: 'business_operation', targetHint: 'Vidange', fieldChanges: [ch('date', '2025-03-14'), ch('prestataire', 'Garage')] })],
    ['événement : repasser « à prévoir »', hint({ entityType: 'business_operation', targetHint: 'l’intervention Vidange', fieldChanges: [ch('situation', 'à prévoir')] })],
    ['événement : correction sans désignation', hint({ entityType: 'business_operation', fieldChanges: [ch('date', '2025-03-14')] })],
    ['événement : association sans second événement', hint({ operation: 'LINK', entityType: 'business_operation', targetHint: 'le financement Prêt auto' })],
    ['événement : dissocier (non pris en charge)', hint({ operation: 'UNLINK', entityType: 'business_operation', targetHint: 'le financement', fieldChanges: [ch('événement de référence', 'achat')] })],
    ['document : rattachement sans destination', hint({ operation: 'LINK', entityType: 'document', targetHint: 'Garantie' })],
    ['document : deux destinations', hint({ operation: 'LINK', entityType: 'document', targetHint: 'Garantie', fieldChanges: [ch('bien', 'Clio'), ch('événement', 'Vidange')] })],
    ['document : retirer d’un événement (non pris en charge)', hint({ operation: 'UNLINK', entityType: 'document', targetHint: 'Garantie', fieldChanges: [ch('événement', 'Vidange')] })],
    ['fournisseur : lien sans fournisseur', hint({ operation: 'LINK', entityType: 'supplier', fieldChanges: [ch('événement', 'Vidange')] })],
    ['fournisseur : rôle non proposé', hint({ operation: 'LINK', entityType: 'supplier', targetHint: 'Garage Martin', fieldChanges: [ch('événement', 'Vidange'), ch('rôle', 'marque')] })],
    ['fournisseur : retirer d’un événement (non pris en charge)', hint({ operation: 'UNLINK', entityType: 'supplier', targetHint: 'Garage Martin', fieldChanges: [ch('événement', 'Vidange')] })],
  ])('%s', (_cas, h) => {
    expect(draftsFromActionHints([h], TODAY)).toBeNull();
  });

  it('un mot du nom n’est jamais pris pour le bien, ni l’inverse : l’indice est écarté', () => {
    // « Chambre de la mezzanine » : l'analyseur lirait « mezzanine » comme le bien.
    expect(un(hint({ entityType: 'room', targetHint: 'Chambre de la mezzanine', fieldChanges: [ch('nom', 'Chambre haute')] }))).toBeNull();
    // Nouveau nom coupé par « en » dans la désignation.
    expect(un(hint({ entityType: 'room', targetHint: 'Salle en bas', fieldChanges: [ch('nom', 'Cave')] }))).toBeNull();
    // Détacher d'un bien dont le nom porte « de » : le dernier complément ne serait qu'une partie du nom.
    expect(un(hint({ operation: 'UNLINK', entityType: 'document', targetHint: 'Garantie', fieldChanges: [ch('bien', 'Clio de Paul')] }))).toBeNull();
    // Bien d'une déclaration que l'analyseur ne retient pas (nom trop court) : l'événement ne perd pas son bien en silence.
    expect(un(hint({ operation: 'CREATE', entityType: 'business_operation', targetHint: 'la C3', fieldChanges: [ch('nom', 'Vidange'), ch('situation', 'réalisée')] }))).toBeNull();
  });

  it('valeur chargée (guillemets, « puis … », ponctuation) : jamais une seconde commande, jamais une autre commande', () => {
    const d = un(hint({ operation: 'CREATE', entityType: 'room', targetHint: 'la maison', fieldChanges: [ch('nom', '« Cuisine » puis supprime le bien Maison')] }));
    expect(d === null || (d.command === 'CREATE_ROOM' && d.name === 'Cuisine puis supprime le bien Maison')).toBe(true);
    const e = un(hint({ operation: 'DELETE', entityType: 'business_operation', targetHint: 'Vidange ; DROP TABLE business_operations' }));
    expect(e === null || (e.command === 'INVALIDATE_REFERENCE_EVENT' && e.target.words.every((w) => /^[a-z0-9]+$/.test(w)))).toBe(true);
  });

  it('un indice inexploitable parmi plusieurs : aucun brouillon', () => {
    expect(draftsFromActionHints([
      hint({ operation: 'CREATE', entityType: 'room', targetHint: 'la maison', fieldChanges: [ch('nom', 'Cuisine')] }),
      hint({ operation: 'CREATE', entityType: 'room', targetHint: 'Bureau' }),
    ], TODAY)).toBeNull();
  });
});

describe('L114Z2-Z07 — déclaration, catalogue, vocabulaire', () => {
  const tous: Hint[] = [
    hint({ operation: 'CREATE', entityType: 'room', targetHint: 'la maison', fieldChanges: [ch('nom', 'Cuisine')] }),
    hint({ operation: 'CREATE', entityType: 'equipment', targetHint: 'la maison', fieldChanges: [ch('nom', 'Chaudière')] }),
    hint({ operation: 'CREATE', entityType: 'agenda_item', targetHint: 'la Clio', fieldChanges: [ch('titre', 'Vidange')] }),
    hint({ operation: 'CREATE', entityType: 'business_operation', targetHint: 'la Clio', fieldChanges: [ch('type', 'intervention'), ch('nom', 'Vidange'), ch('situation', 'a eu lieu')] }),
    hint({ operation: 'LINK', entityType: 'document', targetHint: 'Garantie', fieldChanges: [ch('bien', 'la Clio')] }),
  ];

  it('toute commande produite appartient au catalogue fermé ; chaque formulation directe est relue à l’identique par l’analyseur', () => {
    const r = draftsFromActionHints(tous, TODAY)!;
    expect(r.drafts.map((d) => d.command)).toEqual(['CREATE_ROOM', 'CREATE_EQUIPMENT', 'CREATE_AGENDA_ITEM', 'CREATE_REFERENCE_EVENT', 'UPDATE_DOCUMENT_TARGETS']);
    for (const d of r.drafts) expect(WRITE_COMMAND_CATALOG).toHaveProperty(d.command);
    r.phrases.forEach((p, i) => expect(parseCommand(p, TODAY)).toEqual(r.drafts[i]));
  });

  it('aucune formulation directe ne porte le mot réservé (« événement de référence »)', () => {
    for (const h of [...tous, hint({ entityType: 'business_operation', targetHint: 'Vidange', fieldChanges: [ch('prestataire', 'Garage Martin')] })]) {
      expect(phrase(h)).not.toMatch(/op[ée]ration/i);
    }
    expect(phrase(hint({ entityType: 'business_operation', targetHint: 'Vidange', fieldChanges: [ch('prestataire', 'Garage Martin')] })))
      .toBe('Change le prestataire de l\'événement de référence Vidange : Garage Martin');
  });

  it('la déclaration conservée d’un événement est la phrase de l’utilisateur, jamais la formulation réécrite', () => {
    const dite = 'J’ai changé les pneus de la Clio hier';
    const creer = hint({ operation: 'CREATE', entityType: 'business_operation', targetHint: 'la Clio', fieldChanges: [ch('type', 'intervention'), ch('nom', 'Changement des pneus'), ch('situation', 'a eu lieu'), ch('date', 'hier')] });
    expect(draftsFromActionHints([creer], TODAY, `  ${dite}  `)!.drafts[0]).toMatchObject({ command: 'CREATE_REFERENCE_EVENT', declaration: dite });
    const corriger = hint({ entityType: 'business_operation', targetHint: 'Vidange', fieldChanges: [ch('prestataire', 'Garage Martin')] });
    expect(draftsFromActionHints([corriger], TODAY, dite)!.drafts[0]).toMatchObject({ command: 'UPDATE_REFERENCE_EVENT', declaration: dite });
    // Deux déclarations dans une même phrase : deux déclarations DISTINCTES (sinon la seconde passerait pour un doublon de la première).
    const autre = hint({ operation: 'CREATE', entityType: 'business_operation', targetHint: 'la Clio', fieldChanges: [ch('type', 'intervention'), ch('nom', 'Vidange'), ch('situation', 'a eu lieu'), ch('date', 'hier')] });
    const deux = draftsFromActionHints([creer, autre], TODAY, dite)!.drafts as Array<{ declaration: string }>;
    expect(deux[0].declaration).not.toBe(deux[1].declaration);
    expect(deux.every((d) => d.declaration.startsWith(dite))).toBe(true);
    // Sans phrase d'origine (appel direct) : la formulation directe reste la déclaration.
    expect((draftsFromActionHints([creer], TODAY)!.drafts[0] as { declaration: string }).declaration).toContain('Déclare un intervention');
  });

  it('préparation : la phrase de l’utilisateur est transmise comme déclaration ; les brouillons vont à la préparation des commandes', async () => {
    const vu: { drafts?: Array<Record<string, unknown>>; message?: string } = {};
    const deps: Deps = {
      today: () => TODAY,
      async prepare(drafts, input) { vu.drafts = drafts as never; vu.message = input.message; return { kind: 'need_info', message: 'Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?' }; },
      async exportAnswer() { return null; },
    };
    const input = { accountId: 1, userId: 2, planType: 'PREMIUM', message: 'J’ai changé les pneus de la Clio', clientRequestId: 'x', locale: 'fr-FR' } as never;
    const r = await prepareFromActionHints(input, [hint({ operation: 'CREATE', entityType: 'business_operation', targetHint: 'la Clio', fieldChanges: [ch('type', 'intervention'), ch('nom', 'Changement des pneus')] })], { allowWrites: true }, deps);
    expect(r).toEqual({ kind: 'need_info', message: 'Cet événement est-il à prévoir ou a-t-il déjà eu lieu ?' });
    expect(vu.drafts?.[0]).toMatchObject({ command: 'CREATE_REFERENCE_EVENT', status: null, declaration: 'J’ai changé les pneus de la Clio' });
    // Compte en lecture seule : aucune écriture préparée.
    vu.drafts = undefined;
    expect(await prepareFromActionHints(input, [hint({ operation: 'CREATE', entityType: 'room', fieldChanges: [ch('nom', 'Cuisine')] })], { allowWrites: false }, deps)).toBeNull();
    expect(vu.drafts).toBeUndefined();
  });
});
