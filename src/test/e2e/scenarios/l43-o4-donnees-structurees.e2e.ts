/**
 * Lot 43 — O4, migration structurée et données de vente (CDC Opérations V1
 * ch. 14, 26, B13.1, B13.3, B13.6, B18, C2, C4 TRG-008 à TRG-010, C7.1, C7.3,
 * C7.6, C11.1, C18, C23.1, P19 ; décisions PO Q5, Q6, Q12) — base
 * PostgreSQL réelle.
 *
 * Données de la fiche écrites par les chemins de production (façade de la
 * fiche `updateAssetDetails`, origine USER ; primitive canonique pour une
 * écriture automatique) ; candidats documentaires par la persistance T1
 * réelle ; consolidation par le moteur T3 de production. Aucun appel IA.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';

const AUJOURDHUI = '2026-10-12';
const adc = () => import('@/services/business-operations/consolidation/asset-data-consolidator');
const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const facade = () => import('@/services/asset-details-write.service');
const bus = () => import('@/services/business-operations/events');

type Op = { id: number; type_code: string | null; status: string; provider: string | null; start_date: string | null; realized_date: string | null; invalidated_at: string | null };

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'ACQUISITION', statusHint: 'REALIZED',
    summary: 'Achat du véhicule', sourceRoleHint: 'INVOICE', provider: 'Garage Exemple',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number, over: Partial<AnchoredOperationCandidate['financialHints'][number]> = {}) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1', ...over }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });

scenario('L43-O4', 'Migration structurée et données de vente : fiche du bien → Opérations (ASSET_DATA)', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  async function document(compte: AccountRow, assetId: number, candidats: AnchoredOperationCandidate[]) {
    const f = await make.assetFile(compte, { assetId });
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, {
        accountId: compte.id, fileId: f.id, extractionId: x.id, analysisRunId: null, reanalysis: false, candidates: candidats, facts: new Map(),
      });
    });
    return f.id;
  }
  const fiche = async (compte: AccountRow, assetId: number, fields: Record<string, unknown>, section = 'common') =>
    (await facade()).updateAssetDetails({ assetId, accountId: compte.id, section, fields, actorUserId: compte.ownerUserId });
  const reconcilier = async (compte: AccountRow, assetId: number) => (await adc()).consolidateAssetData(compte.id, assetId, { today: AUJOURDHUI });
  const passerDocs = async (compte: AccountRow) => (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, operationMatch: false });
  const operations = (compte: AccountRow) => sql<Op[]>`
    SELECT id::int AS id, type_code, status, provider, start_date::text AS start_date, realized_date::text AS realized_date, invalidated_at::text AS invalidated_at
      FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;
  const composantes = (opId: number) => sql<{ kind: string; amount_minor: number; currency: string; sources: string[] }[]>`
    SELECT c.kind, c.amount_minor::int AS amount_minor, c.currency,
           (SELECT array_agg(s.source_kind ORDER BY s.source_kind) FROM business_operation_financial_component_sources cs
              JOIN business_operation_sources s ON s.id = cs.operation_source_id WHERE cs.component_id = c.id AND s.active) AS sources
      FROM business_operation_financial_components c WHERE c.operation_id = ${opId} AND c.active ORDER BY c.id`;
  const sources = (opId: number) => sql<{ source_kind: string; source_entity_key: string; authority: string; active: boolean; nature: string | null; match_reason: string | null }[]>`
    SELECT source_kind, source_entity_key, authority, active, locator->>'nature' AS nature, match_reason
      FROM business_operation_sources WHERE operation_id = ${opId} ORDER BY id`;
  const historique = async (compte: AccountRow) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${compte.id}`)[0].n;
  const etatBien = async (assetId: number) => (await sql<{ updated_at: string; status_changed_at: string | null; operations_data_changed_at: string | null; kc: string | null }[]>`
    SELECT updated_at::text, status_changed_at::text, operations_data_changed_at::text, key_characteristics AS kc FROM assets WHERE id = ${assetId}`)[0];
  async function invariants(compte: AccountRow) {
    expect(await sql`SELECT o.id FROM business_operations o WHERE o.account_id = ${compte.id} AND o.invalidated_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active)`).toHaveLength(0);
    expect(await sql`SELECT c.id FROM business_operation_financial_components c WHERE c.account_id = ${compte.id} AND c.active
      AND NOT EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id
                       WHERE cs.component_id = c.id AND s.active)`).toHaveLength(0);
  }

  // ══ Acquisition ═══════════════════════════════════════════════════════════

  it('O4-E01 / F-178 / B13.1 — achat saisi sur la fiche (USER) → ACQUISITION REALIZED, prix REALIZED_COST, source ASSET_DATA', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    await fiche(compte, clio.id, { acquisitionDate: '2021-03-01', acquisitionPrice: 18490.5 });
    const r = await reconcilier(compte, clio.id);
    expect(r.natures.find((n) => n.nature === 'ACQUISITION')).toMatchObject({ outcome: 'CREATE_NEW' });
    const [op, ...autres] = await operations(compte);
    expect(autres).toEqual([]);
    expect(op).toMatchObject({ type_code: 'ACQUISITION', status: 'REALIZED', realized_date: '2021-03-01', invalidated_at: null });
    expect(await composantes(op.id)).toEqual([{ kind: 'REALIZED_COST', amount_minor: 1849050, currency: 'EUR', sources: ['ASSET_DATA'] }]);
    expect(await sources(op.id)).toEqual([expect.objectContaining({ source_kind: 'ASSET_DATA', source_entity_key: String(clio.id), authority: 'USER', active: true, nature: 'ACQUISITION' })]);
    expect(await sql`SELECT asset_id, authority FROM business_operation_asset_links WHERE operation_id = ${op.id} AND active`).toEqual([{ asset_id: clio.id, authority: 'USER' }]);
    // Rejouée : aucune écriture (NFR-OP-004).
    const h = await historique(compte);
    expect((await reconcilier(compte, clio.id)).changes).toBe(0);
    expect(await historique(compte)).toBe(h);
    await invariants(compte);
  });

  it('O4-E02 / F-044 / C7.1 — achat saisi PUIS facture d\'achat analysée → UNE seule ACQUISITION enrichie, un seul prix', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte);
    await fiche(compte, clio.id, { acquisitionDate: '2021-03-01', acquisitionPrice: 18490.5 });
    await reconcilier(compte, clio.id);
    const facture = await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], businessReferences: [{ kind: 'INVOICE', value: 'FV-2021-118' }],
      temporalHints: { realizedDate: '2021-03-02' }, financialHints: [fh('REALIZED_COST', 1849050)] })]);
    const r = await passerDocs(compte);
    expect(r.outcomes).toEqual({ MATCH_AND_ENRICH: 1 });
    const [op, ...autres] = await operations(compte);
    expect(autres).toEqual([]);
    // La date saisie prime ; le prix documentaire égal est LE même fait (deux preuves, une composante).
    expect(op).toMatchObject({ type_code: 'ACQUISITION', realized_date: '2021-03-01' });
    expect(await composantes(op.id)).toEqual([{ kind: 'REALIZED_COST', amount_minor: 1849050, currency: 'EUR', sources: ['ASSET_DATA', 'DOCUMENT'] }]);
    expect((await sources(op.id)).map((s) => [s.source_kind, s.source_entity_key])).toEqual([['ASSET_DATA', String(clio.id)], ['DOCUMENT', String(facture)]]);
    await invariants(compte);
  });

  it('O4-E03 / F-044 / C7.6 — facture d\'achat analysée PUIS achat saisi (prix différent) → même ACQUISITION, la saisie prime, jamais deux prix', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte);
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], temporalHints: { realizedDate: '2021-03-02' }, financialHints: [fh('REALIZED_COST', 1900000)] })]);
    await passerDocs(compte);
    const [doc] = await operations(compte);
    await fiche(compte, clio.id, { acquisitionPrice: 18490.5 });
    const r = await reconcilier(compte, clio.id);
    expect(r.natures.find((n) => n.nature === 'ACQUISITION')).toMatchObject({ outcome: 'MATCH_AND_ENRICH', operationId: doc.id });
    expect(await operations(compte)).toHaveLength(1);
    expect(await composantes(doc.id)).toEqual([{ kind: 'REALIZED_COST', amount_minor: 1849050, currency: 'EUR', sources: ['ASSET_DATA'] }]);
    // Saisie effacée : la preuve documentaire reprend son montant, l'Opération survit (TRG-010).
    await fiche(compte, clio.id, { acquisitionPrice: null });
    await reconcilier(compte, clio.id);
    expect((await operations(compte))[0]).toMatchObject({ id: doc.id, invalidated_at: null });
    expect(await composantes(doc.id)).toEqual([{ kind: 'REALIZED_COST', amount_minor: 1900000, currency: 'EUR', sources: ['DOCUMENT'] }]);
    await invariants(compte);
  });

  it('O4-E04 / C2 anti-blanchiment — valeur écrite par T3 / T1 (origine non humaine) → aucune Opération, même par la migration', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte);
    const canon = await import('@/services/canonical/asset-state');
    await canon.writeCanonicalAssetFields({
      assetId: clio.id, accountId: compte.id, origin: 'RECONCILIATION', source: { type: 'reconciliation', id: 'e2e' },
      writes: [{ key: 'acquisitionDate', value: '2021-03-01' }, { key: 'acquisitionPrice', value: 18000 }, { key: 'insurer', value: 'MAAF' }],
    });
    await canon.writeCanonicalAssetField({ assetId: clio.id, accountId: compte.id, key: 'insuranceContractNumber', value: 'AU-1', origin: 'DOCUMENT_EXTRACTION' });
    const r = await reconcilier(compte, clio.id);
    expect(r.natures.map((n) => n.outcome)).toEqual(['NONE', 'NONE', 'NONE']);
    const m = await (await adc()).runStructuredOperationsMigration({ apply: true, accountId: compte.id, today: AUJOURDHUI });
    expect(m.changes).toBe(0);
    expect(await operations(compte)).toEqual([]);
  });

  // ══ Cession ══════════════════════════════════════════════════════════════

  it('O4-E05 / F-019 / F-124 / F-125 / Q5 / C7.6 — passage à VENDU avec date et prix réalisés → DISPOSAL, PROCEED ; date du statut posée par la base', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte);
    expect((await etatBien(clio.id)).status_changed_at).toBeNull();
    await fiche(compte, clio.id, { status: 'VENDU' });
    const apres = await etatBien(clio.id);
    expect(apres.status_changed_at).not.toBeNull();
    // Sans date de vente : repli « passage au statut » (C11.1), sans prix.
    await reconcilier(compte, clio.id);
    const [op] = await operations(compte);
    const jour = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date(apres.status_changed_at!));
    expect(op).toMatchObject({ type_code: 'DISPOSAL', status: 'REALIZED', realized_date: jour });
    expect(await composantes(op.id)).toEqual([]);
    // Fenêtre « Vente enregistrée » : date et prix réalisés (route de la fiche).
    await fiche(compte, clio.id, { saleDate: '2026-09-30', salePrice: 12000 });
    await reconcilier(compte, clio.id);
    const ops = await operations(compte);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: op.id, realized_date: '2026-09-30' });
    expect(await composantes(op.id)).toEqual([{ kind: 'PROCEED', amount_minor: 1200000, currency: 'EUR', sources: ['ASSET_DATA'] }]);
    // Prix souhaité (informations commerciales) : jamais un produit réalisé (C18).
    expect(await sql`SELECT 1 FROM business_operation_financial_components WHERE operation_id = ${op.id} AND kind <> 'PROCEED'`).toHaveLength(0);
    await invariants(compte);
  });

  it('O4-E06 / Q5 — TRANSMIS → DISPOSAL sans prix (même si un prix est saisi)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const vase = await make.asset(compte, { category: 'OBJECT', keyCharacteristics: {} });
    await sql`UPDATE assets SET object_category = 'ART' WHERE id = ${vase.id}`;
    await fiche(compte, vase.id, { status: 'TRANSMIS' });
    await fiche(compte, vase.id, { saleDate: '2026-08-01', salePrice: 5000 });
    await reconcilier(compte, vase.id);
    const [op, ...autres] = await operations(compte);
    expect(autres).toEqual([]);
    expect(op).toMatchObject({ type_code: 'DISPOSAL', status: 'REALIZED', realized_date: '2026-08-01' });
    expect(await composantes(op.id)).toEqual([]);
  });

  it('O4-E07 / F-042 / TRG-010 — VENDU + acte de vente : une Cession ; retour en service : la donnée se retire, la vente prouvée reste', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte);
    await fiche(compte, clio.id, { status: 'VENDU' });
    await fiche(compte, clio.id, { saleDate: '2026-09-28', salePrice: 12000 });
    await reconcilier(compte, clio.id);
    const acte = await document(compte, clio.id, [cand({ typeHint: 'DISPOSAL', sourceRoleHint: 'SALE_DOCUMENT', summary: 'Acte de vente', targetHints: [cible(clio.id)],
      temporalHints: { realizedDate: '2026-09-28' }, financialHints: [fh('PROCEED', 1200000)] })]);
    await passerDocs(compte);
    const [op, ...autres] = await operations(compte);
    expect(autres).toEqual([]);
    expect(await composantes(op.id)).toEqual([{ kind: 'PROCEED', amount_minor: 1200000, currency: 'EUR', sources: ['ASSET_DATA', 'DOCUMENT'] }]);
    await fiche(compte, clio.id, { status: 'EN_SERVICE' });
    const r = await reconcilier(compte, clio.id);
    expect(r.natures.find((n) => n.nature === 'DISPOSAL')).toMatchObject({ outcome: 'WITHDRAWN' });
    expect((await operations(compte))[0]).toMatchObject({ id: op.id, invalidated_at: null });
    expect((await sources(op.id)).map((s) => [s.source_kind, s.active])).toEqual([['ASSET_DATA', false], ['DOCUMENT', true]]);
    expect(await composantes(op.id)).toEqual([{ kind: 'PROCEED', amount_minor: 1200000, currency: 'EUR', sources: ['DOCUMENT'] }]);
    // Sans document : la Cession seulement saisie est invalidée.
    const autre = await make.asset(compte);
    await fiche(compte, autre.id, { status: 'VENDU' });
    await reconcilier(compte, autre.id);
    await fiche(compte, autre.id, { status: 'EN_SERVICE' });
    await reconcilier(compte, autre.id);
    const seule = (await operations(compte)).find((o) => o.id !== op.id)!;
    expect(seule.invalidated_at).not.toBeNull();
    // Revendu : la même Cession est réactivée (même source), pas une seconde.
    await fiche(compte, autre.id, { status: 'VENDU' });
    await reconcilier(compte, autre.id);
    expect((await operations(compte)).filter((o) => o.id !== op.id)).toEqual([expect.objectContaining({ id: seule.id, invalidated_at: null })]);
    void acte;
    await invariants(compte);
  });

  // ══ Contrat ══════════════════════════════════════════════════════════════

  it('O4-E08 / Q6 / B13.3 / C7.3 — Contrat créé SEULEMENT si assureur ET n° saisis ; contrat documentaire de même police → enrichi', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    await fiche(compte, maison.id, { insurer: 'MAAF Assurances' }, 'insurance');
    expect((await reconcilier(compte, maison.id)).natures.find((n) => n.nature === 'CONTRACT')).toMatchObject({ outcome: 'NONE' });
    expect(await operations(compte)).toEqual([]);
    await fiche(compte, maison.id, { insuranceContractNumber: 'HAB-559201' }, 'insurance');
    await reconcilier(compte, maison.id);
    const [op] = await operations(compte);
    expect(op).toMatchObject({ type_code: 'CONTRACT', status: 'REALIZED', provider: 'MAAF Assurances', start_date: null });
    expect(await sql`SELECT reference_kind, normalized_value FROM business_operation_references WHERE operation_id = ${op.id} AND active`).toEqual([{ reference_kind: 'POLICY', normalized_value: 'HAB559201' }]);
    expect(await sql`SELECT contract_reference FROM business_operation_contract_details WHERE operation_id = ${op.id}`).toEqual([{ contract_reference: 'HAB-559201' }]);

    // Autre bien : contrat documentaire de la même police d'abord, puis saisie → même CONTRACT (M1).
    const studio = await make.asset(compte, { category: 'IMMOBILIER' });
    await document(compte, studio.id, [cand({ typeHint: 'CONTRACT', sourceRoleHint: 'CONTRACT_DOCUMENT', provider: 'AXA', summary: 'Contrat habitation',
      targetHints: [cible(studio.id)], businessReferences: [{ kind: 'CONTRACT', value: 'AX 77-120' }], temporalHints: { startDate: '2025-01-01' } })]);
    await passerDocs(compte);
    const avant = (await operations(compte)).length;
    await fiche(compte, studio.id, { insurer: 'AXA', insuranceContractNumber: 'AX77120' }, 'insurance');
    const r = await reconcilier(compte, studio.id);
    expect(r.natures.find((n) => n.nature === 'CONTRACT')).toMatchObject({ outcome: 'MATCH_AND_ENRICH' });
    expect(await operations(compte)).toHaveLength(avant);
    await invariants(compte);
  });

  // ══ Migration de l'existant (C23.1) ════════════════════════════════════════

  it('O4-E09 / F-175 / F-178 / F-179 / C23.1 — migration : simulation exacte sans écriture, application, rejouée = 0 changement', async () => {
    const compte = await make.account({ plan: 'premium' });
    // Données historiques (colonnes et fiche sans origine tracée : protégées comme saisies).
    const a = await make.asset(compte, { purchaseDate: '2018-06-01', purchasePriceCents: 2500000 });
    const b = await make.asset(compte, { category: 'IMMOBILIER', keyCharacteristics: { insurer: 'GMF', insuranceContractNumber: 'G-42' } });
    const c = await make.asset(compte);
    // Vendu avant le lot : aucune date de passage au statut connue.
    await sql`UPDATE assets SET status = 'VENDU' WHERE id = ${c.id}`;
    await sql`UPDATE assets SET status_changed_at = NULL WHERE id = ${c.id}`;
    const d = await make.asset(compte, { keyCharacteristics: { acquisitionPrice: 900, acquisitionPrice__origin: 'RECONCILIATION' } });
    const tables = async () => (await sql<{ n: number }[]>`
      SELECT ((SELECT count(*) FROM business_operations WHERE account_id = ${compte.id})
            + (SELECT count(*) FROM business_operation_sources WHERE account_id = ${compte.id})
            + (SELECT count(*) FROM business_operation_history WHERE account_id = ${compte.id})
            + (SELECT count(*) FROM business_operation_asset_data_marks WHERE account_id = ${compte.id}))::int AS n`)[0].n;
    const m = await adc();

    const vide = await tables();
    const sim = await m.runStructuredOperationsMigration({ apply: false, accountId: compte.id, today: AUJOURDHUI });
    expect(await tables()).toBe(vide);
    expect(sim).toMatchObject({ mode: 'simulate', scanned: 4, processed: 4, failed: [] });
    expect(sim.outcomes).toEqual({ ACQUISITION: { CREATE_NEW: 1, NONE: 3 }, DISPOSAL: { CREATE_NEW: 1, NONE: 3 }, CONTRACT: { CREATE_NEW: 1, NONE: 3 } });
    // Simulation rejouée : même rapport (rien n'a été écrit).
    expect((await m.runStructuredOperationsMigration({ apply: false, accountId: compte.id, today: AUJOURDHUI })).outcomes).toEqual(sim.outcomes);

    const app = await m.runStructuredOperationsMigration({ apply: true, accountId: compte.id, today: AUJOURDHUI });
    expect(app.outcomes).toEqual(sim.outcomes);
    expect(app.changes).toBe(sim.changes);
    const ops = await operations(compte);
    expect(ops.map((o) => o.type_code).sort()).toEqual(['ACQUISITION', 'CONTRACT', 'DISPOSAL']);
    const parBien = async (assetId: number) => sql<{ type_code: string; match_reason: string }[]>`
      SELECT o.type_code, s.match_reason FROM business_operations o JOIN business_operation_sources s ON s.operation_id = o.id
       WHERE s.source_kind = 'ASSET_DATA' AND s.source_entity_key = ${String(assetId)}`;
    expect(await parBien(a.id)).toEqual([{ type_code: 'ACQUISITION', match_reason: 'MIGRATION_o4-c23.1-v1:NO_MATCH_ESTABLISHED' }]);
    expect((await parBien(b.id)).map((x) => x.type_code)).toEqual(['CONTRACT']);
    // Bien vendu avant le lot : Cession sans date inventée.
    expect(ops.find((o) => o.type_code === 'DISPOSAL')).toMatchObject({ realized_date: null, status: 'REALIZED' });
    expect(await parBien(d.id)).toEqual([]);
    expect(await composantes(ops.find((o) => o.type_code === 'ACQUISITION')!.id)).toEqual([{ kind: 'REALIZED_COST', amount_minor: 2500000, currency: 'EUR', sources: ['ASSET_DATA'] }]);
    expect(await sql`SELECT asset_id FROM business_operation_asset_data_marks WHERE account_id = ${compte.id} ORDER BY asset_id`)
      .toEqual([a.id, b.id, c.id, d.id].map((asset_id) => ({ asset_id })));

    // Rejouée : plus rien à examiner, aucune écriture.
    const h = await historique(compte);
    const encore = await m.runStructuredOperationsMigration({ apply: true, accountId: compte.id, today: AUJOURDHUI });
    expect(encore).toMatchObject({ scanned: 0, changes: 0 });
    expect(await historique(compte)).toBe(h);
    // Un bien modifié (même sans rapport) est réexaminé — sans écriture métier si rien ne change.
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ notes: 'x' })} WHERE id = ${a.id}`;
    const filet = await m.runStructuredOperationsMigration({ apply: true, accountId: compte.id, today: AUJOURDHUI });
    expect(filet).toMatchObject({ scanned: 1, changes: 0 });
    expect(await historique(compte)).toBe(h);
    // Aucun document n'a été réanalysé ni n'a produit d'Opération (P19).
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE account_id = ${compte.id} AND source_kind = 'DOCUMENT'`).toHaveLength(0);
    await invariants(compte);

    // Tâche interne : même service.
    const { findTask } = await import('@/services/scheduling/scheduled-tasks.catalog');
    const t = findTask('operations-structured-migration')!;
    expect(t.schedule).toEqual({ kind: 'interval', everyMs: 3_600_000 });
  });

  // ══ Déclenchement et anti-boucle ═════════════════════════════════════════

  it('O4-E10 / C4 TRG-008 / TRG-009 — modification de la fiche ou du statut (fiche, « À traiter ») → travail T3 du bien ; exécution de production', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte);
    const repo = await import('@/services/ai/queue/job-queue.repository');
    const triggers = await import('@/services/ai/queue/triggers');
    triggers.__setTriggerConfigLoader(async () => null);
    const admin = await make.user();
    await repo.setEmergencyStop(false, admin.id);
    await repo.setTreatmentState('T3', 'ENABLED', admin.id);
    const evenements = async () => {
      for (let i = 0; i < 50; i++) {
        const r = await sql<{ id: number; events: Array<{ trigger: string; assetId?: number }> }[]>`
          SELECT id, payload->'events' AS events FROM ai_job_queue WHERE account_id = ${compte.id} AND target_type = 'business_operations' AND status = 'PENDING'`;
        if (r.length) return r;
        await new Promise((res) => setTimeout(res, 100));
      }
      return [];
    };
    try {
      await fiche(compte, clio.id, { acquisitionPrice: 15000 });
      let jobs = await evenements();
      expect(jobs.flatMap((j) => j.events)).toEqual([expect.objectContaining({ trigger: 'asset_updated', assetId: clio.id })]);
      // Une section sans donnée d'Opération ne déclenche rien de plus.
      await fiche(compte, clio.id, { notes: 'garage' });
      // Statut par la carte « À traiter » ASSET-STATUS (même écrivain que la résolution).
      const { ASSET_STATUS_WRITER } = await import('@/services/to-process/agenda-status-cards');
      const { db } = await import('@/db');
      await ASSET_STATUS_WRITER.write(db as never, clio.id, compte.id, 'VENDU');
      await ASSET_STATUS_WRITER.afterCommit!({ accountId: compte.id, targetId: clio.id, value: 'VENDU', previousValue: 'EN_SERVICE', userId: null });
      for (let i = 0; i < 50 && (await evenements()).flatMap((j) => j.events).length < 2; i++) await new Promise((res) => setTimeout(res, 100));
      jobs = await evenements();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].events.map((e) => [e.trigger, e.assetId])).toEqual([['asset_updated', clio.id], ['asset_disposed', clio.id]]);
      expect((await etatBien(clio.id)).status_changed_at).not.toBeNull();

      // Exécutant de production : Acquisition et Cession établies.
      const { registerJobHandler, runOne } = await import('@/services/ai/queue/queue-worker');
      const { t3JobHandler } = await import('@/services/ai/reconciliation/t3-queue');
      registerJobHandler('T3', t3JobHandler);
      await sql`UPDATE ai_job_queue SET available_at = now() + interval '1 day' WHERE treatment = 'T3' AND status = 'PENDING' AND id <> ${jobs[0].id}`;
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${jobs[0].id}`;
      expect(await runOne('T3')).toBe(true);
      expect((await operations(compte)).map((o) => o.type_code).sort()).toEqual(['ACQUISITION', 'DISPOSAL']);
    } finally {
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE treatment = 'T3' AND status = 'PENDING' AND target_type IN ('business_operations', 'business_operations_sweep')`;
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE treatment = 'T3' AND status = 'PENDING'`;
      triggers.__setTriggerConfigLoader(null);
    }
  });

  it('O4-E11 / B1 / C16.2 — pas de propagation inverse ni de boucle : l\'Opération ne réécrit jamais la fiche, aucun nouveau travail', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte);
    await fiche(compte, clio.id, { acquisitionDate: '2021-03-01', acquisitionPrice: 18000 });
    // Les notifications de l'enregistrement (non bloquantes) sont passées.
    await new Promise((res) => setTimeout(res, 1_000));
    const file = () => sql`SELECT id, status, payload FROM ai_job_queue WHERE account_id = ${compte.id} ORDER BY id`;
    const fileAvant = await file();
    const avant = await etatBien(clio.id);
    // Facture d'un autre montant et d'une autre date : l'Opération change, la fiche non.
    await document(compte, clio.id, [cand({ targetHints: [cible(clio.id)], temporalHints: { realizedDate: '2021-02-15' }, financialHints: [fh('REALIZED_COST', 1999900)] })]);
    await reconcilier(compte, clio.id);
    await passerDocs(compte);
    await reconcilier(compte, clio.id);
    expect(await etatBien(clio.id)).toEqual(avant);
    // Aucune écriture Opération ne relance T3 (ni travail neuf, ni événement fusionné dans un travail existant).
    expect(await file()).toEqual(fileAvant);
    expect(await sql`SELECT 1 FROM canonical_field_writes WHERE asset_id = ${clio.id} AND origin <> 'USER'`).toHaveLength(0);
    // Le repère suit le passage, sans toucher le bien : rien à reprendre.
    expect(await (await adc()).listAssetsToReconcile(10, clio.id - 1, compte.id)).toEqual([]);
  });
});
