/**
 * writeCanonicalAssetField / CanonicalAssetView — scénarios sur PostgreSQL.
 * CDC 15 T3-01, T3-02, T3-05, T2-38, E2E-14 ; plan lot 11 (D-10).
 *
 * OPT-IN : exécuté seulement si `CANONICAL_WRITE_IT_DATABASE_URL` désigne une
 * base JETABLE au schéma à jour (drizzle-kit push + migrations 0102, 0103 et
 * 0216). Sans la variable, tout est ignoré : aucun test unitaire n'ouvre de
 * connexion.
 *
 *   CANONICAL_WRITE_IT_DATABASE_URL=postgres://… npx vitest run canonical-write.pg
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const IT_URL = process.env.CANONICAL_WRITE_IT_DATABASE_URL;

// Hors sujet ici : quota de l'offre et recontrôle T3 différé.
vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
const emitBusinessEvent = vi.fn(async () => {});
vi.mock('@/services/verebona-assistant/events/business-events', () => ({ emitBusinessEvent }));

describe.skipIf(!IT_URL)('écritures canoniques — PostgreSQL', () => {
  type Sql = typeof import('@/db').pgClient;
  let sql: Sql;
  let canon: typeof import('@/services/canonical/asset-state');
  let facade: typeof import('@/services/asset-details-write.service');
  const tag = `cw${Date.now()}`;
  const modeInitial = process.env.CANONICAL_WRITE_MODE;

  beforeAll(async () => {
    process.env.DATABASE_URL = IT_URL;
    sql = (await import('@/db')).pgClient;
    canon = await import('@/services/canonical/asset-state');
    facade = await import('@/services/asset-details-write.service');
  });
  afterEach(() => {
    if (modeInitial === undefined) delete process.env.CANONICAL_WRITE_MODE;
    else process.env.CANONICAL_WRITE_MODE = modeInitial;
    emitBusinessEvent.mockClear();
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  async function compte(name: string) {
    const [u] = await sql<{ id: number }[]>`
      INSERT INTO users (email, password_hash, status) VALUES (${`${tag}-${name}@test.invalid`}, 'x', 'ACTIVE') RETURNING id`;
    const [a] = await sql<{ id: number }[]>`INSERT INTO accounts (name, owner_user_id) VALUES (${name}, ${u.id}) RETURNING id`;
    return { userId: u.id, accountId: a.id };
  }
  async function bien(c: { userId: number; accountId: number }, kc: Record<string, unknown> = {}, category = 'VEHICULE') {
    const [a] = await sql<{ id: number }[]>`
      INSERT INTO assets (user_id, account_id, category, name, key_characteristics)
      VALUES (${c.userId}, ${c.accountId}, ${category}, 'bien', ${JSON.stringify(kc)}) RETURNING id`;
    return a.id;
  }
  async function ligne(id: number) {
    const [r] = await sql<Array<{ kc: string; purchase_date: string | null; purchase_price_cents: number | null; registration_number: string | null; mileage_or_hours: number | null; updated_at: string }>>`
      SELECT key_characteristics AS kc, to_char(purchase_date, 'YYYY-MM-DD') AS purchase_date, purchase_price_cents,
             registration_number, mileage_or_hours, updated_at::text AS updated_at
        FROM assets WHERE id = ${id}`;
    return { ...r, kcObj: JSON.parse(r.kc ?? '{}') as Record<string, unknown> };
  }
  const sansOrigine = (kc: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(kc).filter(([k]) => !/__(origin|updatedAt|authority|sourceDate)$/.test(k)));

  it('T3-01 : même valeur par l’UI (façade) et par une écriture automatique → même état final, hors origine', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const c = await compte('t301');
    const a = await bien(c);
    const b = await bien(c);
    const valeurs = { registrationNumber: 'ab-123-cd', acquisitionDate: '2021-03-15', acquisitionPrice: '18 500 €', mileage: '42 000' };

    await facade.updateAssetDetails({ assetId: a, accountId: c.accountId, section: 'vehicle_identification', fields: valeurs, actorUserId: c.userId });
    const auto = await canon.writeCanonicalAssetFields({
      assetId: b, accountId: c.accountId, origin: 'RECONCILIATION', source: { type: 'reconciliation', id: 'run-1' },
      writes: Object.entries(valeurs).map(([key, value]) => ({ key, value })),
    });
    expect(auto.fields.map((f) => f.outcome)).toEqual(['written', 'written', 'written', 'written']);

    const la = await ligne(a);
    const lb = await ligne(b);
    expect(sansOrigine(la.kcObj)).toEqual(sansOrigine(lb.kcObj));
    expect([la.purchase_date, la.purchase_price_cents, la.registration_number, la.mileage_or_hours])
      .toEqual([lb.purchase_date, lb.purchase_price_cents, lb.registration_number, lb.mileage_or_hours]);
    expect(la.kcObj).toMatchObject({ registrationNumber: 'AB-123-CD', acquisitionPrice: 18500, mileage: 42000, registrationNumber__origin: 'USER' });
    expect(lb.kcObj.registrationNumber__origin).toBe('RECONCILIATION');

    // Journal : USER avec auteur ; ai_field_updates seulement pour l'automatique.
    const ja = await sql`SELECT canonical_key, origin, actor_user_id, source_type, dry_run FROM canonical_field_writes WHERE asset_id = ${a} ORDER BY id`;
    expect(ja).toHaveLength(4);
    expect(ja[0]).toMatchObject({ origin: 'USER', actor_user_id: c.userId, source_type: 'asset_details', dry_run: false });
    expect(await sql`SELECT 1 FROM ai_field_updates WHERE asset_id = ${a}`).toHaveLength(0);
    const ai = await sql`SELECT field_key, new_value FROM ai_field_updates WHERE asset_id = ${b} ORDER BY id`;
    expect(ai.map((r) => r.field_key)).toEqual(['registrationNumber', 'acquisitionDate', 'acquisitionPrice', 'mileage']);
    expect(emitBusinessEvent).toHaveBeenCalledWith({ type: 'ASSET_UPDATED', accountId: c.accountId, entityId: b });
  });

  it('T3-02 / T2-38 : valeur USER protégée contre une écriture automatique ; l’automatique remplit un champ vide', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const c = await compte('t302');
    const a = await bien(c, { registrationNumber: 'AA-111-AA', registrationNumber__origin: 'DOCUMENT_EXTRACTION' });
    await facade.updateAssetDetails({ assetId: a, accountId: c.accountId, section: 'vehicle_identification', fields: { registrationNumber: 'BB-222-BB' } });
    const avant = await ligne(a);

    const r = await canon.writeCanonicalAssetField({ assetId: a, accountId: c.accountId, key: 'registrationNumber', value: 'AA-111-AA', origin: 'DOCUMENT_EXTRACTION' });
    expect(r.field).toMatchObject({ outcome: 'protected', previousValue: 'BB-222-BB', previousOrigin: 'USER' });
    const apres = await ligne(a);
    expect(apres.kc).toBe(avant.kc);
    expect(apres.registration_number).toBe('BB-222-BB');
    expect(apres.updated_at).toBe(avant.updated_at);
    const [j] = await sql`SELECT outcome FROM canonical_field_writes WHERE asset_id = ${a} AND origin = 'DOCUMENT_EXTRACTION'`;
    expect(j.outcome).toBe('protected');

    const vide = await canon.writeCanonicalAssetField({ assetId: a, accountId: c.accountId, key: 'vin', value: 'VF1ABC', origin: 'DOCUMENT_EXTRACTION' });
    expect(vide.field?.outcome).toBe('written');
  });

  it('E2E-14 : fiche = colonne = vue canonique = lecture de l’assistant ; compte étranger : introuvable', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const c = await compte('e2e14');
    const autre = await compte('e2e14-autre');
    const a = await bien(c);
    await facade.updateAssetDetails({ assetId: a, accountId: c.accountId, section: 'vehicle_identification', fields: { registrationNumber: 'cd-456-ef', acquisitionPrice: 749 } });
    const l = await ligne(a);
    const vue = await canon.getCanonicalAssetState(a, c.accountId);
    expect(vue?.fields.registrationNumber).toMatchObject({ value: 'CD-456-EF', origin: 'USER', from: 'key' });
    expect(l.registration_number).toBe('CD-456-EF');
    expect(vue?.fields.acquisitionPrice.value).toBe(749);
    expect(l.purchase_price_cents).toBe(74900);
    const { sqlLookup } = await import('@/services/verebona-assistant/commands/plan.service');
    const t2 = await sqlLookup.getAssetState!(c.accountId, a);
    expect(t2?.characteristics.registrationNumber).toBe('CD-456-EF');

    expect(await canon.getCanonicalAssetState(a, autre.accountId)).toBeNull();
    const refus = await canon.writeCanonicalAssetField({ assetId: a, accountId: autre.accountId, key: 'registrationNumber', value: 'ZZ', origin: 'USER' });
    expect(refus.notFound).toBe(true);
    expect((await ligne(a)).registration_number).toBe('CD-456-EF');
  });

  it('D-10 : repli alias → colonne tant que le rattrapage n’a pas eu lieu', async () => {
    const c = await compte('repli');
    const a = await bien(c, { purchasePriceCents: 120000 }, 'OBJET');
    await sql`UPDATE assets SET purchase_date = '2018-06-01' WHERE id = ${a}`;
    const vue = await canon.getCanonicalAssetState(a, c.accountId);
    expect(vue?.fields.acquisitionPrice).toMatchObject({ value: 1200, from: 'alias' });
    expect(vue?.fields.acquisitionDate).toMatchObject({ value: '2018-06-01', from: 'column', origin: 'USER' });
  });

  it('shadow : le chemin historique écrit, la primitive n’écrit rien et journalise la divergence', async () => {
    process.env.CANONICAL_WRITE_MODE = 'shadow';
    const c = await compte('shadow');
    const a = await bien(c, { acquisitionPrice: 900, acquisitionPrice__origin: 'DOCUMENT_EXTRACTION' }, 'OBJET');
    await facade.updateAssetDetails({ assetId: a, accountId: c.accountId, section: 'common', fields: { acquisitionPrice: '1000', notes: 'rien' } });
    const l = await ligne(a);
    // Chemin historique : valeur brute, pas de miroir ; origine USER posée
    // aussi en legacy/shadow depuis le lot 13 (CDC 15 T3-02).
    expect(l.kcObj).toMatchObject({ acquisitionPrice: '1000', acquisitionPrice__origin: 'USER' });
    expect(l.purchase_price_cents).toBeNull();
    // Observation hors du chemin de la requête : on attend le journal.
    type J = Array<{ canonical_key: string; dry_run: boolean; divergence: Record<string, unknown> | null }>;
    let j: J = [];
    for (let i = 0; i < 40 && j.length < 2; i++) {
      j = await sql<J>`SELECT canonical_key, dry_run, divergence FROM canonical_field_writes WHERE asset_id = ${a} ORDER BY id`;
      if (j.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(j).toHaveLength(2);
    expect(j.every((r) => r.dry_run)).toBe(true);
    const prix = j.find((r) => r.canonical_key === 'acquisitionPrice')!;
    expect(prix.divergence).toEqual({
      mirrors: { purchase_price_cents: { legacy: null, canonical: 100000 } },
    });
    expect(j.find((r) => r.canonical_key === 'notes')!.divergence).toEqual({ mirrors: { notes: { legacy: null, canonical: 'rien' } } });

    // Appel direct de la primitive en shadow : bien intact, journal dry_run.
    const avant = await ligne(a);
    const r = await canon.writeCanonicalAssetField({ assetId: a, accountId: c.accountId, key: 'acquisitionDate', value: '2020-01-01', origin: 'RECONCILIATION' });
    expect(r).toMatchObject({ dryRun: true, field: { outcome: 'written' } });
    expect(await ligne(a)).toEqual(avant);
    expect(await sql`SELECT 1 FROM ai_field_updates WHERE asset_id = ${a}`).toHaveLength(0);
    expect(emitBusinessEvent).not.toHaveBeenCalled();
  });

  it('legacy : la primitive ne fait rien ; la façade garde le chemin historique', async () => {
    process.env.CANONICAL_WRITE_MODE = 'legacy';
    const c = await compte('legacy');
    const a = await bien(c);
    const r = await canon.writeCanonicalAssetField({ assetId: a, accountId: c.accountId, key: 'vin', value: 'X', origin: 'USER' });
    expect(r.skipped).toBe(true);
    await facade.updateAssetDetails({ assetId: a, accountId: c.accountId, section: 'vehicle_identification', fields: { registrationNumber: 'ab-1' } });
    const l = await ligne(a);
    expect(l.kcObj).toEqual({ registrationNumber: 'ab-1', registrationNumber__origin: 'USER', registrationNumber__updatedAt: expect.any(String) });
    expect(l.registration_number).toBe('ab-1');
    expect(await sql`SELECT 1 FROM canonical_field_writes WHERE asset_id = ${a}`).toHaveLength(0);
  });

  it('façade enabled : alias d’une autre famille, origine d’une clé hors registre nettoyée, valeur attendue sous verrou', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const c = await compte('facade');
    const a = await bien(c, { pointure: 40, pointure_origin: 'auto', pointure__authority: 50, pointure__sourceDate: '2025-01-01' }, 'OBJET');
    await facade.updateAssetDetails({
      assetId: a, accountId: c.accountId, section: 'object_condition', fields: { generalCondition: 'Bon état', pointure: 42 },
    });
    const [g] = await sql`SELECT general_condition FROM assets WHERE id = ${a}`;
    expect(g.general_condition).toBe('BON');
    const kc = (await ligne(a)).kcObj;
    expect(kc).toMatchObject({ condition: 'BON', generalCondition: 'BON', condition__origin: 'USER', pointure: 42, pointure__origin: 'USER' });
    expect(kc).not.toHaveProperty('pointure_origin');
    expect(kc).not.toHaveProperty('pointure__authority');
    expect(kc).not.toHaveProperty('pointure__sourceDate');

    // Commande confirmée « A → B » : la valeur en place a changé → CONFLICT, rien d'écrit.
    const avant = await ligne(a);
    await expect(facade.updateAssetDetails({
      assetId: a, accountId: c.accountId, section: 'object_condition', fields: { condition: 'NEUF' },
      expectedCurrent: { condition: 'MOYEN' },
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await ligne(a)).toEqual(avant);
    await facade.updateAssetDetails({
      assetId: a, accountId: c.accountId, section: 'object_condition', fields: { condition: 'NEUF' },
      expectedCurrent: { condition: 'BON' },
    });
    expect((await ligne(a)).kcObj.condition).toBe('NEUF');
  });

  it('verrou : une écriture attend la transaction concurrente (autosave), sans interblocage ni perte', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const c = await compte('verrou');
    const a = await bien(c);
    let libere!: () => void;
    const tenu = new Promise<void>((r) => { libere = r; });
    let verrouPose!: () => void;
    const pose = new Promise<void>((r) => { verrouPose = r; });
    // « Autosave » concurrente : verrouille la ligne, écrit une autre clé, puis valide.
    const autosave = sql.begin(async (t) => {
      await t`SELECT id FROM assets WHERE id = ${a} FOR UPDATE`;
      verrouPose();
      await tenu;
      const [r] = await t<{ kc: string }[]>`SELECT key_characteristics AS kc FROM assets WHERE id = ${a}`;
      await t`UPDATE assets SET key_characteristics = ${JSON.stringify({ ...JSON.parse(r.kc), notesAutosave: 'ok' })} WHERE id = ${a}`;
    });
    await pose;
    let fini = false;
    const ecriture = canon.writeCanonicalAssetField({ assetId: a, accountId: c.accountId, key: 'vin', value: 'VIN-1', origin: 'USER' })
      .then((r) => { fini = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(fini).toBe(false); // bloquée par le FOR UPDATE
    libere();
    await autosave;
    const r = await ecriture;
    expect(r.field?.outcome).toBe('written');
    expect((await ligne(a)).kcObj).toMatchObject({ notesAutosave: 'ok', vin: 'VIN-1' });

    // Rafale concurrente façade + primitive sur le même bien : tout aboutit.
    const res = await Promise.allSettled([
      ...Array.from({ length: 6 }, (_, i) => facade.updateAssetDetails({
        assetId: a, accountId: c.accountId, section: 'vehicle_usage', fields: { mileage: 1000 + i },
      })),
      ...Array.from({ length: 6 }, (_, i) => canon.writeCanonicalAssetField({
        assetId: a, accountId: c.accountId, key: `seats`, value: i + 1, origin: 'RECONCILIATION',
      })),
    ]);
    expect(res.filter((x) => x.status === 'rejected')).toEqual([]);
    const fin = await ligne(a);
    expect(fin.kcObj).toMatchObject({ notesAutosave: 'ok', vin: 'VIN-1' });
    expect(fin.mileage_or_hours).toBe(fin.kcObj.mileage);
  });

  it('annulation : colonnes miroirs capturées puis rétablies', async () => {
    process.env.CANONICAL_WRITE_MODE = 'enabled';
    const c = await compte('undo');
    const a = await bien(c, {}, 'OBJET');
    await canon.writeCanonicalAssetField({ assetId: a, accountId: c.accountId, key: 'acquisitionDate', value: '2019-02-02', origin: 'USER' });
    const capture = await canon.readMirrorColumns(sql as never, c.accountId, a);
    expect(capture).toMatchObject({ purchase_date: '2019-02-02', purchase_price_cents: null });
    await canon.writeCanonicalAssetField({ assetId: a, accountId: c.accountId, key: 'acquisitionDate', value: '2020-03-03', origin: 'USER' });
    await canon.restoreMirrorColumns(sql as never, c.accountId, a, capture!);
    expect((await ligne(a)).purchase_date).toBe('2019-02-02');
  });
});
