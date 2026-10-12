/**
 * Jeux de données minimaux de la recette Opérations V1 (lot 48, O10 — CDC
 * Opérations V1 C30.1) — HARNAIS E2E SEULEMENT (base jetable de l'exécution,
 * jamais une base d'exploitation, jamais un seed applicatif).
 *
 *   1. Standard   : 2 biens, documents mixtes, aucune entité équipement ;
 *   2. Premium    : maison + chaudière + véhicule + équipements,
 *                   interventions, contrats, financement, sinistre ;
 *   3. Duo        : deux utilisateurs sur les mêmes Opérations ;
 *   4. Historique : vieux documents non backfillés + données d'acquisition
 *                   structurées migrées (tâche lot 43) ;
 *   5. Multi-biens: sinistre global, coûts alloués et non alloués ;
 *   6. Devises    : EUR, CHF sans conversion, CHF avec débit EUR ;
 *   7. Ambiguïtés : deux interventions même fournisseur / période, deux
 *                   sinistres même date, décision REJECTED.
 *
 * Écritures par les chemins de PRODUCTION : persistance T1 réelle des
 * candidats (`replaceOperationCandidates`), consolidation T3 réelle
 * (`consolidateAccountOperations`), service Sinistre réel (lot 44),
 * migration structurée réelle (lot 43), décision utilisateur par le dépôt
 * (lot 42). Seules les lignes « amont » (comptes, biens, fichiers,
 * équipements) sont écrites en SQL par les fabriques du harnais.
 * Aucun appel IA (M3 coupé : `operationMatch: false`).
 */
import type postgres from 'postgres';
import type { AccountRow, AssetRow, Factories, UserRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';

type Sql = postgres.Sql;
type Hint = AnchoredOperationCandidate['financialHints'][number];

/** Date du jour figée de la recette (décision PO Q13 : contrats à effet futur). */
export const RECETTE_TODAY = '2026-10-12';

// ── Candidats T1 (forme ancrée persistée par T1) ─────────────────────────────

export function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Intervention', sourceRoleHint: 'INVOICE', provider: 'Prestataire Exemple',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
export const fh = (role: string, amountMinor: number, over: Partial<Hint> = {}): Hint =>
  ({ role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1', ...over }) as Hint;
export const cible = (entityId: number, confidence: 'certain' | 'probable' = 'certain') =>
  ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence });
export const cibleEquipement = (entityId: number) =>
  ({ type: 'EQUIPMENT' as const, entityId, rawLabel: null, confidence: 'certain' as const });
export const ref = (kind: string, value: string) => ({ kind, value });

// ── Lectures et écritures de production ─────────────────────────────────────

export type OpRow = {
  id: number; type_code: string | null; status: string; provider: string | null; planned_date: string | null; start_date: string | null;
  realized_date: string | null; end_date: string | null; closed_at: string | null; invalidated_at: string | null;
  merged_into_operation_id: number | null; parent_operation_id: number | null;
};
export type CompRow = { id: number; kind: string; amount_minor: number; currency: string; amount_eur_cents: number | null; target_asset_id: number | null; sources: number };

export function operationsKit(sql: Sql, make: Factories) {
  const consolidator = () => import('@/services/business-operations/consolidation/consolidator');

  /** Persistance T1 réelle : supersession des candidats actifs du fichier puis nouveaux candidats. */
  async function t1(compte: AccountRow, fileId: number, candidats: AnchoredOperationCandidate[], reanalysis = false): Promise<void> {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    const extractionId = x?.id ?? (await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${fileId}) RETURNING id`)[0].id;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, {
        accountId: compte.id, fileId, extractionId, analysisRunId: null, reanalysis, candidates: candidats, facts: new Map(),
      });
    });
  }

  /** Document déposé + analysé (type documentaire V2, titre, montant documentaire) avec ses candidats T1. */
  async function document(compte: AccountRow, assetId: number | null, candidats: AnchoredOperationCandidate[], o: {
    type?: string | null; title?: string; amountCents?: number | null; date?: string | null;
  } = {}): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET document_type_code = ${o.type ?? null}, retained_title = ${o.title ?? null},
              amount_cents = ${o.amountCents ?? null}, document_date = ${o.date ?? null}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    await t1(compte, f.id, candidats);
    return f.id;
  }

  /** Vieux document analysé AVANT le lot 40 : extraction, montant, aucun candidat (jamais backfillé, P19). */
  async function vieuxDocument(compte: AccountRow, assetId: number, o: { type: string; title: string; amountCents: number; date: string }): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET document_type_code = ${o.type}, retained_title = ${o.title}, amount_cents = ${o.amountCents},
              document_date = ${o.date}, analysis_state = 'ANALYZED' WHERE id = ${f.id}`;
    await sql`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id})`;
    return f.id;
  }

  type PasserOpts = Parameters<Awaited<ReturnType<typeof consolidator>>['consolidateAccountOperations']>[1];
  const passer = async (compte: AccountRow, opts: PasserOpts = {}) =>
    (await consolidator()).consolidateAccountOperations(compte.id, { today: RECETTE_TODAY, operationMatch: false, ...opts });

  const operations = (compte: AccountRow) => sql<OpRow[]>`
    SELECT id::int AS id, type_code, status, provider, planned_date::text AS planned_date, start_date::text AS start_date,
           realized_date::text AS realized_date, end_date::text AS end_date, closed_at::text AS closed_at,
           invalidated_at::text AS invalidated_at, merged_into_operation_id::int AS merged_into_operation_id,
           parent_operation_id::int AS parent_operation_id
      FROM business_operations WHERE account_id = ${compte.id} ORDER BY id`;
  const actives = async (compte: AccountRow) => (await operations(compte)).filter((o) => o.invalidated_at === null && o.merged_into_operation_id === null);
  const composantes = (opId: number, active = true) => sql<CompRow[]>`
    SELECT c.id::int AS id, c.kind, c.amount_minor::int AS amount_minor, c.currency, c.amount_eur_cents::int AS amount_eur_cents,
           c.target_asset_id,
           (SELECT count(*)::int FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id
             WHERE cs.component_id = c.id AND s.active) AS sources
      FROM business_operation_financial_components c WHERE c.operation_id = ${opId} AND c.active = ${active} ORDER BY c.id`;
  const coutNet = async (opId: number) => (await composantes(opId)).reduce((t, c) =>
    t + (c.kind === 'FORECAST_COST' ? 0 : c.kind === 'REALIZED_COST' ? c.amount_minor : -c.amount_minor), 0);
  const sources = (opId: number) => sql<{ source_kind: string; source_entity_key: string; source_role: string | null; active: boolean; match_method: string | null }[]>`
    SELECT source_kind, source_entity_key, source_role, active, match_method FROM business_operation_sources WHERE operation_id = ${opId} ORDER BY id`;
  const liens = (opId: number) => sql<{ asset_id: number; link_role: string; authority: string }[]>`
    SELECT asset_id, link_role, authority FROM business_operation_asset_links WHERE operation_id = ${opId} AND active ORDER BY asset_id`;
  const liensEquipement = (opId: number) => sql<{ equipment_id: number; asset_id: number }[]>`
    SELECT equipment_id, asset_id FROM business_operation_equipment_links WHERE operation_id = ${opId} AND active ORDER BY equipment_id`;
  const candidat = async (fileId: number) => (await sql<{ t3_outcome: string | null; t3_reason: string | null; t3_operation_id: number | null; t3_pending: boolean }[]>`
    SELECT t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id, t3_pending FROM document_operation_candidates
     WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY id`);
  const historique = async (compte: AccountRow) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${compte.id}`)[0].n;

  /** Sinistre saisi par le service de production (lot 44), même validation que la route. */
  async function sinistre(compte: AccountRow, user: UserRow | { id: number }, asset: AssetRow, claim: Record<string, unknown>, assetIds?: number[]): Promise<number> {
    const [{ parseClaimBody }, { ClaimOperationService }] = await Promise.all([
      import('@/services/business-operations/claims/claim-route'),
      import('@/services/business-operations/claims/claim-operation.service'),
    ]);
    const [a] = await sql<{ category: string }[]>`SELECT category FROM assets WHERE id = ${asset.id}`;
    const p = await parseClaimBody({ claim, ...(assetIds ? { assetIds } : {}) }, { category: a.category, accountId: compte.id, refAssetIds: assetIds ?? [asset.id] });
    if (!p.ok) throw new Error(`sinistre invalide : ${JSON.stringify(p.issues)}`);
    const dto = await ClaimOperationService.create(compte.id, user.id, asset.id, { patch: p.value.patch, assetIds: p.value.assetIds ?? undefined });
    return Number((dto as { id: number }).id);
  }

  async function equipement(asset: AssetRow, name: string, type = 'BOILER'): Promise<number> {
    const [e] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${asset.id}, ${name}, ${type}) RETURNING id`;
    return e.id;
  }

  /** Anomalies dures du diagnostic BO (lot 47, C26.2, ACC-022) pour un compte : décomptes non nuls. */
  async function anomaliesDures(accountId: number): Promise<Record<string, number>> {
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    const res = await new OperationDiagnosticsService().hardAnomalies(accountId);
    return Object.fromEntries(res.filter((a) => a.count > 0).map((a) => [a.code, a.count]));
  }

  return {
    t1, document, vieuxDocument, passer, operations, actives, composantes, coutNet, sources, liens, liensEquipement,
    candidat, historique, sinistre, equipement, anomaliesDures,
  };
}

export type OperationsKit = ReturnType<typeof operationsKit>;

// ── Les 7 jeux minimaux (C30.1) ──────────────────────────────────────────────

export interface RecetteDatasets {
  standard: { compte: AccountRow & { owner: UserRow }; clio: AssetRow; studio: AssetRow; reparation: number; notice: number; photo: number; paiementSeul: number; garantie: number; sansBien: number; sinistre: number };
  premium: {
    compte: AccountRow & { owner: UserRow }; maison: AssetRow; voiture: AssetRow; chaudiere: number; radiateur: number;
    entretienChaudiere: number; contratHabitation: number; contratMaintenance: number; lld: number; pret: number; interets: number;
    sinistre: number; reparationSinistre: number; dpeFacture: number;
  };
  duo: { compte: AccountRow & { owner: UserRow }; membre: UserRow; maison: AssetRow; facture: number };
  historique: { compte: AccountRow & { owner: UserRow }; voiture: AssetRow; vieux: number[] };
  multiBiens: { compte: AccountRow & { owner: UserRow }; maison: AssetRow; garage: AssetRow; sinistre: number; reparationMaison: number; factureCommune: number };
  devises: { compte: AccountRow & { owner: UserRow }; velo: AssetRow; eur: number; chf: number; chfDebitEur: number };
  ambiguites: { compte: AccountRow & { owner: UserRow }; clio: AssetRow; maison: AssetRow; devisA: number; factureSansRef: number; factureB: number; sinistre1: number; sinistre2: number };
}

/** Construit les 7 jeux, chacun dans son compte, puis les consolide (T3 de production). */
export async function buildRecetteDatasets(sql: Sql, make: Factories, k: OperationsKit): Promise<RecetteDatasets> {
  // 1. Standard — 2 biens, documents mixtes, aucune entité équipement.
  const std = await (async () => {
    const compte = await make.account({ plan: 'standard' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const studio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const reparation = await k.document(compte, clio.id, [cand({ summary: 'Remplacement embrayage', provider: 'Garage du Centre', targetHints: [cible(clio.id)], businessReferences: [ref('INVOICE', 'STD-F1')], temporalHints: { realizedDate: '2026-04-02' }, financialHints: [fh('REALIZED_COST', 74900)] })], { type: 'REPAIR_INVOICE', title: 'Facture embrayage', amountCents: 74900, date: '2026-04-02' });
    const notice = await k.document(compte, studio.id, [cand({ financialHints: [fh('REALIZED_COST', 12000)] })], { type: 'USER_MANUAL', title: 'Notice chaudière' });
    const photo = await k.document(compte, studio.id, [cand({ established: false, exclusionReason: 'VISUAL_ONLY', visualOnlyEvidence: true })], { type: 'PHOTO', title: 'Photo façade' });
    const paiementSeul = await k.document(compte, clio.id, [cand({ confidence: 'probable', sourceRoleHint: 'PAYMENT_PROOF', provider: 'Pneus Express', targetHints: [cible(clio.id, 'probable')], businessReferences: [ref('INVOICE', 'STD-PNEUS')], financialHints: [fh('PAYMENT', 32000)] })], { type: 'WORKS_PAYMENT_PROOF', title: 'Virement pneus', amountCents: 32000 });
    const garantie = await k.document(compte, studio.id, [cand({ summary: 'Garantie', temporalHints: { endDate: '2028-05-01' } })], { type: 'WARRANTY_CERTIFICATE', title: 'Garantie lave-linge' });
    const sansBien = await k.document(compte, null, [cand({ summary: 'Serrurier', provider: 'Serrurerie Express', businessReferences: [ref('INVOICE', 'STD-SER')], temporalHints: { realizedDate: '2026-05-10' }, financialHints: [fh('REALIZED_COST', 15000)] })], { type: 'REPAIR_INVOICE', title: 'Facture serrurier', amountCents: 15000 });
    const sinistre = await k.sinistre(compte, compte.owner, clio, { claimType: 'BRIS_DE_GLACE', occurredOn: '2026-02-14', status: 'A_DECLARER' });
    return { compte, clio, studio, reparation, notice, photo, paiementSeul, garantie, sansBien, sinistre };
  })();

  // 2. Premium — maison + chaudière + véhicule + équipements, interventions, contrats, financement, sinistre.
  const prem = await (async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchaseDate: '2015-06-01', purchasePriceCents: 32000000 });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Model 3' });
    const chaudiere = await k.equipement(maison, 'Chaudière Frisquet');
    const radiateur = await k.equipement(maison, 'Radiateur salon', 'RADIATOR');
    const entretienChaudiere = await k.document(compte, maison.id, [cand({ summary: 'Remplacement corps de chauffe', provider: 'Chauffage Plus', targetHints: [cibleEquipement(chaudiere)], businessReferences: [ref('INVOICE', 'CH-2026-15')], temporalHints: { realizedDate: '2026-03-12' }, financialHints: [fh('REALIZED_COST', 120000)] })], { type: 'MAINTENANCE_INVOICE', title: 'Facture chaudière', amountCents: 120000, date: '2026-03-12' });
    const contratHabitation = await k.document(compte, maison.id, [cand({ typeHint: 'CONTRACT', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Assurance habitation', provider: 'Assur’Habitat', targetHints: [cible(maison.id)], businessReferences: [ref('POLICY', 'HAB-1001')], temporalHints: { startDate: '2026-01-01', endDate: '2026-12-31' }, financialHints: [fh('REALIZED_COST', 48000, { amountScope: 'INSTALLMENT', periodStart: '2026-01-01', periodEnd: '2026-12-31' })] })], { type: 'INSURANCE_POLICY', title: 'Contrat habitation' });
    const contratMaintenance = await k.document(compte, maison.id, [cand({ typeHint: 'CONTRACT', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Contrat d’entretien chaudière', provider: 'Chauffage Plus', targetHints: [cibleEquipement(chaudiere)], businessReferences: [ref('CONTRACT', 'MAINT-77')], temporalHints: { startDate: '2026-02-01', endDate: '2027-01-31' }, financialHints: [fh('REALIZED_COST', 18000, { amountScope: 'INSTALLMENT', periodStart: '2026-02-01', periodEnd: '2027-01-31' })] })], { type: 'MAINTENANCE_CONTRACT', title: 'Contrat entretien chaudière' });
    const lld = await k.document(compte, voiture.id, [cand({ typeHint: 'CONTRACT', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Location longue durée (LOA)', provider: 'Leasys', targetHints: [cible(voiture.id)], businessReferences: [ref('CONTRACT', 'LOA-5521')], temporalHints: { startDate: '2023-04-01', endDate: '2026-09-30' }, financialHints: [fh('FORECAST_COST', 45000, { amountScope: 'INSTALLMENT' })] })], { type: 'LEASING_FINANCING_CONTRACT', title: 'Contrat LOA' });
    const pret = await k.document(compte, maison.id, [cand({ typeHint: 'FINANCING', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Prêt travaux', provider: 'Banque Exemple', targetHints: [cible(maison.id)], businessReferences: [ref('LOAN', 'PR-889')], temporalHints: { startDate: '2026-02-15', endDate: '2031-02-15' } })], { type: 'LEASING_FINANCING_CONTRACT', title: 'Offre de prêt' });
    const interets = await k.document(compte, maison.id, [cand({ typeHint: 'FINANCING', sourceRoleHint: 'INVOICE', summary: 'Intérêts annuels', provider: 'Banque Exemple', targetHints: [cible(maison.id)], businessReferences: [ref('LOAN', 'PR-889'), ref('INVOICE', 'INT-2026')], financialHints: [fh('REALIZED_COST', 50000, { periodStart: '2026-02-15', periodEnd: '2027-02-14' })] })], { type: 'LEASING_FINANCING_CONTRACT', title: 'Relevé d’intérêts' });
    const sinistre = await k.sinistre(compte, compte.owner, maison, { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-05-04', status: 'CLOS', insurerClaimRef: 'SIN-PREM-1', compensationCents: 80000, estimatedDamageCents: 150000 });
    const reparationSinistre = await k.document(compte, maison.id, [cand({ summary: 'Reprise plafond', provider: 'Plâtrerie Martin', targetHints: [cible(maison.id)], businessReferences: [ref('CLAIM', 'SIN-PREM-1'), ref('QUOTE', 'PL-12')], statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', temporalHints: { plannedDate: '2026-11-20' }, financialHints: [fh('FORECAST_COST', 95000)] })], { type: 'WORKS_QUOTE', title: 'Devis plafond' });
    const dpeFacture = await k.document(compte, maison.id, [cand({ summary: 'Diagnostic de performance énergétique', provider: 'Diag Expert', targetHints: [cible(maison.id)], businessReferences: [ref('INVOICE', 'DPE-77')], temporalHints: { realizedDate: '2026-01-20' }, financialHints: [fh('REALIZED_COST', 18000)] })], { type: 'DPE', title: 'DPE et facture du diagnostiqueur', amountCents: 18000 });
    return { compte, maison, voiture, chaudiere, radiateur, entretienChaudiere, contratHabitation, contratMaintenance, lld, pret, interets, sinistre, reparationSinistre, dpeFacture };
  })();

  // 3. Duo — deux utilisateurs actifs sur le même compte (mêmes Opérations).
  const duo = await (async () => {
    const compte = await make.account({ plan: 'premium_duo' });
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${compte.id}, ${membre.id}, 'member', 'active')`;
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison Duo' });
    const facture = await k.document(compte, maison.id, [cand({ summary: 'Ramonage', provider: 'Ramoneur Dupont', targetHints: [cible(maison.id)], businessReferences: [ref('INVOICE', 'DUO-1')], temporalHints: { realizedDate: '2026-02-02' }, financialHints: [fh('REALIZED_COST', 9000)] })], { type: 'MAINTENANCE_INVOICE', title: 'Facture ramonage', amountCents: 9000 });
    return { compte, membre, maison, facture };
  })();

  // 4. Historique — vieux documents sans candidats + données d'acquisition structurées (migration lot 43).
  const hist = await (async () => {
    const compte = await make.account({ plan: 'premium' });
    const voiture = await make.asset(compte, { category: 'VEHICULE', name: 'Polo 2012', purchaseDate: '2012-09-01', purchasePriceCents: 1450000 });
    const vieux = [
      await k.vieuxDocument(compte, voiture.id, { type: 'MAINTENANCE_INVOICE', title: 'Révision 2019', amountCents: 18000, date: '2019-04-01' }),
      await k.vieuxDocument(compte, voiture.id, { type: 'REPAIR_INVOICE', title: 'Pneus 2020', amountCents: 42000, date: '2020-10-12' }),
    ];
    const { runStructuredOperationsMigration } = await import('@/services/business-operations/consolidation/asset-data-consolidator');
    await runStructuredOperationsMigration({ apply: true, accountId: compte.id, today: RECETTE_TODAY });
    return { compte, voiture, vieux };
  })();

  // 5. Multi-biens — sinistre global (indemnité non allouée), coût alloué (réparation d'un bien), coût commun non alloué.
  const multi = await (async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison principale' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    const sinistre = await k.sinistre(compte, compte.owner, maison, { claimType: 'EVENEMENT_CLIMATIQUE', occurredOn: '2026-06-01', insurerClaimRef: 'TEMP-26', compensationCents: 200000 }, [maison.id, garage.id]);
    const reparationMaison = await k.document(compte, maison.id, [cand({ summary: 'Toiture maison', provider: 'Couvreur Alpes', targetHints: [cible(maison.id)], businessReferences: [ref('CLAIM', 'TEMP-26'), ref('INVOICE', 'COUV-1')], temporalHints: { realizedDate: '2026-06-20' }, financialHints: [fh('REALIZED_COST', 300000)] })], { type: 'WORKS_INVOICE', title: 'Facture toiture', amountCents: 300000 });
    const factureCommune = await k.document(compte, maison.id, [cand({ summary: 'Bâchage maison et garage', provider: 'Couvreur Alpes', targetHints: [cible(maison.id), cible(garage.id)], businessReferences: [ref('CLAIM', 'TEMP-26'), ref('INVOICE', 'COUV-2')], temporalHints: { realizedDate: '2026-06-02' }, financialHints: [fh('REALIZED_COST', 60000)] })], { type: 'WORKS_INVOICE', title: 'Facture bâchage', amountCents: 60000 });
    return { compte, maison, garage, sinistre, reparationMaison, factureCommune };
  })();

  // 6. Devises — EUR, CHF sans conversion, CHF avec débit EUR explicite.
  const dev = await (async () => {
    const compte = await make.account({ plan: 'premium' });
    const velo = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo cargo' });
    const eur = await k.document(compte, velo.id, [cand({ summary: 'Révision vélo', provider: 'Cycles Lyon', targetHints: [cible(velo.id)], businessReferences: [ref('INVOICE', 'EUR-1')], temporalHints: { realizedDate: '2026-03-01' }, financialHints: [fh('REALIZED_COST', 8000)] })], { type: 'MAINTENANCE_INVOICE', title: 'Révision', amountCents: 8000 });
    const chf = await k.document(compte, velo.id, [cand({ summary: 'Batterie', provider: 'Velo Zürich AG', targetHints: [cible(velo.id)], businessReferences: [ref('INVOICE', 'CH-1')], temporalHints: { realizedDate: '2026-04-01' }, financialHints: [fh('REALIZED_COST', 45000, { currency: 'CHF' })] })], { type: 'REPAIR_INVOICE', title: 'Batterie (CHF)' });
    const chfDebitEur = await k.document(compte, velo.id, [cand({ summary: 'Moteur', provider: 'Velo Zürich AG', targetHints: [cible(velo.id)], businessReferences: [ref('INVOICE', 'CH-2')], temporalHints: { realizedDate: '2026-05-01' }, financialHints: [fh('REALIZED_COST', 60000, { currency: 'CHF' }), fh('PAYMENT', 62500, { currency: 'EUR' })] })], { type: 'REPAIR_INVOICE', title: 'Moteur (CHF, débit EUR)' });
    return { compte, velo, eur, chf, chfDebitEur };
  })();

  // 7. Ambiguïtés — deux interventions même fournisseur / période, deux sinistres même date, décision REJECTED.
  const amb = await (async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio ambiguë' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison ambiguë' });
    const devisA = await k.document(compte, clio.id, [cand({ summary: 'Freinage', statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', provider: 'Garage A', targetHints: [cible(clio.id)], businessReferences: [ref('QUOTE', 'AMB-D1')], temporalHints: { plannedDate: '2026-06-03' }, financialHints: [fh('FORECAST_COST', 25500)] })], { type: 'REPAIR_QUOTE', title: 'Devis freinage' });
    const factureB = await k.document(compte, clio.id, [cand({ summary: 'Vidange', provider: 'Garage A', targetHints: [cible(clio.id)], businessReferences: [ref('INVOICE', 'AMB-F2')], temporalHints: { realizedDate: '2026-06-04' }, financialHints: [fh('REALIZED_COST', 9000)] })], { type: 'MAINTENANCE_INVOICE', title: 'Facture vidange' });
    const sinistreDoc = (r: string) => cand({ typeHint: 'CLAIM', sourceRoleHint: 'CLAIM_DOCUMENT', summary: `Sinistre ${r}`, provider: 'Assur', targetHints: [cible(maison.id)], businessReferences: [ref('CLAIM', r)], temporalHints: { realizedDate: '2026-02-02' } });
    const sinistre1 = await k.document(compte, maison.id, [sinistreDoc('AMB-S1')], { type: 'CLAIM_DECLARATION', title: 'Déclaration 1' });
    const sinistre2 = await k.document(compte, maison.id, [sinistreDoc('AMB-S2')], { type: 'CLAIM_DECLARATION', title: 'Déclaration 2' });
    await k.passer(compte);
    // Même garage, même bien, même semaine, aucune référence : seul M3 trancherait → attente.
    const factureSansRef = await k.document(compte, clio.id, [cand({ summary: 'Freinage', provider: 'Garage A', targetHints: [cible(clio.id)], temporalHints: { realizedDate: '2026-06-05' }, financialHints: [fh('REALIZED_COST', 24900)] })], { type: 'REPAIR_INVOICE', title: 'Facture freinage' });
    await k.passer(compte);
    // L'utilisateur répond « une autre intervention » (décision REJECTED durable, lot 42).
    const [op] = (await k.actives(compte)).filter((o) => o.type_code === 'INTERVENTION' && o.status === 'ENVISAGED');
    const [{ key }] = await sql<{ key: string }[]>`SELECT candidate_key AS key FROM document_operation_candidates WHERE file_id = ${factureSansRef} AND status = 'ACTIVE'`;
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const { USER_DISTINCT_REASON } = await import('@/services/business-operations/consolidation/consolidator');
    await withBusinessOperationWrite(compte.id, (r) => r.recordMatchDecision({
      sourceKind: 'DOCUMENT', entityKey: factureSansRef, sourceVersion: key, operationId: op.id, decision: 'REJECTED', origin: 'USER_ARBITRATION', reasonCode: USER_DISTINCT_REASON,
    }));
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${factureSansRef} AND status = 'ACTIVE'`;
    return { compte, clio, maison, devisA, factureSansRef, factureB, sinistre1, sinistre2 };
  })();

  for (const c of [std.compte, prem.compte, duo.compte, hist.compte, multi.compte, dev.compte, amb.compte]) {
    await k.passer(c);
    // Second passage : les réexamens (attentes, parents) convergent ; le troisième n'écrit plus rien (INV-040).
    await k.passer(c, { reevaluateHolds: true });
  }
  return { standard: std, premium: prem, duo, historique: hist, multiBiens: multi, devises: dev, ambiguites: amb };
}
