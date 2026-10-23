/**
 * Lot 45 — O6 : T2 « Opération d'abord », non exclusive (CDC Opérations V1
 * ch. 16, P11-P13, P16, B15, C10, C12, C15, C15.1, C15.2, C17.1 ; recette
 * F-126 à F-137). Règles PURES : coûts consolidés par périmètre, agrégat
 * mixte, libellés (P09), intentions, sources ouvrables, abonnement du cache.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AssistantOperationRead } from '@/services/business-operations/read-service';
import {
  operationCostLines, summarizeOperationCosts, operationTheme, operationLabel, operationCountLabel, formatMinorAmount, costLineSource,
} from '../operations';
import {
  aggregateExpenses, expenseItemsLabel, mixedExpenseNotes, expenseSumSource, expenseCoverageComplete, classifyExpenseDocument, isCreditNoteTitle,
  type QualifiedExpenses,
} from '../expenses';
import { claimAnswer, paymentsAnswer, historyAnswer, contractsAnswer, operationCostAnswer, CLAIM_Q, HISTORY_Q, PAID, CONTRACT_Q } from '../structured-answers';
import { specificCostTerms } from '../operations';
import { parseEntityRef, hrefEntite, hrefSource } from '../../core/entity-ref';
import { claimSourceId, parseClaimSourceId } from '../source-ids';

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

let seq = 100;
function op(o: Partial<AssistantOperationRead> = {}): AssistantOperationRead {
  seq += 1;
  return {
    id: seq, accountId: 1, typeCode: 'INTERVENTION', status: 'REALIZED', technicalLabel: 'Remplacement embrayage',
    provider: 'Garage Martin', plannedDate: null, startDate: null, realizedDate: '2026-03-02', endDate: null, closedAt: null,
    invalidatedAt: null, invalidationReason: null, mergedIntoOperationId: null, lastReconciledAt: null, version: 1, active: true,
    contractReference: null, effectiveFrom: null, effectiveTo: null, claimStatus: null, claimType: null, insurerClaimRef: null, declaredOn: null,
    assetIds: [20], components: [], documents: [{ fileId: seq * 10, role: 'INVOICE', title: 'Facture Garage Martin', date: '2026-03-02', amountCents: 125000, documentTypeCode: 'REPAIR_INVOICE' }],
    sourceKinds: ['DOCUMENT'], ...o,
  };
}
let cseq = 0;
const comp = (kind: string, amountMinor: number, o: Record<string, unknown> = {}) =>
  ({ id: ++cseq, kind, amountMinor, currency: 'EUR', amountEurCents: null, economicDate: null, targetAssetId: null, label: null, ...o }) as AssistantOperationRead['components'][number];

describe('O6-01 — coût consolidé d’un bien sans double comptage (C12, C15.1, C17.1)', () => {
  it('F-127 / O6-01 — devis + acompte + solde + avoir + preuve de paiement : 1 200 − 100, devis « prévu » seulement si envisagé', () => {
    const o = op({
      components: [comp('FORECAST_COST', 120000), comp('REALIZED_COST', 30000), comp('REALIZED_COST', 90000), comp('REDUCTION', 10000)],
      documents: [
        { fileId: 1, role: 'QUOTE', title: 'Devis', date: '2026-01-10', amountCents: 120000, documentTypeCode: 'REPAIR_QUOTE' },
        { fileId: 2, role: 'DEPOSIT_INVOICE', title: 'Acompte', date: '2026-02-01', amountCents: 30000, documentTypeCode: 'REPAIR_INVOICE' },
        { fileId: 3, role: 'INVOICE', title: 'Solde', date: '2026-03-02', amountCents: 90000, documentTypeCode: 'REPAIR_INVOICE' },
        { fileId: 4, role: 'CREDIT_NOTE', title: 'Avoir', date: '2026-03-10', amountCents: 10000, documentTypeCode: null },
        { fileId: 5, role: 'PAYMENT_PROOF', title: 'Virement', date: '2026-03-12', amountCents: 110000, documentTypeCode: 'WORKS_PAYMENT_PROOF' },
      ],
    });
    const [l] = operationCostLines([o], { assetIds: [20] });
    expect(l).toMatchObject({ costCents: 110000, forecastCents: 0, hasCost: true, noAmount: false, theme: 'repair', primaryFileId: 3 });
    const env = op({ status: 'ENVISAGED', components: [comp('FORECAST_COST', 50000)] });
    const { part, entries } = summarizeOperationCosts(operationCostLines([env], { assetIds: [20] }), null);
    expect(part.forecast).toEqual({ count: 1, sumCents: 50000 });
    expect(entries).toEqual([]);
    expect(part.count).toBe(0);
  });

  it('O6-02 — indemnité seulement dans le net (Q4), remboursement en réduction', () => {
    const claim = op({ typeCode: 'CLAIM', components: [comp('INDEMNITY', 80000)], documents: [] });
    const rep = op({ components: [comp('REALIZED_COST', 125000), comp('REFUND', 20000)] });
    const { part } = summarizeOperationCosts(operationCostLines([claim, rep], { assetIds: [20] }), null);
    expect(part.sumCents).toBe(105000);
    expect(part.indemnity).toMatchObject({ count: 1, sumCents: 80000 });
    // Thème « entretien » : l'indemnité d'un sinistre n'y est pas.
    expect(summarizeOperationCosts(operationCostLines([claim], { assetIds: [20] }), 'maintenance').part.indemnity.sumCents).toBe(0);
  });

  it('O6-03 — devise sans contre-valeur : à part, jamais additionnée (C12.3) ; contre-valeur explicite : comptée', () => {
    const chf = op({ components: [comp('REALIZED_COST', 30000, { currency: 'CHF' }), comp('REALIZED_COST', 50000, { currency: 'USD', amountEurCents: 46000 })] });
    const { part } = summarizeOperationCosts(operationCostLines([chf], { assetIds: [20] }), null);
    expect(part.sumCents).toBe(46000);
    expect(part.foreign).toEqual([{ currency: 'CHF', amountMinor: 30000 }]);
    expect(formatMinorAmount(30000, 'CHF')).toMatch(/300,00\sCHF/);
    expect(formatMinorAmount(5000, 'JPY')).toMatch(/5\s?000\s?(JPY|¥)/);
  });

  it('O6-04 — multi-biens : composante ciblée imputée à son bien ; non ventilée → « non attribuée », jamais comptée entière (C10)', () => {
    const multi = op({ assetIds: [20, 21], components: [comp('REALIZED_COST', 40000, { targetAssetId: 20 }), comp('REALIZED_COST', 60000, { targetAssetId: 21 }), comp('REALIZED_COST', 10000)] });
    const polo = summarizeOperationCosts(operationCostLines([multi], { assetIds: [20] }), null).part;
    expect(polo.sumCents).toBe(40000);
    expect(polo.unattributed).toMatchObject({ count: 1, sumCents: 10000 });
    // Les deux biens demandés : tout est compté une fois.
    expect(summarizeOperationCosts(operationCostLines([multi], { assetIds: [20, 21] }), null).part.sumCents).toBe(110000);
    // Compte global : une fois aussi.
    expect(summarizeOperationCosts(operationCostLines([multi], { assetIds: [] }), null).part.sumCents).toBe(110000);
  });

  it('F-136 / F-137 — sans bien : exclue d’une question limitée à un bien, mentionnée pour le compte', () => {
    const orpheline = op({ assetIds: [], components: [comp('REALIZED_COST', 9900)] });
    expect(operationCostLines([orpheline], { assetIds: [20] })).toEqual([]);
    const { part } = summarizeOperationCosts(operationCostLines([orpheline], { assetIds: [] }), null);
    expect(part.untargeted).toEqual({ count: 1, sumCents: 9900 });
  });

  it('F-118 / C15.1 §31 — Opération sans montant : signalée, total incomplet (jamais remplacée par ses documents)', () => {
    const sans = op({ components: [] });
    const { part } = summarizeOperationCosts(operationCostLines([sans], { assetIds: [20] }), null);
    expect(part.withoutAmount.count).toBe(1);
    expect(part.withoutAmount.labels[0]).toBe('intervention « Remplacement embrayage »');
    expect(expenseCoverageComplete(part, { count: 0, sumCents: 0, represented: { count: 1, fileIds: [1] }, representedElsewhere: { count: 0, fileIds: [] },
      unattributed: { count: 0, sumCents: 0, fileIds: [] }, creditNotes: { count: 0, sumCents: 0 } })).toBe(false);
  });

  it('année demandée : composante sans date non qualifiée, autre année ignorée', () => {
    const o = op({ realizedDate: null, components: [comp('REALIZED_COST', 5000), comp('REALIZED_COST', 7000, { economicDate: '2024-05-01' }), comp('REALIZED_COST', 3000, { economicDate: '2025-02-01' })] });
    const [l] = operationCostLines([o], { assetIds: [20], year: 2025 });
    expect(l).toMatchObject({ costCents: 3000, undatedCents: 5000, undatedCount: 1 });
  });

  it('thème : type métier, type des documents, libellé ; nature inconnue → non qualifiée pour un thème précis', () => {
    expect(operationTheme(op({ typeCode: 'ACQUISITION' }))).toBe('purchase');
    expect(operationTheme(op({ documents: [{ fileId: 1, role: 'INVOICE', title: 'x', date: null, amountCents: 1, documentTypeCode: 'MAINTENANCE_INVOICE' }] }))).toBe('maintenance');
    expect(operationTheme(op({ documents: [], technicalLabel: 'Vidange et révision' }))).toBe('maintenance');
    const inconnue = op({ documents: [], technicalLabel: 'Prestation', components: [comp('REALIZED_COST', 4000)] });
    expect(operationTheme(inconnue)).toBeNull();
    const t = summarizeOperationCosts(operationCostLines([inconnue], { assetIds: [20] }), 'maintenance');
    expect(t.part.unqualified).toEqual({ count: 1, sumCents: 4000 });
    const tous = summarizeOperationCosts(operationCostLines([inconnue], { assetIds: [20] }), null);
    expect(tous.entries).toEqual([{ operationId: inconnue.id, amountCents: 4000, theme: 'other' }]);
  });

  it('P09 — libellés : jamais « Opération »', () => {
    expect(operationCountLabel({ INTERVENTION: 2, CONTRACT: 1 })).toBe('2 interventions et 1 contrat');
    expect(operationLabel(op({ typeCode: 'CLAIM', claimType: 'DEGAT_DES_EAUX', documents: [] }))).toMatch(/^sinistre « /);
    expect(operationLabel(op({ typeCode: null, technicalLabel: null, documents: [] }))).toBe('dépense');
  });
});

describe('O6-05 — agrégat mixte (C15.1) : Opérations + documents non représentés', () => {
  const o = op({ components: [comp('REALIZED_COST', 125000)] });
  const { part, entries } = summarizeOperationCosts(operationCostLines([o], { assetIds: [20] }), null);
  const agg = aggregateExpenses(
    [{ fileId: 900, amountCents: 18000, cls: { kind: 'theme', theme: 'maintenance' } }],
    null, [], entries.map((e) => ({ operationId: e.operationId, amountCents: e.amountCents, theme: e.theme! })),
  );
  const q: QualifiedExpenses = {
    ...agg, operations: part,
    documents: { count: 1, sumCents: 18000, represented: { count: 1, fileIds: [o.documents[0].fileId] }, representedElsewhere: { count: 0, fileIds: [] },
      unattributed: { count: 0, sumCents: 0, fileIds: [] }, creditNotes: { count: 0, sumCents: 0 } },
  };

  it('F-129 — somme Opérations + vieille facture hors Opération, document source exclu', () => {
    expect(q.qualifiedSumCents).toBe(143000);
    const rep = q.byTheme.find((t) => t.theme === 'repair')!;
    expect(rep).toMatchObject({ operationCount: 1, documentCount: 0, operationIds: [o.id] });
    expect(expenseItemsLabel(rep, part)).toBe('1 intervention');
    expect(expenseItemsLabel(q.byTheme.find((t) => t.theme === 'maintenance')!, part)).toBe('1 document');
  });

  it('C15.1 §33 — provenance lisible, documents non recomptés ; source vérifiable', () => {
    const notes = mixedExpenseNotes(q, { scopeLabel: 'Polo' }).join(' ');
    expect(notes).toMatch(/Dont 1\s250,00\s€ consolidés \(1 intervention\) et 180,00\s€ lus sur 1 document/);
    expect(notes).toContain('déjà pris en compte dans une intervention');
    expect(notes).not.toMatch(/op[ée]ration/i);
    const src = expenseSumSource(q, { assetIds: [20], scopeLabel: 'Polo' });
    expect(src.content).toContain(`doc-${o.documents[0].fileId}`);
    expect(src.meta).toMatchObject({ operationCount: 1, consolidatedCents: 125000, documentFallbackCents: 18000, representedDocumentCount: 1 });
  });

  it('sans Opération : forme du lot 15 inchangée (aucune note, aucun champ ajouté au thème)', () => {
    const lot15 = aggregateExpenses([{ fileId: 1, amountCents: 100, cls: { kind: 'theme', theme: 'maintenance' } }], null);
    expect(lot15.byTheme[0]).toEqual({ theme: 'maintenance', label: 'entretien', sumCents: 100, count: 1, fileIds: [1] });
    expect(mixedExpenseNotes(lot15, { scopeLabel: null })).toEqual([]);
  });

  it('P16 — preuve de paiement exclue (jamais un coût), avoir reconnu au titre', () => {
    expect(classifyExpenseDocument('WORKS_PAYMENT_PROOF', null)).toEqual({ kind: 'excluded', reason: 'PAYMENT_PROOF' });
    expect(classifyExpenseDocument('ACQUISITION_PAYMENT', null)).toEqual({ kind: 'excluded', reason: 'PAYMENT_PROOF' });
    expect(isCreditNoteTitle('Avoir n°12 — Garage Martin')).toBe(true);
    expect(isCreditNoteTitle('Facture, merci de nous avoir choisis')).toBe(false);
  });
});

describe('O6-06 — intentions et réponses (C15, C15.2)', () => {
  it('intentions : sinistre, historique, « payé » distinct de « coûté » (F-132, F-133)', () => {
    expect(CLAIM_Q.test(plain('Où en est mon sinistre ?'))).toBe(true);
    for (const q of ['Qu’est-ce qui a été fait sur la Polo ?', 'Quelles réparations sur la Polo ?', 'Historique des interventions de la maison']) {
      expect(HISTORY_Q.test(plain(q))).toBe(true);
    }
    expect(HISTORY_Q.test(plain('Quelles interventions prévues sur la Polo ?'))).toBe(false);
    expect(PAID.test(plain('J’ai payé combien pour la Polo ?'))).toBe(true);
    expect(PAID.test(plain('Combien m’a coûté la Polo ?'))).toBe(false);
  });

  it('F-132 — « payé » sans preuve : le règlement n’est pas affirmé, le coût est distingué', () => {
    const q = aggregateExpenses([{ fileId: 1, amountCents: 125000, cls: { kind: 'theme', theme: 'repair' } }], null);
    const r = paymentsAnswer({ proofs: [], sumCents: 0, withoutAmount: 0 }, q, { pour: ' pour la Polo', scopeLabel: 'Polo', assetIds: [20], assets: [] });
    expect(r.answer).toContain('aucune preuve de paiement pour la Polo');
    expect(r.answer).toContain('ne prouve pas qu’il a été réglé');
    expect(r.strategy).toBe('structured.payments');
    const avec = paymentsAnswer({ proofs: [{ fileId: 7, title: 'Virement', date: '2026-03-12', amountCents: 100000, operationId: 3 }], sumCents: 100000, withoutAmount: 0 }, q,
      { pour: ' pour la Polo', scopeLabel: 'Polo', assetIds: [20], assets: [] });
    expect(avec.answer).toMatch(/Règlements justifiés pour la Polo : 1\s000,00\s€ \(1 preuve de paiement/);
    expect(avec.answer).toMatch(/pas de preuve de règlement pour 250,00\s€/);
    expect(avec.sources[0].id).toBe('doc_7');
  });

  it('« où en est mon sinistre ? » : statut, indemnité, net ; source = le sinistre (lot 83D : plus de rubrique Sinistres)', () => {
    const r = claimAnswer([{
      operationId: 9, label: 'sinistre « Dégât des eaux »', assetIds: [20], occurredOn: '2026-03-01', declaredOn: '2026-03-02',
      statusLabel: 'En attente d\'indemnisation', insurerClaimRef: 'S-1', closed: false, indemnityCents: 80000, grossCents: 125000, netCents: 45000, documentIds: [], agendaItemId: null,
    }], { assets: [], ambiguous: false, unresolved: false, label: null }, [{ id: 20, name: 'Maison', category: 'IMMOBILIER', subtype: null, purchaseDate: null, isRented: false }]);
    expect(r.answer).toMatch(/Sinistre « Dégât des eaux » du 1 mars 2026 \(Maison\) : statut « En attente d'indemnisation »/);
    expect(r.answer).toMatch(/indemnité reçue : 800,00\s€ ; coût des réparations : 1\s250,00\s€ ; net après indemnité : 450,00\s€/);
    expect(r.sources[0].id).toBe('claim:20:9');
  });

  it('F-127 — coût d’une intervention précise : termes distinctifs, montant consolidé, parts à part', () => {
    expect(specificCostTerms('Combien a coûté la réparation du toit ?')).toEqual(['toit']);
    expect(specificCostTerms('Combien ai-je dépensé pour la Polo en 2025 ?', ['Polo'])).toEqual([]);
    expect(specificCostTerms('Combien m’a coûté la Polo ?', ['Polo'])).toEqual([]);
    const r = operationCostAnswer([{ operationId: 1, label: 'intervention « Réfection toiture »', date: '2026-03-02', provider: 'Couvreur Dupont', costCents: 240000,
      indemnityCents: 0, forecastCents: 0, foreign: [{ currency: 'CHF', amountMinor: 5000 }], unattributedCents: 0, status: 'REALIZED', source: null }],
    { assets: [], ambiguous: false, unresolved: true, label: null });
    expect(r.answer).toMatch(/^Coût de l’intervention « Réfection toiture » \(Couvreur Dupont, 2 mars 2026\) : 2\s400,00\s€ — en plus, non converti : 50,00\sCHF\.$/);
    const sinistre = operationCostAnswer([{ operationId: 2, label: 'sinistre « Vol »', date: null, provider: null, costCents: null, indemnityCents: 0, forecastCents: 0,
      foreign: [], unattributedCents: 0, status: 'REALIZED', source: null }], { assets: [], ambiguous: false, unresolved: true, label: null });
    expect(sinistre.answer).toBe('Coût du sinistre « Vol » : montant non consolidé.');
  });

  it('B15 — contrat : prestataire, n°, période ; tarif annoncé jamais présenté comme payé', () => {
    expect(CONTRACT_Q.test(plain('Quel est mon contrat d’assurance pour la Polo ?'))).toBe(true);
    expect(CONTRACT_Q.test(plain('Quelles assurances ai-je ?'))).toBe(true);
    const r = contractsAnswer([{ operationId: 1, label: 'contrat « Assurance auto »', provider: 'MAAF', reference: 'C-42', from: '2026-01-01', to: '2026-12-31',
      status: 'REALIZED', realizedCents: null, forecastCents: 60000, assetIds: [20], source: { id: 'doc_5', type: 'document', title: 'Police', content: 'x' } }],
    { assets: [], ambiguous: false, unresolved: false, label: 'Polo' });
    expect(r.answer).toMatch(/^Contrat « Assurance auto » chez MAAF \(n° C-42\), du 1 janvier 2026 au 31 décembre 2026 — tarif annoncé : 600,00\s€ \(prévisionnel\)\.$/);
    expect(r.sources.map((x) => x.id)).toEqual(['doc_5']);
  });

  it('F-134 — historique : lignes datées, intervention + document non représenté', () => {
    const r = historyAnswer({ id: 20, name: 'Polo', category: 'VEHICULE', subtype: null, purchaseDate: null, isRented: false }, [
      { date: '2026-03-02', theme: 'repair', kind: 'operation', label: 'intervention « Embrayage »', amountCents: 125000, status: null, provider: 'Garage Martin', operationId: 1, fileId: null,
        source: { id: 'doc_3', type: 'document', title: 'Facture', content: 'x' } },
      { date: '2021-05-01', theme: 'maintenance', kind: 'document', label: 'document « Révision 2021 »', amountCents: 18000, status: null, provider: null, operationId: null, fileId: 8,
        source: { id: 'doc_8', type: 'document', title: 'Révision 2021', content: 'y' } },
    ], null);
    expect(r.answer).toContain('Ce qui a été fait sur Polo :');
    expect(r.answer).toMatch(/2 mars 2026 : intervention « Embrayage » \(Garage Martin\) — 1\s250,00\s€/);
    expect(r.sources.map((s) => s.id)).toEqual(['doc_3', 'doc_8']);
  });
});

describe('O6-07 — sources ouvrables : document ou sinistre, jamais une « Opération »', () => {
  it('sinistre : `claim:<bien>:<id>` → élément d’Agenda principal (tiroir) sinon fiche du bien — lot 83D : plus de section Sinistres (desktop et mobile)', () => {
    expect(claimSourceId(20, 9)).toBe('claim:20:9');
    expect(parseClaimSourceId('claim:20:9')).toEqual({ assetId: 20, claimId: 9 });
    expect(parseClaimSourceId('claim:x:9')).toBeNull();
    const ref = parseEntityRef('claim:20:9');
    expect(ref).toMatchObject({ kind: 'asset', id: 20, claimId: 9 });
    expect(hrefEntite(ref!)).toBe('/assets/20');
    expect(hrefSource('claim:20:9')).toBe('/assets/20');
    expect(hrefSource('claim:20:9', { agendaItemId: 77 })).toMatch(/77/);
    expect(hrefSource('claim:20:9', { agendaItemId: 77 })).not.toMatch(/highlight=claims/);
    expect(parseEntityRef('claim:20:9', 'document')).toBeNull();
  });
  it('coût consolidé : document principal (facture), sinon rien', () => {
    const o = op({ components: [comp('REALIZED_COST', 1000)] });
    const [l] = operationCostLines([o], { assetIds: [20] });
    const s = costLineSource(l, { assetId: 20, assetName: 'Polo' });
    expect(s).toMatchObject({ id: `doc_${o.documents[0].fileId}`, type: 'document' });
    expect(hrefSource(s!.id)).toMatch(/tiroir=document/);
    const sansDoc = op({ documents: [], components: [comp('REALIZED_COST', 1000)] });
    expect(costLineSource(operationCostLines([sansDoc], { assetIds: [20] })[0])).toBeNull();
  });
});

describe('O6-08 — cache de l’assistant invalidé par les événements Opération (Q10, C21.1)', () => {
  const bump = vi.fn(async () => {});
  const invalidate = vi.fn(() => 0);
  beforeEach(() => { bump.mockClear(); invalidate.mockClear(); vi.resetModules(); });

  it('abonnement au bus Opérations, sans élargir le catalogue fermé ; compte quitté invalidé aussi', async () => {
    vi.doMock('../../core/retrieval-cache', () => ({
      bumpRetrievalCacheVersion: bump, invalidateRetrievalCacheForAccount: invalidate, clearRetrievalCache: vi.fn(),
    }));
    const bus = await import('@/services/business-operations/events');
    bus.resetBusinessOperationEventBusForTests();
    const h = await import('../../events/handlers');
    const ev = await import('../../events/business-events');
    h.resetAssistantHandlersForTests();
    h.registerAssistantBusinessEventHandlers();
    h.registerAssistantBusinessEventHandlers();
    await bus.publishBusinessOperationEvents([
      { type: 'BUSINESS_OPERATION_FINANCIAL_CHANGED', accountId: 5, operationId: 1, correlationId: 'c', occurredAt: 'x' },
      { type: 'BUSINESS_OPERATION_TARGET_CHANGED', accountId: 6, previousAccountId: 5, operationId: 2, correlationId: 'c', occurredAt: 'x' },
    ]);
    expect(bump.mock.calls).toEqual([[5, 'BUSINESS_OPERATION_FINANCIAL_CHANGED'], [6, 'BUSINESS_OPERATION_TARGET_CHANGED'], [5, 'BUSINESS_OPERATION_TARGET_CHANGED']]);
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(ev.ASSISTANT_BUSINESS_EVENTS).toHaveLength(14);
    expect(ev.isAssistantEventType('BUSINESS_OPERATION_CREATED')).toBe(false);
    vi.doUnmock('../../core/retrieval-cache');
  });
});
