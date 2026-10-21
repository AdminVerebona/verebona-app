/**
 * Lot 75G — seuils par relation (RDE-G1), arbitrage T3 commun (RDE-C),
 * contrat de la file durable (RDE-D / L71R-D3) et montants à la création
 * (L71R-D2). Unitaires, sans base.
 *
 * RDE-G1  Seuils inchangés et documentés : DOCUMENT_EQUIPMENT 0,5 (exclusif,
 *         marge master 0,15) ; EQUIPMENT_DOCUMENT 0,5 appliqué par le
 *         service (section `documents` du master non exclusive à 0,4) ;
 *         agenda / fournisseurs 0,4 ; réexamen LINK-ELT : marge 0,2 en plus.
 * RDE-C3  Abstention T3 ou marge insuffisante : aucun équipement retenu.
 * RDE-D2  Travail durable : une cible par équipement (déduplication),
 *         événements fusionnés, contexte versionné, événement malformé rejeté.
 * L71R-D2 Montants en centimes : stricts à la création, compatibles en modification.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileLinks = vi.fn();
vi.mock('@/services/ai/reconciliation/link-reconciler', async (orig) => ({
  ...(await orig<typeof import('@/services/ai/reconciliation/link-reconciler')>()),
  reconcileLinks: (i: unknown) => reconcileLinks(i),
}));
vi.mock('@/db', () => ({ pgClient: { unsafe: async () => [] }, db: {} }));

const { LINK_SCORE_THRESHOLDS, LINK_MIN_MARGIN } = await import('@/services/ai/reconciliation/link-reconciler');
const { defaultDocumentArbitrate, defaultEquipmentArbitrate, ELEMENT_REQUIRED_MARGIN } = await import('../document-equipment-link.service');
const { LINK_RELATIONS } = await import('@/services/ai/reconciliation/master/link-ambiguity');

const sortie = (o: Partial<{ matches: unknown[]; documents: unknown[]; ambiguities: unknown[] }>) => ({
  documents: [], agendaItems: [], suppliers: [], matches: [], ambiguities: [], ...o,
});
beforeEach(() => reconcileLinks.mockReset());

describe('RDE-G1 — seuils et marges par relation (jamais abaissés)', () => {
  it('valeurs de référence', () => {
    expect(LINK_SCORE_THRESHOLDS).toEqual({ equipmentToObjects: 0.4, documentToEquipment: 0.5 });
    expect(LINK_MIN_MARGIN).toBe(0.15);
    expect(ELEMENT_REQUIRED_MARGIN).toBe(0.2);
    expect(LINK_RELATIONS.matches).toMatchObject({ exclusive: true, threshold: 0.5 });
    expect(LINK_RELATIONS.documents).toMatchObject({ exclusive: false, threshold: 0.4 });
    expect(LINK_RELATIONS.agendaItems.threshold).toBe(0.4);
    expect(LINK_RELATIONS.suppliers.threshold).toBe(0.4);
  });
  it('DOCUMENT_EQUIPMENT : sous 0,5 rien ; au-dessus, le meilleur des candidats fournis', async () => {
    reconcileLinks.mockResolvedValueOnce(sortie({ matches: [{ id: 2, score: 0.49, reason: 'faible' }] }));
    expect((await defaultDocumentArbitrate({ accountId: 1, fileId: 9, subjectContext: 's', equipmentsList: 'l', candidateIds: [1, 2] })).equipmentId).toBeNull();
    reconcileLinks.mockResolvedValueOnce(sortie({ matches: [{ id: 7, score: 0.99, reason: 'hors liste' }, { id: 2, score: 0.8, reason: 'ok' }] }));
    expect((await defaultDocumentArbitrate({ accountId: 1, fileId: 9, subjectContext: 's', equipmentsList: 'l', candidateIds: [1, 2] })).equipmentId).toBe(2);
  });
  it('EQUIPMENT_DOCUMENT : seuil 0,5 appliqué par le service (règle 71A conservée)', async () => {
    reconcileLinks.mockResolvedValueOnce(sortie({ documents: [{ id: 10, score: 0.45, reason: 'x' }, { id: 11, score: 0.7, reason: 'y' }] }));
    expect(await defaultEquipmentArbitrate({ accountId: 1, equipmentId: 3, subjectContext: 's', documentsList: 'd', candidateIds: [10, 11] }))
      .toEqual([{ fileId: 11, score: 0.7, reason: 'y' }]);
  });
});

describe('RDE-C3 — abstentions protégées', () => {
  it('abstention explicite du master : aucun équipement', async () => {
    reconcileLinks.mockResolvedValueOnce(sortie({ matches: [], ambiguities: [{ section: 'matches', reasonCode: 'LINK_TIE', candidateIds: [1, 2] }] }));
    expect(await defaultDocumentArbitrate({ accountId: 1, fileId: 9, subjectContext: 's', equipmentsList: 'l', candidateIds: [1, 2] }))
      .toMatchObject({ equipmentId: null, abstained: true });
  });
  it('réexamen LINK-ELT : marge < 0,2 entre les deux meilleurs → abstention (règle 54A conservée)', async () => {
    const deux = sortie({ matches: [{ id: 1, score: 0.9, reason: 'a' }, { id: 2, score: 0.72, reason: 'b' }] });
    reconcileLinks.mockResolvedValueOnce(deux);
    expect((await defaultDocumentArbitrate({ accountId: 1, fileId: 9, subjectContext: 's', equipmentsList: 'l', candidateIds: [1, 2], requiredMargin: ELEMENT_REQUIRED_MARGIN })).equipmentId).toBeNull();
    reconcileLinks.mockResolvedValueOnce(deux);
    expect((await defaultDocumentArbitrate({ accountId: 1, fileId: 9, subjectContext: 's', equipmentsList: 'l', candidateIds: [1, 2] })).equipmentId).toBe(1);
  });
});

describe('RDE-D2 — travail durable `equipment_documents`', () => {
  it('une cible par équipement, événements fusionnés, contexte versionné', async () => {
    const { requestEquipmentDocumentSync, T3_TARGET_EQUIPMENT_DOCUMENTS } = await import('../equipment-document-queue');
    const enqueue = vi.fn().mockResolvedValue({ decision: 'create', jobId: 42 });
    expect(await requestEquipmentDocumentSync(5, 77, { reason: 'identifiers_changed', keys: ['serialNumber', 'serialNumber'] }, { enqueue }, new Date('2026-10-20T10:00:00Z'))).toBe(42);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      treatment: 'T3', scope: { accountId: 5, targetType: T3_TARGET_EQUIPMENT_DOCUMENTS, targetId: '77' }, payloadOnDedupe: 'append_events',
      payload: expect.objectContaining({ payloadVersion: 1, kind: 'equipment_documents', events: [{ reason: 'identifiers_changed', keys: ['serialNumber'], at: '2026-10-20T10:00:00.000Z' }] }),
    }));
    expect(await requestEquipmentDocumentSync(0, 77, { reason: 'created' }, { enqueue })).toBeNull();
  });
  it('contexte relu par le registre T3 ; événement malformé : échec définitif', async () => {
    const { registerEquipmentDocumentsT3 } = await import('../equipment-document-queue');
    const { resolveT3Job } = await import('@/services/ai/reconciliation/t3-job-contract');
    registerEquipmentDocumentsT3();
    const job = (payload: unknown) => ({ id: 1, treatment: 'T3', accountId: 5, targetType: 'equipment_documents', targetId: '77', payload }) as never;
    expect(resolveT3Job(job({ payloadVersion: 1, kind: 'equipment_documents', events: [{ reason: 'created' }] })).payload)
      .toMatchObject({ equipmentId: 77, events: [{ reason: 'created' }] });
    expect(() => resolveT3Job(job({ payloadVersion: 1, kind: 'equipment_documents', events: [{ reason: 'inconnu' }] }))).toThrow(/malformé/);
  });
  it('la cible « equipment_documents » est contrôlée comme un équipement (périmètre de compte)', async () => {
    const { JOB_TARGET_KINDS } = await import('@/services/ai/queue/job-scope');
    expect(JOB_TARGET_KINDS.equipment_documents).toBe('equipment');
  });
});

describe('L71R-D2 — montants en centimes', () => {
  it('stricts à la création, compatibles en modification', async () => {
    const { parseEquipmentCents } = await import('@/lib/equipment-amounts');
    expect(parseEquipmentCents('p', undefined, 'strict')).toBeUndefined();
    expect(parseEquipmentCents('p', null, 'strict')).toBeNull();
    expect(parseEquipmentCents('p', 49_900, 'strict')).toBe(49_900);
    expect(parseEquipmentCents('p', 499.5, 'strict')).toBe('INVALID');
    expect(parseEquipmentCents('p', '499', 'strict')).toBe('INVALID');
    expect(parseEquipmentCents('p', -1, 'legacy')).toBe('INVALID');
    expect(parseEquipmentCents('p', 2_147_483_648, 'legacy')).toBe('INVALID');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseEquipmentCents('p', 499.5, 'legacy')).toBe(500);
  });
});
