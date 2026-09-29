/**
 * CDC 15 T3-07 (lot 13) — rattachement ambigu : aucune liaison automatique.
 * Document → équipement : carte « À traiter » LINK-ELT
 * (`proposeDocumentEquipmentLink`), journal conservé, échec non bloquant.
 * Équipement → objets : journal seul.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const results: unknown[][] = [];
const updates: unknown[] = [];
function chain(res: unknown): unknown {
  const p = Promise.resolve(res);
  const c: unknown = new Proxy(() => {}, {
    get: (_t, k) => (k === 'then' ? p.then.bind(p) : () => c),
  });
  return c;
}
vi.mock('@/db', () => ({
  db: {
    select: () => chain(results.shift() ?? []),
    update: () => ({ set: (v: unknown) => { updates.push(v); return { where: async () => {} }; } }),
  },
}));
const reconcileLinks = vi.fn();
vi.mock('@/services/ai/reconciliation/link-reconciler', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/reconciliation/link-reconciler')>()),
  reconcileLinks: (i: unknown) => reconcileLinks(i),
}));
const propose = vi.fn();
vi.mock('@/services/to-process/document-equipment-link', () => ({
  proposeDocumentEquipmentLink: (p: unknown) => propose(p),
}));

const { linkDocumentToEquipments, reportLinkAmbiguities } = await import('../equipment-auto-link.service');

const DOC = {
  id: 40, assetId: 3, equipmentId: null, title: 'Facture intervention', filename: null, docType: null,
  documentDate: null, supplier: null, amountCents: null, description: null,
};
const EQUIPS = [{ id: 9, name: 'Pompe nord', type: null }, { id: 12, name: 'Pompe sud', type: null }];
const AMBIGU = {
  section: 'matches' as const, reasonCode: 'LINK_MARGIN_INSUFFICIENT' as const, candidateIds: [9, 12],
  candidates: [{ candidateId: 9, score: 0.74, reason: 'type commun' }, { candidateId: 12, score: 0.7, reason: 'type commun' }],
};
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  results.length = 0; updates.length = 0; reconcileLinks.mockReset(); propose.mockReset();
  propose.mockResolvedValue({ status: 'CREATED', reason: 'ok', rejected: [] });
  results.push([DOC], EQUIPS);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('document → équipement, architecture T3 master', () => {
  it('ambiguïté : aucune liaison, carte LINK-ELT avec les candidats au-dessus du seuil, journal conservé', async () => {
    reconcileLinks.mockResolvedValue({ documents: [], agendaItems: [], suppliers: [], matches: [], ambiguities: [AMBIGU] });
    await linkDocumentToEquipments(40, 1);
    expect(updates).toEqual([]);
    expect(propose).toHaveBeenCalledWith({
      accountId: 1, fileId: 40, assetId: 3,
      candidates: [{ equipmentId: 9, score: 0.74, reason: 'type commun' }, { equipmentId: 12, score: 0.7, reason: 'type commun' }],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/document #40 .*matches LINK_MARGIN_INSUFFICIENT candidats \[9, 12\]/));
  });

  it('échec de la proposition : jamais bloquant', async () => {
    reconcileLinks.mockResolvedValue({ documents: [], agendaItems: [], suppliers: [], matches: [], ambiguities: [AMBIGU] });
    propose.mockRejectedValue(new Error('base indisponible'));
    await expect(linkDocumentToEquipments(40, 1)).resolves.toBeUndefined();
    expect(updates).toEqual([]);
  });

  it('candidat net : liaison appliquée comme avant, aucune carte', async () => {
    reconcileLinks.mockResolvedValue({
      documents: [], agendaItems: [], suppliers: [],
      matches: [{ id: 12, score: 0.62, reason: 'r' }, { id: 9, score: 0.48, reason: 'r' }], ambiguities: [],
    });
    await linkDocumentToEquipments(40, 1);
    expect(updates).toEqual([{ equipmentId: 12 }]);
    expect(propose).not.toHaveBeenCalled();
  });
});

describe('reportLinkAmbiguities', () => {
  it('équipement → objets (pas de document) : journal seul, aucune carte', async () => {
    expect(await reportLinkAmbiguities({ accountId: 1, subject: 'équipement #5' }, [
      { ...AMBIGU, section: 'documents' },
    ])).toBe(1);
    expect(propose).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('violation du monde fermé : journal seul (pas de candidats exploitables)', async () => {
    await reportLinkAmbiguities({ accountId: 1, subject: 'document #40', document: { fileId: 40, assetId: 3 } }, [
      { section: 'matches', reasonCode: 'CLOSED_WORLD_VIOLATION', candidateIds: [9, 12] },
    ]);
    expect(propose).not.toHaveBeenCalled();
  });

  it('proposition ignorée ou candidats rejetés : journalisé', async () => {
    propose.mockResolvedValue({ status: 'SKIPPED', reason: 'Document introuvable', rejected: [12] });
    await reportLinkAmbiguities({ accountId: 1, subject: 'document #40', document: { fileId: 40, assetId: 3 } }, [AMBIGU]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/LINK-ELT SKIPPED — Document introuvable \(rejetés : 12\)/));
  });

  it('architecture steps (pas d’ambiguïtés) → 0', async () => {
    expect(await reportLinkAmbiguities({ accountId: 1, subject: 's' }, undefined)).toBe(0);
  });
});
