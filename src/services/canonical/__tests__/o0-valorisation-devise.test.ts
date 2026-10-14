/**
 * Lot 38 — O0 (CDC Opérations V1 §11.4, §19, B18, C12.3, C18, INV-010 ;
 * décision PO Q12).
 *
 *   O0-06  valeur estimée : autorité PROPRE (expertise / estimation), plus
 *          héritée du prix d'achat ; preuve venue d'une facture écartée (T3) ;
 *   O0-07  `valuationHistory` : alimenté automatiquement par toute écriture
 *          automatique légitime de estimatedValue (avec sa source), jamais
 *          pour une saisie humaine (chemin propre), ni une correction
 *          technique ;
 *   O0-08  devise : détection, refus explicite d'une devise étrangère par le
 *          registre, devise conservée dans la représentation documentaire.
 *   F-161 : « Valuation doc fiable → valuationHistory, pas Operation ».
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: {}, db: {} }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent: vi.fn(async () => {}) }));

const { planCanonicalWrites } = await import('../asset-state/write-canonical-asset-field');
const { resolveAuthority, getAuthorityMatrix } = await import('@/services/ai/reconciliation/decision/authority-matrix');
const { toEvidenceCandidates } = await import('@/services/ai/reconciliation/evidence-collector');
const { isValuationEvidenceAdmissible, isTransactionDocumentType } = await import('../valuation-semantics');
const { normalizeValue } = await import('@/services/canonical/registry');
const { currenciesIn, detectDocumentCurrency, isEurAmount, storableCurrency } = await import('@/lib/document-currency');
const { buildKnowledgeFromSourceAnalysis } = await import('@/services/ai/knowledge/document-knowledge');

const NOW = '2026-10-11T10:00:00.000Z';
const row = (kc: Record<string, unknown> = {}) => ({
  id: 1, account_id: 7, category: 'OBJECT', key_characteristics: JSON.stringify(kc), updated_at: NOW,
  status: 'EN_SERVICE', lock_state: 'NONE', purchase_date: null, purchase_price_cents: null,
  registration_number: null, address: null, city: null, postal_code: null, warranty_end_date: null,
  mileage_or_hours: null,
}) as never;

describe('O0-06 — autorité propre de la valeur estimée (C18, INV-010)', () => {
  it('O0-06a la valeur estimée n’hérite plus de l’autorité du prix d’achat', () => {
    const m = getAuthorityMatrix();
    expect(m.fieldOrders.estimatedValue).toEqual(expect.arrayContaining(['VALUE_APPRAISAL', 'VALUE_ESTIMATE']));
    expect(m.fieldOrders.estimatedValue).not.toContain('FACTURE');
    expect(m.fieldOrders.estimatedValue).not.toContain('ACTE_AUTHENTIQUE');
    // Une facture ne prend plus le rang explicite du prix d'achat pour la valeur estimée.
    expect(resolveAuthority({ fieldKey: 'acquisitionPrice', documentType: 'FACTURE' }).rule).toMatch(/acquisitionPrice#/);
    expect(resolveAuthority({ fieldKey: 'estimatedValue', documentType: 'FACTURE' }).rule).toMatch(/:base:FACTURE$/);
    const expertise = resolveAuthority({ fieldKey: 'estimatedValue', documentType: 'VALUE_APPRAISAL' });
    expect(expertise.rule).toMatch(/estimatedValue#0$/);
    expect(expertise.score).toBeGreaterThan(resolveAuthority({ fieldKey: 'estimatedValue', documentType: 'ACTE_AUTHENTIQUE' }).score);
  });

  it('O0-06b T3 : une preuve de valeur estimée venue d’une facture / d’un devis est écartée ; une expertise reste', () => {
    const ev = (id: number, documentType: string) => ({
      id, value: 1000, confidence: 'certain', documentType, sourceId: id, sourceType: 'asset_file', excerpt: 'Valeur 1 000 €',
    });
    const c = toEvidenceCandidates('estimatedValue', [ev(1, 'FACTURE'), ev(2, 'DEVIS'), ev(3, 'VALUE_APPRAISAL')] as never);
    expect(c.map((x) => x.evidenceId)).toEqual([3]);
    // Le prix d'achat garde ses preuves de facture.
    expect(toEvidenceCandidates('acquisitionPrice', [ev(1, 'FACTURE')] as never)).toHaveLength(1);
    expect(isValuationEvidenceAdmissible('estimatedValue', 'ACQUISITION_INVOICE')).toBe(false);
    expect(isValuationEvidenceAdmissible('estimatedValue', 'CLAIM_APPRAISAL')).toBe(true);
    expect(isTransactionDocumentType('WORKS_PAYMENT_PROOF')).toBe(true);
    expect(isTransactionDocumentType('VALUE_ESTIMATE')).toBe(false);
  });
});

describe('O0-07 — valuationHistory (décision PO Q12)', () => {
  it('F-161 valorisation automatique fiable (T3, expertise) : entrée valuationHistory avec sa source', () => {
    const p = planCanonicalWrites(row({ valuationHistory: [{ id: 'v0', value: 800, source: 'USER' }] }), [
      { key: 'estimatedValue', value: 1200, trace: { evidenceId: 55, sourceDate: '2026-09-01T00:00:00.000Z' } },
    ], { origin: 'RECONCILIATION', now: NOW, source: { type: 'document', id: 42 } });
    const h = p.kc.valuationHistory as Array<Record<string, unknown>>;
    expect(h).toHaveLength(2);
    expect(h[1]).toMatchObject({
      value: 1200, date: '2026-09-01', source: 'AI', origin: 'RECONCILIATION',
      sourceType: 'document', sourceId: '42', evidenceId: 55, addedAt: NOW,
    });
  });

  it('O0-07a date de valorisation écrite dans le même lot : elle prime sur la date du document', () => {
    const p = planCanonicalWrites(row({ estimatedValueDate: '2020-01-01', estimatedValueDate__origin: 'RECONCILIATION' }), [
      { key: 'estimatedValue', value: 1200 }, { key: 'estimatedValueDate', value: '2026-08-15' },
    ], { origin: 'RECONCILIATION', now: NOW, source: { type: 'document', id: 1 } });
    expect((p.kc.valuationHistory as Array<Record<string, unknown>>)[0]).toMatchObject({ value: 1200, date: '2026-08-15' });
  });

  it('O0-07b saisie humaine : rien ajouté ici (chemin propre de la fiche) ; valeur identique ou retrait : rien', () => {
    const humain = planCanonicalWrites(row(), [{ key: 'estimatedValue', value: 900 }], { origin: 'USER', now: NOW });
    expect(humain.kc.valuationHistory).toBeUndefined();
    const meme = planCanonicalWrites(row({ estimatedValue: 900, estimatedValue__origin: 'RECONCILIATION' }), [{ key: 'estimatedValue', value: 900 }], { origin: 'RECONCILIATION', now: NOW });
    expect(meme.kc.valuationHistory).toBeUndefined();
    const retrait = planCanonicalWrites(row({ estimatedValue: 900, estimatedValue__origin: 'RECONCILIATION' }), [{ key: 'estimatedValue', value: null }], { origin: 'RECONCILIATION', now: NOW });
    expect(retrait.kc.valuationHistory).toBeUndefined();
    const migration = planCanonicalWrites(row({ estimatedValue: 90000, estimatedValue__origin: 'RECONCILIATION' }), [{ key: 'estimatedValue', value: 900 }], { origin: 'RECONCILIATION', now: NOW, source: { type: 'migration', id: 'MIG-02' } });
    expect(migration.kc.valuationHistory).toBeUndefined();
  });

  it('O0-07c une écriture automatique du prix d’achat n’alimente jamais l’historique de valorisation', () => {
    const p = planCanonicalWrites(row(), [{ key: 'acquisitionPrice', value: 129 }], { origin: 'RECONCILIATION', now: NOW, source: { type: 'document', id: 9 } });
    expect(p.kc.valuationHistory).toBeUndefined();
    expect(p.kc.estimatedValue).toBeUndefined();
  });
});

describe('O0-08 — devise conservée, jamais présumée à tort (C12.3)', () => {
  it('O0-08a détection : montant, document, présumée, indéterminée', () => {
    expect(currenciesIn('TOTAL 1 250,00 CHF')).toEqual(['CHF']);
    expect(currenciesIn('Prix : 129 € — soit US$ 140')).toEqual(['EUR', 'USD']);
    expect(currenciesIn('3 dollars canadiens et 2 C$')).toEqual(['CAD']);
    expect(currenciesIn('Polynésie : 12 000 F CFP')).toEqual(['XPF']);
    expect(currenciesIn('Europe, Eurostar, cad. ')).toEqual([]);
    expect(detectDocumentCurrency({ amountExcerpt: 'Total 12,00 £' })).toMatchObject({ code: 'GBP', basis: 'amount' });
    expect(detectDocumentCurrency({ amountExcerpt: 'Total 12,00', transcription: 'Montants en CHF' })).toMatchObject({ code: 'CHF', basis: 'document' });
    expect(detectDocumentCurrency({ amountExcerpt: 'Total 12,00', transcription: 'Ticket\nTotal 12,00' })).toMatchObject({ code: 'EUR', basis: 'presumed' });
    const ambigu = detectDocumentCurrency({ amountExcerpt: 'Total 12,00', transcription: '12,00 CHF soit 12,40 €' });
    expect(ambigu).toMatchObject({ code: null, basis: 'ambiguous' });
    expect(isEurAmount(ambigu)).toBe(false);
    expect(storableCurrency(ambigu)).toBe('XXX');
  });

  it('O0-08b registre : un montant en devise étrangère est refusé pour un champ en euros (aucune conversion)', () => {
    for (const brut of ['1 250 CHF', 'CHF 1 250', '$ 1 250', 'USD 1250', '1 250 £']) {
      const r = normalizeValue('acquisitionPrice', brut);
      expect(r.ok, brut).toBe(false);
    }
    expect(normalizeValue('estimatedValue', 1000, { sourceUnit: 'CHF' })).toMatchObject({ ok: false });
    expect(normalizeValue('acquisitionPrice', '749 €')).toEqual({ ok: true, value: 749 });
    expect(normalizeValue('acquisitionPrice', '€ 749')).toEqual({ ok: true, value: 749 });
  });

  it('O0-08c représentation documentaire : devise détectée conservée (plus « EUR » d’office)', () => {
    const base = {
      sourceGroup: { sourceIds: [1], leadSourceId: 1 },
      assetCandidates: [], roomCandidates: [], equipmentCandidates: [], extractedFields: [], agendaCandidates: [], warnings: [],
      operationTrace: { usedFallback: false, models: ['m'], traceIds: ['t'] },
    };
    const ctx = { accountId: 1, fileId: 1, analysisRunId: null, assetIdAtAnalysis: null, sourceType: 'asset_file' as const };
    const chf = buildKnowledgeFromSourceAnalysis({ ...base, document: {
      amountCents: { value: 125000, confidence: 'certain', excerpt: 'Total 1 250,00 CHF', location: {} },
      transcription: 'Garage SA — Lausanne\nTotal 1 250,00 CHF',
    } } as never, ctx);
    expect(chf.extraction.currency).toBe('CHF');
    expect(chf.extraction.metadata.currencyDetection).toEqual({ basis: 'amount', seen: ['CHF'] });
    const fr = buildKnowledgeFromSourceAnalysis({ ...base, document: {
      amountCents: { value: 12900, confidence: 'certain', excerpt: 'TOTAL TTC 129,00', location: {} }, transcription: 'TOTAL TTC 129,00',
    } } as never, ctx);
    // Lot 53D (PO-D2) : aucune devise écrite → euro seulement présumé, stocké « XXX » (hors agrégats EUR).
    expect(fr.extraction.currency).toBe('XXX');
  });
});
