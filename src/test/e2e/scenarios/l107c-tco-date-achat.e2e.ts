/**
 * Lot 107C — ticket P1 « TCO — Date d'achat du bien prioritaire pour le
 * calcul annuel » — PostgreSQL 16 réel.
 *
 * Chemins de PRODUCTION : primitive canonique (`writeCanonicalAssetFields`,
 * origines USER / DOCUMENT_EXTRACTION), lecture canonique (clé, alias,
 * colonne `assets.purchase_date`), lecteur des Opérations, service TCO
 * (`readAssetTco` → `computeTco` → `resolveAcquisitionStart` →
 * `computeTcoAnnual`), routes HTTP de la fiche et du BO, contrôle
 * COH-OPS-ACQUISITION-DATE v2 (moteur `controlObjects` puis campagne
 * orchestrée à blanc / corrective), journal `canonical_field_writes`. État
 * T3 persisté écrit en SQL (Opérations consolidées), comme le stock. Aucun
 * appel IA. Assertions limitées aux comptes créés ici ; date de référence
 * injectée.
 *
 *   L107C-E2E-01  cas constaté : date USER 15/03/2020, ACQUISITION liée du 21/09/2007 → départ 2020 ; route, BO, T2, export
 *   L107C-E2E-02  bien + équipement (+ accessoire) : seule l'acquisition du bien ; accessoire ajouté → indéterminée
 *   L107C-E2E-03  sans date canonique, achat certain : date reprise ; campagne à blanc puis corrective → fiche enrichie, idempotente
 *   L107C-E2E-04  startDate seule (début de contrat) : aucun faux achat
 *   L107C-E2E-05  date USER ≠ acquisition déjà datée : saisie conservée, écart détecté par le contrôle (realized_date non nul)
 *   L107C-E2E-06  date automatique fausse, achat prouvé : réparation traçable, idempotente, jamais sur une valeur USER
 *   L107C-E2E-07  date seulement dans `assets.purchase_date` ou un alias historique : repli canonique préservé
 *   L107C-E2E-08  date impossible / future / après cession ; LLD et multibiens : aucune annualisation fictive, aucun emprunt
 *   L107C-E2E-09  correction de la date pendant l'ouverture : relecture immédiate, total inchangé
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow, AssetRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0, adminId: 0 }));
vi.mock('@/lib/auth-guards', async (o) => ({ ...(await o<object>()), requireAdmin: async () => session.adminId }));

type Json = Record<string, any>;
const AUJ = '2026-11-03';
const CHECK = 'COH-OPS-ACQUISITION-DATE';

scenario('L107C', 'TCO — date d’achat du bien prioritaire pour le calcul annuel', ({ sql, make }) => {
  let NextRequest: typeof import('next/server').NextRequest;
  beforeAll(async () => {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }) as never);
    ({ NextRequest } = await import('next/server'));
  });

  // ── Outils ────────────────────────────────────────────────────────────────
  const tco = async (compte: AccountRow, assetId: number) =>
    (await import('@/services/business-operations/tco/service')).readAssetTco(compte.id, assetId, { today: AUJ });
  const fiche = async (compte: AccountRow, assetId: number) => {
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    const { GET } = await import('@/app/api/assets/[id]/tco/route');
    const res = await GET(new NextRequest(`http://x/api/assets/${assetId}/tco`), { params: Promise.resolve({ id: String(assetId) }) });
    expect(res.status).toBe(200);
    return (await res.json() as Json).tco as Json;
  };
  const bo = async (compte: AccountRow, assetId: number) => {
    const admin = await make.user({ role: 'ADMIN' });
    session.adminId = admin.id;
    const { GET } = await import('@/app/api/admin/operations/tco/route');
    const res = await GET(new NextRequest(`http://x/api/admin/operations/tco?accountId=${compte.id}&assetId=${assetId}`));
    expect(res.status).toBe(200);
    return await res.json() as Json;
  };
  /** Écriture par la primitive canonique unique (même chemin que la fiche, T1, T3). */
  const ecrire = async (compte: AccountRow, assetId: number, fields: Record<string, unknown>, origin: 'USER' | 'DOCUMENT_EXTRACTION' = 'USER') => {
    const canon = await import('@/services/canonical/asset-state');
    await canon.writeCanonicalAssetFields({
      assetId, accountId: compte.id, origin, actorUserId: origin === 'USER' ? compte.ownerUserId : null,
      source: { type: origin === 'USER' ? 'asset_details' : 'document', id: 'e2e-107c' },
      writes: Object.entries(fields).map(([key, value]) => ({ key, value })),
    });
  };
  /** ACQUISITION consolidée (état T3 persisté), justifiée par un document du bien, liée au bien. */
  const acquisition = async (compte: AccountRow, asset: AssetRow, o: {
    cents: number; realized?: string | null; start?: string | null; status?: string; label?: string; equipmentId?: number; authority?: string; autresBiens?: number[];
  }) => {
    const [op] = await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, realized_date, start_date)
      VALUES (${compte.id}, 'ACQUISITION', ${o.status ?? 'REALIZED'}, ${o.label ?? 'Achat L107C'}, 'Vendeur', ${o.realized ?? null}, ${o.start ?? null}) RETURNING id`;
    const [c] = await sql<{ id: number }[]>`
      INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, active, economic_date, target_equipment_id)
      VALUES (${compte.id}, ${op.id}, 'REALIZED_COST', ${o.cents}, 'EUR', true, ${o.realized ?? null}, ${o.equipmentId ?? null}) RETURNING id`;
    const f = await make.assetFile(compte, { assetId: asset.id });
    const [src] = await sql<{ id: number }[]>`
      INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, authority, confidence, active)
      VALUES (${compte.id}, ${op.id}, 'DOCUMENT', ${String(f.id)}, 'INVOICE', 'DOCUMENT', 'certain', true) RETURNING id`;
    await sql`INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, is_primary) VALUES (${c.id}, ${src.id}, true)`;
    for (const b of [asset.id, ...(o.autresBiens ?? [])]) {
      await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority, active)
                VALUES (${compte.id}, ${op.id}, ${b}, ${b === asset.id ? 'PRIMARY' : 'CONCERNED'}, ${o.authority ?? 'DOCUMENT'}, true)`;
    }
    return Number(op.id);
  };
  const equipement = async (asset: AssetRow, name: string) =>
    (await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${asset.id}, ${name}) RETURNING id`)[0].id;
  const ecritures = (assetId: number) => sql<Json[]>`
    SELECT new_value AS v, old_value AS old, origin, source_type, source_id, outcome FROM canonical_field_writes
     WHERE asset_id = ${assetId} AND canonical_key = 'acquisitionDate' ORDER BY id`;
  const canonique = async (compte: AccountRow, assetId: number) => {
    const { getCanonicalAssetState } = await import('@/services/canonical/asset-state/canonical-asset-view');
    return (await getCanonicalAssetState(assetId, compte.id))!.fields.acquisitionDate ?? null;
  };
  const realisee = async (opId: number) => (await sql<{ d: string | null }[]>`SELECT realized_date::text AS d FROM business_operations WHERE id = ${opId}`)[0].d;
  /** Contrôle ciblé par le moteur réel (inspection → réparation déléguée → recontrôle → preuve). */
  const controler = async (compte: AccountRow, ids: number[], mode: 'DRY_RUN' | 'CORRECTIVE' = 'CORRECTIVE') => {
    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([
      import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db'),
    ]);
    return controlObjects({
      ctx: { sql: pgClient as never, now: new Date(`${AUJ}T10:00:00Z`), today: AUJ, mode, correlationId: `coherence:e2e-107c:${CHECK}` },
      check: getCheck(CHECK)!, accountId: compte.id, ids, trigger: 'MANUAL', campaignId: null,
      stillEligible: async () => ({ eligible: true, reason: 'e2e' }),
    });
  };
  const preuve = async (compte: AccountRow, objectId: number) => (await sql<Json[]>`
    SELECT last_result, finding FROM coherence_object_proofs WHERE account_id = ${compte.id} AND check_id = ${CHECK} AND object_id = ${objectId}`)[0];
  const cand = (t: Awaited<ReturnType<typeof tco>>, opId: number) => t.acquisitionStart!.candidates.find((c) => c.operationId === opId)!;

  // ══ 01 ═══════════════════════════════════════════════════════════════════

  it('L107C-E2E-01 — cas constaté : achat confirmé le 15/03/2020, acquisition liée du 21/09/2007 → départ 2020 ; fiche, BO, T2 et export alignés', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await ecrire(compte, maison.id, { acquisitionDate: '2020-03-15', acquisitionPrice: 300_000 });
    const op2007 = await acquisition(compte, maison, { cents: 150_000, realized: '2007-09-21', label: 'Achat mobilier' });

    const t = await tco(compte, maison.id);
    expect(t.period).toMatchObject({ start: '2020-03-15', startSource: 'ASSET_DATA', startStatus: 'RESOLVED', startBasis: 'ASSET_USER', startKind: 'PURCHASE' });
    expect(t.annual.average).toMatchObject({ status: 'COMPUTED', start: '2020-03-15' });
    expect(t.annual.average.years).toBeLessThan(7);
    // Source possible démontrée : l'ancienne règle aurait retenu l'acquisition de 2007 (19,1 ans).
    expect(t.acquisitionStart!.legacyDate).toBe('2007-09-21');
    expect(cand(t, op2007)).toMatchObject({ accepted: false, reason: 'NOT_ASSET_PURCHASE', date: '2007-09-21' });
    // Provenance de la date de la fiche : origine USER, clé canonique, dernière écriture journalisée.
    expect(t.acquisitionStart!.canonical).toMatchObject({ raw: '2020-03-15', origin: 'USER', from: 'key', human: true,
      lastWrite: { value: '2020-03-15', origin: 'USER', sourceType: 'asset_details' } });

    // Fiche (route réelle) : même date, état transmis, jamais la résolution complète.
    const f = await fiche(compte, maison.id);
    expect(f.period).toMatchObject({ start: '2020-03-15', startStatus: 'RESOLVED', startKind: 'PURCHASE' });
    expect(f.acquisitionStart).toBeUndefined();
    expect(JSON.stringify({ period: f.period, average: f.annual.average })).not.toContain('2007');
    // La dépense de 2007 reste visible avec son motif (achat distinct), jamais comme date de départ.
    expect(f.lines).toEqual(expect.arrayContaining([expect.objectContaining({ operationId: op2007, reason: 'NOT_OWNERSHIP_COST' })]));
    // BO : date retenue, source, candidats rejetés et motif, ancienne règle.
    const b = await bo(compte, maison.id);
    expect(b.tco.acquisitionStart).toMatchObject({ status: 'RESOLVED', basis: 'ASSET_USER', date: '2020-03-15', legacyDate: '2007-09-21' });
    expect(b.tco.acquisitionStart.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ operationId: op2007, reason: 'NOT_ASSET_PURCHASE' })]));
    // T2 : même date de départ.
    const { ownershipCostAnswer } = await import('@/services/verebona-assistant/canonical/structured-answers');
    const r = ownershipCostAnswer({ id: maison.id, name: 'Maison' } as never, t) as { answer: string };
    expect(r.answer).toContain('depuis l’achat du bien le');
    expect(r.answer).not.toContain('2007');
    // Diagnostic exportable : même résolution (synthèse TCO de l'export BO).
    const trace = await import('@/services/admin/diagnostics-export/trace');
    const resume = trace.tcoSummary(await trace.loadTcoContext(compte.id, maison.id, AUJ));
    expect(resume).toMatchObject({ disponible: true, period: { start: '2020-03-15' }, acquisitionStart: { legacyDate: '2007-09-21' } });

    // Contrôle : l'acquisition de 2007 n'est pas l'achat du bien mais l'ancienne règle la retenait — constat tracé, rien d'écrit.
    const avant = await ecritures(maison.id);
    await controler(compte, [op2007]);
    expect(await preuve(compte, op2007)).toMatchObject({ last_result: expect.stringMatching(/AMBIGUOUS|FINDING/) });
    expect((await preuve(compte, op2007)).finding).toMatchObject({ anomaly: 'ACQUISITION_MISATTRIBUTED' });
    expect(await ecritures(maison.id)).toEqual(avant);
    expect(await realisee(op2007)).toBe('2007-09-21');
  });

  // ══ 02 ═══════════════════════════════════════════════════════════════════

  it('L107C-E2E-02 — bien + équipement : seule l’acquisition du bien date le TCO ; un second achat possible → indéterminée, alerte ciblée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const chaudiere = await equipement(maison, 'Chaudière');
    const achat = await acquisition(compte, maison, { cents: 30_000_000, realized: '2020-03-15', label: 'Acte de vente' });
    const eq = await acquisition(compte, maison, { cents: 400_000, realized: '2007-09-21', label: 'Achat chaudière', equipmentId: chaudiere });
    const t = await tco(compte, maison.id);
    expect(t.period).toMatchObject({ start: '2020-03-15', startSource: 'OPERATION', startBasis: 'OPERATION' });
    expect(cand(t, eq)).toMatchObject({ reason: 'EQUIPMENT_PURCHASE' });
    expect(t.acquisitionStart!.operationId).toBe(achat);
    const total = t.summary.cumulativeCostCents;

    // Second achat coûté non distinguable (sans prix ni date sur la fiche) : jamais « la plus ancienne ».
    await acquisition(compte, maison, { cents: 20_000, realized: '2010-01-05', label: 'Achat store' });
    const u = await tco(compte, maison.id);
    expect(u.period).toMatchObject({ start: null, startStatus: 'UNDETERMINED' });
    expect(u.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_UNDETERMINED', cents: null });
    expect(u.summary.cumulativeCostCents).toBe(total + 20_000);
    const f = await fiche(compte, maison.id);
    expect(f.annual.average.status).toBe('ACQUISITION_DATE_UNDETERMINED');
    expect(f.warningLabels.join(' ')).toContain('Date d’achat du bien incertaine');
    expect(f.status).toBe('INCOMPLETE');
  });

  // ══ 03 ═══════════════════════════════════════════════════════════════════

  it('L107C-E2E-03 — sans date canonique, achat du bien certain : date reprise ; campagne à blanc (rien) puis corrective (fiche enrichie, provenance), idempotente', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const op = await acquisition(compte, clio, { cents: 1_800_000, realized: '2021-05-01', label: 'Achat Clio' });
    const t = await tco(compte, clio.id);
    expect(t.period).toMatchObject({ start: '2021-05-01', startSource: 'OPERATION' });
    expect(t.acquisitionStart!.repair).toMatchObject({ kind: 'ENRICH_CANONICAL', value: '2021-05-01', operationId: op });

    const o = await import('@/services/coherence/orchestrator');
    const campagne = async (mode: 'DRY_RUN' | 'CORRECTIVE') => {
      const id = await o.startCampaign({ kind: 'MANUAL', trigger: 'e2e', mode, scopeAccountIds: [compte.id] });
      for (let i = 0; i < 40; i++) if ((await o.runCampaignStep(id, { deadline: Date.now() + 120_000, today: AUJ })).done) break;
    };
    await campagne('DRY_RUN');
    expect(await preuve(compte, op)).toMatchObject({ last_result: 'WOULD_REPAIR' });
    expect(await ecritures(clio.id)).toEqual([]);

    await campagne('CORRECTIVE');
    expect(await preuve(compte, op)).toMatchObject({ last_result: 'REPAIRED' });
    expect(await ecritures(clio.id)).toEqual([expect.objectContaining({ v: '2021-05-01', old: null, origin: 'RECONCILIATION', source_type: 'coherence_acquisition_date', source_id: String(op), outcome: 'written' })]);
    expect(await canonique(compte, clio.id)).toMatchObject({ value: '2021-05-01', origin: 'RECONCILIATION' });
    const u = await tco(compte, clio.id);
    expect(u.period).toMatchObject({ start: '2021-05-01', startBasis: 'ASSET_AUTOMATIC' });
    expect(u.summary.cumulativeCostCents).toBe(t.summary.cumulativeCostCents);
    expect(u.annual.average.cents).toBe(t.annual.average.cents);
    const repars = await sql<Json[]>`SELECT object_id::int AS o, service FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = ${CHECK}`;
    expect(repars).toEqual([{ o: op, service: 'writeCanonicalAssetField' }]);

    // Second passage : rien à faire, aucune écriture.
    await campagne('CORRECTIVE');
    expect(await ecritures(clio.id)).toHaveLength(1);
    expect(await sql`SELECT 1 FROM coherence_repairs WHERE account_id = ${compte.id} AND check_id = ${CHECK}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'ACQUISITION'`).toHaveLength(1);
  });

  // ══ 04 ═══════════════════════════════════════════════════════════════════

  it('L107C-E2E-04 — date de réalisation absente, startDate = début de contrat : aucun faux achat, aucune date fabriquée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await make.asset(compte, { category: 'VEHICULE', name: 'Kangoo' });
    const op = await acquisition(compte, v, { cents: 900_000, realized: null, start: '2019-01-01' });
    const t = await tco(compte, v.id);
    expect(t.period).toMatchObject({ start: null, startStatus: 'MISSING' });
    expect(cand(t, op)).toMatchObject({ reason: 'START_DATE_ONLY', rawDate: '2019-01-01' });
    expect(t.annual.average.status).toBe('ACQUISITION_DATE_MISSING');
    expect(t.acquisitionStart!.repair).toBeNull();
    await controler(compte, [op]);
    expect(await ecritures(v.id)).toEqual([]);
  });

  // ══ 05 ═══════════════════════════════════════════════════════════════════

  it('L107C-E2E-05 — date USER ≠ acquisition déjà datée : saisie conservée, écart détecté par le contrôle alors que realized_date est renseignée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const op = await acquisition(compte, maison, { cents: 30_000_000, realized: '2007-09-21', label: 'Acte' });
    await ecrire(compte, maison.id, { acquisitionDate: '2020-03-15' });
    const t = await tco(compte, maison.id);
    expect(t.period).toMatchObject({ start: '2020-03-15', startBasis: 'ASSET_USER' });
    expect(cand(t, op)).toMatchObject({ reason: 'CANONICAL_USER_PRIORITY', role: 'ASSET_PURCHASE' });
    expect(t.acquisitionStart!.contradictions).toEqual([expect.objectContaining({ code: 'OPERATION_VS_USER_DATE', resolvedBy: 'USER_AUTHORITY' })]);
    const avant = await ecritures(maison.id);
    await controler(compte, [op]);
    expect((await preuve(compte, op)).finding).toMatchObject({ anomaly: 'ACQUISITION_DATE_CONTRADICTS_ASSET' });
    expect(await realisee(op)).toBe('2007-09-21');
    expect(await ecritures(maison.id)).toEqual(avant);
    expect(await canonique(compte, maison.id)).toMatchObject({ value: '2020-03-15', origin: 'USER' });
  });

  // ══ 06 ═══════════════════════════════════════════════════════════════════

  it('L107C-E2E-06 — date automatique fausse, achat prouvé (rattaché par l’utilisateur) : réparation traçable, idempotente ; une saisie USER n’est jamais remplacée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    await ecrire(compte, maison.id, { acquisitionDate: '2007-09-21' }, 'DOCUMENT_EXTRACTION');
    const op = await acquisition(compte, maison, { cents: 30_000_000, realized: '2020-03-15', authority: 'USER', label: 'Acte' });
    const t = await tco(compte, maison.id);
    expect(t.period).toMatchObject({ start: '2020-03-15', startBasis: 'OPERATION' });
    expect(t.acquisitionStart!.repair).toMatchObject({ kind: 'CORRECT_AUTOMATIC_CANONICAL', expectedCurrent: '2007-09-21', value: '2020-03-15' });

    await controler(compte, [op], 'DRY_RUN');
    expect(await canonique(compte, maison.id)).toMatchObject({ value: '2007-09-21', origin: 'DOCUMENT_EXTRACTION' });
    await controler(compte, [op]);
    expect(await canonique(compte, maison.id)).toMatchObject({ value: '2020-03-15', origin: 'RECONCILIATION' });
    const journal = await ecritures(maison.id);
    expect(journal.at(-1)).toMatchObject({ old: '2007-09-21', v: '2020-03-15', origin: 'RECONCILIATION', source_type: 'coherence_acquisition_date' });
    const n = journal.length;
    await controler(compte, [op]);
    expect(await ecritures(maison.id)).toHaveLength(n);
    expect((await tco(compte, maison.id)).period).toMatchObject({ start: '2020-03-15', startBasis: 'ASSET_AUTOMATIC' });

    // L'utilisateur corrige (2019) : autorité ; le contrôle ne réécrit jamais sa valeur.
    await ecrire(compte, maison.id, { acquisitionDate: '2019-01-10' });
    await controler(compte, [op]);
    expect(await canonique(compte, maison.id)).toMatchObject({ value: '2019-01-10', origin: 'USER' });
    expect((await tco(compte, maison.id)).period).toMatchObject({ start: '2019-01-10', startBasis: 'ASSET_USER' });
    expect((await preuve(compte, op)).finding).toMatchObject({ anomaly: 'ACQUISITION_DATE_CONTRADICTS_ASSET' });
  });

  // ══ 07 ═══════════════════════════════════════════════════════════════════

  it('L107C-E2E-07 — date seulement dans la colonne historique `purchase_date`, puis dans un alias : repli canonique préservé, prioritaire sur une acquisition de 2007', async () => {
    const compte = await make.account({ plan: 'premium' });
    const colonne = await make.asset(compte, { category: 'OBJET', name: 'Piano', purchaseDate: '2015-04-02', keyCharacteristics: {} });
    const op = await acquisition(compte, colonne, { cents: 500_000, realized: '2007-09-21' });
    const t = await tco(compte, colonne.id);
    expect(t.period).toMatchObject({ start: '2015-04-02', startBasis: 'ASSET_USER' });
    expect(t.acquisitionStart!.canonical).toMatchObject({ from: 'column', fromName: 'purchase_date', origin: 'USER', lastWrite: null });
    expect(cand(t, op).reason).toBe('CANONICAL_USER_PRIORITY');
    const alias = await make.asset(compte, { category: 'OBJET', name: 'Violon', keyCharacteristics: { dateAchat: '2016-08-20' } });
    const a = await tco(compte, alias.id);
    expect(a.period).toMatchObject({ start: '2016-08-20', startBasis: 'ASSET_USER' });
    expect(a.acquisitionStart!.canonical).toMatchObject({ from: 'alias', fromName: 'dateAchat' });
  });

  // ══ 08 ═══════════════════════════════════════════════════════════════════

  it('L107C-E2E-08 — date impossible / future / après cession ; LLD, multibiens : aucune annualisation fictive, aucune date étrangère', async () => {
    const compte = await make.account({ plan: 'premium' });
    const imp = await make.asset(compte, { category: 'OBJET', name: 'Vélo', keyCharacteristics: { acquisitionDate: '2025-02-29' } });
    await acquisition(compte, imp, { cents: 30_000, realized: '2020-03-15' });
    const i = await tco(compte, imp.id);
    expect(i.period).toMatchObject({ start: null, startStatus: 'REJECTED', startRejected: '2025-02-29' });
    expect(i.annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', incoherence: 'INVALID_DATE', cents: null });
    const fut = await make.asset(compte, { category: 'OBJET', name: 'Kayak', keyCharacteristics: { acquisitionDate: '2027-01-01' } });
    expect((await tco(compte, fut.id)).annual.average).toMatchObject({ status: 'ACQUISITION_DATE_INCOHERENT', incoherence: 'FUTURE', cents: null });

    // LLD : début de POSSESSION, jamais la date d'une acquisition liée.
    const lld = await make.asset(compte, { category: 'VEHICULE', name: 'Zoé', keyCharacteristics: { acquisitionDate: '2023-02-01', vehicleOwnershipStatus: 'LLD' } });
    const opL = await acquisition(compte, lld, { cents: 100_000, realized: '2007-09-21' });
    const l = await tco(compte, lld.id);
    expect(l.period).toMatchObject({ start: '2023-02-01', startKind: 'POSSESSION' });
    expect(cand(l, opL).reason).toBe('NO_PURCHASE_EXPECTED');
    expect((await fiche(compte, lld.id)).annual.average.startKind).toBe('POSSESSION');

    // Multibiens non attribuée : aucune date empruntée.
    const a = await make.asset(compte, { category: 'OBJET', name: 'Lot A' });
    const b = await make.asset(compte, { category: 'OBJET', name: 'Lot B' });
    const opM = await acquisition(compte, a, { cents: 100_000, realized: '2007-09-21', autresBiens: [b.id] });
    const m = await tco(compte, a.id);
    expect(cand(m, opM).reason).toBe('MULTI_ASSET');
    expect(m.period.start).toBeNull();
  });

  // ══ 09 ═══════════════════════════════════════════════════════════════════

  it('L107C-E2E-09 — correction de la date pendant l’ouverture : relecture immédiate (aucun cache), total inchangé, moyenne recalculée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const v = await make.asset(compte, { category: 'OBJET', name: 'Vélo' });
    await ecrire(compte, v.id, { acquisitionDate: '2024-01-10', acquisitionPrice: 300 });
    const avant = await fiche(compte, v.id);
    await ecrire(compte, v.id, { acquisitionDate: '2022-01-10' });
    const apres = await fiche(compte, v.id);
    expect(apres.period.start).toBe('2022-01-10');
    expect(apres.summary.cumulativeCostCents).toBe(avant.summary.cumulativeCostCents);
    expect(apres.annual.average.totalCents).toBe(avant.annual.average.totalCents);
    // Lot 111F : le prix d'achat n'est plus annualisé (achat seul → 0 €/an) ; la durée, elle, est recalculée immédiatement.
    expect(apres.annual.average.days).toBeGreaterThan(avant.annual.average.days);
    expect([avant.annual.average.cents, apres.annual.average.cents]).toEqual([0, 0]);
  });
});
