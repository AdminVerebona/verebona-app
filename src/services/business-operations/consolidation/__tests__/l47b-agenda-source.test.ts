/**
 * Lot 47B — point 1 : l'Agenda comme source T3 (règles pures). CDC
 * Opérations V1 ch. 3.1, 3.2, 17, C2, C4 TRG-012 à TRG-014, C5, C7.2, C8,
 * C16.1, C16.2, C19 ; recette F-020 à F-022, F-085 à F-087.
 */
import { describe, expect, it } from 'vitest';
import {
  agendaContribution, agendaEstablishesIntervention, agendaIdentity, agendaItemMayEstablishOperation, agendaItemStatus,
  applyAgendaAuthority, isUserAuthoredAgendaItem, matchAgendaItem, sameIntervention,
  type AgendaMatchOperation, type AgendaSourceItem,
} from '../agenda-source';
import { consolidateOperationState, type CandidateIdentity, type SourceContribution } from '../model';
import { decideCandidate, isPlausible, type ExistingOperation } from '../matching';
import { agendaChangeTriggersT3 } from '../../agenda-projection/model';

const TODAY = '2026-10-12';

function item(over: Partial<AgendaSourceItem> = {}): AgendaSourceItem {
  return {
    id: 10, accountId: 1, title: 'Remplacement chaudière', description: null, date: '2026-11-20', endDate: null, manualStatus: null,
    isAutomatic: false, isAutomaticModified: false, projected: false, statusByUser: false, businessOperationId: null,
    nature: null, businessType: null, assetIds: [5], equipmentIds: [], fileIds: [], ...over,
  };
}

function op(over: Partial<AgendaMatchOperation> = {}): AgendaMatchOperation {
  return {
    id: 100, status: 'ENVISAGED', plannedDate: '2026-11-20', realizedDate: null, technicalLabel: 'Remplacement chaudière',
    assetIds: [5], documentFileIds: [], hasOtherUserItem: false, ...over,
  };
}

describe('F-020 / F-021 / F-022 — création depuis un élément saisi (C5, règles fermées)', () => {
  it('F-020 — rappel « penser à vérifier chaudière » : aucune Opération', () => {
    expect(agendaEstablishesIntervention(item({ title: 'Penser à vérifier chaudière' }))).toEqual({ kind: 'NONE', reason: 'REMINDER' });
    // Même avec un mot d'intervention : un rappel reste un rappel (3.2).
    expect(agendaEstablishesIntervention(item({ title: 'Penser au ramonage' }))).toEqual({ kind: 'NONE', reason: 'REMINDER' });
    expect(agendaEstablishesIntervention(item({ title: 'Ramonage ?' }))).toEqual({ kind: 'NONE', reason: 'REMINDER' });
    expect(agendaEstablishesIntervention(item({ title: 'Demander un devis pour la toiture' }))).toEqual({ kind: 'NONE', reason: 'REMINDER' });
  });

  it('F-021 — « remplacement chaudière prévu le 20/11 » : INTERVENTION ENVISAGED', () => {
    expect(agendaEstablishesIntervention(item({ title: 'Remplacement chaudière prévu le 20/11' }))).toEqual({ kind: 'INTERVENTION', status: 'ENVISAGED' });
    // Une date passée seule ne prouve pas la réalisation (ch. 17).
    expect(agendaEstablishesIntervention(item({ title: 'Ramonage', date: '2026-01-10' }))).toEqual({ kind: 'INTERVENTION', status: 'ENVISAGED' });
  });

  it('F-022 — « vidange faite aujourd\'hui » : INTERVENTION REALIZED ; « réalisé » posé : REALIZED', () => {
    expect(agendaEstablishesIntervention(item({ title: 'Vidange faite aujourd’hui', date: TODAY }))).toEqual({ kind: 'INTERVENTION', status: 'REALIZED' });
    expect(agendaEstablishesIntervention(item({ title: 'Révision', manualStatus: 'realise', date: '2026-10-01' }))).toEqual({ kind: 'INTERVENTION', status: 'REALIZED' });
  });

  it('échéance pure, élément sans date, sans bien, annulé, automatique, non-intervention : jamais de création', () => {
    expect(agendaEstablishesIntervention(item({ title: 'Contrôle technique avant le 12/05' }))).toEqual({ kind: 'NONE', reason: 'DEADLINE' });
    expect(agendaEstablishesIntervention(item({ title: 'Fin de garantie lave-linge' }))).toEqual({ kind: 'NONE', reason: 'DEADLINE' });
    expect(agendaEstablishesIntervention(item({ date: null }))).toEqual({ kind: 'NONE', reason: 'NO_DATE' });
    expect(agendaEstablishesIntervention(item({ assetIds: [] }))).toEqual({ kind: 'NONE', reason: 'NO_ASSET' });
    expect(agendaEstablishesIntervention(item({ manualStatus: 'annule' }))).toEqual({ kind: 'NONE', reason: 'CANCELLED' });
    expect(agendaEstablishesIntervention(item({ isAutomatic: true, isAutomaticModified: true }))).toEqual({ kind: 'NONE', reason: 'NOT_USER_ENTERED' });
    expect(agendaEstablishesIntervention(item({ title: 'Anniversaire de Paul' }))).toEqual({ kind: 'NONE', reason: 'NOT_AN_INTERVENTION' });
    expect(agendaEstablishesIntervention(item({ title: 'Achat Clio' }))).toEqual({ kind: 'NONE', reason: 'NOT_AN_INTERVENTION' });
  });

  it('pré-filtre du déclencheur (TRG-012) : mêmes règles, sans base', () => {
    const base = { isAutomatic: false, title: 'Ramonage', startDate: '2026-11-02', manualStatus: null, assetCount: 1 };
    expect(agendaItemMayEstablishOperation(base)).toBe(true);
    expect(agendaItemMayEstablishOperation({ ...base, title: 'Penser à appeler le ramoneur' })).toBe(false);
    expect(agendaItemMayEstablishOperation({ ...base, assetCount: 0 })).toBe(false);
    expect(agendaItemMayEstablishOperation({ ...base, isAutomatic: true })).toBe(false);
    expect(agendaItemMayEstablishOperation({ ...base, startDate: null })).toBe(false);
  });
});

describe('C2 / C16.2 — garde anti-blanchiment (projection, T4 intacts : jamais source)', () => {
  it('O7b-01 — saisi à la main : utilisateur ; projection / T4 intacts : non ; modifiés : oui', () => {
    expect(isUserAuthoredAgendaItem(item())).toBe(true);
    expect(isUserAuthoredAgendaItem(item({ isAutomatic: true, projected: true }))).toBe(false);
    expect(isUserAuthoredAgendaItem(item({ isAutomatic: true }))).toBe(false);
    expect(isUserAuthoredAgendaItem(item({ isAutomatic: true, projected: true, isAutomaticModified: true }))).toBe(true);
  });

  it('O7b-02 — statut posé par le SYSTÈME (STATUS_AUTO_COMPLETED) ne blanchit pas ; posé par l\'utilisateur : oui', () => {
    expect(isUserAuthoredAgendaItem(item({ isAutomatic: true, manualStatus: 'realise', statusByUser: false }))).toBe(false);
    expect(isUserAuthoredAgendaItem(item({ isAutomatic: true, manualStatus: 'realise', statusByUser: true }))).toBe(true);
  });

  it('O7b-03 — contribution : projection intacte retirée, élément délié retiré, type non intervention retiré', () => {
    const p = { operationId: 7, operationType: 'INTERVENTION', otherSupport: true, today: TODAY };
    expect(agendaContribution(item({ businessOperationId: 7, isAutomatic: true, projected: true }), p)).toEqual({ kind: 'WITHDRAWN', reason: 'NOT_USER_AUTHORED' });
    expect(agendaContribution(item({ businessOperationId: 8 }), p)).toEqual({ kind: 'WITHDRAWN', reason: 'UNLINKED' });
    expect(agendaContribution(item({ businessOperationId: 7 }), { ...p, operationType: 'ACQUISITION' })).toEqual({ kind: 'WITHDRAWN', reason: 'TYPE_NOT_SUPPORTED' });
    expect(agendaContribution(null, p)).toEqual({ kind: 'WITHDRAWN', reason: 'ITEM_GONE' });
  });
});

describe('C8 / TRG-014 / F-087 — statut réalisé / annulé posé par l\'utilisateur', () => {
  const p = { operationId: 7, operationType: 'INTERVENTION', otherSupport: false, today: TODAY };

  it('O7b-04 — « réalisé » → REALIZED ; « annulé » sans autre preuve → CANCELLED', () => {
    const r = agendaContribution(item({ businessOperationId: 7, manualStatus: 'realise', date: '2026-10-01' }), p);
    expect(r).toMatchObject({ kind: 'CONTRIBUTES', status: 'REALIZED' });
    const a = agendaContribution(item({ businessOperationId: 7, manualStatus: 'annule' }), p);
    expect(a).toMatchObject({ kind: 'CONTRIBUTES', status: 'CANCELLED' });
  });

  it('F-087 / TRG-014 — « annulé » à côté d\'autres preuves : la source est retirée, jamais une annulation métier', () => {
    expect(agendaContribution(item({ businessOperationId: 7, manualStatus: 'annule', isAutomatic: true, projected: true, statusByUser: true }), { ...p, otherSupport: true }))
      .toEqual({ kind: 'WITHDRAWN', reason: 'CANCELLED_OTHER_PROOF' });
  });

  it('O7b-05 — état consolidé : réalisé (date prévue conservée, C8), annulé, rouvert', () => {
    const contrib = (over: Partial<AgendaSourceItem>, id = 1): SourceContribution => {
      const i = item({ businessOperationId: 7, ...over });
      return { sourceId: id, identity: agendaIdentity(i, agendaItemStatus(i), TODAY) };
    };
    const fait = [contrib({ manualStatus: 'realise', date: '2026-10-01' })];
    const s = applyAgendaAuthority(consolidateOperationState('INTERVENTION', fait, TODAY), fait);
    expect(s).toMatchObject({ status: 'REALIZED', plannedDate: '2026-10-01', realizedDate: '2026-10-01' });
    const annule = [contrib({ manualStatus: 'annule' })];
    expect(consolidateOperationState('INTERVENTION', annule, TODAY).status).toBe('CANCELLED');
    const ouvert = [contrib({})];
    expect(consolidateOperationState('INTERVENTION', ouvert, TODAY).status).toBe('ENVISAGED');
    // Réalisé à une date future : aucune date de réalisation inventée (C16.1).
    const futur = [contrib({ manualStatus: 'realise', date: '2026-12-01' })];
    expect(applyAgendaAuthority(consolidateOperationState('INTERVENTION', futur, TODAY), futur).realizedDate).toBeNull();
  });
});

describe('C19 — la correction Agenda de l\'utilisateur prime pour la date qu\'elle porte', () => {
  const doc = (planned: string | null, realized: string | null, status: 'ENVISAGED' | 'REALIZED'): SourceContribution => ({
    sourceId: 1,
    identity: {
      candidateId: 1, candidateKey: 'k', fileId: 3, established: true, confidence: 'certain', type: 'INTERVENTION', status, role: status === 'REALIZED' ? 'INVOICE' : 'QUOTE',
      summary: 'Devis', provider: 'Chauffage SA', providerKey: 'chauffage', assetIds: [5], targetAuthority: 'INFERENCE', equipmentIds: [], refs: [],
      dates: { plannedDate: planned, startDate: null, realizedDate: realized, endDate: null }, hints: [],
    } as CandidateIdentity,
  });
  const ag = (i: AgendaSourceItem, id = 2): SourceContribution => ({ sourceId: id, identity: agendaIdentity(i, agendaItemStatus(i), TODAY) });

  it('O7b-06 — date prévue corrigée sur l\'événement projeté : la date de l\'utilisateur l\'emporte sur le devis', () => {
    const sources = [doc('2026-11-20', null, 'ENVISAGED'), ag(item({ date: '2026-11-25', isAutomatic: true, projected: true, isAutomaticModified: true }))];
    expect(applyAgendaAuthority(consolidateOperationState('INTERVENTION', sources, TODAY), sources).plannedDate).toBe('2026-11-25');
  });

  it('O7b-07 — échéance marquée « réalisé » : la date de la facture prime ; un fait historique corrigé prime sur la facture', () => {
    const facture = doc(null, '2026-03-10', 'REALIZED');
    const echeance = ag(item({ date: '2026-03-12', manualStatus: 'realise', isAutomatic: true, statusByUser: true }));
    let sources = [facture, echeance];
    expect(applyAgendaAuthority(consolidateOperationState('INTERVENTION', sources, TODAY), sources).realizedDate).toBe('2026-03-10');
    const historique = ag(item({ date: '2026-03-09', nature: 'HISTORICAL', isAutomatic: true, projected: true, isAutomaticModified: true }));
    sources = [facture, historique];
    expect(applyAgendaAuthority(consolidateOperationState('INTERVENTION', sources, TODAY), sources).realizedDate).toBe('2026-03-09');
  });

  it('O7b-08 — les biens de l\'élément ne reciblent pas une Opération prouvée par un document', () => {
    const sources = [doc('2026-11-20', null, 'ENVISAGED'), ag(item({ assetIds: [9], isAutomaticModified: true, isAutomatic: true }))];
    const s = applyAgendaAuthority(consolidateOperationState('INTERVENTION', sources, TODAY), sources);
    expect(s.assets.map((a) => a.assetId)).toEqual([5]);
    // Preuve non gérée par T3 (saisie, migration) : l'élément ne pose aucune cible.
    const seul = [ag(item({ assetIds: [9], isAutomaticModified: true, isAutomatic: true }))];
    expect(applyAgendaAuthority(consolidateOperationState('INTERVENTION', seul, TODAY), seul, true).assets).toEqual([]);
    expect(applyAgendaAuthority(consolidateOperationState('INTERVENTION', seul, TODAY), seul).assets.map((a) => a.assetId)).toEqual([9]);
  });
});

describe('C16.1 / C7.2 — rapprochement d\'un élément non relié (jamais de doublon)', () => {
  it('O7b-09 — même bien, même intervention, date à ±3 j : rattaché à l\'Opération existante', () => {
    expect(matchAgendaItem(item({ date: '2026-11-21' }), 'ENVISAGED', [op()])).toMatchObject({ kind: 'MATCH', operationId: 100 });
  });

  it('O7b-10 — même document lié : certain, même à une autre date', () => {
    expect(matchAgendaItem(item({ title: 'RDV artisan', date: '2026-12-10', fileIds: [3] }), 'ENVISAGED', [op({ documentFileIds: [3] })]))
      .toMatchObject({ kind: 'MATCH', operationId: 100 });
  });

  it('O7b-11 — intervention d\'une autre nature, même bien, même semaine : distincte (aucun rattachement)', () => {
    expect(matchAgendaItem(item({ title: 'Ramonage' }), 'ENVISAGED', [op()])).toEqual({ kind: 'NONE' });
    expect(sameIntervention('Ramonage', 'Remplacement chaudière')).toBe('distinct');
    expect(sameIntervention('Révision chaudière', 'Remplacement chaudière')).toBe('same');
  });

  it('O7b-12 — plausible (acte inconnu, date proche au-delà de la tolérance, deux candidates) : HOLD, ni lien ni création', () => {
    expect(matchAgendaItem(item({ title: 'Travaux' }), 'ENVISAGED', [op({ technicalLabel: null })])).toMatchObject({ kind: 'HOLD' });
    expect(matchAgendaItem(item({ date: '2026-11-25' }), 'ENVISAGED', [op()])).toMatchObject({ kind: 'HOLD' });
    expect(matchAgendaItem(item(), 'ENVISAGED', [op(), op({ id: 101 })])).toMatchObject({ kind: 'HOLD', reason: 'AGENDA_SEVERAL_OPERATIONS' });
    expect(matchAgendaItem(item(), 'ENVISAGED', [op({ hasOtherUserItem: true })])).toMatchObject({ kind: 'HOLD' });
  });

  it('O7b-13 — planifié ↔ réalisé : tolérance de 7 j ; Opération annulée : jamais rapprochée', () => {
    expect(matchAgendaItem(item({ date: '2026-11-26', manualStatus: 'realise' }), 'REALIZED', [op()])).toMatchObject({ kind: 'MATCH' });
    expect(matchAgendaItem(item(), 'ENVISAGED', [op({ status: 'CANCELLED' })])).toEqual({ kind: 'NONE' });
  });

  it('O7b-14 — machine C5 commune : aucune Opération plausible → CREATE_NEW (« AGENDA action métier explicite »)', () => {
    const identity = agendaIdentity(item(), 'ENVISAGED', TODAY);
    expect(decideCandidate(identity, { operations: [], confirmed: new Set(), rejected: new Set(), assetStatus: new Map() }))
      .toMatchObject({ outcome: 'CREATE_NEW' });
    // Bien vendu : hors périmètre (aucune création).
    expect(decideCandidate(identity, { operations: [], confirmed: new Set(), rejected: new Set(), assetStatus: new Map([[5, 'VENDU']]) }))
      .toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'TARGET_OUT_OF_PORTFOLIO' });
  });

  it('O7b-15 — facture d\'un bien dont l\'intervention vient de l\'agenda seul : PLAUSIBLE (M3), jamais un doublon ; entre deux éléments : non', () => {
    const agendaOp: ExistingOperation = {
      id: 100, typeCode: 'INTERVENTION', status: 'ENVISAGED', providerKey: null, assetIds: [5], refs: [],
      plannedDate: '2026-11-20', startDate: null, realizedDate: null, endDate: null, agendaOnly: true,
    };
    const facture = {
      ...agendaIdentity(item(), 'REALIZED', TODAY), agenda: undefined, candidateKey: 'c1', fileId: 3, provider: 'Chauffage SA', providerKey: 'chauffage',
      role: 'INVOICE' as const, dates: { plannedDate: null, startDate: null, realizedDate: '2026-11-22', endDate: null },
    };
    expect(isPlausible(facture, agendaOp)).toBe(true);
    expect(decideCandidate(facture, { operations: [agendaOp], confirmed: new Set(), rejected: new Set(), assetStatus: new Map() }))
      .toMatchObject({ outcome: 'HOLD_UNRESOLVED', reason: 'M3_REQUIRED' });
    expect(isPlausible(agendaIdentity(item({ title: 'Vidange' }), 'ENVISAGED', TODAY), agendaOp)).toBe(false);
  });
});

describe('C16.2 — anti-boucle du déclencheur Agenda', () => {
  it('C16-20 — écriture de projection : jamais T3 ; geste utilisateur sur un élément relié : T3 ; non relié : seulement candidat', () => {
    expect(agendaChangeTriggersT3({ businessOperationId: 7, fromProjection: true, userFieldsChanged: true })).toBe(false);
    expect(agendaChangeTriggersT3({ businessOperationId: 7, fromProjection: false, userFieldsChanged: true })).toBe(true);
    expect(agendaChangeTriggersT3({ businessOperationId: null, fromProjection: false, userFieldsChanged: true })).toBe(false);
    expect(agendaChangeTriggersT3({ businessOperationId: null, fromProjection: false, userFieldsChanged: true, candidate: true })).toBe(true);
    expect(agendaChangeTriggersT3({ businessOperationId: null, fromProjection: true, userFieldsChanged: true, candidate: true })).toBe(false);
    expect(agendaChangeTriggersT3({ businessOperationId: 7, fromProjection: false, userFieldsChanged: false })).toBe(false);
  });
});
