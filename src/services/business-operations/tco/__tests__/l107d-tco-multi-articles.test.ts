/**
 * Lot 107D — ticket à plusieurs articles : le prix d'achat de la fiche (ligne
 * de l'article) et le total de la transaction (Opération d'achat du même
 * ticket) ne sont JAMAIS additionnés dans le TCO (ticket §3 « sans créer de
 * dépenses en double », §6 « Total opération / lignes d'articles »). Pur.
 */
import { describe, expect, it } from 'vitest';
import { computeTco, type TcoAssetPrice, type TcoInput, type TcoOperation } from '../model';
import type { ComponentProvenance } from '../fact-identity';
import type { EconomicDocumentInput } from '../../finance/economic-lines';
import type { LedgerComponent } from '../../finance/engine';

const OBJET = 90;
const TICKET = 501;
const TODAY = '2026-11-03';

const comp = (id: number, cents: number): LedgerComponent => ({
  id, operationId: 9001, kind: 'REALIZED_COST', amountMinor: cents, currency: 'EUR', amountEurCents: null, economicDate: '2026-04-24',
  periodStart: null, periodEnd: null, targetAssetId: null,
});
const operation: TcoOperation = {
  id: 9001, typeCode: 'ACQUISITION', status: 'REALIZED', realizedDate: '2026-04-24', startDate: null, plannedDate: null,
  assetIds: [OBJET], label: 'Achat — ticket', components: [comp(77_001, 12_793)], documents: [{ fileId: TICKET, title: 'Ticket', role: 'INVOICE' }],
  sourceKinds: ['DOCUMENT'],
};
const provenance = new Map<number, ComponentProvenance>([[77_001, { documentFileIds: [TICKET], withdrawnFileIds: [], otherSourceKinds: [], invoiceRefs: [], explained: true }]]);
const ticket: EconomicDocumentInput = {
  fileId: TICKET, title: 'Ticket de caisse', typeCode: 'ACQUISITION_INVOICE', legacyType: null, date: '2026-04-24', supplier: null,
  amountCents: 12_793, currency: 'EUR', userEditedAmount: false, hash: 'h-ticket', state: 'ANALYZED', ignoredWith: null,
  linkedAssetIds: [OBJET], multiAsset: false, candidates: [],
  operations: [{ operationId: 9001, label: 'Achat — ticket', inScope: true, cancelled: false, hasAssets: true, exploitable: true, citesDocument: true, typeCode: 'ACQUISITION' }],
};
const prix = (o: Partial<TcoAssetPrice> = {}): TcoAssetPrice => ({ amountMinor: 6_999, currency: 'EUR', origin: 'RECONCILIATION', evidenceFileIds: [TICKET], ...o });
const entree = (o: Partial<TcoInput> = {}): TcoInput => ({
  assetId: OBJET, today: TODAY, operations: [operation], assetAcquisitionDate: '2026-04-24', assetSaleDate: null, assetStatus: 'ACTIF',
  valuationHistory: [], desiredSalePriceCents: null, budgets: [], readComplete: true, documents: [ticket], assetPrice: prix(),
  assetCategory: 'OBJECT', componentProvenance: provenance, ...o,
});

describe('L107D-U-TCO — total de la transaction et ligne de l’article : jamais additionnés', () => {
  it('L107D-U-TCO-01 — prix de la fiche (ligne, preuve = le ticket) + Opération d’achat du même ticket (total) : compté UNE fois', () => {
    const t = computeTco(entree());
    expect(t.summary.cumulativeCostCents).not.toBe(6_999 + 12_793);
    expect(t.summary.cumulativeCostCents).toBeLessThanOrEqual(12_793);
    // Le ticket lui-même n'ajoute pas une troisième dépense.
    const docs = t.lines.filter((l) => l.source === 'DOCUMENT' && l.fileId === TICKET && l.includedCents > 0);
    const ops = t.lines.filter((l) => l.source !== 'DOCUMENT' && l.includedCents > 0);
    expect(docs.length + ops.length).toBeLessThanOrEqual(1);
  });

  it('L107D-U-TCO-02 — même situation, prix saisi par l’utilisateur : aucune double dépense non plus', () => {
    const t = computeTco(entree({ assetPrice: prix({ origin: 'USER' }) }));
    expect(t.summary.cumulativeCostCents).not.toBe(6_999 + 12_793);
  });
});
