/**
 * Lot 114G (Trello #760, audit T1 du 13/11) — P1-03 (liens locaux fait ↔ unité)
 * et P1-04 (déduplication par identité), fonctions pures.
 *
 *   I01  P1-03 : le lien local de la réparation fait foi, y compris pour un
 *        passage identique présent dans plusieurs unités ;
 *   I02  P1-04 : même valeur et même extrait mais deux attributs ou deux
 *        cibles → deux faits, jamais un doublon ;
 *   I03  P1-04 : réexécution identique → doublon reconnu ; même fait relu sur
 *        une autre page → le même fait (unités complétées), comme à l'analyse.
 */
import { describe, expect, it } from 'vitest';
import { KnownFacts, LocalLinks, factCoreIdentity, factLinkKey } from '../repair-identity';

const fait = (o: Record<string, unknown> = {}) => ({ rawKey: 'Montant TTC', rawValue: '1 340,00 €', evidence: { excerpt: 'Montant à payer : 1 340,00 €' }, ...o });

describe('L114G-I01 — P1-03 : liens locaux de la réparation', () => {
  it('le fait projeté retrouve les unités de la zone ciblée', () => {
    const rendu = fait();
    const l = new LocalLinks(new Map([[rendu, ['page:1:field:2']]]));
    expect(l.take({ rawKey: 'montant ttc', rawValue: '1 340,00 €', evidence: { excerpt: 'Montant à payer : 1 340,00 €' } })).toEqual(['page:1:field:2']);
  });

  it('passage identique sur deux pages : chaque fait garde SON unité, dans l’ordre', () => {
    const a = fait();
    const b = fait();
    const l = new LocalLinks(new Map([[a, ['page:1:block:4']], [b, ['page:3:block:9']]]));
    expect(l.take(fait())).toEqual(['page:1:block:4']);
    expect(l.take(fait())).toEqual(['page:3:block:9']);
    // Une relecture supplémentaire du même fait garde la dernière preuve connue (jamais « aucun lien »).
    expect(l.take(fait())).toEqual(['page:3:block:9']);
  });

  it('fait sans lien local : null — l’appelant recalcule et consigne le motif', () => {
    const l = new LocalLinks(new Map([[fait(), ['page:1:block:4']]]));
    expect(l.take(fait({ rawValue: '999,00 €' }))).toBeNull();
    expect(new LocalLinks(null).take(fait())).toBeNull();
    expect(new LocalLinks(new Map([[fait(), []]])).take(fait())).toBeNull();
  });

  it('la clé de correspondance ignore casse, accents et espaces, pas la valeur', () => {
    expect(factLinkKey(fait())).toBe(factLinkKey({ label: 'MONTANT  TTC', rawValue: '1 340,00 €', evidence: { excerpt: 'montant a payer : 1 340,00 €' } }));
    expect(factLinkKey(fait())).not.toBe(factLinkKey(fait({ rawValue: '1 340,01 €' })));
  });
});

describe('L114G-I02 — P1-04 : des faits distincts ne sont jamais éliminés', () => {
  const ecrit = { id: 10, key: 'amount_ttc', value: '1340.00', excerpt: 'Total : 1 340,00 €', targetType: 'ASSET', targetEntityId: 7, sourceUnitIds: ['page:1:block:4'] };

  it('même valeur, même extrait, AUTRE attribut : nouveau fait', () => {
    expect(new KnownFacts([ecrit]).match({ ...ecrit, key: 'amount_ht' })).toBeNull();
  });

  it('même valeur, même extrait, AUTRE cible : nouveau fait', () => {
    const k = new KnownFacts([ecrit]);
    expect(k.match({ ...ecrit, targetEntityId: 8 })).toBeNull();
    expect(k.match({ ...ecrit, targetType: 'EQUIPMENT' })).toBeNull();
  });

  it('valeur ou extrait différent : nouveau fait', () => {
    const k = new KnownFacts([ecrit]);
    expect(k.match({ ...ecrit, value: '1340.01' })).toBeNull();
    expect(k.match({ ...ecrit, excerpt: 'Acompte : 1 340,00 €' })).toBeNull();
  });
});

describe('L114G-I03 — P1-04 : réexécution identique et relecture ailleurs', () => {
  const ecrit = { id: 10, key: 'amount_ttc', value: '1340.00', excerpt: 'Total : 1 340,00 €', targetType: 'ASSET', targetEntityId: 7, sourceUnitIds: ['page:1:block:4'] };

  it('même clé, valeur, cible, extrait : doublon reconnu, quelle que soit la casse ou l’espacement', () => {
    const k = new KnownFacts([ecrit]);
    expect(k.match({ ...ecrit })).toBe(10);
    expect(k.match({ ...ecrit, excerpt: 'total :  1 340,00 €' })).toBe(10);
  });

  it('même fait relu sur une autre page : le MÊME fait (ses unités seront complétées), pas une seconde ligne', () => {
    expect(new KnownFacts([ecrit]).match({ ...ecrit, sourceUnitIds: ['page:2:block:1'] })).toBe(10);
  });

  it('fait ajouté pendant la reprise : reconnu au second passage ; ligne historique sans provenance : reconnue', () => {
    const k = new KnownFacts([{ id: 5, key: 'k', value: 'v', excerpt: 'e', sourceUnitIds: null }]);
    expect(k.match({ key: 'k', value: 'v', excerpt: 'e', sourceUnitIds: ['page:1:block:4'] })).toBe(5);
    k.add({ ...ecrit, key: 'amount_ht' }, 11);
    expect(k.match({ ...ecrit, key: 'amount_ht' })).toBe(11);
  });

  it('même identité que l’analyse : clé, valeur, cible, extrait', () => {
    expect(factCoreIdentity({ key: 'Clé', value: ' V ', excerpt: 'É  x' })).toBe(factCoreIdentity({ key: 'cle', value: 'v', excerpt: 'e x' }));
  });
});
