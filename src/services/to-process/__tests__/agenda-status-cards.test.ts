/**
 * Cartes « À traiter » de statut (CDC 15 T4-12, D-15 ; lot 14 volet B) :
 * règles, propositions, liste blanche des écrivains.
 */
import { describe, it, expect } from 'vitest';
import {
  agendaStatusProposals, agendaStatusTriggerContext, assetStatusProposals, ASSET_STATUS_BY_EVENT,
  AGENDA_STATUS_WRITER, ASSET_STATUS_WRITER, USER_SETTABLE_ASSET_STATUSES,
} from '../agenda-status-cards';
import { findFieldWriter, isResolvableFromCard } from '../resolve-action.service';
import { checkRulesCatalog, getRule } from '../rules-catalog';
import { isDisplayableArbitration } from '../action-model';

describe('catalogue', () => {
  it('AGENDA-DONE, AGENDA-NOT-DONE (élément d’agenda) et ASSET-STATUS (bien) : arbitrages, « Non applicable » permis', () => {
    expect(checkRulesCatalog()).toEqual([]);
    for (const code of ['AGENDA-DONE', 'AGENDA-NOT-DONE']) {
      expect(getRule(code)).toMatchObject({ targetType: 'AGENDA_ITEM', fieldKey: 'manualStatus', completePriority: null, allowNotApplicable: true });
    }
    expect(getRule('ASSET-STATUS')).toMatchObject({ targetType: 'ASSET', fieldKey: 'status', completePriority: null });
  });
  it('résolubles depuis la carte (liste blanche)', () => {
    expect(isResolvableFromCard('AGENDA_ITEM', 'manualStatus')).toBe(true);
    expect(isResolvableFromCard('ASSET', 'status')).toBe(true);
    expect(findFieldWriter('ASSET', 'status')).toBe(ASSET_STATUS_WRITER);
    expect(findFieldWriter('AGENDA_ITEM', 'manualStatus')).toBe(AGENDA_STATUS_WRITER);
  });
});

describe('statut d’une échéance', () => {
  it('propose_done : « réalisé » ou « pas encore » ; propose_not_done : « annulé » ou « reste à faire »', () => {
    const done = agendaStatusProposals('propose_done', 5);
    expect(done.map((p) => p.value)).toEqual(['realise', null]);
    expect(done[0].evidenceIds).toEqual(['file:5']);
    expect(agendaStatusProposals('propose_not_done', null).map((p) => p.value)).toEqual(['annule', null]);
    expect(isDisplayableArbitration(done)).toBe(true);
  });
  it('empreinte : élément + verdict + preuve (idempotence, §7.4)', () => {
    expect(agendaStatusTriggerContext(1, 'propose_done', 5)).toEqual({ itemId: 1, decision: 'propose_done', sourceFileId: 5 });
  });
  it('écrivain : seules les valeurs du statut, « aucun » compris ; valeur absente refusée', () => {
    expect(AGENDA_STATUS_WRITER.validate('realise')).toBe(true);
    expect(AGENDA_STATUS_WRITER.validate('annule')).toBe(true);
    expect(AGENDA_STATUS_WRITER.validate(null)).toBe(true);
    expect(AGENDA_STATUS_WRITER.validate(undefined)).toBe(false);
    expect(AGENDA_STATUS_WRITER.validate('not_completed')).toBe(false);
    expect(AGENDA_STATUS_WRITER.nullable).toBe(true);
  });
});

describe('D-15 — statut du bien', () => {
  // Contrainte en vigueur (migration 0121) et contrainte élargie aux valeurs de l'interface.
  const base0121 = new Set(['EN_SERVICE', 'EN_MAINTENANCE', 'HORS_SERVICE', 'ARCHIVED', 'TRANSMIS']);
  const elargie = new Set([...USER_SETTABLE_ASSET_STATUSES, 'ARCHIVED']);

  it('correspondance selon les valeurs ADMISES : 0121 → TRANSMIS ; HORS_SERVICE / EN_MAINTENANCE', () => {
    expect(assetStatusProposals('sale', 'EN_SERVICE', 'Vente', base0121).map((x) => x.value)).toEqual(['TRANSMIS', 'EN_SERVICE']);
    expect(assetStatusProposals('claim', 'EN_SERVICE', 'Sinistre', base0121).map((x) => x.value)).toEqual(['HORS_SERVICE', 'EN_MAINTENANCE', 'EN_SERVICE']);
  });
  it('contrainte élargie : VENDU / TRANSMIS ; DETRUIT / EN_REPARATION', () => {
    const p = assetStatusProposals('sale', 'EN_SERVICE', 'Vente (2027-01-01)', elargie);
    expect(p.map((x) => x.value)).toEqual(['VENDU', 'TRANSMIS', 'EN_SERVICE']);
    expect(p[2].isCurrentValue).toBe(true);
    expect(assetStatusProposals('claim', 'EN_SERVICE', 'x', elargie).map((x) => x.value)).toEqual(['DETRUIT', 'EN_REPARATION', 'EN_SERVICE']);
    for (const s of [...ASSET_STATUS_BY_EVENT.sale, ...ASSET_STATUS_BY_EVENT.claim]) expect(USER_SETTABLE_ASSET_STATUSES).toContain(s.value);
  });
  it('rien si déjà appliqué, type sans effet, ou aucune valeur admise', () => {
    expect(assetStatusProposals('sale', 'TRANSMIS', 'x', base0121)).toEqual([]);
    expect(assetStatusProposals('purchase', 'EN_SERVICE', 'x', elargie)).toEqual([]);
    expect(assetStatusProposals('sale', 'EN_SERVICE', 'x', new Set(['EN_SERVICE']))).toEqual([]);
  });
  it('écrivain : jamais ARCHIVED ni valeur forgée ; contrôle en base (compte, verrou, contrainte)', () => {
    expect(ASSET_STATUS_WRITER.validate('TRANSMIS')).toBe(true);
    expect(ASSET_STATUS_WRITER.validate('ARCHIVED')).toBe(false);
    expect(ASSET_STATUS_WRITER.validate('ROOT')).toBe(false);
    expect(ASSET_STATUS_WRITER.validate(null)).toBe(false);
    expect(typeof ASSET_STATUS_WRITER.check).toBe('function');
  });
});

describe('T4-04 — échéance d’une source non autoritaire (AGENDA-PROPOSAL)', () => {
  it('règle dédiée : relation par échéance de la source, « Non » = Non applicable', async () => {
    expect(getRule('AGENDA-PROPOSAL')).toMatchObject({ targetType: 'DOCUMENT', relationKey: 'agenda', completePriority: null, allowNotApplicable: true });
    const { AGENDA_PROPOSAL_REASONS } = await import('../agenda-proposal-cards');
    expect([...AGENDA_PROPOSAL_REASONS].sort()).toEqual(['SOURCE_TYPE_NOT_AUTHORIZED', 'SOURCE_TYPE_UNKNOWN', 'TEMPORAL_AMBIGUITY']);
  });
  it('relation : clé fonctionnelle, sinon empreinte stable (titre normalisé, champ, date)', async () => {
    const { agendaProposalRelation } = await import('../agenda-proposal-cards');
    const c = { title: 'Remplacement chaudière', date: '2027-05-12', originFieldKey: null };
    expect(agendaProposalRelation('abc', c)).toBe('agenda:abc');
    expect(agendaProposalRelation(null, c)).toBe(agendaProposalRelation(null, { ...c, title: 'remplacement  CHAUDIÈRE' }));
    expect(agendaProposalRelation(null, c)).not.toBe(agendaProposalRelation(null, { ...c, date: '2027-06-01' }));
  });
});

describe('relecture lot 14 — effets après validation', () => {
  it('l’écrivain de statut renvoie D-13 / D-15 après validation, seulement pour « réalisé »', async () => {
    expect(typeof AGENDA_STATUS_WRITER.afterCommit).toBe('function');
    // « annulé » / « aucun » : aucun effet (ne charge rien, ne lève pas).
    await expect(AGENDA_STATUS_WRITER.afterCommit!({ accountId: 1, targetId: 2, value: 'annule', previousValue: null, userId: null })).resolves.toBeUndefined();
    await expect(AGENDA_STATUS_WRITER.afterCommit!({ accountId: 1, targetId: 2, value: null, previousValue: 'realise', userId: null })).resolves.toBeUndefined();
  });
});
