/**
 * Lot 38 — O0 (CDC Opérations V1 §11, §19, B18, B24, C11.1, C12.3, C18) :
 * la règle « facture d'achat » de la projection T1 reste CONTEXTUALISÉE.
 *
 *   O0-03  date : livraison / remise / achat explicite d'abord, date du
 *          document seulement pour le justificatif d'achat du bien lui-même ;
 *          jamais pour réparation, devis, acompte, avoir, preuve de paiement ;
 *   O0-04  prix : seulement en EUR (devise écrite ou seule devise du
 *          document) ; montant canonique en devise étrangère → générique ;
 *   O0-05  valeur estimée : jamais lue sur un document de transaction.
 *   F-162 / F-163 / F-164 : cas de recette du CDC.
 *
 * Fonction PURE : aucun mock, aucune base.
 */
import { describe, expect, it } from 'vitest';
import { T1AnalyzeDocumentOutput, type T1Fact } from '../../master/t1-contract';
import { checkFactEvidence } from '../../master/fact-evidence';
import { projectDocumentFacts, type ProjectionContext } from '../document-projection';
import { PROJECTION_RULES, transactionNature, labelsExplicitAcquisitionDate } from '../rules';
import { loadT1Fixture, type T1Fixture } from '../../__fixtures__/t1/load';
import { toAssetFamily, type AssetFamily } from '@/services/canonical/registry';

type Out = Record<string, unknown> & { document: Record<string, unknown>; facts: unknown[]; transcription?: string };

function prepare(f: T1Fixture) {
  const parsed = T1AnalyzeDocumentOutput.parse(f.recording.output);
  const facts = parsed.facts.map(checkFactEvidence).filter((c) => c.ok).map((c) => (c as { fact: T1Fact }).fact);
  const v = f.context.verified ?? {};
  const verifiedIds = {
    ASSET: new Set(v.ASSET ?? []), EQUIPMENT: new Set(v.EQUIPMENT ?? []),
    ROOM: new Set(v.ROOM ?? []), SUPPLIER: new Set(v.SUPPLIER ?? []),
  };
  const known = f.context.linkedAssetId ?? null;
  const ctx: ProjectionContext = {
    knownAssetId: known, documentAssetId: known,
    assetFamilies: new Map<number, AssetFamily | undefined>((f.context.assets ?? []).map((a) => [a.id, toAssetFamily(a.category)])),
    verifiedIds,
  };
  return { analysis: { ...parsed, facts }, ctx };
}

/** Ticket draisienne (P-T1-02), modifié par `edit`. */
function ticket(edit: (o: Out) => void = () => {}) {
  const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
  edit(f.recording.output as unknown as Out);
  const { analysis, ctx } = prepare(f);
  const p = projectDocumentFacts(analysis, ctx);
  return { p, byKey: (k: string) => p.facts.filter((x) => x.canonicalKey === k) };
}

const fait = (over: Record<string, unknown>) => ({
  canonicalKey: null, normalizedValue: null, target: { type: 'ASSET', entityId: 184, confidence: 'certain' },
  provenance: 'TEXT_EXTRACTION', confidence: 'certain', ...over,
});

describe('O0-03 — date d’acquisition contextualisée (C11.1)', () => {
  it('O0-03a justificatif d’achat du bien sans meilleure date : date du document (inchangé, P-T1-02)', () => {
    const { byKey } = ticket();
    expect(byKey('acquisitionDate')).toEqual([expect.objectContaining({
      value: '2026-04-24', ruleCode: PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_DATE,
    })]);
  });

  it('O0-03b date de livraison explicite : elle prime sur la date du document', () => {
    const { p, byKey } = ticket((o) => {
      o.facts.push(fait({ rawKey: 'dateLivraison', label: 'Date de livraison', rawValue: '02/05/2026', normalizedValue: '2026-05-02',
        valueType: 'date', evidence: { excerpt: 'Livré le 02/05/2026' } }));
    });
    expect(byKey('acquisitionDate')).toEqual([expect.objectContaining({
      value: '2026-05-02', origin: 'DETERMINISTIC_RULE', ruleCode: PROJECTION_RULES.PURCHASE_DELIVERY_ACQUISITION_DATE,
      evidence: expect.objectContaining({ excerpt: 'Livré le 02/05/2026' }),
    })]);
    expect(p.appliedRules).not.toContain(PROJECTION_RULES.PURCHASE_RECEIPT_ACQUISITION_DATE);
  });

  it('O0-03c deux dates de livraison différentes : aucune date d’acquisition devinée', () => {
    const { byKey } = ticket((o) => {
      o.facts.push(
        fait({ rawKey: 'dateLivraison', rawValue: '02/05/2026', normalizedValue: '2026-05-02', valueType: 'date', evidence: { excerpt: 'Livraison 02/05/2026' } }),
        fait({ rawKey: 'dateLivraison', rawValue: '09/05/2026', normalizedValue: '2026-05-09', valueType: 'date', evidence: { excerpt: 'Livraison 09/05/2026' } }),
      );
    });
    expect(byKey('acquisitionDate')).toEqual([]);
  });

  it('O0-03d preuve de paiement d’acquisition : ni date ni prix déduits du document (INV-012)', () => {
    const { p, byKey } = ticket((o) => {
      (o.document.classification as Record<string, unknown>).documentTypeCode = 'ACQUISITION_PAYMENT';
    });
    expect(byKey('acquisitionDate')).toEqual([]);
    expect(byKey('acquisitionPrice')).toEqual([]);
    expect(p.appliedRules).toContain(PROJECTION_RULES.PAYMENT_PROOF_NO_ACQUISITION_RULE);
  });

  it('O0-03e facture d’acompte : ni date ni prix, même proposés par le modèle (INV-014)', () => {
    const { p, byKey } = ticket((o) => {
      o.document.title = { value: 'Facture d’acompte — draisienne', confidence: 'certain', evidence: { excerpt: 'FACTURE D’ACOMPTE' } };
      o.facts.push(fait({ canonicalKey: 'acquisitionPrice', rawValue: '30,00 €', normalizedValue: 30, valueType: 'money_eur',
        canonicalUnit: 'EUR', evidence: { excerpt: 'Acompte 30,00 €' } }));
    });
    expect(byKey('acquisitionDate')).toEqual([]);
    expect(byKey('acquisitionPrice')).toEqual([]);
    expect(p.appliedRules).toContain(PROJECTION_RULES.DEPOSIT_OR_CREDIT_NOTE_NO_ACQUISITION);
    expect(p.facts.some((f) => f.canonicalKey === null && f.ruleCode === PROJECTION_RULES.DEPOSIT_OR_CREDIT_NOTE_NO_ACQUISITION)).toBe(true);
  });

  it('O0-03f avoir : aucune acquisition', () => {
    const { byKey } = ticket((o) => {
      o.document.amountCents = { value: 12900, confidence: 'certain', evidence: { excerpt: 'AVOIR N° 12 — 129,00 €' } };
    });
    expect(byKey('acquisitionPrice')).toEqual([]);
    expect(byKey('acquisitionDate')).toEqual([]);
  });

  it('O0-03g réparation / entretien et devis : jamais d’acquisition (§13, déjà couvert — revérifié)', () => {
    const rep = projectDocumentFacts(...Object.values(prepare(loadT1Fixture('p-t1-03-facture-reparation.json'))) as [never, never]);
    expect(rep.facts.some((f) => f.canonicalKey === 'acquisitionPrice' || f.canonicalKey === 'acquisitionDate')).toBe(false);
    const { byKey } = ticket((o) => {
      (o.document.classification as Record<string, unknown>).canonicalType = 'DEVIS';
      (o.document.classification as Record<string, unknown>).documentTypeCode = 'REPAIR_QUOTE';
    });
    expect(byKey('acquisitionPrice')).toEqual([]);
    expect(byKey('acquisitionDate')).toEqual([]);
  });

  it('transactionNature / labelsExplicitAcquisitionDate : « merci de nous avoir… » n’est pas un avoir', () => {
    expect(transactionNature({ documentTypeCode: 'ACQUISITION_INVOICE', texts: ['Merci de nous avoir fait confiance'] })).toBe('PURCHASE');
    expect(transactionNature({ documentTypeCode: null, texts: ['Avoir sur facture F-12'] })).toBe('DEPOSIT_OR_CREDIT_NOTE');
    expect(transactionNature({ documentTypeCode: 'WORKS_PAYMENT_PROOF', texts: [] })).toBe('PAYMENT_PROOF');
    expect(labelsExplicitAcquisitionDate('dateLivraison')).toBe(true);
    expect(labelsExplicitAcquisitionDate('Date d’achat')).toBe(true);
    expect(labelsExplicitAcquisitionDate('dateEcheance', 'Date limite de paiement')).toBe(false);
  });
});

describe('O0-04 — devise (C12.3)', () => {
  it('O0-04a montant en CHF : aucun prix d’acquisition en euros (pas de conversion)', () => {
    const { p, byKey } = ticket((o) => {
      o.document.amountCents = { value: 12900, confidence: 'certain', evidence: { excerpt: 'TOTAL TTC 129,00 CHF' } };
      o.transcription = 'JOUETS SA\nGENÈVE\n24/04/2026\nDRAISIENNE 129,00\nTOTAL TTC 129,00 CHF';
    });
    expect(byKey('acquisitionPrice')).toEqual([]);
    expect(p.appliedRules).toContain(PROJECTION_RULES.ACQUISITION_PRICE_CURRENCY_NOT_EUR);
    // La date d'achat reste établie : seule la conversion manque.
    expect(byKey('acquisitionDate')).toHaveLength(1);
  });

  it('O0-04b devise non écrite avec le montant mais document en USD : aucun prix', () => {
    const { byKey } = ticket((o) => {
      o.document.amountCents = { value: 12900, confidence: 'certain', evidence: { excerpt: 'TOTAL 129.00' } };
      o.transcription = 'TOY STORE INC.\nTOTAL 129.00\nAll prices in USD';
    });
    expect(byKey('acquisitionPrice')).toEqual([]);
  });

  it('O0-04c plusieurs devises (CHF et €) sans devise sur le montant : indéterminée, aucun prix', () => {
    const { byKey } = ticket((o) => {
      o.document.amountCents = { value: 12900, confidence: 'certain', evidence: { excerpt: 'TOTAL 129,00' } };
      o.transcription = 'TOTAL 129,00\nSoit environ 132,00 € — paiement en CHF';
    });
    expect(byKey('acquisitionPrice')).toEqual([]);
  });

  it('O0-04d / PO-D2-09 document sans aucune mention de devise : EUR seulement présumé — prix gardé en PROPOSITION à confirmer (lot 53D)', () => {
    const { p, byKey } = ticket((o) => {
      o.document.amountCents = { value: 12900, confidence: 'certain', evidence: { excerpt: 'TOTAL TTC 129,00' } };
      o.transcription = 'TICKET DE CAISSE\n24/04/2026\nDRAISIENNE BOIS 12 POUCES 129,00\nTOTAL TTC 129,00';
    });
    expect(byKey('acquisitionPrice')).toEqual([expect.objectContaining({ value: 129, confidence: 'probable' })]);
    expect(p.appliedRules).toContain(PROJECTION_RULES.CURRENCY_PRESUMED_TO_CONFIRM);
  });

  it('PO-D2-10 fait canonique en euros sans aucune devise écrite : proposition (probable) ; avec « € » écrit : inchangé', () => {
    const sans = ticket((o) => {
      o.transcription = 'TICKET DE CAISSE\nDRAISIENNE 129,00\nTOTAL TTC 129,00';
      (o.document.amountCents as Record<string, unknown>) = { value: 12900, confidence: 'certain', evidence: { excerpt: 'TOTAL TTC 129,00' } };
      o.facts.push(fait({ canonicalKey: 'acquisitionPrice', rawValue: '129,00', normalizedValue: 129, valueType: 'money_eur', canonicalUnit: 'EUR', evidence: { excerpt: 'TOTAL TTC 129,00' } }));
    });
    expect(sans.byKey('acquisitionPrice').every((f) => f.confidence !== 'certain')).toBe(true);
    const avec = ticket((o) => {
      o.facts.push(fait({ canonicalKey: 'acquisitionPrice', rawValue: '129,00 €', normalizedValue: 129, valueType: 'money_eur', canonicalUnit: 'EUR', evidence: { excerpt: 'TOTAL TTC 129,00 €' } }));
    });
    expect(avec.byKey('acquisitionPrice').some((f) => f.value === 129 && f.confidence === 'certain')).toBe(true);
  });

  it('O0-04e fait canonique acquisitionPrice lu « 1 250,00 CHF » : connaissance générique, jamais en euros', () => {
    const { p, byKey } = ticket((o) => {
      o.facts.push(fait({ canonicalKey: 'acquisitionPrice', rawValue: '1 250,00 CHF', normalizedValue: 1250, valueType: 'money_eur',
        canonicalUnit: 'EUR', evidence: { excerpt: 'Prix 1 250,00 CHF' } }));
    });
    expect(byKey('acquisitionPrice').some((f) => f.value === 1250)).toBe(false);
    expect(p.facts.some((f) => f.canonicalKey === null && f.ruleCode === PROJECTION_RULES.NON_EUR_AMOUNT_NOT_CANONICAL)).toBe(true);
  });
});

describe('O0-05 / F-16x — valorisation et montants génériques', () => {
  it('F-162 facture d’achat : coût d’acquisition, jamais valeur estimée', () => {
    const { byKey } = ticket();
    expect(byKey('acquisitionPrice')).toEqual([expect.objectContaining({ value: 129 })]);
    expect(byKey('estimatedValue')).toEqual([]);
    expect(byKey('estimatedValueDate')).toEqual([]);
  });

  it('O0-05 valeur estimée lue sur une facture : connaissance générique (C18)', () => {
    const { p, byKey } = ticket((o) => {
      o.facts.push(fait({ canonicalKey: 'estimatedValue', rawValue: '129,00 €', normalizedValue: 129, valueType: 'money_eur',
        canonicalUnit: 'EUR', evidence: { excerpt: 'TOTAL TTC 129,00 €' } }));
    });
    expect(byKey('estimatedValue')).toEqual([]);
    expect(p.facts.some((f) => f.ruleCode === PROJECTION_RULES.VALUATION_FROM_TRANSACTION_DOCUMENT)).toBe(true);
  });

  it('F-161 (projection) valeur estimée d’une expertise : canonique, aucune acquisition déduite', () => {
    const { byKey } = ticket((o) => {
      o.document.classification = { canonicalType: null, rubricCode: 'PROPERTY_MANAGEMENT', documentTypeCode: 'VALUE_APPRAISAL', confidence: 0.95, evidence: { excerpt: 'RAPPORT D’EXPERTISE' } };
      o.document.amountCents = { value: 25000, confidence: 'certain', evidence: { excerpt: 'Valeur estimée : 250,00 €' } };
      o.facts.length = 0;
      o.facts.push(fait({ canonicalKey: 'estimatedValue', rawValue: '250,00 €', normalizedValue: 250, valueType: 'money_eur',
        canonicalUnit: 'EUR', evidence: { excerpt: 'Valeur estimée : 250,00 €' } }));
    });
    expect(byKey('estimatedValue')).toEqual([expect.objectContaining({ value: 250, origin: 'MODEL_CANONICAL' })]);
    expect(byKey('acquisitionPrice')).toEqual([]);
    expect(byKey('acquisitionDate')).toEqual([]);
  });

  it('F-163 date de document générique (facture sans finalité d’achat) : aucune acquisitionDate', () => {
    const p = projectDocumentFacts(...Object.values(prepare(loadT1Fixture('t1-02-facture-sans-finalite.json'))) as [never, never]);
    expect(p.facts.some((f) => f.canonicalKey === 'acquisitionDate')).toBe(false);
  });

  it('F-164 montant générique (facture sans finalité d’achat) : ni acquisitionPrice ni estimatedValue', () => {
    const p = projectDocumentFacts(...Object.values(prepare(loadT1Fixture('t1-02-facture-sans-finalite.json'))) as [never, never]);
    expect(p.facts.some((f) => f.canonicalKey === 'acquisitionPrice' || f.canonicalKey === 'estimatedValue')).toBe(false);
  });
});
