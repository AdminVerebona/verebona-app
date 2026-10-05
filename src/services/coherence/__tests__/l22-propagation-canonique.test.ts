/**
 * Lot 22 (chantier B) — le moteur de propagation de cohérence écrit par la
 * primitive canonique (`writeCanonicalAssetField`, origine SYSTEM_RULE), et
 * une valeur USER/ADMIN n'est jamais écrasée : conflit « À traiter » à la place.
 * Tests de non-régression du moteur (application, proposition, conflit).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  asset: { id: 3, accountId: 7, name: 'Maison', category: 'IMMOBILIER', keyCharacteristics: '{}' },
  fields: {} as Record<string, { value: unknown; origin: string }>,
  rules: [] as Array<Record<string, unknown>>,
  write: vi.fn(),
  createInconsistency: vi.fn(async () => ({})),
  autoResolve: vi.fn(async () => 0),
  enqueue: vi.fn(async () => 1),
  complete: vi.fn(async () => {}),
  dbUpdate: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    select: () => {
      const c = { from: () => c, where: () => c, limit: async () => [h.asset] };
      return c;
    },
    // Plus aucune écriture directe de la fiche du bien.
    update: (...a: unknown[]) => { h.dbUpdate(...a); throw new Error('écriture directe interdite'); },
  },
}));
vi.mock('../impact-queue.service', () => ({
  enqueue: h.enqueue, complete: h.complete, fail: vi.fn(async () => {}), dequeueBatch: vi.fn(async () => []),
}));
vi.mock('../field-dependency.service', () => ({ resolveImpacts: vi.fn(async () => h.rules) }));
vi.mock('../version-tracker.service', () => ({ computeHash: () => 'h', recordVersion: vi.fn(async () => {}) }));
vi.mock('../inconsistency.service', async (orig) => ({
  ...(await orig<typeof import('../inconsistency.service')>()),
  createInconsistency: h.createInconsistency,
  autoResolveForField: h.autoResolve,
}));
vi.mock('@/services/canonical/asset-state', async (orig) => ({
  ...(await orig<typeof import('@/services/canonical/asset-state')>()),
  getCanonicalAssetState: vi.fn(async () => ({
    assetId: 3, accountId: 7, family: 'IMMOBILIER', category: 'IMMOBILIER', fields: h.fields, assetUpdatedAt: null,
  })),
  writeCanonicalAssetField: h.write,
}));

const { processImpact, PROPAGATION_ORIGIN } = await import('../impact-propagation.service');

const rule = (over: Record<string, unknown>) => ({
  id: 1, sourceField: 'amountCents', targetField: 'acquisitionPrice', category: null,
  impactType: 'propagation', transformRule: 'cents_to_euros', confidence: 'certain', ...over,
});
const item = (changedFields: Record<string, unknown>) => ({
  id: 99, publicId: 'p', accountId: 7, assetId: 3, documentId: null, agendaItemId: null, triggerType: 'manual_request',
  triggerReason: null, source: 't', status: 'processing', priority: 0, attempts: 0, maxAttempts: 3, lastError: null,
  metadata: { changedFields }, scheduledFor: null, lockedUntil: null, completedAt: null, createdAt: new Date(), updatedAt: new Date(),
});
const ecrit = (outcome: string, over: Record<string, unknown> = {}) => ({
  notFound: false,
  fields: [],
  field: { key: 'acquisitionPrice', requestedKey: 'acquisitionPrice', outcome, previousValue: null, previousOrigin: null, nextValue: 1899, origin: 'SYSTEM_RULE', mirrors: {}, ...over },
});

beforeEach(() => {
  h.fields = {};
  h.rules = [rule({})];
  for (const f of [h.write, h.createInconsistency, h.autoResolve, h.enqueue, h.complete, h.dbUpdate]) f.mockClear();
  h.write.mockResolvedValue(ecrit('written'));
});

describe('propagation → primitive canonique', () => {
  it('champ vide, source certaine : writeCanonicalAssetField (SYSTEM_RULE, jamais USER), centimes convertis, impact chaîné', async () => {
    const r = await processImpact(item({ amountCents: 189900 }) as never);
    expect(PROPAGATION_ORIGIN).toBe('SYSTEM_RULE');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledWith({
      assetId: 3, accountId: 7, key: 'acquisitionPrice', value: 1899, origin: 'SYSTEM_RULE', expectedCurrent: null,
      source: { type: 'impact_propagation', id: 'amountCents' },
    });
    expect(h.dbUpdate).not.toHaveBeenCalled();
    expect(h.autoResolve).toHaveBeenCalledWith(3, 'acquisitionPrice');
    expect(h.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      assetId: 3, triggerType: 'asset_updated', metadata: { changedFields: { acquisitionPrice: 1899 } }, priority: -1,
    }));
    expect(r).toMatchObject({ fieldsApplied: 1, fieldsConflicted: 0, errors: 0 });
  });

  it('valeur USER en place (colonne miroir comprise, lue par la vue canonique) et différente : conflit À traiter, aucune écriture', async () => {
    h.fields = { acquisitionPrice: { value: 1500, origin: 'USER' } };
    const r = await processImpact(item({ amountCents: 189900 }) as never);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.createInconsistency).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 7, assetId: 3, fieldKey: 'acquisitionPrice', currentValue: '1500', proposedValue: '1899',
      sourceType: 'reconciliation', inconsistencyType: 'conflictual',
    }));
    expect(r).toMatchObject({ fieldsApplied: 0, fieldsConflicted: 1 });
  });

  it('même valeur déjà en place : rien', async () => {
    h.fields = { acquisitionPrice: { value: 1899, origin: 'USER' } };
    const r = await processImpact(item({ amountCents: 189900 }) as never);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.createInconsistency).not.toHaveBeenCalled();
    expect(r.fieldsApplied).toBe(0);
  });

  it('saisie USER concurrente (vide à la lecture, protégée ou changée à l’écriture) : conflit, rien d’écrasé', async () => {
    for (const [outcome, prev] of [['protected', 'USER'], ['conflict', 'ADMIN']] as const) {
      h.createInconsistency.mockClear();
      h.enqueue.mockClear();
      h.write.mockResolvedValueOnce(ecrit(outcome, { previousValue: 1500, previousOrigin: prev, nextValue: 1500 }));
      const r = await processImpact(item({ amountCents: 189900 }) as never);
      expect(h.createInconsistency).toHaveBeenCalledWith(expect.objectContaining({
        fieldKey: 'acquisitionPrice', currentValue: '1500', proposedValue: '1899', sourceType: 'reconciliation', inconsistencyType: 'conflictual',
      }));
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(r).toMatchObject({ fieldsApplied: 0, fieldsConflicted: 1 });
    }
  });

  it('source probable sur champ vide : proposition (inchangé), aucune écriture', async () => {
    h.rules = [rule({ targetField: 'estimatedValue', confidence: 'probable' })];
    const r = await processImpact(item({ amountCents: 189900 }) as never);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.createInconsistency).toHaveBeenCalledWith(expect.objectContaining({
      fieldKey: 'estimatedValue', proposedValue: '1899', inconsistencyType: 'probable',
    }));
    expect(r.fieldsProposed).toBe(1);
  });

  it('clé hors registre (`category`) ou règle de transformation non implémentée : jamais écrite', async () => {
    h.rules = [
      rule({ sourceField: 'retainedFunctionCode', targetField: 'category', transformRule: 'doc_type_to_category' }),
      rule({ sourceField: 'address1', targetField: 'city', transformRule: 'extract_city_from_address' }),
      rule({ sourceField: 'retainedFunctionCode', targetField: 'name', transformRule: null }),
    ];
    const r = await processImpact(item({ retainedFunctionCode: 'X', address1: '12 rue des Lilas 75011 Paris' }) as never);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.createInconsistency).not.toHaveBeenCalled();
    expect(h.dbUpdate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ fieldsApplied: 0, errors: 0 });
  });
});
