/**
 * Lot 107D — rôles des montants d'un justificatif à plusieurs articles
 * (fonctions pures, aucune base). Chiffres SYNTHÉTIQUES (ticket §6) : aucun
 * montant ni objet n'est codé dans le module testé.
 */
import { describe, expect, it } from 'vitest';
import {
  attributeArticle, buildReceiptProfile, classifyAmount, isBasketAmountOfMultiArticle, linesOfSourceUnits,
  linesOfT1Tables, linesOfTranscription, parseMoneyCents,
} from '../amount-roles';

const TICKET_3 = [
  'MAGASIN DEMO',
  'TEL 01.23.45.67.89',
  'DRAISIENNE BOIS 12P            69,99 A',
  'CASQUE ENFANT                  34,95 A',
  'SONNETTE                       22,99 A',
  'SOUS-TOTAL                    127,93',
  'TVA 20%                        21,32',
  'TOTAL TTC                     127,93',
  'CB                            127,93',
  '3 ARTICLES',
].join('\n');

describe('L107D-U-AMOUNTS — rôles des montants', () => {
  it('L107D-U-AMOUNTS-01 — montants lus en fin de ligne (virgule, point, signe, code TVA) ; numéros de téléphone ignorés', () => {
    expect(parseMoneyCents('69,99 A')).toBe(6999);
    expect(parseMoneyCents('1 234,50 €')).toBe(123450);
    expect(parseMoneyCents('-10,00')).toBe(-1000);
    expect(parseMoneyCents('10,00-')).toBe(-1000);
    expect(parseMoneyCents(12.5)).toBe(1250);
    const p = buildReceiptProfile(linesOfTranscription(TICKET_3));
    expect(p.articles.map((a) => a.designation)).toEqual(['DRAISIENNE BOIS 12P', 'CASQUE ENFANT', 'SONNETTE']);
  });

  it('L107D-U-AMOUNTS-02 — ticket 3 articles : lignes, sous-total, TVA, total, paiement typés ; multi-articles ; arithmétique cohérente', () => {
    const p = buildReceiptProfile(linesOfTranscription(TICKET_3));
    expect(p.multiArticle).toBe(true);
    expect(p.declaredArticleCount).toBe(3);
    expect(p.summaries.map((s) => s.role)).toEqual(['SUBTOTAL', 'TAX', 'TOTAL_PAID', 'PAYMENT']);
    expect(p.reconciled).toBe(true);
    expect(classifyAmount(p, 12793)).toMatchObject({ role: 'BASKET' });
    expect(classifyAmount(p, 6999)).toMatchObject({ role: 'LINE' });
    expect(isBasketAmountOfMultiArticle(p, 12793)).toBe(true);
    expect(isBasketAmountOfMultiArticle(p, 6999)).toBe(false);
  });

  it('L107D-U-AMOUNTS-03 — attribution par désignation : la ligne de l’objet, jamais le total ; autre objet → sa ligne ; objet absent → abstention', () => {
    const p = buildReceiptProfile(linesOfTranscription(TICKET_3));
    expect(attributeArticle(p, { name: 'Draisienne' })).toMatchObject({ ok: true, cents: 6999, basis: 'LINE', matchedBy: 'DESIGNATION', confidence: 'certain' });
    expect(attributeArticle(p, { name: 'Casque enfant' })).toMatchObject({ ok: true, cents: 3495 });
    expect(attributeArticle(p, { name: 'Trottinette' })).toEqual({ ok: false, reason: 'NO_MATCHING_LINE' });
    expect(attributeArticle(p, { name: null })).toEqual({ ok: false, reason: 'NO_DESCRIPTOR' });
  });

  it('L107D-U-AMOUNTS-04 — remise de ligne explicite : montant net ; remise globale ou coupon : abstention', () => {
    const ligne = buildReceiptProfile(linesOfTranscription('VELO ENFANT 16P 120,00\nREMISE -20,00\nGANTS 10,00\nTOTAL 110,00'));
    expect(attributeArticle(ligne, { name: 'Vélo enfant' })).toMatchObject({ ok: true, cents: 10000, basis: 'LINE_NET' });
    expect(ligne.reconciled).toBe(true);
    const globale = buildReceiptProfile(linesOfTranscription('VELO ENFANT 120,00\nGANTS 10,00\nSOUS-TOTAL 130,00\nREMISE FIDELITE -13,00\nTOTAL 117,00'));
    expect(attributeArticle(globale, { name: 'Vélo enfant' })).toEqual({ ok: false, reason: 'GLOBAL_ADJUSTMENT_UNCERTAIN' });
    const coupon = buildReceiptProfile(linesOfTranscription('VELO ENFANT 120,00\nGANTS 10,00\nBON D ACHAT -5,00\nTOTAL 125,00'));
    expect(attributeArticle(coupon, { name: 'Vélo enfant' })).toEqual({ ok: false, reason: 'GLOBAL_ADJUSTMENT_UNCERTAIN' });
  });

  it('L107D-U-AMOUNTS-05 — quantité > 1 : prix unitaire écrit et cohérent seulement ; sinon abstention ; lot : abstention', () => {
    const pu = buildReceiptProfile(linesOfTranscription('2 x 15,00 LAMPE CHEVET 30,00\nAMPOULE 4,00\nTOTAL 34,00'));
    expect(pu.multiArticle).toBe(true);
    expect(attributeArticle(pu, { name: 'Lampe chevet' })).toMatchObject({ ok: true, cents: 1500, basis: 'UNIT_PRICE' });
    const sansPu = buildReceiptProfile(linesOfTranscription('Qté 2 LAMPE CHEVET 30,00\nTOTAL 30,00'));
    expect(sansPu.multiArticle).toBe(true);
    expect(attributeArticle(sansPu, { name: 'Lampe chevet' })).toEqual({ ok: false, reason: 'QUANTITY_UNIT_PRICE_NOT_SHOWN' });
    const lot = buildReceiptProfile(linesOfTranscription('LOT DE 3 TABOURETS 45,00\nCOUSSIN 9,00\nTOTAL 54,00'));
    expect(attributeArticle(lot, { name: 'Tabourets' })).toEqual({ ok: false, reason: 'BUNDLE_OR_LOT' });
  });

  it('L107D-U-AMOUNTS-06 — articles identiques sur deux lignes : abstention ; une référence exacte départage', () => {
    const p = buildReceiptProfile(linesOfTranscription('CHAISE JARDIN REF CJ100 25,00\nCHAISE JARDIN REF CJ200 29,00\nTOTAL 54,00'));
    expect(attributeArticle(p, { name: 'Chaise jardin' })).toEqual({ ok: false, reason: 'AMBIGUOUS_LINES', candidates: 2 });
    expect(attributeArticle(p, { name: 'Chaise jardin', reference: 'CJ200' })).toMatchObject({ ok: true, cents: 2900, matchedBy: 'REFERENCE' });
  });

  it('L107D-U-AMOUNTS-07 — ticket à un seul article : pas multi-articles (le total reste le prix possible)', () => {
    const p = buildReceiptProfile(linesOfTranscription('DRAISIENNE 69,99\nTOTAL 69,99\nCB 69,99'));
    expect(p.multiArticle).toBe(false);
    expect(isBasketAmountOfMultiArticle(p, 6999)).toBe(false);
  });

  it('L107D-U-AMOUNTS-08 — unités persistées (couche A) et tableaux T1 : même profil', () => {
    const { lines, documentTotalCents } = linesOfSourceUnits([
      { sourceUnitId: 'doc:meta:amount', kind: 'DOCUMENT_METADATA', text: '127,93 €', payload: { field: 'amount', cents: 12793 } },
      { sourceUnitId: 'page:1:block:1', kind: 'TEXT_BLOCK', text: 'DRAISIENNE BOIS 69,99\nCASQUE 34,95\nSONNETTE 22,99' },
      { sourceUnitId: 'page:1:field:1', kind: 'LABEL_VALUE', text: 'TOTAL : 127,93', label: 'TOTAL', value: '127,93' },
    ]);
    const p = buildReceiptProfile(lines, documentTotalCents);
    expect(p.multiArticle).toBe(true);
    expect(p.articles[0].unitId).toBe('page:1:block:1');
    expect(isBasketAmountOfMultiArticle(p, 12793)).toBe(true);
    const t = buildReceiptProfile(linesOfT1Tables([{ columns: [{ header: 'Désignation' }, { header: 'Qté' }, { header: 'Montant' }],
      rows: [{ cells: [{ column: 0, value: 'Draisienne bois' }, { column: 1, value: '1' }, { column: 2, value: '69,99' }] },
        { cells: [{ column: 0, value: 'Casque' }, { column: 1, value: '1' }, { column: 2, value: '34,95' }] }] }]), 10494);
    expect(t.multiArticle).toBe(true);
    expect(attributeArticle(t, { name: 'Draisienne' })).toMatchObject({ ok: true, cents: 6999 });
    expect(isBasketAmountOfMultiArticle(t, 10494)).toBe(true);
  });

  it('L107D-U-AMOUNTS-09 — retour / remboursement : jamais attribué comme prix', () => {
    const p = buildReceiptProfile(linesOfTranscription('RETOUR DRAISIENNE -69,99\nCASQUE 34,95\nTOTAL -35,04'));
    expect(attributeArticle(p, { name: 'Draisienne' })).toEqual({ ok: false, reason: 'REFUND_LINE' });
  });
});
