/**
 * Reprise des actions V1 → V2 — CDC V2.0 §15.3, P-06, ATP-05.
 *
 * Trois des quatre lignes du §15.3 portent une condition. Une reprise
 * nominale produirait des cartes « À arbitrer » sans rien à arbitrer, que
 * l'utilisateur ne pourrait ni résoudre ni faire disparaître.
 */
import { describe, it, expect } from 'vitest';
import { mapLegacyItem, type LegacyItem } from '@/services/to-process/legacy-migration.service';

const item = (overrides: Partial<LegacyItem> = {}): LegacyItem => ({
  family: 'arbitrate',
  status: 'active',
  objectType: 'document',
  objectId: 7,
  fieldKey: 'rubricCode',
  proposals: [{ value: 'MAINTENANCE_WORKS', label: 'Entretien et travaux' }],
  ...overrides,
});

describe('« mis de côté » disparaît (§15.3)', () => {
  it('n’est jamais repris', () => {
    const result = mapLegacyItem(item({ status: 'snoozed' }));
    expect(result).toEqual({ skipped: 'SNOOZED_DROPPED' });
  });
});

describe('quatre familles vers deux natures (§15.3)', () => {
  it('« à arbitrer » avec proposition devient un arbitrage', () => {
    const result = mapLegacyItem(item({ family: 'arbitrate' }));
    expect('intent' in result && result.intent.actionKind).toBe('ARBITRATE');
  });

  it('« à confirmer » devient un arbitrage : toute proposition à choisir en est un', () => {
    const result = mapLegacyItem(item({ family: 'confirm' }));
    expect('intent' in result && result.intent.actionKind).toBe('ARBITRATE');
  });

  it('« à rattacher » avec cible devient un arbitrage', () => {
    const result = mapLegacyItem(
      item({ family: 'attach', fieldKey: null, proposals: [{ value: 42, label: 'Maison' }] }),
    );
    expect('intent' in result && result.intent.actionKind).toBe('ARBITRATE');
    // La V1 ne nommait pas le champ : « à rattacher » signifiait « pas de bien ».
    expect('intent' in result && result.intent.fieldKey).toBe('assetIds');
  });

  it('« à rattacher » sans cible devient une complétion', () => {
    const result = mapLegacyItem(item({ family: 'attach', fieldKey: null, proposals: [] }));
    expect('intent' in result && result.intent.actionKind).toBe('COMPLETE');
  });

  it('ATP-05 — un arbitrage sans proposition ne devient pas une carte vide', () => {
    // Le Type n'autorise pas la complétion sans règle : DOC-TYP l'autorise,
    // mais le fournisseur non — l'élément est alors abandonné.
    const result = mapLegacyItem(
      item({ family: 'confirm', fieldKey: 'supplier', proposals: [] }),
    );
    expect(result).toEqual({ skipped: 'NO_PROPOSAL' });
  });
});

describe('P-06 — la reprise fait diminuer le nombre d’actions', () => {
  it('abandonne les champs absents du catalogue §10', () => {
    const result = mapLegacyItem(item({ fieldKey: 'notes' }));
    expect(result).toEqual({ skipped: 'NO_RULE' });
  });

  it('abandonne un type d’objet inconnu', () => {
    const result = mapLegacyItem(item({ objectType: 'inconnu' }));
    expect(result).toEqual({ skipped: 'UNKNOWN_OBJECT_TYPE' });
  });

  it('les propositions V1 n’entrent jamais avec une confiance écrivante', () => {
    // Les créditer d'une confiance élevée les ferait écrire sans arbitrage au
    // premier passage du moteur, alors qu'elles étaient justement en attente.
    const result = mapLegacyItem(item());
    expect('intent' in result && result.intent.proposals[0].confidence).toBe(0);
  });
});
