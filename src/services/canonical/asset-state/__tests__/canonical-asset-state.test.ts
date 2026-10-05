/**
 * CanonicalAssetView et writeCanonicalAssetField — tests unitaires (sans base).
 * CDC 15 SVC-04, SVC-05, T3-01, T3-02, T3-05, T2-38 ; plan lot 11 (D-09, D-10).
 * Lot 16b-3 : `CANONICAL_WRITE_MODE`, `rollout.ts` et l'observation
 * (`divergenceOf`) supprimés — la primitive écrit toujours.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => ({ pgClient: {}, db: {} }));
const emitBusinessEvent = vi.fn(async () => {});
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent }));

const { buildCanonicalAssetState, readCanonicalValue } = await import('../canonical-asset-view');
const {
  planCanonicalWrites, writeCanonicalAssetFields, writeCanonicalAssetField, fieldTargetsAsset,
} = await import('../write-canonical-asset-field');
const { getField } = await import('@/services/canonical/registry');
const { canOverwrite, writeOrigin } = await import('@/services/ai/reconciliation/field-origin');

type Row = Parameters<typeof buildCanonicalAssetState>[0];
const NOW = '2026-09-29T10:00:00.000Z';

function row(kc: Record<string, unknown>, cols: Record<string, unknown> = {}, category = 'VEHICULE'): Row {
  return {
    id: 1, account_id: 7, category, key_characteristics: JSON.stringify(kc), updated_at: NOW,
    status: 'EN_SERVICE', lock_state: 'NONE', purchase_date: null, purchase_price_cents: null,
    registration_number: null, address: null, city: null, postal_code: null, warranty_end_date: null,
    mileage_or_hours: null, ...cols,
  };
}

/** État final comparable, sans les métadonnées d'origine ni les dates d'écriture. */
function sansOrigine(kc: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(kc).filter(([k]) => !/__(origin|updatedAt|authority|sourceDate)$/.test(k)));
}

describe('field-origin — préséance', () => {
  it('humain passe toujours ; automatique ne remplace jamais une valeur humaine renseignée', () => {
    expect(canOverwrite({ origin: 'RECONCILIATION', empty: false }, 'USER')).toEqual({ allowed: true });
    expect(canOverwrite({ origin: 'USER', empty: false }, 'ADMIN')).toEqual({ allowed: true });
    expect(canOverwrite({ origin: 'USER', empty: false }, 'RECONCILIATION')).toMatchObject({ allowed: false });
    expect(canOverwrite({ origin: 'ADMIN', empty: false }, 'DOCUMENT_EXTRACTION')).toMatchObject({ allowed: false });
    expect(canOverwrite({ origin: 'USER', empty: true }, 'RECONCILIATION')).toEqual({ allowed: true });
    expect(canOverwrite({ origin: 'DOCUMENT_EXTRACTION', empty: false }, 'RECONCILIATION')).toEqual({ allowed: true });
  });

  it('writeOrigin humain retire l’autorité de la preuve précédente ; appel historique inchangé', () => {
    const kc = { x: 1, x_origin: 'auto', x__authority: 80, x__sourceDate: '2026-01-01' };
    expect(writeOrigin(kc, 'x', 'RECONCILIATION')).toEqual({ x: 1, x__origin: 'RECONCILIATION', x__authority: 80, x__sourceDate: '2026-01-01' });
    expect(writeOrigin(kc, 'x', 'USER', { updatedAt: NOW })).toEqual({ x: 1, x__origin: 'USER', x__updatedAt: NOW });
  });
});

describe('CanonicalAssetView', () => {
  it('clé canonique, puis alias, puis colonne historique (D-10), dans l’unité canonique (D-09)', () => {
    const st = buildCanonicalAssetState(row(
      { registrationNumber: 'AB-123-CD', registrationNumber__origin: 'DOCUMENT_EXTRACTION', purchasePriceCents: 150000 },
      { purchase_date: '2020-05-04', mileage_or_hours: 42000, registration_number: 'ZZ-999-ZZ' },
    ));
    expect(st.family).toBe('VEHICULE');
    expect(st.fields.registrationNumber).toMatchObject({ value: 'AB-123-CD', origin: 'DOCUMENT_EXTRACTION', from: 'key' });
    // Alias en centimes → euros.
    expect(st.fields.acquisitionPrice).toMatchObject({ value: 1500, from: 'alias', fromName: 'purchasePriceCents', origin: 'USER' });
    // Colonnes historiques : origine inconnue → USER (protégée).
    expect(st.fields.acquisitionDate).toMatchObject({ value: '2020-05-04', from: 'column', fromName: 'purchase_date', origin: 'USER' });
    expect(st.fields.mileage).toMatchObject({ value: 42000, from: 'column' });
    expect(st.fields.address1).toBeUndefined(); // hors famille VEHICULE
  });

  it('colonne en centimes relue en euros ; valeur hors format signalée non normalisée', () => {
    const st = buildCanonicalAssetState(row({ acquisitionDate: 'hier' }, { purchase_price_cents: 74900 }, 'OBJET'));
    expect(st.family).toBe('OBJECT');
    expect(st.fields.acquisitionPrice.value).toBe(749);
    expect(st.fields.acquisitionDate).toMatchObject({ value: 'hier', normalized: false });
    expect(readCanonicalValue(row({}, { purchase_price_cents: 74900 }), 'purchasePrice')?.value).toBe(749);
  });
});

describe('planCanonicalWrites', () => {
  const ui = (r: Row, key: string, value: unknown) =>
    planCanonicalWrites(r, [{ key, value }], { origin: 'USER', now: NOW, keepRequestedKey: true });
  const t3 = (r: Row, key: string, value: unknown) =>
    planCanonicalWrites(r, [{ key, value }], { origin: 'RECONCILIATION', now: NOW });

  it('normalise (euros D-09), pose origine et date, recopie les miroirs (E2E-14)', () => {
    const p = ui(row({}), 'acquisitionPrice', '1 500,50 €');
    expect(p.kc.acquisitionPrice).toBe(1500.5);
    expect(p.kc.acquisitionPrice__origin).toBe('USER');
    expect(p.kc.acquisitionPrice__updatedAt).toBe(NOW);
    expect(p.columns).toEqual({ purchase_price_cents: 150050 });
    expect(p.results[0]).toMatchObject({ outcome: 'written', key: 'acquisitionPrice', nextValue: 1500.5, mirrors: { purchase_price_cents: 150050 } });
  });

  it('T3-01 : même valeur écrite par l’UI et par T3 → même état final, hors origine', () => {
    const base = row({ mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION' }, { purchase_date: null });
    const a = planCanonicalWrites(base, [{ key: 'acquisitionDate', value: '04/05/2020' }, { key: 'mileage', value: '12 000 km' }], { origin: 'USER', now: NOW });
    const b = planCanonicalWrites(base, [{ key: 'acquisitionDate', value: '2020-05-04' }, { key: 'mileage', value: 12000 }], { origin: 'RECONCILIATION', now: NOW });
    expect(sansOrigine(a.kc)).toEqual(sansOrigine(b.kc));
    expect(a.columns).toEqual(b.columns);
    expect(a.columns).toEqual({ purchase_date: '2020-05-04', mileage_or_hours: 12000 });
    expect(a.kc.mileage__origin).toBe('USER');
    expect(b.kc.mileage__origin).toBe('RECONCILIATION');
  });

  it('T3-02 : IA remplit A, l’utilisateur corrige B, un nouveau document propose A → B reste', () => {
    const r1 = t3(row({}), 'registrationNumber', 'AA-111-AA');
    expect(r1.results[0].outcome).toBe('written');
    const r2 = ui(row(r1.kc, r1.columns), 'registrationNumber', 'BB-222-BB');
    expect(r2.kc.registrationNumber__origin).toBe('USER');
    const r3 = t3(row(r2.kc, r2.columns), 'registrationNumber', 'AA-111-AA');
    expect(r3.results[0]).toMatchObject({ outcome: 'protected', reason: 'HUMAN_VALUE_PROTECTED', previousValue: 'BB-222-BB' });
    expect(r3.kc.registrationNumber).toBe('BB-222-BB');
    expect(r3.columns).toEqual({});
  });

  it('valeur historique non tracée (colonne seule) : protégée contre l’automatique', () => {
    const p = t3(row({}, { purchase_date: '2019-01-01' }), 'acquisitionDate', '2020-01-01');
    expect(p.results[0].outcome).toBe('protected');
  });

  it('écriture humaine d’une valeur identique : origine USER (T2-38), valeur matérialisée ; automatique identique : rien', () => {
    const auto = row({ mileage: 5000, mileage__origin: 'DOCUMENT_EXTRACTION', mileage__authority: 70 }, { mileage_or_hours: 5000 });
    const h = ui(auto, 'mileage', '5000');
    expect(h.results[0].outcome).toBe('written');
    expect(h.kc).toMatchObject({ mileage: 5000, mileage__origin: 'USER' });
    expect(h.kc.mileage__authority).toBeUndefined();
    expect(t3(auto, 'mileage', 5000).results[0].outcome).toBe('unchanged');
    // Valeur en colonne seulement : l'humain la matérialise dans la fiche.
    const col = ui(row({}, { registration_number: 'CC-333-CC' }), 'registrationNumber', 'CC-333-CC');
    expect(col.kc.registrationNumber).toBe('CC-333-CC');
  });

  it('alias déjà présents alignés (dans leur unité) ; effacement humain vide fiche, alias et miroirs', () => {
    const r = row({ purchasePriceCents: 100000, prixAchat: '1000' }, { purchase_price_cents: 100000 }, 'OBJET');
    const p = ui(r, 'acquisitionPrice', 1200);
    expect(p.kc).toMatchObject({ acquisitionPrice: 1200, purchasePriceCents: 120000, prixAchat: 1200 });
    const clear = ui(row(p.kc, p.columns, 'OBJET'), 'acquisitionPrice', '');
    expect(clear.kc.acquisitionPrice).toBeUndefined();
    expect(clear.kc.purchasePriceCents).toBeUndefined();
    expect(clear.columns).toEqual({ purchase_price_cents: null });
    expect(buildCanonicalAssetState(row(clear.kc, { ...clear.columns }, 'OBJET')).fields.acquisitionPrice).toBeUndefined();
  });

  it('refus : clé inconnue, exclue, hors famille, valeur invalide, valeur attendue changée', () => {
    const p = planCanonicalWrites(row({ mileage: 10 }), [
      { key: 'pointure', value: 42 },
      { key: 'iban', value: 'FR76…' },
      { key: 'livingArea', value: 80 },
      { key: 'acquisitionDate', value: '31/02/2020' },
      { key: 'mileage', value: 20, expectedCurrent: 15 },
    ], { origin: 'USER', now: NOW });
    expect(p.results.map((r) => [r.outcome, r.reason?.split(' ')[0]])).toEqual([
      ['invalid', 'UNKNOWN_KEY'], ['invalid', 'EXCLUDED_KEY'], ['invalid', 'FIELD_NOT_APPLICABLE'],
      ['invalid', 'acquisitionDate'], ['conflict', 'CURRENT_VALUE_CHANGED'],
    ]);
    expect(p.changed).toBe(false);
  });

  it('clé canonique d’une autre famille = alias dans celle du bien (generalCondition → condition pour un objet)', () => {
    const obj = row({}, { general_condition: null }, 'OBJET');
    const p = ui(obj, 'generalCondition', 'Bon état');
    expect(p.results[0]).toMatchObject({ key: 'condition', requestedKey: 'generalCondition', outcome: 'written', nextValue: 'BON' });
    expect(p.kc).toMatchObject({ condition: 'BON', generalCondition: 'BON', condition__origin: 'USER' });
    expect(p.columns).toEqual({ general_condition: 'BON' });
    // Lecture : l'alias est reconnu pour un objet, la clé reste canonique en immobilier.
    expect(buildCanonicalAssetState(row({ generalCondition: 'MOYEN' }, {}, 'OBJET')).fields.condition)
      .toMatchObject({ value: 'MOYEN', from: 'alias', fromName: 'generalCondition' });
    expect(buildCanonicalAssetState(row({ generalCondition: 'MOYEN' }, {}, 'IMMOBILIER')).fields.generalCondition)
      .toMatchObject({ value: 'MOYEN', from: 'key' });
    // Un alias existant est aligné par une écriture automatique.
    const t = t3(row({ generalCondition: 'MOYEN', generalCondition__origin: 'DOCUMENT_EXTRACTION' }, {}, 'OBJET'), 'condition', 'NEUF');
    expect(t.results[0].outcome).toBe('written');
    expect(t.kc).toMatchObject({ condition: 'NEUF', generalCondition: 'NEUF' });
  });
});

describe('writeCanonicalAssetFields — écriture réelle seule (lot 16b-3)', () => {
  const kc = { mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION' };
  let calls: Array<{ q: string; p: unknown[] }>;
  const runner = () => {
    const unsafe = vi.fn(async (q: string, p: unknown[] = []) => {
      calls.push({ q: q.replace(/\s+/g, ' ').trim(), p });
      if (q.includes('row_to_json')) return [{ r: row(kc) }];
      return [];
    });
    return { unsafe, begin: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({ unsafe })) };
  };
  beforeEach(() => { calls = []; emitBusinessEvent.mockClear(); });
  const input = { assetId: 1, accountId: 7, origin: 'RECONCILIATION' as const, source: { type: 'document', id: 55 }, writes: [{ key: 'kilometrage', value: 2000 }] };

  it('commutateur retiré encore posé (legacy / shadow) : ignoré, écriture réelle sous verrou', async () => {
    for (const v of ['legacy', 'shadow']) {
      vi.stubEnv('CANONICAL_WRITE_MODE', v);
      calls = [];
      const run = runner();
      const r = await writeCanonicalAssetFields(input, {}, run as never);
      expect(r).toMatchObject({ notFound: false });
      expect(r).not.toHaveProperty('dryRun');
      expect(run.begin).toHaveBeenCalled();
      expect(calls.some((c) => c.q.includes('FOR UPDATE'))).toBe(true);
      expect(calls.some((c) => c.q.startsWith('UPDATE assets'))).toBe(true);
      expect(calls.find((c) => c.q.startsWith('INSERT INTO canonical_field_writes'))!.p[11]).toBe(false); // dry_run
    }
    vi.unstubAllEnvs();
  });

  it('transaction, FOR UPDATE borné au compte, UPDATE avec miroirs, journal, ai_field_updates, événement', async () => {
    const run = runner();
    const { writes: _w, ...un } = input;
    const r = await writeCanonicalAssetField({
      ...un, key: 'kilometrage', value: 2000, traceId: 'tr-1',
      trace: { reasonCode: 'AUTO_VALUE_BETTER_AUTHORITY', authority: 90 },
    }, run as never);
    expect(r).toMatchObject({ notFound: false });
    expect(r.field).toMatchObject({ key: 'mileage', requestedKey: 'kilometrage', outcome: 'written' });
    const sel = calls.find((c) => c.q.includes('row_to_json'))!;
    expect(sel.q).toMatch(/a\.account_id = \$2 AND a\.deleted_at IS NULL FOR UPDATE/);
    expect(sel.p).toEqual([1, 7]);
    const upd = calls.find((c) => c.q.startsWith('UPDATE assets'))!;
    expect(upd.q).toMatch(/mileage_or_hours = \$4 WHERE id = \$1 AND account_id = \$2/);
    expect(JSON.parse(upd.p[2] as string)).toMatchObject({ mileage: 2000, mileage__origin: 'RECONCILIATION' });
    expect(upd.p[3]).toBe(2000);
    const j = calls.find((c) => c.q.startsWith('INSERT INTO canonical_field_writes'))!;
    expect(j.p.slice(0, 12)).toEqual([7, 1, 'mileage', '1000', '2000', 'RECONCILIATION', null, 'document', '55', 'tr-1', 'written', false]);
    expect(JSON.parse(upd.p[2] as string)).toMatchObject({ mileage__authority: 90 });
    const ai = calls.find((c) => c.q.startsWith('INSERT INTO ai_field_updates'))!;
    expect(ai.q).toMatch(/\(account_id, asset_id, asset_file_id, field_key, old_value, new_value, reason_code\)/);
    expect(ai.p).toEqual([7, 1, 55, 'mileage', '1000', '2000', 'AUTO_VALUE_BETTER_AUTHORITY']);
    expect(emitBusinessEvent).toHaveBeenCalledWith({ type: 'ASSET_UPDATED', accountId: 7, entityId: 1 });
  });

  it('plusieurs clés → UN INSERT journal et UN INSERT ai_field_updates (multi-VALUES)', async () => {
    const run = runner();
    await writeCanonicalAssetFields({
      ...input,
      writes: [{ key: 'mileage', value: 3000 }, { key: 'vin', value: 'VF1', trace: { confidence: 'certain' } }, { key: 'seats', value: 5 }],
    }, {}, run as never);
    const j = calls.filter((c) => c.q.startsWith('INSERT INTO canonical_field_writes'));
    expect(j).toHaveLength(1);
    expect(j[0].p).toHaveLength(3 * 14);
    const ai = calls.filter((c) => c.q.startsWith('INSERT INTO ai_field_updates'));
    expect(ai).toHaveLength(1);
    expect(ai[0].q).toMatch(/\(account_id, asset_id, asset_file_id, field_key, old_value, new_value, confidence\) VALUES \(\$1.*\), \(.*\), \(.*\$21\)$/);
    expect(ai[0].p.filter((_, i) => i % 7 === 6)).toEqual([null, 'certain', null]);
  });

  it('écriture USER → pas de ligne ai_field_updates ; valeur protégée → journal « protected », pas d’UPDATE', async () => {
    const run = runner();
    await writeCanonicalAssetFields({ ...input, origin: 'USER', emitEvent: false }, {}, run as never);
    expect(calls.some((c) => c.q.startsWith('INSERT INTO ai_field_updates'))).toBe(false);
    expect(emitBusinessEvent).not.toHaveBeenCalled();

    calls = [];
    kc.mileage__origin = 'USER';
    const r = await writeCanonicalAssetFields(input, {}, run as never);
    kc.mileage__origin = 'DOCUMENT_EXTRACTION';
    expect(r.fields[0].outcome).toBe('protected');
    expect(calls.some((c) => c.q.startsWith('UPDATE assets'))).toBe(false);
    expect(calls.find((c) => c.q.startsWith('INSERT INTO canonical_field_writes'))!.p[10]).toBe('protected');
    expect(emitBusinessEvent).not.toHaveBeenCalled();
  });
});

describe('relecture lot 13', () => {
  const N = '2026-09-29T10:00:00.000Z';
  it('section entière (confirmUnchanged: false) : une valeur identique garde son origine automatique', () => {
    const r = row({ mileage: 1000, mileage__origin: 'DOCUMENT_EXTRACTION' });
    const section = planCanonicalWrites(r, [{ key: 'mileage', value: '1 000' }], { origin: 'USER', now: N, confirmUnchanged: false });
    expect(section.results[0].outcome).toBe('unchanged');
    expect(section.kc.mileage__origin).toBe('DOCUMENT_EXTRACTION');
    // Écriture ciblée (défaut) : confirmation humaine, comme au lot 11.
    const cible = planCanonicalWrites(r, [{ key: 'mileage', value: '1 000' }], { origin: 'USER', now: N });
    expect(cible.kc.mileage__origin).toBe('USER');
  });

  it('champ d’une autre cible que le bien (roomArea) : refusé explicitement, rien d’écrit', () => {
    const p = planCanonicalWrites(row({}, {}, 'IMMOBILIER'), [{ key: 'roomArea', value: 12 }], { origin: 'USER', now: N });
    expect(p.results[0]).toMatchObject({ outcome: 'invalid', reason: 'TARGET_NOT_ASSET' });
    expect(p.changed).toBe(false);
    expect(fieldTargetsAsset(getField('acquisitionDate')!)).toBe(true);
  });
});
