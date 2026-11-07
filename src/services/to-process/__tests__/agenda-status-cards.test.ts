/**
 * Cartes « À traiter » de statut du BIEN (CDC 15 D-15 ; lot 14 volet B) :
 * règles, propositions, liste blanche des écrivains.
 *
 * #715 (lot 113P) : plus de statut d'événement — les cas AGENDA-DONE /
 * AGENDA-NOT-DONE (« réalisée ? ») sont remplacés par leur ABSENCE (catalogue,
 * liste blanche) ; le bloc « statut d'une échéance » et l'effet d'après
 * validation de l'écrivain de statut sont retirés.
 */
import { describe, it, expect } from 'vitest';
import {
  assetStatusProposals, ASSET_STATUS_BY_EVENT, ASSET_STATUS_WRITER, USER_SETTABLE_ASSET_STATUSES,
} from '../agenda-status-cards';
import { findFieldWriter, isResolvableFromCard } from '../resolve-action.service';
import { checkRulesCatalog, getRule } from '../rules-catalog';

describe('catalogue', () => {
  it('#715 : plus d’AGENDA-DONE / AGENDA-NOT-DONE ; ASSET-STATUS (bien) : arbitrage, « Non applicable » permis', () => {
    expect(checkRulesCatalog()).toEqual([]);
    for (const code of ['AGENDA-DONE', 'AGENDA-NOT-DONE']) expect(getRule(code)).toBeUndefined();
    expect(getRule('ASSET-STATUS')).toMatchObject({ targetType: 'ASSET', fieldKey: 'status', completePriority: null });
  });
  it('résolubles depuis la carte (liste blanche)', () => {
    expect(isResolvableFromCard('AGENDA_ITEM', 'manualStatus')).toBe(false);
    expect(isResolvableFromCard('ASSET', 'status')).toBe(true);
    expect(findFieldWriter('ASSET', 'status')).toBe(ASSET_STATUS_WRITER);
    expect(findFieldWriter('AGENDA_ITEM', 'manualStatus')).toBeFalsy();
  });
});

describe('D-15 — statut du bien', () => {
  // Lot 32 (PO-Q11) : contrainte officielle (migration 0278) et ancienne contrainte 0121.
  const officielle = new Set(['EN_SERVICE', 'VENDU', 'TRANSMIS', 'ARCHIVED']);
  const base0121 = new Set(['EN_SERVICE', 'EN_MAINTENANCE', 'HORS_SERVICE', 'ARCHIVED', 'TRANSMIS']);

  it('PO-Q11 — vente : VENDU puis TRANSMIS (liste officielle) ; base non migrée : TRANSMIS seul', () => {
    const p = assetStatusProposals('sale', 'EN_SERVICE', 'Vente (2027-01-01)', officielle);
    expect(p.map((x) => x.value)).toEqual(['VENDU', 'TRANSMIS', 'EN_SERVICE']);
    expect(p[2].isCurrentValue).toBe(true);
    expect(assetStatusProposals('sale', 'EN_SERVICE', 'Vente', base0121).map((x) => x.value)).toEqual(['TRANSMIS', 'EN_SERVICE']);
    for (const s of ASSET_STATUS_BY_EVENT.sale) expect(USER_SETTABLE_ASSET_STATUSES).toContain(s.value);
  });
  it('PO-Q11 — sinistre : plus aucune carte (ni « en réparation » ni « détruit » dans la liste officielle)', () => {
    expect(ASSET_STATUS_BY_EVENT.claim).toBeUndefined();
    expect(assetStatusProposals('claim', 'EN_SERVICE', 'Sinistre', officielle)).toEqual([]);
    expect([...USER_SETTABLE_ASSET_STATUSES]).toEqual(['EN_SERVICE', 'VENDU', 'TRANSMIS']);
  });
  it('rien si déjà appliqué, type sans effet, ou aucune valeur admise', () => {
    expect(assetStatusProposals('sale', 'TRANSMIS', 'x', base0121)).toEqual([]);
    expect(assetStatusProposals('purchase', 'EN_SERVICE', 'x', officielle)).toEqual([]);
    expect(assetStatusProposals('sale', 'EN_SERVICE', 'x', new Set(['EN_SERVICE']))).toEqual([]);
  });
  it('écrivain : jamais ARCHIVED ni valeur forgée ; contrôle en base (compte, verrou, contrainte)', () => {
    expect(ASSET_STATUS_WRITER.validate('TRANSMIS')).toBe(true);
    expect(ASSET_STATUS_WRITER.validate('VENDU')).toBe(true);
    expect(ASSET_STATUS_WRITER.validate('EN_PANNE')).toBe(false);
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
