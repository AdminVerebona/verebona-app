/**
 * writeCanonicalEntityField et vue canonique d'un équipement / d'une pièce —
 * tests unitaires sans base (CDC 15 T1-04, T3-01, T3-02 ; lot 18, R3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: {}, db: {} }));
const emitBusinessEvent = vi.fn(async () => {});
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent }));

const es = await import('..');
import type { CanonicalEntityRow } from '..';

const NOW = '2026-10-01T10:00:00.000Z';
const ctx = (origin: 'USER' | 'RECONCILIATION' = 'RECONCILIATION') => ({ origin, now: NOW });

function equipement(kc: Record<string, unknown> = {}, cols: Record<string, unknown> = {}, hasSpecs = false): CanonicalEntityRow {
  return {
    target: { type: 'EQUIPMENT', id: 11 }, assetId: 3, accountId: 7, name: 'Chaudière', archived: false, kc, hasSpecs,
    columns: {
      'equipments.purchase_price_cents': null, 'equipments.estimated_value_cents': null,
      'equipment_cil_specs.brand': null, 'equipment_cil_specs.model': null,
      'equipment_cil_specs.serial_number': null, 'equipment_cil_specs.power_kw': null, ...cols,
    },
  };
}
const piece = (kc: Record<string, unknown> = {}, area: unknown = null): CanonicalEntityRow => ({
  target: { type: 'ROOM', id: 21 }, assetId: 3, accountId: 7, name: 'Salon', archived: false, kc, columns: { 'substructures.area': area },
});

describe('vue canonique d’une entité', () => {
  it('fiche d’abord, puis colonne miroir convertie ; colonne sans origine = USER', () => {
    const st = es.buildCanonicalEntityState(equipement(
      { warrantyEndDate: '2031-03-01', warrantyEndDate__origin: 'RECONCILIATION' },
      { 'equipments.purchase_price_cents': 189900, 'equipment_cil_specs.serial_number': 'SN-1' },
    ));
    expect(st.fields.warrantyEndDate).toMatchObject({ value: '2031-03-01', origin: 'RECONCILIATION', from: 'key' });
    expect(st.fields.acquisitionPrice).toMatchObject({ value: 1899, origin: 'USER', from: 'column' });
    expect(st.fields.serialNumber).toMatchObject({ value: 'SN-1', origin: 'USER', from: 'column' });
    // Jamais un champ de bien sur un équipement.
    expect(st.fields.registrationNumber).toBeUndefined();
  });

  it('pièce (sous-structure, D-G) : `substructures.area` (texte) lu comme nombre', () => {
    expect(es.buildCanonicalEntityState(piece({}, '18.5')).fields.roomArea).toMatchObject({ value: 18.5, from: 'column', origin: 'USER' });
  });
});

describe('planEntityWrites', () => {
  it('targetTypes obligatoire : champ de pièce sur un équipement, champ de bien sur une pièce → invalid', () => {
    const p1 = es.planEntityWrites(equipement(), [{ key: 'roomArea', value: 12 }], ctx());
    expect(p1.results[0]).toMatchObject({ outcome: 'invalid', reason: 'TARGET_NOT_APPLICABLE' });
    const p2 = es.planEntityWrites(piece(), [{ key: 'livingArea', value: 80 }, { key: 'zzz', value: 1 }], ctx());
    expect(p2.results.map((r) => r.reason)).toEqual(['TARGET_NOT_APPLICABLE', 'UNKNOWN_KEY']);
    expect(p2.changed).toBe(false);
  });

  it('alias résolu, valeur normalisée, origine et date posées, miroirs calculés', () => {
    const p = es.planEntityWrites(equipement(), [
      { key: 'numeroSerie', value: 'FR-2024-77', trace: { authority: 80, sourceDate: '2024-05-02' } },
      { key: 'finGarantie', value: '01/03/2031' },
      { key: 'acquisitionPrice', value: 1899.5 },
    ], ctx());
    expect(p.results.map((r) => [r.key, r.outcome])).toEqual([
      ['serialNumber', 'written'], ['warrantyEndDate', 'written'], ['acquisitionPrice', 'written'],
    ]);
    expect(p.kc).toMatchObject({
      serialNumber: 'FR-2024-77', serialNumber__origin: 'RECONCILIATION', serialNumber__updatedAt: NOW,
      serialNumber__authority: 80, serialNumber__sourceDate: '2024-05-02',
      warrantyEndDate: '2031-03-01', acquisitionPrice: 1899.5,
    });
    expect(p.columns).toEqual({
      'equipment_cil_specs.serial_number': 'FR-2024-77', 'equipments.purchase_price_cents': 189950,
    });
  });

  it('T3-02 : valeur USER (ou colonne saisie) protégée d’une écriture automatique ; l’humain passe', () => {
    const user = equipement({ serialNumber: 'A', serialNumber__origin: 'USER' });
    expect(es.planEntityWrites(user, [{ key: 'serialNumber', value: 'B' }], ctx()).results[0])
      .toMatchObject({ outcome: 'protected', previousOrigin: 'USER' });
    const colonne = equipement({}, { 'equipment_cil_specs.serial_number': 'A' });
    expect(es.planEntityWrites(colonne, [{ key: 'serialNumber', value: 'B' }], ctx()).results[0].outcome).toBe('protected');
    const h = es.planEntityWrites(user, [{ key: 'serialNumber', value: 'B' }], ctx('USER'));
    expect(h.results[0].outcome).toBe('written');
    expect(h.kc.serialNumber__origin).toBe('USER');
  });

  it('contrôle optimiste ; retrait (null) efface fiche et miroir', () => {
    const auto = piece({ roomArea: 20, roomArea__origin: 'RECONCILIATION' }, '20');
    expect(es.planEntityWrites(auto, [{ key: 'roomArea', value: 25, expectedCurrent: 19 }], ctx()).results[0])
      .toMatchObject({ outcome: 'conflict', reason: 'CURRENT_VALUE_CHANGED' });
    const r = es.planEntityWrites(auto, [{ key: 'roomArea', value: null, expectedCurrent: 20 }], ctx());
    expect(r.results[0].outcome).toBe('written');
    expect(r.kc.roomArea).toBeUndefined();
    expect(r.columns).toEqual({ 'substructures.area': null });
  });
});

/** Exécutant SQL simulé : enregistre les requêtes, rend la ligne demandée. */
function runner(row: Record<string, unknown> | null) {
  const calls: Array<{ q: string; p: unknown[] }> = [];
  const r = {
    calls,
    unsafe: vi.fn(async (q: string, p: unknown[] = []) => {
      calls.push({ q, p });
      if (/FROM equipments x|FROM substructures x/.test(q)) return row ? [row] : [];
      return [];
    }),
    begin: async (fn: (t: unknown) => Promise<unknown>) => fn(r),
  };
  return r;
}
const ligneEquipement = (over: Record<string, unknown> = {}) => ({
  id: 11, assetId: 3, accountId: 7, name: 'Chaudière', archived: false, kc: {}, ppc: null, evc: null,
  specId: null, brand: null, model: null, sn: null, pkw: null, ...over,
});

describe('writeCanonicalEntityFields — écriture réelle seule (lot 16b-3)', () => {
  beforeEach(() => { es.__resetEntityColumnsForTests(true); emitBusinessEvent.mockClear(); });

  it('0227 absente : rien (schemaNotReady)', async () => {
    es.__resetEntityColumnsForTests(false);
    const run = runner(ligneEquipement());
    const res = await es.writeCanonicalEntityFields({
      target: { type: 'EQUIPMENT', id: 11 }, accountId: 7, origin: 'RECONCILIATION',
      writes: [{ key: 'serialNumber', value: 'X' }],
    }, run as never);
    expect(res).toMatchObject({ skipped: true, schemaNotReady: true });
    expect(run.unsafe).not.toHaveBeenCalled();
  });

  it('commutateur retiré encore posé (legacy / shadow) : ignoré, écriture réelle journalisée avec la cible', async () => {
    for (const v of ['legacy', 'shadow']) {
      vi.stubEnv('CANONICAL_WRITE_MODE', v);
      const run = runner(ligneEquipement());
      const res = await es.writeCanonicalEntityFields({
        target: { type: 'EQUIPMENT', id: 11 }, accountId: 7, origin: 'RECONCILIATION',
        writes: [{ key: 'serialNumber', value: 'X' }],
      }, run as never);
      expect(res.fields[0].outcome).toBe('written');
      expect(res).not.toHaveProperty('dryRun');
      expect(run.calls.some((c) => c.q.trim().startsWith('UPDATE equipments'))).toBe(true);
      const j = run.calls.find((c) => c.q.includes('INSERT INTO canonical_field_writes'))!;
      expect(j.q).toContain('target_type, target_id');
      expect(j.p.slice(0, 5)).toEqual([7, 3, 'EQUIPMENT', 11, 'serialNumber']);
      expect(j.p[13]).toBe(false); // dry_run
    }
    vi.unstubAllEnvs();
  });

  it('verrou, fiche + colonne équipement + caractéristiques (créées), journal, événement du bien porteur', async () => {
    const run = runner(ligneEquipement());
    const res = await es.writeCanonicalEntityFields({
      target: { type: 'EQUIPMENT', id: 11 }, accountId: 7, origin: 'RECONCILIATION',
      writes: [{ key: 'serialNumber', value: 'X1' }, { key: 'acquisitionPrice', value: 10 }],
    }, run as never);
    expect(res).toMatchObject({ assetId: 3 });
    const sel = run.calls[0];
    expect(sel.q).toContain('FOR UPDATE OF x');
    expect(sel.q).toContain('a.account_id = $2');
    const upd = run.calls.find((c) => c.q.startsWith('UPDATE equipments'))!;
    expect(upd.q).toContain('purchase_price_cents = $3');
    expect(JSON.parse(upd.p[1] as string)).toMatchObject({ serialNumber: 'X1', serialNumber__origin: 'RECONCILIATION' });
    expect(upd.p[2]).toBe(1000);
    const spec = run.calls.find((c) => c.q.includes('INSERT INTO equipment_cil_specs'))!;
    expect(spec.p).toEqual([11, 'X1']);
    expect(run.calls.find((c) => c.q.includes('INSERT INTO canonical_field_writes'))!.p[13]).toBe(false);
    expect(emitBusinessEvent).toHaveBeenCalledWith({ type: 'ASSET_UPDATED', accountId: 7, entityId: 3 });
  });

  it('entité d’un autre compte → introuvable, rien écrit', async () => {
    const run = runner(null);
    const res = await es.writeCanonicalEntityField({
      target: { type: 'ROOM', id: 21 }, accountId: 99, origin: 'USER', key: 'roomArea', value: 12,
    }, run as never);
    expect(res).toMatchObject({ notFound: true, field: null });
    expect(run.calls).toHaveLength(1);
  });
});

describe('recordManualEntityEdit (hors commutateur)', () => {
  beforeEach(() => es.__resetEntityColumnsForTests(true));

  it('seules les clés réellement modifiées (par rapport à la vue) reçoivent USER', async () => {
    const run = runner(ligneEquipement({ kc: { acquisitionPrice: 50, acquisitionPrice__origin: 'RECONCILIATION' }, ppc: 5000, evc: 7000 }));
    const cles = await es.recordManualEntityEdit({
      target: { type: 'EQUIPMENT', id: 11 }, accountId: 7, actorUserId: 4,
      after: { acquisitionPrice: 60, estimatedValue: 70 },
    }, run as never);
    expect(cles).toEqual(['acquisitionPrice']);
    const upd = run.calls.find((c) => c.q.startsWith('UPDATE equipments'))!;
    expect(JSON.parse(upd.p[1] as string)).toMatchObject({ acquisitionPrice: 60, acquisitionPrice__origin: 'USER' });
    expect(JSON.parse(upd.p[1] as string).estimatedValue__origin).toBeUndefined();
  });

  it('comparaison à la vue (fiche PUIS colonne) : fiche automatique ≠ colonne → la saisie devient USER', async () => {
    // La fiche porte 55 € (automatique), la colonne 60 € : saisir 60 € n'est
    // pas « inchangé » — la vue lit la fiche, la saisie doit l'emporter.
    const ligne = ligneEquipement({ kc: { acquisitionPrice: 55, acquisitionPrice__origin: 'RECONCILIATION' }, ppc: 6000 });
    const vue = es.buildCanonicalEntityState(equipement(ligne.kc as Record<string, unknown>, { 'equipments.purchase_price_cents': 6000 }));
    const run = runner(ligne);
    expect(await es.recordManualEntityEdit({
      target: { type: 'EQUIPMENT', id: 11 }, accountId: 7, before: vue, after: { acquisitionPrice: 60 },
    }, run as never)).toEqual(['acquisitionPrice']);
  });

  it('rien de modifié par rapport à la vue fournie : aucune requête', async () => {
    const run = runner(ligneEquipement());
    const vue = es.buildCanonicalEntityState(equipement({}, { 'equipments.purchase_price_cents': 5000 }));
    expect(await es.recordManualEntityEdit({
      target: { type: 'EQUIPMENT', id: 11 }, accountId: 7, before: vue, after: { acquisitionPrice: 50 },
    }, run as never)).toEqual([]);
    expect(run.unsafe).not.toHaveBeenCalled();
  });
});
