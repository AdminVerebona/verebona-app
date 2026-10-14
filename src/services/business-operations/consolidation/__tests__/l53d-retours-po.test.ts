/**
 * Lot 53D — retours PO du 12/10/2026 sur les lots 37 à 51 : D2 (devises),
 * Q16 (contre-valeur EUR et capital emprunté), D9 (prix d'achat saisi,
 * écarts, frais annexes), D12 (portée d'un total « incomplet »). Règles
 * PURES : barrière T1, projection, consolidation T3, cartes, lecture T2.
 * Tests nommés PO-D2-xx, PO-Q16-xx, PO-D9-xx, PO-D12-xx.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const { currenciesNextToAmount, detectDocumentCurrency, storableCurrency, isCurrencyEstablished } = await import('@/lib/document-currency');
const { gateOperationCandidates, isLoanPrincipalText } = await import('@/services/ai/source-analysis/operation-candidates/prepare');
const { buildCandidateIdentity, consolidateOperationState, componentsFromIdentity, applyCurrencyChoices, consolidateComponentsDetailed } = await import('../model');
const { applyStructuredAuthority, assetDataContribution, assetDataFacts } = await import('../asset-data');
const { currencyProposals, currencyQuestion, parseOperationCardChoice, formatAmount } = await import('@/services/to-process/operation-cards');
const { componentEurCents, formatMinorAmount, operationCostLines, summarizeOperationCosts } = await import('@/services/verebona-assistant/canonical/operations');
const { aggregateExpenses, expenseCoverageComplete, mixedExpenseNotes } = await import('@/services/verebona-assistant/canonical/expenses');
const { acquisitionSideNotes } = await import('@/services/verebona-assistant/canonical/structured-answers');

type Anchored = import('@/services/ai/source-analysis/operation-candidates/prepare').AnchoredOperationCandidate;
type Hint = Anchored['financialHints'][number];
type Gate = Parameters<typeof gateOperationCandidates>[1];

const hint = (over: Partial<Hint> = {}): Hint => ({
  role: 'REALIZED_COST', amountMinor: 74900, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1', ...over,
});
const cand = (over: Partial<Anchored> = {}): Anchored => ({
  candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED', summary: 'Facture',
  sourceRoleHint: 'INVOICE', provider: null, targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [hint()],
  evidenceFactRefs: ['f1'], visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
});
const gate = (c: Anchored, ev: { rawValue?: string | null; excerpt?: string | null; key?: string | null; transcription?: string | null }): Anchored => {
  const ctx: Gate = {
    hasExploitableContent: true, documentTypeCode: null,
    verifiedIds: { ASSET: new Set(), EQUIPMENT: new Set(), ROOM: new Set() }, capabilities: { rooms: true, equipments: true },
    keptFactRefs: new Set(['f1']),
    currencyEvidence: {
      facts: new Map([['f1', { rawValue: ev.rawValue ?? null, excerpt: ev.excerpt ?? null, key: ev.key ?? null }]]),
      transcription: ev.transcription ?? null,
    },
  };
  return gateOperationCandidates([c], ctx).candidates[0];
};
const identite = (financialHints: unknown[], over: { typeHint?: string; role?: string; fileId?: number; id?: number; refs?: Array<{ kind: string; value: string }> } = {}) =>
  buildCandidateIdentity({
    id: over.id ?? 1, accountId: 1, fileId: over.fileId ?? 50, candidateKey: 'op1', established: true, confidence: 'certain',
    typeHint: over.typeHint ?? 'INTERVENTION', statusHint: 'REALIZED', summary: 'x',
    payload: { sourceRoleHint: over.role ?? 'INVOICE', businessReferences: over.refs ?? [], financialHints: financialHints as never },
  }, { fileAssetId: 7, liveAssetIds: new Set([7]), equipmentAssets: new Map() });

// ════════════════════════════════════════════════════════════════════════════
describe('PO-D2 — devise présumée : montant conservé, hors agrégats EUR, confirmation demandée', () => {
  it('PO-D2-01 devise écrite À CÔTÉ du montant (avant / après, formats FR et CH), jamais un sous-montant', () => {
    expect(currenciesNextToAmount(['Total TTC 749,00 €'], 74900)).toEqual(['EUR']);
    expect(currenciesNextToAmount(['Montant : CHF 1\'250.00'], 125000)).toEqual(['CHF']);
    expect(currenciesNextToAmount(['1 250,00 CHF soit 1 300,00 € débités'], 130000)).toEqual(['EUR']);
    expect(currenciesNextToAmount(['1 250,00 CHF soit 1 300,00 € débités'], 125000)).toEqual(['CHF']);
    // « 250,00 » n'est pas lu dans « 1 250,00 CHF », ni « 1 250,00 » dans « 11 250,00 € ».
    expect(currenciesNextToAmount(['Total 1 250,00 CHF'], 25000)).toEqual([]);
    expect(currenciesNextToAmount(['Total 11 250,00 €'], 125000)).toEqual([]);
    expect(currenciesNextToAmount(['TOTAL TTC 129,00'], 12900)).toEqual([]);
  });

  it('PO-D2-02 (bug reproduit) aucune devise écrite : l’indice « EUR » du modèle devient « XXX », montant conservé, EUR à confirmer', () => {
    const c = gate(cand(), { excerpt: 'Total TTC 749,00', transcription: 'GARAGE MARTIN\nVidange\nTotal TTC 749,00' });
    expect(c.financialHints[0]).toMatchObject({ amountMinor: 74900, currency: 'XXX', currencyCandidates: ['EUR'], currencyBasis: 'PRESUMED' });
    expect(c.adjustments).toContain('CURRENCY_NOT_ESTABLISHED');
    // Jamais déduit du seul contexte du compte : la détection reste une présomption, stockée « XXX ».
    const d = detectDocumentCurrency({ amountExcerpt: 'Total TTC 749,00', transcription: 'Total TTC 749,00' });
    expect(isCurrencyEstablished(d)).toBe(false);
    expect(storableCurrency(d)).toBe('XXX');
  });

  it('PO-D2-03 devise écrite : retenue (y compris corrigée quand le modèle se trompe), aucune question', () => {
    expect(gate(cand(), { excerpt: 'Total TTC 749,00 €' }).financialHints[0]).toMatchObject({ currency: 'EUR' });
    expect(gate(cand(), { excerpt: 'Total TTC 749,00', transcription: 'Tous les montants sont en euros.\nTotal TTC 749,00' }).financialHints[0].currency).toBe('EUR');
    const corrige = gate(cand({ financialHints: [hint({ amountMinor: 125000 })] }), { excerpt: 'Total 1 250,00 CHF' });
    expect(corrige.financialHints[0]).toMatchObject({ currency: 'CHF' });
    expect(corrige.adjustments).toContain('CURRENCY_READ_NEXT_TO_AMOUNT');
    // Modèle sans devise (« XXX ») et document en une seule devise : devise du document.
    expect(gate(cand({ financialHints: [hint({ currency: 'XXX' })] }), { excerpt: 'Total 749,00', transcription: 'Prix en CHF\nTotal 749,00' }).financialHints[0].currency).toBe('CHF');
  });

  it('PO-D2-04 plusieurs devises sans précision : « XXX » ambigu, devises plausibles gardées', () => {
    const h = gate(cand(), { excerpt: 'Total 749,00', transcription: 'Paiement en CHF — environ 780,00 € — Total 749,00' }).financialHints[0];
    expect(h).toMatchObject({ currency: 'XXX', currencyBasis: 'AMBIGUOUS' });
    expect(h.currencyCandidates).toEqual(expect.arrayContaining(['EUR', 'CHF']));
  });

  it('PO-D2-05 T3 : composante « XXX » hors agrégat EUR ; même montant établi par une autre source → devise confirmée sans question', () => {
    const xxx = identite([{ role: 'REALIZED_COST', amountMinor: 74900, currency: 'XXX', currencyCandidates: ['EUR'], amountScope: 'TOTAL' }], { refs: [{ kind: 'INVOICE', value: 'F-1' }] });
    const [c] = componentsFromIdentity(xxx);
    expect(c).toMatchObject({ currency: 'XXX', currencyCandidates: ['EUR'], amountEurCents: null });
    expect(componentEurCents({ amountMinor: 74900, currency: 'XXX', amountEurCents: null })).toBeNull();
    const eur = identite([{ role: 'REALIZED_COST', amountMinor: 74900, currency: 'EUR', amountScope: 'TOTAL' }], { refs: [{ kind: 'INVOICE', value: 'F-1' }], id: 2, fileId: 51 });
    const r = consolidateComponentsDetailed([{ sourceId: 1, components: componentsFromIdentity(xxx) }, { sourceId: 2, components: componentsFromIdentity(eur) }]);
    expect(r.conflicts).toEqual([]);
    expect(r.components.map((x) => [x.currency, x.sourceIds])).toEqual([['EUR', [1, 2]]]);
  });

  it('PO-D2-06 décision utilisateur : devise choisie appliquée ; « je ne sais pas » laisse « XXX »', () => {
    const [c] = consolidateComponentsDetailed([{ sourceId: 1, components: componentsFromIdentity(identite([{ role: 'REALIZED_COST', amountMinor: 74900, currency: 'XXX', amountScope: 'TOTAL' }])) }]).components;
    expect(applyCurrencyChoices([c], new Map([[c.fingerprint, { currency: 'EUR' }]]))[0]).toMatchObject({ currency: 'EUR', fingerprint: c.fingerprint });
    expect(applyCurrencyChoices([c], new Map([[c.fingerprint, { currency: null }]]))[0].currency).toBe('XXX');
  });

  it('PO-D2-07 carte « À traiter » : question métier, propositions fermées, choix forgé refusé, montant affiché sans « ¤ »', () => {
    expect(currencyQuestion(74900)).toBe('Aucune devise n’est écrite clairement pour le montant 749,00 de ce document : de quelle devise s’agit-il ?');
    expect(currencyProposals(['EUR', 'CHF']).map((p) => [p.value, p.label])).toEqual([
      ['CURRENCY:EUR', 'En euros'], ['CURRENCY:CHF', 'En francs suisses'], ['UNKNOWN', 'Je ne sais pas — le laisser hors des totaux'],
    ]);
    const ctx = { kind: 'operation_currency', operationId: 1, fingerprint: 'f', amountMinor: 74900, candidates: ['EUR'] };
    expect(parseOperationCardChoice('OPERATION-CURRENCY', 'CURRENCY:EUR', ctx)).toEqual({ kind: 'CURRENCY', currency: 'EUR' });
    expect(parseOperationCardChoice('OPERATION-CURRENCY', 'UNKNOWN', ctx)).toEqual({ kind: 'CURRENCY', currency: null });
    expect(parseOperationCardChoice('OPERATION-CURRENCY', 'CURRENCY:USD', ctx)).toBeNull();
    expect(formatAmount(74900, 'XXX')).toBe('749,00 (devise non établie)');
    expect(formatMinorAmount(74900, 'XXX')).toBe('749,00 (devise non établie)');
  });

  it('PO-D2-08 T2 : un montant « XXX » n’est jamais additionné en euros, il est cité à part comme devise à confirmer', () => {
    const op = {
      id: 9, active: true, typeCode: 'INTERVENTION', status: 'REALIZED', technicalLabel: 'Vidange', provider: null, realizedDate: '2026-03-01', startDate: null, plannedDate: null,
      assetIds: [7], documents: [], components: [{ id: 1, kind: 'REALIZED_COST', amountMinor: 74900, currency: 'XXX', amountEurCents: null, economicDate: null, targetAssetId: null, label: null }],
    } as never;
    const { part } = summarizeOperationCosts(operationCostLines([op], { assetIds: [7] }), null);
    expect(part.sumCents).toBe(0);
    expect(part.foreign).toEqual([{ currency: 'XXX', amountMinor: 74900 }]);
    const q = { ...aggregateExpenses([], null), operations: part };
    expect(mixedExpenseNotes(q as never, { scopeLabel: 'la Clio' }).join(' ')).toContain('dont la devise n’est pas écrite sur le document, à confirmer et non compté en euros : 749,00 (devise non établie)');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PO-Q16 — contre-valeur EUR documentaire et capital emprunté', () => {
  it('PO-Q16-01 contre-valeur EUR ÉCRITE sur le document : gardée, devise d’origine tracée ; non écrite : retirée', () => {
    const lu = gate(cand({ financialHints: [hint({ amountMinor: 125000, currency: 'CHF', amountEurMinor: 130000 })] }),
      { excerpt: 'Total 1 250,00 CHF', transcription: 'Total 1 250,00 CHF\nMontant débité : 1 300,00 €' });
    expect(lu.financialHints[0]).toMatchObject({ currency: 'CHF', amountMinor: 125000, amountEurMinor: 130000 });
    const invente = gate(cand({ financialHints: [hint({ amountMinor: 125000, currency: 'CHF', amountEurMinor: 131000 })] }),
      { excerpt: 'Total 1 250,00 CHF', transcription: 'Total 1 250,00 CHF\nMontant débité : 1 300,00 €' });
    expect(invente.financialHints[0].amountEurMinor).toBeUndefined();
    expect(invente.adjustments).toContain('EUR_COUNTERVALUE_NOT_READ');
  });

  it('PO-Q16-02 T3 : la contre-valeur documentaire alimente l’agrégat EUR, le montant d’origine reste en CHF', () => {
    const [c] = componentsFromIdentity(identite([{ role: 'REALIZED_COST', amountMinor: 125000, currency: 'CHF', amountEurMinor: 130000, amountScope: 'TOTAL' }]));
    expect(c).toMatchObject({ amountMinor: 125000, currency: 'CHF', amountEurCents: 130000 });
    expect(componentEurCents(c)).toBe(130000);
    // Jamais pour un montant en euros ou de devise non établie.
    expect(componentsFromIdentity(identite([{ role: 'REALIZED_COST', amountMinor: 100, currency: 'XXX', amountEurMinor: 100, amountScope: 'TOTAL' }]))[0].amountEurCents).toBeNull();
  });

  it('PO-Q16-03 capital emprunté : jamais une dépense — reclassé par la barrière, porté par le détail du financement', () => {
    expect(isLoanPrincipalText('Capital emprunté : 15 000,00 €')).toBe(true);
    expect(isLoanPrincipalText('Frais de dossier 150,00 €')).toBe(false);
    const c = gate(cand({ typeHint: 'FINANCING', sourceRoleHint: 'CONTRACT_DOCUMENT', financialHints: [hint({ amountMinor: 1500000 })] }),
      { key: 'montantEmprunte', excerpt: 'Montant du prêt : 15 000,00 €' });
    expect(c.financialHints[0]).toMatchObject({ role: 'LOAN_PRINCIPAL', currency: 'EUR' });
    expect(c.adjustments).toContain('LOAN_PRINCIPAL_NOT_A_COST');
    const id = identite([
      { role: 'LOAN_PRINCIPAL', amountMinor: 1500000, currency: 'EUR', amountScope: 'TOTAL' },
      { role: 'REALIZED_COST', amountMinor: 15000, currency: 'EUR', amountScope: 'FEE' },
    ], { typeHint: 'FINANCING', role: 'CONTRACT_DOCUMENT' });
    const s = consolidateOperationState('FINANCING', [{ sourceId: 1, identity: id }], '2026-10-13');
    expect(s.financing).toMatchObject({ principalAmountMinor: 1500000, principalCurrency: 'EUR' });
    expect(s.components.map((x) => [x.kind, x.amountMinor])).toEqual([['FORECAST_COST', 15000]]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PO-D9 — prix d’achat saisi : référence conservée, écarts exposés, frais isolés', () => {
  const doc = (financialHints: unknown[]) => ({ sourceId: 1, identity: identite(financialHints, { typeHint: 'ACQUISITION' }) });
  const humain = (k: string, v: unknown) => ({ [k]: v, [`${k}__origin`]: 'USER' });
  const saisie = (prix: number) => {
    const row = { id: 7, account_id: 1, category: 'VEHICULE', key_characteristics: JSON.stringify(humain('acquisitionPrice', prix)), status: 'EN_SERVICE', status_changed_at: null } as never;
    expect(assetDataFacts(row).ACQUISITION).not.toBeNull();
    return assetDataContribution(2, row, 'ACQUISITION')!;
  };
  const etat = (sources: Parameters<typeof consolidateOperationState>[1]) => applyStructuredAuthority(consolidateOperationState('ACQUISITION', sources, '2026-10-13'), sources);

  it('PO-D9-01 (bug reproduit) prix facture ≠ saisie : la saisie reste comptée, l’écart est CONSERVÉ hors total (plus effacé en silence)', () => {
    const s = etat([doc([{ role: 'REALIZED_COST', amountMinor: 1900000, currency: 'EUR', amountScope: 'TOTAL' }]), saisie(18490.5)]);
    expect(s.components.map((c) => [c.kind, c.amountMinor, c.sourceIds])).toEqual([['REALIZED_COST', 1849050, [2]]]);
    expect(s.sideAmounts.map((x) => [x.nature, x.amountMinor, x.sourceIds])).toEqual([['DOCUMENT_AMOUNT_DIFFERS', 1900000, [1]]]);
  });

  it('PO-D9-02 frais annexes d’un achat (portée FEE) : isolés, jamais additionnés au prix ; même facture, plusieurs frais distincts', () => {
    const s = etat([doc([
      { role: 'REALIZED_COST', amountMinor: 1849050, currency: 'EUR', amountScope: 'TOTAL' },
      { role: 'REALIZED_COST', amountMinor: 45000, currency: 'EUR', amountScope: 'FEE' },
      { role: 'REALIZED_COST', amountMinor: 27600, currency: 'EUR', amountScope: 'FEE' },
    ]), saisie(18490.5)]);
    expect(s.components.map((c) => c.amountMinor)).toEqual([1849050]);
    expect(s.sideAmounts.map((x) => [x.nature, x.amountMinor]).sort()).toEqual([['ANCILLARY_FEE', 27600], ['ANCILLARY_FEE', 45000]]);
    // Hors achat (intervention), un frais facturé reste un coût de l'intervention.
    const inter = consolidateOperationState('INTERVENTION', [{ sourceId: 1, identity: identite([{ role: 'REALIZED_COST', amountMinor: 4500, currency: 'EUR', amountScope: 'FEE' }]) }], '2026-10-13');
    expect(inter.components.map((c) => c.amountMinor)).toEqual([4500]);
    expect(inter.sideAmounts).toEqual([]);
  });

  it('PO-D9-03 T2 : écart et frais dits à part, la saisie reste la référence', () => {
    const espaces = (t: string) => t.replace(/[\s\u00a0\u202f]+/g, ' ');
    expect(espaces(acquisitionSideNotes({
      priceCents: 1849050,
      documentPrices: [{ amountMinor: 1900000, currency: 'EUR', title: 'Facture concession' }],
      fees: [{ amountMinor: 45000, currency: 'EUR', title: 'Facture concession' }],
    }))).toBe(' Le document « Facture concession » indique 19 000,00 € : la valeur saisie sur la fiche est conservée comme référence.'
      + ' Frais annexes connus, non inclus dans ce prix : 450,00 € « Facture concession ».');
    expect(acquisitionSideNotes({ priceCents: 100 })).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('PO-D12 — total « incomplet » qualifié au bon périmètre', () => {
  const docs = (over: Record<string, unknown> = {}) => ({
    count: 0, sumCents: 0, represented: { count: 0, fileIds: [] }, representedElsewhere: { count: 0, fileIds: [] },
    unattributed: { count: 0, sumCents: 0, fileIds: [] }, creditNotes: { count: 0, sumCents: 0 },
    unconfirmedAsset: { count: 0, sumCents: 0, items: [] }, countedForOtherAssets: { count: 0, fileIds: [] }, foreign: [], ...over,
  });
  const vide = () => ({ ...aggregateExpenses([], null), operations: summarizeOperationCosts([], null).part });

  it('PO-D12-01 dépense sans bien confirmé liée à un document du bien : incomplet AU NIVEAU DU BIEN, dépense identifiée', () => {
    const d = docs({
      representedElsewhere: { count: 1, fileIds: [5] },
      unconfirmedAsset: { count: 1, sumCents: 40000, items: [{ fileId: 5, operationId: 9, label: 'intervention « Carrosserie »', amountCents: 40000 }] },
    });
    expect(expenseCoverageComplete(summarizeOperationCosts([], null).part, d as never)).toBe(false);
    expect(mixedExpenseNotes({ ...vide(), documents: d } as never, { scopeLabel: 'la Polo' }).join(' ')).toContain(
      '1 document pour la Polo est rattaché à une dépense dont le bien n’est pas confirmé : intervention « Carrosserie » (400,00 €) — non comptée pour la Polo, le total peut être incomplet de ce montant.');
  });

  it('PO-D12-02 (bug reproduit) dépense attribuée à un AUTRE bien : le total de ce bien n’est pas dégradé', () => {
    const d = docs({ representedElsewhere: { count: 1, fileIds: [5] }, countedForOtherAssets: { count: 1, fileIds: [5] } });
    expect(expenseCoverageComplete(summarizeOperationCosts([], null).part, d as never)).toBe(true);
    expect(mixedExpenseNotes({ ...vide(), documents: d } as never, { scopeLabel: 'la Polo' }).join(' '))
      .toContain('1 document lié pour la Polo concerne une dépense attribuée à un autre bien : comptée pour cet autre bien.');
  });

  it('PO-D12-03 dépense sans bien du compte, sans lien avec le bien : incertitude de niveau COMPTE, exposée sans dégrader le bien', () => {
    const q = { ...vide(), documents: docs(), accountUnassigned: { count: 2, sumCents: 65000, labels: [] } };
    expect(expenseCoverageComplete(q.operations, q.documents as never)).toBe(true);
    expect(mixedExpenseNotes(q as never, { scopeLabel: 'la Polo' }).join(' '))
      .toContain('Au niveau du compte, 2 dépenses sans bien identifié (650,00 €) ne sont imputées à aucun bien, ni à la Polo.');
  });

  it('PO-D12-04 forme historique (sans qualification) : comportement du lot 45 conservé', () => {
    const d = { ...docs({ representedElsewhere: { count: 1, fileIds: [5] } }), unconfirmedAsset: undefined, countedForOtherAssets: undefined };
    expect(expenseCoverageComplete(summarizeOperationCosts([], null).part, d as never)).toBe(false);
  });
});
