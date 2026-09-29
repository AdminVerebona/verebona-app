/**
 * LINK-ELT — rattachement ambigu document → équipement (CDC 15 T3-07, lot 13).
 * Base simulée pour la proposition ; résolution et annulation sur base réelle
 * dans `src/test/e2e/scenarios/link-elt-equipement.e2e.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  doc: { assetId: 10, linkedAssetId: null } as Record<string, unknown> | null,
  equipements: [{ id: 1, name: 'Chaudière' }, { id: 2, name: 'Pompe à chaleur' }],
  upsert: vi.fn(async (_i: Record<string, unknown>) => ({ status: 'CREATED', reason: 'ok', actionId: 5 })),
}));
vi.mock('@/db', async () => {
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  const select = () => {
    let table = '';
    const c: Record<string, unknown> = {
      from: (t: never) => { table = getTableName(t); return c; },
      innerJoin: () => c, where: () => c,
      limit: async () => (table === 'asset_files' && h.doc ? [h.doc] : []),
      then: (res: (v: unknown) => unknown) => Promise.resolve(table === 'equipments' ? h.equipements : []).then(res),
    };
    return c;
  };
  return { db: { select } };
});
vi.mock('../to-process-action.service', async (orig) => ({
  ...(await orig<typeof import('../to-process-action.service')>()), upsertAction: h.upsert,
}));

import {
  proposeDocumentEquipmentLink, documentEquipmentTriggerContext, findRelationWriter, DOCUMENT_ELEMENT_WRITER,
} from '../document-equipment-link';
import { computeTriggerContextHash } from '../to-process-action.service';

beforeEach(() => {
  h.doc = { assetId: 10, linkedAssetId: null };
  h.equipements = [{ id: 1, name: 'Chaudière' }, { id: 2, name: 'Pompe à chaleur' }];
  h.upsert.mockClear();
});

describe('liste blanche des relations', () => {
  it('DOCUMENT / elementId seulement ; valeur = identifiant positif', () => {
    expect(findRelationWriter('DOCUMENT', 'elementId')).toBe(DOCUMENT_ELEMENT_WRITER);
    expect(findRelationWriter('DOCUMENT', 'assetId')).toBeNull();
    expect(findRelationWriter('ASSET', 'elementId')).toBeNull();
    expect(DOCUMENT_ELEMENT_WRITER.validate(3)).toBe(true);
    expect(DOCUMENT_ELEMENT_WRITER.validate('3')).toBe(true);
    expect(DOCUMENT_ELEMENT_WRITER.validate(0)).toBe(false);
    expect(DOCUMENT_ELEMENT_WRITER.validate('x')).toBe(false);
  });
});

describe('proposeDocumentEquipmentLink', () => {
  const candidats = [
    { equipmentId: 2, score: 0.61, reason: 'marque citée' },
    { equipmentId: 1, score: 0.64, reason: 'modèle cité' },
    { equipmentId: 99, score: 0.9, reason: 'autre bien' },
  ];

  it('arbitrage LINK-ELT, candidats revérifiés (autre bien / compte écarté), empreinte document + candidats triés', async () => {
    const r = await proposeDocumentEquipmentLink({ accountId: 7, fileId: 55, assetId: 10, candidates: candidats });
    expect(r).toMatchObject({ status: 'CREATED', rejected: [99] });
    const arg = h.upsert.mock.calls[0][0];
    expect(arg).toMatchObject({
      accountId: 7, targetType: 'DOCUMENT', targetId: 55, relationKey: 'elementId', actionKind: 'ARBITRATE', ruleCode: 'LINK-ELT',
      triggerContext: { fileId: 55, candidates: [1, 2] },
    });
    expect((arg.proposals as Array<{ value: number; label: string }>).map((x) => [x.value, x.label])).toEqual([[1, 'Chaudière'], [2, 'Pompe à chaleur']]);
  });

  it('idempotence : même document et mêmes candidats → même empreinte, quels que soient scores et ordre', async () => {
    await proposeDocumentEquipmentLink({ accountId: 7, fileId: 55, assetId: 10, candidates: candidats });
    await proposeDocumentEquipmentLink({ accountId: 7, fileId: 55, assetId: 10, candidates: [...candidats].reverse().map((c) => ({ ...c, score: c.score / 2, reason: 'x' })) });
    const [a, b] = h.upsert.mock.calls.map((c) => c[0] as Record<string, never>);
    const hash = (x: Record<string, never>) => computeTriggerContextHash({ ruleCode: x.ruleCode, actionKind: x.actionKind, proposals: x.proposals, triggerContext: x.triggerContext });
    expect(hash(a)).toBe(hash(b));
    expect(documentEquipmentTriggerContext(55, [2, 1, 2])).toEqual({ fileId: 55, candidates: [1, 2] });
  });

  it('document d’un autre bien, ou moins de deux candidats valides : pas de carte', async () => {
    expect((await proposeDocumentEquipmentLink({ accountId: 7, fileId: 55, assetId: 11, candidates: candidats })).status).toBe('SKIPPED');
    h.equipements = [{ id: 1, name: 'Chaudière' }];
    expect((await proposeDocumentEquipmentLink({ accountId: 7, fileId: 55, assetId: 10, candidates: candidats })).status).toBe('SKIPPED');
    h.doc = null;
    expect((await proposeDocumentEquipmentLink({ accountId: 7, fileId: 55, assetId: 10, candidates: candidats })).status).toBe('SKIPPED');
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
