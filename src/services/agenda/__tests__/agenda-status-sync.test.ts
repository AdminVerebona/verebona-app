/**
 * Réconciliation de statut branchée (CDC 15 T4-12 à T4-14, lot 14 volet B) :
 * correspondance preuve ↔ échéance, gouvernance, effets par décision.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  proofs: [] as unknown[],
  items: [] as unknown[],
  current: [{ s: null }] as unknown[],
  reconcile: vi.fn(),
  propose: vi.fn(async (_p: Record<string, unknown>) => ({ status: 'CREATED', reason: '' })),
  close: vi.fn(async () => []),
  write: vi.fn(async (_i: Record<string, unknown>, _o: Record<string, unknown>) => ({ id: 1 })),
  record: vi.fn(async () => {}),
}));
vi.mock('@/db', () => ({
  db: {},
  pgClient: {
    unsafe: vi.fn(async (q: string) => (q.includes('field_evidence') ? h.proofs : q.includes('agenda_asset_links') ? h.items : h.current)),
  },
}));
vi.mock('@/services/ai/evidence/canonical-columns', () => ({ fieldEvidenceCanonicalReady: async () => true }));
vi.mock('../agenda-columns', () => ({ agendaFunctionalColumnsReady: async () => true }));
vi.mock('@/services/ai/agenda/status-reconciliation.service', () => ({ reconcileStatus: h.reconcile }));
vi.mock('@/services/to-process/agenda-status-cards', () => ({ proposeAgendaStatus: h.propose, closeAgendaStatusCards: h.close }));
vi.mock('../agenda-write-primitive', () => ({ upsertAgendaItem: h.write }));
vi.mock('../agenda-persistence', () => ({ recordOccurrenceEvent: h.record }));

import {
  parseSeriesRecurrence, evidenceForItem, toStatusItem, reconcileAgendaStatusForSource,
  type SourceProof,
} from '../agenda-status-sync';

const ligne = (over: Record<string, unknown> = {}) => ({
  id: 10, title: 'Entretien annuel', date: '2027-03-10', homeCategory: 'action', manualStatus: null,
  isAutomatic: true, isAutomaticModified: false, originFieldKey: 'maintenanceDueDate', occurrenceNature: 'CONFIRMED',
  seriesKey: null, recurrence: null, businessType: null, eventNature: null, ...over,
});
const preuve = (over: Partial<SourceProof> = {}): SourceProof => ({
  businessType: 'maintenance', nature: 'HISTORICAL', excerpt: 'Entretien effectué', confidence: 'certain',
  documentType: 'RAPPORT_ENTRETIEN', documentDate: new Date('2027-03-09T00:00:00Z'), occurrenceDate: new Date('2027-03-08T00:00:00Z'), ...over,
});
const brute = (over: Record<string, unknown> = {}) => ({
  fieldKey: 'lastRevision', canonicalKey: 'lastRevision', normalizedValue: '2027-03-08', valueJson: '2027-03-08',
  excerpt: 'Entretien effectué le 08/03/2027', confidence: 'certain', documentType: 'RAPPORT_ENTRETIEN',
  documentDate: '2027-03-09', eventType: null, eventNature: null, ...over,
});

beforeEach(() => {
  h.reconcile.mockReset(); h.propose.mockClear(); h.close.mockClear(); h.write.mockClear(); h.record.mockClear();
  h.proofs = [brute()]; h.items = [ligne()]; h.current = [{ s: null }];
});

describe('ExistingAgendaItem enrichi', () => {
  it('type métier (registre), récurrence de la série, statut, protection manuelle', () => {
    const it1 = toStatusItem(ligne({ recurrence: { frequency: 'YEARLY', interval: 1 } }));
    expect(it1).toMatchObject({ businessType: 'maintenance', recurrence: { frequency: 'yearly', interval: 1 }, status: null, manual: false });
    expect(toStatusItem(ligne({ isAutomaticModified: true, manualStatus: '' })).manual).toBe(true);
    expect(toStatusItem(ligne({ businessType: 'inspection' })).businessType).toBe('inspection');
  });
  it('récurrence : JSON, règle FREQ, puis registre du champ d’origine', () => {
    expect(parseSeriesRecurrence({ rule: 'FREQ=MONTHLY;INTERVAL=6' })).toEqual({ frequency: 'monthly', interval: 6 });
    expect(parseSeriesRecurrence(null, 'insuranceExpiry')).toEqual({ frequency: 'yearly', interval: 1 });
    expect(parseSeriesRecurrence({ frequency: 'hourly' })).toBeNull();
  });
});

describe('preuve d’une échéance dans un document', () => {
  const item = toStatusItem(ligne());
  it('fait de même type métier, non DEADLINE, le plus sûr ; sa date est l’occurrence', () => {
    const e = evidenceForItem(item, [preuve({ confidence: 'probable' }), preuve(), preuve({ nature: 'DEADLINE', confidence: 'certain' })]);
    expect(e).toMatchObject({ confidence: 'certain', documentType: 'RAPPORT_ENTRETIEN' });
    expect(e?.occurrenceDate?.toISOString().slice(0, 10)).toBe('2027-03-08');
  });
  it('sinon le document si son type couvre le type métier — au mieux « probable »', () => {
    const e = evidenceForItem(item, [preuve({ businessType: 'insurance' })]);
    expect(e).toMatchObject({ confidence: 'probable', documentType: 'RAPPORT_ENTRETIEN' });
    expect(evidenceForItem(item, [preuve({ businessType: 'insurance', documentType: 'CONTRAT_ASSURANCE' })])).toBeNull();
    expect(evidenceForItem({ ...item, businessType: null }, [preuve()])).toBeNull();
  });
});

describe('gouvernance', () => {
  // Lot 16b-2 : AI_T4_EFFECTS et T4 `steps` retirés — toujours active.
  it('toujours active : la preuve du document est lue et la décision demandée', async () => {
    h.reconcile.mockResolvedValue({ engine: 'completion_v2', status: 'unknown', decision: 'keep', occurrenceMatch: 'exact', reasonCode: 'X', reason: '', needsModel: false });
    const r = await reconcileAgendaStatusForSource({ accountId: 1, assetId: 2, sourceFileId: 3 });
    expect(r.skipped).toBeUndefined();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });
});

describe('effets', () => {
  const run = () => reconcileAgendaStatusForSource({ accountId: 1, assetId: 2, sourceFileId: 3 });
  const verdict = (decision: string) => ({ engine: 'completion_v2', status: 'completed', decision, occurrenceMatch: 'exact', reasonCode: 'COMPLETION_PROVEN', reason: '', needsModel: false });

  it('ExistingAgendaItem transmis avec type métier, récurrence et statut', async () => {
    h.reconcile.mockResolvedValue(verdict('keep'));
    await run();
    const [item, evidence, ctx] = h.reconcile.mock.calls[0];
    expect(item).toMatchObject({ id: 10, businessType: 'maintenance', status: null, manual: false });
    expect(evidence).toMatchObject({ confidence: 'certain', documentType: 'RAPPORT_ENTRETIEN' });
    expect(ctx).toEqual({ accountId: 1, sourceFileId: 3, userId: undefined });
  });

  it('mark_done : statut « réalisé » par la primitive (origine automatique), document lié comme preuve, trace, cartes closes', async () => {
    h.reconcile.mockResolvedValue(verdict('mark_done'));
    const r = await run();
    expect(r.entries[0]).toMatchObject({ itemId: 10, applied: 'marked_done' });
    expect(h.write.mock.calls[0][0]).toMatchObject({
      itemId: 10, origin: 'AUTOMATIC', details: { manualStatus: 'realise' }, sources: [{ fileId: 3, role: 'PROOF' }],
    });
    expect(h.record).toHaveBeenCalledWith(10, 1, 'STATUS_AUTO_COMPLETED', expect.objectContaining({ origin: 'AI', sourceFileId: 3 }));
    expect(h.close).toHaveBeenCalledWith(1, 10, 'OBSOLETE');
  });

  it('mark_done : un statut posé entre-temps n’est jamais écrasé', async () => {
    h.reconcile.mockResolvedValue(verdict('mark_done'));
    h.current = [{ s: 'annule' }];
    const r = await run();
    expect(r.entries[0].applied).toBe('none');
    expect(h.write).not.toHaveBeenCalled();
  });

  it('propose_done / propose_not_done : carte À traiter, jamais d’écriture de statut', async () => {
    for (const d of ['propose_done', 'propose_not_done']) {
      h.propose.mockClear();
      h.reconcile.mockResolvedValue(verdict(d));
      const r = await run();
      expect(r.entries[0].applied).toBe('card');
      expect(h.propose).toHaveBeenCalledWith({ accountId: 1, itemId: 10, kind: d, sourceFileId: 3 });
    }
    expect(h.write).not.toHaveBeenCalled();
  });

  it('fenêtre : une preuve d’une autre occurrence est ignorée ; une seule occurrence par type', async () => {
    h.reconcile.mockResolvedValue(verdict('keep'));
    h.proofs = [brute({ normalizedValue: '2025-03-08', valueJson: '2025-03-08', documentDate: '2025-03-09' })];
    h.items = [ligne({ recurrence: { frequency: 'yearly', interval: 1 } })];
    await run();
    expect(h.reconcile).not.toHaveBeenCalled();

    h.proofs = [brute()];
    h.items = [ligne({ id: 11, date: '2026-03-10' }), ligne(), ligne({ id: 12, date: '2027-09-10' })];
    await run();
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.reconcile.mock.calls[0][0].id).toBe(10);
  });

  it('éléments HISTORICAL et sans preuve : rien', async () => {
    h.items = [ligne({ eventNature: 'HISTORICAL' })];
    await run();
    expect(h.reconcile).not.toHaveBeenCalled();
    h.proofs = [];
    expect(await run()).toEqual({ skipped: 'NO_PROOF', entries: [] });
  });
});
