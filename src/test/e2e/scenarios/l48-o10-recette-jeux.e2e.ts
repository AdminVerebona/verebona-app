/**
 * Lot 48 — O10, recette complète Opérations V1 sur les 7 jeux de données
 * minimaux (CDC Opérations V1 C29, C30, C30.1, C31, C34) — base PostgreSQL
 * réelle.
 *
 * Les jeux (`../datasets/operations-v1.ts`) sont construits UNE fois pour le
 * fichier par les chemins de production (persistance T1, consolidation T3,
 * service Sinistre, migration structurée, décision utilisateur), puis :
 *   · invariants finaux C34 et anomalies dures du diagnostic BO (ACC-022) à 0
 *     sur chaque compte (`OperationDiagnosticsService`, lot 47) ;
 *   · cas C29 propres à chaque jeu (F-xxx) ;
 *   · consommateurs : T2 (`sumQualifiedExpenses`), projection Agenda (T4).
 * Aucun appel IA (M3 coupé). Les tests suivent l'ordre du fichier : ceux qui
 * ajoutent des données viennent après les contrôles d'invariants.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import {
  buildRecetteDatasets, cand, cible, fh, operationsKit, ref, RECETTE_TODAY, type OperationsKit, type RecetteDatasets,
} from '../datasets/operations-v1';

const bus = () => import('@/services/business-operations/events');
const can = () => import('@/services/verebona-assistant/canonical');

scenario('L48-O10', 'Recette Opérations V1 : 7 jeux C30.1, invariants C34, anomalies dures, cas C29 par jeu', ({ sql, make }) => {
  let k: OperationsKit;
  let d: RecetteDatasets;
  let comptes: Array<[string, AccountRow]>;

  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
    d = await buildRecetteDatasets(sql, make, k);
    comptes = [
      ['standard', d.standard.compte], ['premium', d.premium.compte], ['duo', d.duo.compte], ['historique', d.historique.compte],
      ['multi-biens', d.multiBiens.compte], ['devises', d.devises.compte], ['ambiguïtés', d.ambiguites.compte],
    ];
  });
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  const typeDe = async (c: AccountRow, fileId: number) => {
    const [x] = await k.candidat(fileId);
    const op = (await k.operations(c)).find((o) => o.id === x?.t3_operation_id);
    return { candidat: x, op };
  };

  // ══ Invariants finaux (C34) et anomalies dures (ACC-022) ═════════════════

  it('O10-01 / ACC-022 / INV-FINAL-006 / F-173 / F-174 / ACC-002 — 7 jeux consolidés : anomalies dures BO à 0 sur chaque compte, toute Opération active a une source active', async () => {
    for (const [nom, c] of comptes) {
      expect(await k.anomaliesDures(c.id), nom).toEqual({});
      const sansSource = await sql`SELECT o.id FROM business_operations o WHERE o.account_id = ${c.id} AND o.invalidated_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active)`;
      expect(sansSource, nom).toHaveLength(0);
      // ACC-002 : provenance diagnosticable (méthode ou motif de création tracé sur chaque source active).
      expect(await sql`SELECT s.id FROM business_operation_sources s JOIN business_operations o ON o.id = s.operation_id
        WHERE o.account_id = ${c.id} AND s.active AND o.invalidated_at IS NULL AND s.match_reason IS NULL AND s.source_kind = 'DOCUMENT'`, nom).toHaveLength(0);
    }
    // Les jeux ne sont pas vides : chaque compte porte au moins une Opération active.
    for (const [nom, c] of comptes) expect((await k.actives(c)).length, nom).toBeGreaterThan(0);
  });

  it('O10-02 / INV-040 / INV-039 / F-090 / F-184 — passage T3 rejoué sur les 7 jeux : aucune écriture, aucun historique ; aucun compte remis en file par le balayage', async () => {
    const { listAccountsToConsolidate } = await import('@/services/business-operations/consolidation/consolidator');
    for (const [nom, c] of comptes) {
      const h = await k.historique(c);
      const r = await k.passer(c, { reevaluateHolds: true });
      expect(r.changes, nom).toBe(0);
      expect(await k.historique(c), nom).toBe(h);
      // Un compte n'est remis en file que s'il porte un rapprochement M3 encore dû (lot 42, C6.1) — jamais pour rien.
      const m3Du = (await sql`SELECT 1 FROM document_operation_candidates WHERE account_id = ${c.id} AND status = 'ACTIVE' AND t3_reason = 'M3_REQUIRED'`).length > 0;
      if (m3Du) expect(nom).toBe('ambiguïtés');
      else expect(await listAccountsToConsolidate(c.id - 1, 1), nom).not.toContain(c.id);
    }
  });

  it('O10-03 / INV-FINAL-001 / INV-002 — une source n’est jamais l’Opération : un document → plusieurs Opérations possibles, une Opération → plusieurs sources ; aucune Opération n’a de colonne « document »', async () => {
    // Multi-biens : le sinistre est prouvé par la saisie ET reçoit des enfants prouvés par deux factures distinctes.
    const ops = await k.actives(d.multiBiens.compte);
    const claim = ops.find((o) => o.type_code === 'CLAIM')!;
    // Une saisie par bien concerné (clé de source = bien), aucune source « document » : la CLAIM n'est pas un document.
    expect([...new Set((await k.sources(claim.id)).filter((s) => s.active).map((s) => s.source_kind))]).toEqual(['CLAIM_FORM']);
    const enfants = ops.filter((o) => o.parent_operation_id === claim.id);
    expect(enfants).toHaveLength(2);
    const cols = await sql<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'business_operations'`;
    expect(cols.map((x) => x.column_name)).not.toEqual(expect.arrayContaining(['file_id']));
    expect(cols.map((x) => x.column_name)).not.toEqual(expect.arrayContaining(['document_id']));
  });

  // ══ Jeu 1 — Standard ═════════════════════════════════════════════════════

  it('F-003 / F-004 / F-005 / F-006 / F-024 / ACC-001 / INV-FINAL-002 / INV-FINAL-003 / INV-003 / INV-004 / INV-005 — Standard : notice, photo, garantie → aucune Opération ; preuve de paiement seule → attente ; facture de réparation → une INTERVENTION', async () => {
    const s = d.standard;
    expect((await k.candidat(s.notice))[0]).toMatchObject({ t3_outcome: 'NO_OPERATION', t3_reason: 'DOCUMENT_NOT_BUSINESS', t3_operation_id: null });
    expect((await k.candidat(s.garantie))[0]).toMatchObject({ t3_outcome: 'NO_OPERATION', t3_reason: 'DOCUMENT_NOT_BUSINESS', t3_operation_id: null });
    // Candidat non établi (preuve seulement visuelle) : conservé pour la trace, jamais soumis à T3.
    expect((await k.candidat(s.photo))[0]).toMatchObject({ t3_pending: false, t3_operation_id: null });
    expect((await k.candidat(s.paiementSeul))[0]).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'PROBABLE_WITHOUT_MATCH', t3_operation_id: null });
    const { op } = await typeDe(s.compte, s.reparation);
    expect(op).toMatchObject({ type_code: 'INTERVENTION', status: 'REALIZED', realized_date: '2026-04-02' });
    expect((await k.actives(s.compte)).map((o) => o.type_code).sort()).toEqual(['CLAIM', 'INTERVENTION', 'INTERVENTION']);
  });

  it('F-190 / F-082 / F-188 / INV-060 — Standard sans entité équipement ; downgrade Premium → Standard : aucune donnée Opération supprimée (liens équipement compris), passage sans écriture', async () => {
    expect(await sql`SELECT e.id FROM equipments e JOIN assets a ON a.id = e.asset_id WHERE a.account_id = ${d.standard.compte.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM business_operation_equipment_links WHERE account_id = ${d.standard.compte.id}`).toHaveLength(0);
    const p = d.premium.compte;
    const avant = await sql`SELECT (SELECT count(*) FROM business_operations WHERE account_id = ${p.id})::int AS ops,
      (SELECT count(*) FROM business_operation_equipment_links WHERE account_id = ${p.id} AND active)::int AS eq,
      (SELECT count(*) FROM business_operation_financial_components WHERE account_id = ${p.id} AND active)::int AS comp`;
    await sql`UPDATE account_subscriptions SET plan_code = 'standard' WHERE account_id = ${p.id}`;
    try {
      const r = await k.passer(p, { reevaluateHolds: true });
      expect(r.changes).toBe(0);
      const apres = await sql`SELECT (SELECT count(*) FROM business_operations WHERE account_id = ${p.id})::int AS ops,
        (SELECT count(*) FROM business_operation_equipment_links WHERE account_id = ${p.id} AND active)::int AS eq,
        (SELECT count(*) FROM business_operation_financial_components WHERE account_id = ${p.id} AND active)::int AS comp`;
      expect(apres).toEqual(avant);
      expect(avant[0].eq).toBeGreaterThan(0);
    } finally {
      await sql`UPDATE account_subscriptions SET plan_code = 'premium' WHERE account_id = ${p.id}`;
    }
  });

  it('F-078 / F-136 / F-137 / INV-FINAL-007 — Opération sans bien (Standard) : active, exclue de la somme d’un bien et de l’agenda ; comptée pour le compte sans bien affirmé', async () => {
    const s = d.standard;
    const { op } = await typeDe(s.compte, s.sansBien);
    expect(op).toMatchObject({ type_code: 'INTERVENTION', invalidated_at: null });
    expect(await k.liens(op!.id)).toEqual([]);
    const c = await can();
    const clio = await c.sumQualifiedExpenses(s.compte.id, { assetIds: [s.clio.id] });
    expect(clio.operations?.operationIds ?? []).not.toContain(op!.id);
    const compte = await c.sumQualifiedExpenses(s.compte.id, {});
    expect(compte.operations?.untargeted).toMatchObject({ count: 1, sumCents: 15000 });
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    await projectAccountOperations(s.compte.id, { all: true, today: RECETTE_TODAY });
    expect(await sql`SELECT id FROM agenda_items WHERE business_operation_id = ${op!.id}`).toHaveLength(0);
  });

  // ══ Jeu 2 — Premium ══════════════════════════════════════════════════════

  it('F-002 / F-116 / F-081 — Premium : facture chaudière (cible équipement) → INTERVENTION REALIZED, lien équipement + bien parent, une seule composante ; T2 compte le coût une fois pour la maison', async () => {
    const p = d.premium;
    const { op } = await typeDe(p.compte, p.entretienChaudiere);
    expect(op).toMatchObject({ type_code: 'INTERVENTION', status: 'REALIZED', realized_date: '2026-03-12' });
    expect(await k.liensEquipement(op!.id)).toEqual([{ equipment_id: p.chaudiere, asset_id: p.maison.id }]);
    expect(await k.liens(op!.id)).toEqual([{ asset_id: p.maison.id, link_role: 'PRIMARY', authority: 'DOCUMENT' }]);
    expect((await k.composantes(op!.id)).map((c) => [c.kind, c.amount_minor, c.target_asset_id])).toEqual([['REALIZED_COST', 120000, null]]);
    const t2 = await (await can()).sumQualifiedExpenses(p.compte.id, { assetIds: [p.maison.id] });
    expect(t2.operations?.operationIds.filter((x) => x === op!.id)).toHaveLength(1);
    expect(t2.operations?.lines.filter((l) => l.operationId === op!.id).reduce((t, l) => t + l.costCents, 0)).toBe(120000);
  });

  it('F-010 / F-011 / F-012 / F-073 — Premium : assurance habitation, entretien chaudière (sur équipement), LOA → trois CONTRACT avec détails ; LOA échue reste REALIZED avec sa date de fin (jamais CANCELLED)', async () => {
    const p = d.premium;
    for (const [f, refAttendue] of [[p.contratHabitation, 'HAB-1001'], [p.contratMaintenance, 'MAINT-77'], [p.lld, 'LOA-5521']] as const) {
      const { op } = await typeDe(p.compte, f);
      expect(op, refAttendue).toMatchObject({ type_code: 'CONTRACT', status: 'REALIZED' });
      expect(await sql`SELECT contract_reference FROM business_operation_contract_details WHERE operation_id = ${op!.id}`).toEqual([{ contract_reference: refAttendue }]);
      // F-110 : le tarif annoncé reste un coût PRÉVU (aucune échéance générée).
      expect((await k.composantes(op!.id)).every((c) => c.kind === 'FORECAST_COST')).toBe(true);
    }
    const { op: loa } = await typeDe(p.compte, p.lld);
    expect(loa).toMatchObject({ end_date: '2026-09-30', status: 'REALIZED' });
    const { op: maint } = await typeDe(p.compte, p.contratMaintenance);
    expect(await k.liensEquipement(maint!.id)).toEqual([{ equipment_id: p.chaudiere, asset_id: p.maison.id }]);
  });

  it('F-014 / F-038 / F-103 / F-104 / INV-FINAL-016 / INV-025 — Premium : prêt → FINANCING (prêteur, référence) sans composante de principal ; facture d’intérêts citant le prêt → REALIZED_COST du même FINANCING', async () => {
    const p = d.premium;
    const { op } = await typeDe(p.compte, p.pret);
    expect(op).toMatchObject({ type_code: 'FINANCING', start_date: '2026-02-15', end_date: '2031-02-15' });
    expect(await sql`SELECT financing_reference, lender, principal_amount_minor FROM business_operation_financing_details WHERE operation_id = ${op!.id}`)
      .toEqual([{ financing_reference: 'PR-889', lender: 'Banque Exemple', principal_amount_minor: null }]);
    const { op: interets, candidat } = await typeDe(p.compte, p.interets);
    expect(interets!.id).toBe(op!.id);
    expect(candidat).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M1' });
    expect((await k.composantes(op!.id)).map((c) => [c.kind, c.amount_minor])).toEqual([['REALIZED_COST', 50000]]);
    // Le principal n'est jamais additionné au prix d'acquisition : aucune composante de financement sur l'ACQUISITION de la maison.
    expect(await sql`SELECT c.id FROM business_operation_financial_components c JOIN business_operations o ON o.id = c.operation_id
      WHERE o.account_id = ${p.compte.id} AND o.type_code = 'ACQUISITION' AND c.active`).toHaveLength(0);
  });

  it('F-075 / F-076 / F-149 / INV-FINAL-022 / INV-FINAL-023 / INV-019 / INV-021 / INV-023 — Premium : sinistre « Clos » = CLAIM REALIZED + closed_at, dossier CLOS ; devis de réparation citant le dossier = enfant ENVISAGED (état propre)', async () => {
    const p = d.premium;
    const [claim] = (await k.actives(p.compte)).filter((o) => o.type_code === 'CLAIM');
    expect(claim.id).toBe(p.sinistre);
    expect(claim.status).toBe('REALIZED');
    expect(claim.closed_at).not.toBeNull();
    expect(await sql`SELECT status FROM business_operation_claim_details WHERE operation_id = ${claim.id}`).toEqual([{ status: 'CLOS' }]);
    const { op: enfant } = await typeDe(p.compte, p.reparationSinistre);
    expect(enfant).toMatchObject({ type_code: 'INTERVENTION', status: 'ENVISAGED', parent_operation_id: claim.id, planned_date: '2026-11-20' });
    // Indemnité saisie : composante du sinistre, attribuée au bien (mono-bien), coût brut inchangé (Q4).
    expect((await k.composantes(claim.id)).map((c) => [c.kind, c.amount_minor, c.target_asset_id])).toEqual([['INDEMNITY', 80000, p.maison.id]]);
  });

  it('F-008 / F-009 — Premium : DPE avec facture du diagnostiqueur = INTERVENTION ; DPE descriptif (sortie T1 enregistrée DESCRIPTIVE_ONLY) = aucune Opération ; la fiche du bien n’est pas réécrite', async () => {
    const p = d.premium;
    const avant = await sql`SELECT key_characteristics, purchase_price_cents, purchase_date::text AS purchase_date FROM assets WHERE id = ${p.maison.id}`;
    const { op } = await typeDe(p.compte, p.dpeFacture);
    expect(op).toMatchObject({ type_code: 'INTERVENTION', status: 'REALIZED', realized_date: '2026-01-20' });
    expect((await k.composantes(op!.id)).map((c) => [c.kind, c.amount_minor])).toEqual([['REALIZED_COST', 18000]]);
    const descriptif = await k.document(p.compte, p.maison.id, [cand({ established: false, exclusionReason: 'DESCRIPTIVE_ONLY', summary: 'DPE classe D' })], { type: 'DPE', title: 'DPE 2024' });
    await k.passer(p.compte);
    expect((await k.candidat(descriptif))[0]).toMatchObject({ t3_pending: false, t3_operation_id: null });
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE source_kind = 'DOCUMENT' AND source_entity_key = ${String(descriptif)}`).toHaveLength(0);
    expect(await sql`SELECT key_characteristics, purchase_price_cents, purchase_date::text AS purchase_date FROM assets WHERE id = ${p.maison.id}`).toEqual(avant);
  });

  it('F-013 / F-045 — Premium : levée d’option de la LOA (facture d’achat citant le contrat) → nouvelle ACQUISITION, distincte du CONTRACT', async () => {
    const p = d.premium;
    const { op: loa } = await typeDe(p.compte, p.lld);
    const levee = await k.document(p.compte, p.voiture.id, [cand({
      typeHint: 'ACQUISITION', summary: 'Levée d’option d’achat', provider: 'Leasys', targetHints: [cible(p.voiture.id)],
      businessReferences: [ref('CONTRACT', 'LOA-5521'), ref('INVOICE', 'LO-2026-9')], temporalHints: { realizedDate: '2026-10-01' },
      financialHints: [fh('REALIZED_COST', 1200000)],
    })], { type: 'REPAIR_INVOICE', title: 'Facture de levée d’option' });
    await k.passer(p.compte);
    const { op, candidat } = await typeDe(p.compte, levee);
    expect(candidat).toMatchObject({ t3_outcome: 'CREATE_NEW' });
    expect(op).toMatchObject({ type_code: 'ACQUISITION', status: 'REALIZED', realized_date: '2026-10-01' });
    expect(op!.id).not.toBe(loa!.id);
    expect((await typeDe(p.compte, p.lld)).op).toMatchObject({ type_code: 'CONTRACT' });
    expect(await k.anomaliesDures(p.compte.id)).toEqual({});
  });

  // ══ Jeu 3 — Duo ══════════════════════════════════════════════════════════

  it('F-189 / F-083 / F-084 / INV-059 / INV-058 — Duo : les deux membres lisent les mêmes Opérations et le même total ; une conversation n’est jamais une source (nature fermée en base)', async () => {
    const u = d.duo;
    const { BusinessOperationReadService } = await import('@/services/business-operations/read-service');
    const lus = await new BusinessOperationReadService().listActiveOperations(u.compte.id, { assetId: u.maison.id });
    expect(lus.map((o) => o.typeCode)).toEqual(['INTERVENTION']);
    // Le membre et le titulaire partagent le compte : même lecture (aucun filtre par utilisateur).
    expect(await sql`SELECT user_id FROM account_memberships WHERE account_id = ${u.compte.id} AND status = 'active' ORDER BY user_id`)
      .toEqual([u.compte.ownerUserId, u.membre.id].sort((a, b) => a - b).map((user_id) => ({ user_id })));
    const c = await can();
    expect((await c.sumQualifiedExpenses(u.compte.id, { assetIds: [u.maison.id] })).qualifiedSumCents).toBe(9000);
    // F-084 : aucune nature « conversation » (contrainte SQL) ; les sources du compte sont des preuves métier.
    const [op] = await k.actives(u.compte);
    await expect(sql`INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, authority, confidence)
      VALUES (${u.compte.id}, ${op.id}, 'CONVERSATION', '1', 'USER', 'certain')`).rejects.toThrow(/check|constraint/i);
    expect((await k.sources(op.id)).map((s) => s.source_kind)).toEqual(['DOCUMENT']);
  });

  // ══ Jeu 4 — Historique ═══════════════════════════════════════════════════

  it('F-176 / F-178 / F-175 / ACC-020 / INV-FINAL-024 / INV-FINAL-025 / INV-036 / INV-037 — Historique : vieux documents jamais backfillés (aucune Opération) ; achat structuré migré = UNE ACQUISITION ; migration rejouée sans effet', async () => {
    const h = d.historique;
    const ops = await k.actives(h.compte);
    expect(ops.map((o) => o.type_code)).toEqual(['ACQUISITION']);
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE account_id = ${h.compte.id} AND source_kind = 'DOCUMENT'`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM document_operation_candidates WHERE file_id IN ${sql(h.vieux)}`).toHaveLength(0);
    const { runStructuredOperationsMigration } = await import('@/services/business-operations/consolidation/asset-data-consolidator');
    expect(await runStructuredOperationsMigration({ apply: true, accountId: h.compte.id, today: RECETTE_TODAY })).toMatchObject({ scanned: 0, changes: 0 });
    // T2 n'est pas limité aux Opérations : les vieux documents restent comptés en repli (INV-FINAL-010).
    const t2 = await (await can()).sumQualifiedExpenses(h.compte.id, { assetIds: [h.voiture.id] });
    expect(t2.documents?.count).toBe(2);
  });

  it('F-177 — Historique : vieux document réanalysé → entre dans le modèle normal (candidat, T3, Opération documentaire), sans toucher l’autre', async () => {
    const h = d.historique;
    await k.t1(h.compte, h.vieux[0], [cand({ summary: 'Révision 60 000 km', provider: 'Garage Martin', targetHints: [cible(h.voiture.id)], businessReferences: [ref('INVOICE', 'R-2019')], temporalHints: { realizedDate: '2019-04-01' }, financialHints: [fh('REALIZED_COST', 18000)] })], true);
    await k.passer(h.compte);
    const { op, candidat } = await typeDe(h.compte, h.vieux[0]);
    expect(candidat).toMatchObject({ t3_outcome: 'CREATE_NEW' });
    expect(op).toMatchObject({ type_code: 'INTERVENTION', realized_date: '2019-04-01' });
    expect(await sql`SELECT 1 FROM document_operation_candidates WHERE file_id = ${h.vieux[1]}`).toHaveLength(0);
    // F-135 : la source n'est plus recomptée en repli.
    const t2 = await (await can()).sumQualifiedExpenses(h.compte.id, { assetIds: [h.voiture.id] });
    expect(t2.documents?.count).toBe(1);
    expect(t2.documents?.represented.fileIds).toContain(h.vieux[0]);
  });

  // ══ Jeu 5 — Multi-biens ═════════════════════════════════════════════════

  it('F-158 / F-029 / F-114 / F-123 / F-160 / ACC-014 / INV-FINAL-017 / INV-016 / INV-017 — Multi-biens : une CLAIM sur deux biens, indemnité globale non ventilée ; facture commune non ventilée ; réparation de la maison attribuée à la maison seule', async () => {
    const m = d.multiBiens;
    const ops = await k.actives(m.compte);
    const claim = ops.find((o) => o.type_code === 'CLAIM')!;
    expect(ops.filter((o) => o.type_code === 'CLAIM')).toHaveLength(1);
    expect((await k.liens(claim.id)).map((l) => l.asset_id)).toEqual([m.maison.id, m.garage.id].sort((a, b) => a - b));
    expect((await k.composantes(claim.id)).map((c) => [c.kind, c.amount_minor, c.target_asset_id])).toEqual([['INDEMNITY', 200000, null]]);
    const { op: maison } = await typeDe(m.compte, m.reparationMaison);
    expect(maison).toMatchObject({ parent_operation_id: claim.id });
    expect((await k.liens(maison!.id)).map((l) => l.asset_id)).toEqual([m.maison.id]);
    const { op: commune } = await typeDe(m.compte, m.factureCommune);
    expect((await k.liens(commune!.id)).map((l) => l.asset_id)).toEqual([m.maison.id, m.garage.id].sort((a, b) => a - b));
    expect((await k.composantes(commune!.id)).map((c) => c.target_asset_id)).toEqual([null]);
    const c = await can();
    const garage = await c.sumQualifiedExpenses(m.compte.id, { assetIds: [m.garage.id] });
    expect(garage.qualifiedSumCents).toBe(0);
    expect(garage.operations?.unattributed.sumCents).toBe(60000);
    const pourMaison = await c.sumQualifiedExpenses(m.compte.id, { assetIds: [m.maison.id] });
    expect(pourMaison.qualifiedSumCents).toBe(300000);
    // L'indemnité globale ne réduit aucun bien : non allouée.
    expect(pourMaison.operations?.indemnity.unallocatedCents ?? 0).toBeGreaterThanOrEqual(0);
    expect(pourMaison.operations?.indemnity.sumCents ?? 0).toBe(0);
  });

  // ══ Jeu 6 — Devises ══════════════════════════════════════════════════════

  it('F-105 / F-106 / ACC-015 / INV-049 / INV-050 — Devises : CHF conservé sans conversion ; avec débit EUR lu, aucune contre-valeur inventée (écart E-01) ; EUR seul additionné', async () => {
    const v = d.devises;
    const comp = async (f: number) => (await k.composantes((await typeDe(v.compte, f)).op!.id)).map((c) => [c.kind, c.amount_minor, c.currency, c.amount_eur_cents]);
    expect(await comp(v.eur)).toEqual([['REALIZED_COST', 8000, 'EUR', null]]);
    expect(await comp(v.chf)).toEqual([['REALIZED_COST', 45000, 'CHF', null]]);
    // La preuve de débit EUR (PAYMENT) n'est jamais un coût ; T1 v4 ne porte pas de contre-valeur : amount_eur_cents reste nul.
    expect(await comp(v.chfDebitEur)).toEqual([['REALIZED_COST', 60000, 'CHF', null]]);
    const t2 = await (await can()).sumQualifiedExpenses(v.compte.id, { assetIds: [v.velo.id] });
    expect(t2.qualifiedSumCents).toBe(8000);
    expect(t2.operations?.foreign).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'CHF' })]));
  });

  // ══ Jeu 7 — Ambiguïtés ═══════════════════════════════════════════════════

  it('F-041 / F-034 / F-058 / F-200 / F-048 / F-192 / F-046 / F-191 / ACC-005 / INV-FINAL-005 / INV-FINAL-021 / INV-008 / INV-045 — Ambiguïtés : deux sinistres même date = deux CLAIM ; même garage sans référence = attente M3 ; REJECTED durable → autre intervention, jamais rematchée', async () => {
    const a = d.ambiguites;
    const ops = await k.actives(a.compte);
    expect(ops.filter((o) => o.type_code === 'CLAIM')).toHaveLength(2);
    expect((await typeDe(a.compte, a.sinistre1)).op!.id).not.toBe((await typeDe(a.compte, a.sinistre2)).op!.id);
    const { op: devis } = await typeDe(a.compte, a.devisA);
    const { op: autre, candidat } = await typeDe(a.compte, a.factureSansRef);
    expect(candidat).toMatchObject({ t3_outcome: 'CREATE_NEW' });
    expect(autre!.id).not.toBe(devis!.id);
    // Facture du même garage, même semaine, sans clé : aucune création ni rattachement automatique.
    expect((await k.candidat(a.factureB))[0]).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'M3_REQUIRED', t3_operation_id: null });
    expect(ops.filter((o) => o.type_code === 'INTERVENTION')).toHaveLength(2);
    // Décision durable : toujours active, le balayage ne rematche jamais vers le devis.
    expect(await sql`SELECT decision, active FROM business_operation_match_decisions WHERE account_id = ${a.compte.id}`).toEqual([{ decision: 'REJECTED', active: true }]);
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${a.factureSansRef} AND status = 'ACTIVE'`;
    await k.passer(a.compte, { reevaluateHolds: true });
    expect((await k.candidat(a.factureSansRef))[0]).toMatchObject({ t3_operation_id: autre!.id });
    expect(await k.anomaliesDures(a.compte.id)).toEqual({});
  });

  // ══ Consommateurs : T4 (projection), invalidation ═══════════════════════

  it('INV-FINAL-012 / INV-029 / INV-030 / F-138 / F-139 / F-141 / F-142 / F-144 — projection Agenda des jeux : au plus un événement par Opération, rien pour FINANCING / contrat sans échéance à venir ; aucune projection n’est source ; rejouée = no-op', async () => {
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    for (const [nom, c] of comptes) {
      await projectAccountOperations(c.id, { all: true, today: RECETTE_TODAY });
      const parOp = await sql<{ op: number; n: number }[]>`SELECT business_operation_id::int AS op, count(*)::int AS n FROM agenda_items
        WHERE account_id = ${c.id} AND business_operation_id IS NOT NULL GROUP BY 1`;
      expect(parOp.filter((x) => x.n > 1), nom).toEqual([]);
      expect(await sql`SELECT s.id FROM business_operation_sources s JOIN agenda_items i ON s.source_kind = 'AGENDA' AND s.source_entity_key = i.id::text
        WHERE s.account_id = ${c.id} AND s.active AND i.projection_origin = 'OPERATION'`, nom).toHaveLength(0);
      const again = await projectAccountOperations(c.id, { all: true, today: RECETTE_TODAY });
      expect(again.changes, nom).toBe(0);
    }
    const p = d.premium;
    const { op: pret } = await typeDe(p.compte, p.pret);
    expect(await sql`SELECT id FROM agenda_items WHERE business_operation_id = ${pret!.id}`).toHaveLength(0);
    const { op: chaudiere } = await typeDe(p.compte, p.entretienChaudiere);
    expect(await sql`SELECT start_date::text AS d FROM agenda_items WHERE business_operation_id = ${chaudiere!.id}`).toEqual([{ d: '2026-03-12' }]);
  });

  it('INV-FINAL-020 / INV-042 / F-064 / F-107 / INV-FINAL-019 / INV-056 — Standard : document supprimé → Opération invalidée, retirée immédiatement de T2 et de l’agenda ; source et composante historisées', async () => {
    const s = d.standard;
    const { op } = await typeDe(s.compte, s.reparation);
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    await projectAccountOperations(s.compte.id, { all: true, today: RECETTE_TODAY });
    expect(await sql`SELECT id FROM agenda_items WHERE business_operation_id = ${op!.id}`).toHaveLength(1);
    const c = await can();
    expect((await c.sumQualifiedExpenses(s.compte.id, { assetIds: [s.clio.id] })).operations?.operationIds).toContain(op!.id);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${s.reparation}`;
    await k.passer(s.compte);
    await projectAccountOperations(s.compte.id, { all: true, today: RECETTE_TODAY });
    const [apres] = (await k.operations(s.compte)).filter((o) => o.id === op!.id);
    expect(apres.invalidated_at).not.toBeNull();
    expect((await c.sumQualifiedExpenses(s.compte.id, { assetIds: [s.clio.id] })).operations?.operationIds ?? []).not.toContain(op!.id);
    expect(await sql`SELECT id FROM agenda_items WHERE business_operation_id = ${op!.id} AND projection_origin = 'OPERATION'`).toHaveLength(0);
    expect((await k.sources(op!.id)).map((x) => x.active)).toEqual([false]);
    expect((await k.composantes(op!.id, false)).map((x) => x.amount_minor)).toEqual([74900]);
    expect(await k.anomaliesDures(s.compte.id)).toEqual({});
  });

  // ══ « Reconsolider ce compte » sur les jeux (O10) ═══════════════════════

  it('O10-10 / INV-040 — reconsolidation complète (travail BO) sur chaque jeu cohérent : aucune écriture métier, anomalies dures toujours à 0', async () => {
    const { reconsolidateAllActiveOperations } = await import('@/services/business-operations/consolidation/queue');
    for (const [nom, c] of comptes) {
      const h = await k.historique(c);
      const r = await reconsolidateAllActiveOperations(c.id, { today: RECETTE_TODAY });
      expect(r, nom).toMatchObject({ changes: 0, errors: 0, truncated: false });
      expect(r.operations, nom).toBe((await k.actives(c)).length);
      expect(await k.historique(c), nom).toBe(h);
      expect(await k.anomaliesDures(c.id), nom).toEqual({});
    }
  });
});
