/**
 * Décision PO D-M (lot 20) : date tranchée par T4 → preuve RÉVISÉE du champ
 * (cycle ACTIVE → SUPERSEDED), puis réconciliation T3 en file.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sql = vi.hoisted(() => ({ calls: [] as Array<{ q: string; p: unknown[] }>, rows: [] as unknown[] }));
vi.mock('@/db', () => ({
  db: {},
  pgClient: {
    unsafe: vi.fn(async (q: string, p: unknown[] = []) => {
      sql.calls.push({ q, p });
      return q.startsWith('SELECT') ? sql.rows : [];
    }),
  },
}));

const { reviseDateEvidenceFromT4, revisedEvidenceInput, evidenceDateValue, T4_REVISION_RULE } = await import('../revised-date-evidence');
const { __resetCanonicalColumnsForTests } = await import('../canonical-columns');
import type { OriginalEvidenceRow, ReviseDateDeps } from '../revised-date-evidence';

const ORIGINALE: OriginalEvidenceRow = {
  id: 70, assetId: 3, fieldKey: 'nextInspection', value: '2027-03-04', sourceType: 'document', sourceId: 40, sourceVersion: null,
  location: { page: 1 }, excerpt: 'Prochain contrôle avant le 03/04/2027', evidenceOrigin: 'TEXT_EXTRACTION',
  documentType: 'CONTROLE_TECHNIQUE', documentDate: '2025-04-03', provider: 'gemini', model: 'm', promptVersion: 't1_master_v1',
  confidence: 'certain', authorityScore: 90, operationTraceId: 'tr', canonicalKey: 'nextInspection', canonicalUnit: null,
  targetType: 'ASSET', targetEntityId: 3, targetLabel: 'Clio', targetConfidence: 'certain',
  eventType: 'inspection', eventNature: 'DEADLINE', analysisRunId: 12,
};
const INPUT = { accountId: 1, userId: 2, sourceFileId: 40, fieldKey: 'nextInspection', extractedDate: '2027-03-04', chosenDate: '2027-04-03', evidenceId: 70 };

function deps(mode: 'legacy' | 'shadow' | 'enabled', originale: OriginalEvidenceRow | null = ORIGINALE): ReviseDateDeps & Record<string, ReturnType<typeof vi.fn>> {
  return {
    mode: () => mode,
    schemaReady: vi.fn(async () => true),
    findOriginal: vi.fn(async () => originale),
    record: vi.fn(async () => 71),
    supersede: vi.fn(async () => {}),
    enqueueAsset: vi.fn(async () => [1]),
    enqueueEntity: vi.fn(async () => [1]),
  } as never;
}

beforeEach(() => {
  sql.calls = [];
  sql.rows = [];
  __resetCanonicalColumnsForTests(true);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('reviseDateEvidenceFromT4', () => {
  it('legacy : rien, aucune requête', async () => {
    expect(await reviseDateEvidenceFromT4(INPUT)).toMatchObject({ mode: 'legacy', originalId: null, revisedId: null, enqueued: false });
    expect(sql.calls).toHaveLength(0);
    const d = deps('legacy');
    await reviseDateEvidenceFromT4(INPUT, d);
    expect(d.findOriginal).not.toHaveBeenCalled();
  });

  it('shadow : lecture seule, rien écrit, rien en file', async () => {
    const d = deps('shadow');
    expect(await reviseDateEvidenceFromT4(INPUT, d)).toMatchObject({ mode: 'shadow', originalId: 70, revisedId: null, enqueued: false });
    expect(d.record).not.toHaveBeenCalled();
    expect(d.supersede).not.toHaveBeenCalled();
    expect(d.enqueueAsset).not.toHaveBeenCalled();
  });

  it('enabled : preuve révisée (même autorité, même source, règle tracée), originale SUPERSEDED, T3 du bien en file', async () => {
    const d = deps('enabled');
    expect(await reviseDateEvidenceFromT4(INPUT, d)).toMatchObject({ originalId: 70, revisedId: 71, enqueued: true });
    expect(d.record).toHaveBeenCalledWith(expect.objectContaining({
      fieldKey: 'nextInspection', value: '2027-04-03', normalizedValue: '2027-04-03', rawValue: '2027-03-04',
      sourceType: 'document', sourceId: 40, authorityScore: 90, documentType: 'CONTROLE_TECHNIQUE',
      canonicalKey: 'nextInspection', projectionOrigin: 'DETERMINISTIC_RULE', projectionRule: T4_REVISION_RULE,
      excerpt: 'Prochain contrôle avant le 03/04/2027', analysisRunId: 12,
    }));
    expect(d.supersede).toHaveBeenCalledWith({ accountId: 1, originalId: 70, revisedId: 71 });
    expect(d.enqueueAsset).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, userId: 2, assetIds: [3], sourceFileId: 40, reason: T4_REVISION_RULE }));
    expect(d.enqueueEntity).not.toHaveBeenCalled();
  });

  it('enabled, preuve d’un équipement : réconciliation ciblée de l’équipement', async () => {
    const d = deps('enabled', { ...ORIGINALE, targetType: 'EQUIPMENT', targetEntityId: 501 });
    await reviseDateEvidenceFromT4(INPUT, d);
    expect(d.enqueueEntity).toHaveBeenCalledWith(expect.objectContaining({ targets: [{ type: 'EQUIPMENT', id: 501 }] }));
    expect(d.enqueueAsset).not.toHaveBeenCalled();
  });

  it('même date, date invalide, preuve introuvable ou schéma absent : rien', async () => {
    for (const p of [{ ...INPUT, chosenDate: INPUT.extractedDate }, { ...INPUT, chosenDate: '03/04/2027' }]) {
      const d = deps('enabled');
      expect((await reviseDateEvidenceFromT4(p, d)).revisedId).toBeNull();
      expect(d.findOriginal).not.toHaveBeenCalled();
    }
    const introuvable = deps('enabled', null);
    expect(await reviseDateEvidenceFromT4(INPUT, introuvable)).toMatchObject({ originalId: null, revisedId: null });
    expect(introuvable.record).not.toHaveBeenCalled();
    const sansSchema = deps('enabled');
    sansSchema.schemaReady = vi.fn(async () => false);
    expect((await reviseDateEvidenceFromT4(INPUT, sansSchema)).originalId).toBeNull();
  });

  it('jamais bloquant : une erreur d’écriture est journalisée, rien en file', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps('enabled');
    d.record = vi.fn(async () => { throw new Error('boom'); });
    expect(await reviseDateEvidenceFromT4(INPUT, d)).toMatchObject({ originalId: 70, revisedId: null, enqueued: false });
    expect(d.enqueueAsset).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });

  it('sans utilisateur : preuve révisée écrite, la réconciliation du bien attend la suivante', async () => {
    const d = deps('enabled');
    expect(await reviseDateEvidenceFromT4({ ...INPUT, userId: null }, d)).toMatchObject({ revisedId: 71, enqueued: false });
    expect(d.enqueueAsset).not.toHaveBeenCalled();
  });

  it('lecture par défaut : preuve du candidat retenue seulement si sa valeur est la date extraite (bornée au compte)', async () => {
    process.env.CANONICAL_WRITE_MODE = 'shadow';
    try {
      sql.rows = [{ ...ORIGINALE, value: '2027-03-04' }];
      expect((await reviseDateEvidenceFromT4(INPUT)).originalId).toBe(70);
      expect(sql.calls[0].p).toEqual([70, 1]);
      expect(sql.calls.some((c) => /INSERT|UPDATE/.test(c.q))).toBe(false);
    } finally {
      delete process.env.CANONICAL_WRITE_MODE;
    }
  });
});

describe('utilitaires', () => {
  it('evidenceDateValue : date ISO seulement', () => {
    expect(evidenceDateValue('2027-03-04')).toBe('2027-03-04');
    expect(evidenceDateValue('2027-03-04T00:00:00.000Z')).toBe('2027-03-04');
    expect(evidenceDateValue('03/04/2027')).toBeNull();
    expect(evidenceDateValue(20270304)).toBeNull();
  });

  it('revisedEvidenceInput : cible et événement de l’originale conservés', () => {
    const r = revisedEvidenceInput({ ...ORIGINALE, targetType: 'EQUIPMENT', targetEntityId: 501, targetLabel: 'PAC' }, INPUT);
    expect(r.target).toEqual({ type: 'EQUIPMENT', entityId: 501, label: 'PAC', confidence: 'certain' });
    expect(r.semanticEvent).toEqual({ type: 'inspection', nature: 'DEADLINE' });
    expect(r.documentDate).toEqual(new Date('2025-04-03'));
  });
});
