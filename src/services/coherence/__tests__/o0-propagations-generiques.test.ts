/**
 * Lot 38 — O0 (CDC Opérations V1 §19, §24, B18, B24, B32 étape 2, C18, C23) :
 * neutralisation des propagations génériques dangereuses du moteur de
 * cohérence, AVANT toute Opération.
 *
 *   O0-01  seed et migration 0315 : règles génériques retirées / désactivées,
 *          seed idempotent (`IS NULL` au lieu de `= NULL`) ;
 *   O0-02  moteur : aucune écriture ni proposition vers l'acquisition ou la
 *          valorisation, quelle que soit la règle en base ; aucune création
 *          d'agenda générique ; aucune injection dans estimatedValue.
 *   F-163, F-164, F-165 : cas de recette du CDC.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({
  asset: { id: 3, accountId: 7, name: 'Maison', category: 'IMMOBILIER', keyCharacteristics: '{}' },
  rules: [] as Array<Record<string, unknown>>,
  write: vi.fn(),
  createInconsistency: vi.fn(async () => ({})),
  enqueue: vi.fn(async () => 1),
  dbInsert: vi.fn(),
  dbUpdate: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    select: () => {
      const c = { from: () => c, where: () => c, orderBy: () => c, limit: async () => [h.asset] };
      return c;
    },
    insert: (...a: unknown[]) => { h.dbInsert(...a); throw new Error('création d’agenda générique interdite'); },
    update: (...a: unknown[]) => { h.dbUpdate(...a); throw new Error('écriture directe interdite'); },
  },
}));
vi.mock('../impact-queue.service', () => ({
  enqueue: h.enqueue, complete: vi.fn(async () => {}), fail: vi.fn(async () => {}), dequeueBatch: vi.fn(async () => []),
}));
vi.mock('../field-dependency.service', () => ({ resolveImpacts: vi.fn(async () => h.rules) }));
vi.mock('../version-tracker.service', () => ({ computeHash: () => 'h', recordVersion: vi.fn(async () => {}) }));
vi.mock('../inconsistency.service', async (orig) => ({
  ...(await orig<typeof import('../inconsistency.service')>()),
  createInconsistency: h.createInconsistency,
  autoResolveForField: vi.fn(async () => 0),
}));
vi.mock('@/services/canonical/asset-state', async (orig) => ({
  ...(await orig<typeof import('@/services/canonical/asset-state')>()),
  getCanonicalAssetState: vi.fn(async () => ({
    assetId: 3, accountId: 7, family: 'IMMOBILIER', category: 'IMMOBILIER', fields: {}, assetUpdatedAt: null,
  })),
  writeCanonicalAssetField: h.write,
}));

const { processImpact, SEMANTIC_ONLY_TARGETS, isSemanticOnlyTarget } = await import('../impact-propagation.service');
const { DEPENDENCIES, RETIRED_DEPENDENCIES, categoryClause } = await import('../seed-dependencies');

const rule = (over: Record<string, unknown>) => ({
  id: 1, sourceField: 'amountCents', targetField: 'acquisitionPrice', category: null,
  impactType: 'propagation', transformRule: 'cents_to_euros', confidence: 'certain', ...over,
});
const item = (changedFields: Record<string, unknown>) => ({
  id: 99, publicId: 'p', accountId: 7, assetId: 3, documentId: null, agendaItemId: null, triggerType: 'manual_request',
  triggerReason: null, source: 't', status: 'processing', priority: 0, attempts: 0, maxAttempts: 3, lastError: null,
  metadata: { changedFields }, scheduledFor: null, lockedUntil: null, completedAt: null, createdAt: new Date(), updatedAt: new Date(),
});

beforeEach(() => {
  for (const f of [h.write, h.createInconsistency, h.enqueue, h.dbInsert, h.dbUpdate]) f.mockClear();
  h.write.mockResolvedValue({ notFound: false, fields: [], field: { key: 'x', requestedKey: 'x', outcome: 'written', previousValue: null, previousOrigin: null, nextValue: 1, origin: 'SYSTEM_RULE', mirrors: {} } });
});

describe('O0-01 — seed et migration 0315', () => {
  const generiques = [
    ['documentDate', 'acquisitionDate'], ['documentDate', 'estimatedValueDate'], ['documentDate', 'documentDate_agenda'],
    ['supplier', 'acquisitionLocation'], ['amountCents', 'acquisitionPrice'], ['amountCents', 'estimatedValue'],
  ];

  it('O0-01a les six règles génériques sont retirées du seed et listées pour désactivation', () => {
    for (const [src, dst] of generiques) {
      expect(DEPENDENCIES.some((d) => d.sourceField === src && d.targetField === dst)).toBe(false);
      expect(RETIRED_DEPENDENCIES.some((d) => d.sourceField === src && d.targetField === dst)).toBe(true);
    }
  });

  it('O0-01b plus aucune règle du seed vers une cible d’acquisition / valorisation, ni création d’agenda', () => {
    expect(DEPENDENCIES.filter((d) => d.impactType === 'propagation' && SEMANTIC_ONLY_TARGETS.has(d.targetField))).toEqual([]);
    expect(DEPENDENCIES.filter((d) => d.impactType === 'agenda_creation')).toEqual([]);
    // Ce qui sert encore est conservé (exports à régénérer, index, DPE…).
    expect(DEPENDENCIES.some((d) => d.sourceField === 'estimatedValue' && d.targetField === '_export_stale')).toBe(true);
  });

  it('O0-01c seed idempotent : catégorie NULL comparée par IS NULL (et non « = NULL », toujours faux)', () => {
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(categoryClause(null)).sql).toMatch(/"category" is null/i);
    const avec = dialect.sqlToQuery(categoryClause('VEHICULE'));
    expect(avec.sql).toMatch(/"category" = \$1/);
    expect(avec.params).toEqual(['VEHICULE']);
  });

  it('O0-01d migration 0315 : idempotente, sans effet si la table manque, désactive (ne supprime pas)', () => {
    const sql = readFileSync(join(process.cwd(), 'src/db/migrations/0315_neutralize_generic_propagations.sql'), 'utf8');
    expect(sql).toMatch(/to_regclass\('public\.field_dependencies'\) IS NULL/);
    expect(sql).toMatch(/SET is_active = false/);
    expect(sql).toMatch(/WHERE is_active = true/);
    expect(sql).not.toMatch(/DELETE FROM field_dependencies/i);
    for (const [src, dst] of generiques) {
      expect(sql).toContain(`'${src}'`);
      expect(sql).toContain(`'${dst}'`);
    }
    expect(sql).toMatch(/impact_type = 'agenda_creation'/);
  });
});

describe('O0-02 — moteur de propagation', () => {
  it('F-164 montant générique : amountCents → acquisitionPrice (certain) / estimatedValue (probable) : rien écrit ni proposé', async () => {
    h.rules = [rule({}), rule({ targetField: 'estimatedValue', confidence: 'probable' })];
    const r = await processImpact(item({ amountCents: 189900 }) as never);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.createInconsistency).not.toHaveBeenCalled();
    expect(r).toMatchObject({ fieldsApplied: 0, fieldsProposed: 0, fieldsConflicted: 0, errors: 0 });
  });

  it('F-163 date de document générique : documentDate → acquisitionDate / estimatedValueDate : rien', async () => {
    h.rules = [
      rule({ sourceField: 'documentDate', targetField: 'acquisitionDate', transformRule: 'copy_date', confidence: 'probable' }),
      rule({ sourceField: 'documentDate', targetField: 'estimatedValueDate', transformRule: 'copy_date', confidence: 'certain' }),
    ];
    const r = await processImpact(item({ documentDate: '2026-04-24' }) as never);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.createInconsistency).not.toHaveBeenCalled();
    expect(r.fieldsApplied + r.fieldsProposed + r.fieldsConflicted).toBe(0);
  });

  it('O0-02a règle ajoutée plus tard (alias de cible, `prixAchat`) ou fournisseur → lieu d’achat : ignorées', async () => {
    h.rules = [
      rule({ sourceField: 'montant', targetField: 'prixAchat' }),
      rule({ sourceField: 'supplier', targetField: 'acquisitionLocation', transformRule: null }),
      rule({ sourceField: 'montant', targetField: 'valuationHigh' }),
    ];
    await processImpact(item({ montant: 1000, supplier: 'Garage X' }) as never);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.createInconsistency).not.toHaveBeenCalled();
    expect(isSemanticOnlyTarget('prixAchat')).toBe(true);
    expect(isSemanticOnlyTarget('valeurEstimee')).toBe(true);
    expect(isSemanticOnlyTarget('charges')).toBe(false);
  });

  it('F-165 « prochaine échéance » : le moteur ne crée jamais d’événement d’agenda générique (T4 seul)', async () => {
    h.rules = [
      rule({ sourceField: 'documentDate', targetField: 'documentDate_agenda', impactType: 'agenda_creation', transformRule: null }),
      rule({ sourceField: 'firstRegistrationDate', targetField: 'nextInspection', impactType: 'agenda_creation', transformRule: null }),
    ];
    const r = await processImpact(item({ documentDate: '2026-04-24', firstRegistrationDate: '2020-01-01' }) as never);
    expect(h.dbInsert).not.toHaveBeenCalled();
    expect(h.dbUpdate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ agendaItemsCreated: 0, errors: 0 });
    // Le module ne contient plus la création générique « echeance ».
    const src = readFileSync(join(process.cwd(), 'src/services/coherence/impact-propagation.service.ts'), 'utf8');
    expect(src).not.toContain("'echeance'");
    expect(src).not.toContain('createOrUpdateAgendaItem');
  });

  it('O0-02b recalcul : n’injecte jamais la valeur source dans estimatedValue', async () => {
    h.rules = [rule({ sourceField: 'cilRubricCodes', targetField: 'valuation', impactType: 'recalculation', transformRule: null })];
    await processImpact(item({ cilRubricCodes: 'DPE' }) as never);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('O0-02c une cible ordinaire continue de se propager (non-régression)', async () => {
    h.rules = [rule({ sourceField: 'chargesCents', targetField: 'charges' })];
    const r = await processImpact(item({ chargesCents: 12000 }) as never);
    expect(h.write).toHaveBeenCalledWith(expect.objectContaining({ key: 'charges', value: 120, origin: 'SYSTEM_RULE' }));
    expect(r.fieldsApplied).toBe(1);
  });
});
