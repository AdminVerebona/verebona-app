/**
 * Lot 48 — O10, recette complète Opérations V1 : cas C29 restant à
 * automatiser (chacun dans son compte) et action BO « Reconsolider ce
 * compte » (point ouvert du lot 47) — base PostgreSQL réelle.
 *
 * Candidats par la persistance T1 réelle, consolidation par le moteur T3 de
 * production, projection Agenda réelle, route BO réelle (garde simulée),
 * travail exécuté par l'exécutant T3 de production (`runOne`). Aucun appel IA.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import { cand, cible, cibleEquipement, fh, operationsKit, ref, RECETTE_TODAY, type OperationsKit } from '../datasets/operations-v1';

const admin = vi.hoisted(() => ({ id: 0 }));
vi.mock('@/lib/auth-guards', () => ({
  requireAdmin: async () => admin.id,
  getSession: async () => ({ userId: admin.id, email: 'admin-o10@test.invalid' }),
  isSessionError: () => false,
  sessionErrorResponse: () => new Response(null, { status: 401 }),
}));

const bus = () => import('@/services/business-operations/events');
const can = () => import('@/services/verebona-assistant/canonical/expenses');

scenario('L48-O10b', 'Recette Opérations V1 : cas C29 complémentaires et « Reconsolider ce compte »', ({ sql, make }) => {
  let k: OperationsKit;
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
    k = operationsKit(sql, make);
  });
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });

  const nouveauCompte = async (plan: 'standard' | 'premium' = 'premium') => {
    const compte = await make.account({ plan });
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    return { compte, bien };
  };

  // ══ Création ═════════════════════════════════════════════════════════════

  it('F-027 — une facture avec deux travaux explicitement indépendants (deux candidats T1) : deux Opérations', async () => {
    const { compte, bien } = await nouveauCompte();
    const f = await k.document(compte, bien.id, [
      cand({ candidateKey: 'op1', summary: 'Ramonage', provider: 'Multi Services', targetHints: [cible(bien.id)], temporalHints: { realizedDate: '2026-03-02' }, financialHints: [fh('REALIZED_COST', 9000, { amountScope: null })] }),
      cand({ candidateKey: 'op2', summary: 'Élagage', provider: 'Multi Services', targetHints: [cible(bien.id)], temporalHints: { realizedDate: '2026-03-02' }, financialHints: [fh('REALIZED_COST', 25000, { amountScope: null })] }),
    ], { type: 'WORKS_INVOICE' });
    await k.passer(compte);
    const ops = await k.actives(compte);
    expect(ops).toHaveLength(2);
    expect((await k.candidat(f)).map((c) => c.t3_outcome)).toEqual(['CREATE_NEW', 'CREATE_NEW']);
    expect((await Promise.all(ops.map((o) => k.coutNet(o.id)))).sort((a, b) => a - b)).toEqual([9000, 25000]);
  });

  it('F-028 / F-032 / F-108 / ACC-007 — pièces + main-d’œuvre d’une même réparation : UNE INTERVENTION, une composante ; deux copies de la facture : même Opération, une composante soutenue par deux sources', async () => {
    const { compte, bien } = await nouveauCompte();
    const facture = () => cand({ summary: 'Réparation fuite (pièces et main-d’œuvre)', provider: 'Plombier Martin', targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', 'PL-2026-3')], temporalHints: { realizedDate: '2026-02-11' }, financialHints: [fh('REALIZED_COST', 41000)] });
    await k.document(compte, bien.id, [facture()], { type: 'WORKS_INVOICE' });
    await k.document(compte, bien.id, [facture()], { type: 'WORKS_INVOICE' });
    await k.passer(compte);
    const [op, ...autres] = await k.actives(compte);
    expect(autres).toEqual([]);
    expect(op.type_code).toBe('INTERVENTION');
    expect((await k.composantes(op.id)).map((c) => [c.kind, c.amount_minor, c.sources])).toEqual([['REALIZED_COST', 41000, 2]]);
    expect(await k.coutNet(op.id)).toBe(41000);
  });

  it('F-016 / F-040 — courrier de l’assureur citant la référence de sinistre : rattaché au sinistre saisi (MATCH) ; sans sinistre existant : CLAIM créée', async () => {
    const { compte, bien } = await nouveauCompte();
    const id = await k.sinistre(compte, compte.owner, bien, { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', insurerClaimRef: 'SIN-16' });
    const courrier = (r: string) => cand({ typeHint: 'CLAIM', sourceRoleHint: 'CLAIM_DOCUMENT', summary: 'Courrier de l’assureur', provider: 'Assur', targetHints: [cible(bien.id)], businessReferences: [ref('CLAIM', r)], temporalHints: { realizedDate: '2026-03-12' } });
    const a = await k.document(compte, bien.id, [courrier('SIN-16')], { type: 'CLAIM_DECLARATION' });
    const b = await k.document(compte, bien.id, [courrier('SIN-99')], { type: 'CLAIM_DECLARATION' });
    await k.passer(compte);
    expect((await k.candidat(a))[0]).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: id });
    const [cb] = await k.candidat(b);
    expect(cb.t3_outcome).toBe('CREATE_NEW');
    expect((await k.actives(compte)).filter((o) => o.type_code === 'CLAIM').map((o) => o.id).sort((x, y) => x - y)).toEqual([id, cb.t3_operation_id].sort((x, y) => x! - y!));
  });

  // ══ Rapprochement ════════════════════════════════════════════════════════

  it('F-055 / F-054 — Opération OTHER requalifiée CONTRACT par la réanalyse de sa source : même identifiant, TYPE_CHANGED historisé, détails de contrat posés', async () => {
    const { compte, bien } = await nouveauCompte();
    const base = { summary: 'Abonnement télésurveillance', provider: 'Sécuritas', targetHints: [cible(bien.id)], businessReferences: [ref('CONTRACT', 'TS-55')], temporalHints: { startDate: '2026-01-01' } };
    const f = await k.document(compte, bien.id, [cand({ ...base, typeHint: 'OTHER', sourceRoleHint: 'CONTRACT_DOCUMENT' })], { type: 'MAINTENANCE_CONTRACT' });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    expect(op.type_code).toBe('OTHER');
    await k.t1(compte, f, [cand({ ...base, typeHint: 'CONTRACT', sourceRoleHint: 'CONTRACT_DOCUMENT' })], true);
    await k.passer(compte);
    const ops = await k.actives(compte);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ id: op.id, type_code: 'CONTRACT' });
    expect(await sql`SELECT event_type, before_json->>'type_code' AS avant, after_json->>'type_code' AS apres FROM business_operation_history
      WHERE operation_id = ${op.id} AND event_type = 'TYPE_CHANGED'`).toEqual([{ event_type: 'TYPE_CHANGED', avant: 'OTHER', apres: 'CONTRACT' }]);
    expect(await sql`SELECT contract_reference FROM business_operation_contract_details WHERE operation_id = ${op.id}`).toEqual([{ contract_reference: 'TS-55' }]);
    expect((await k.sources(op.id)).filter((s) => s.active)).toHaveLength(1);
    expect(await k.anomaliesDures(compte.id)).toEqual({});
  });

  it('F-081 / F-079 — cible affinée de l’actif vers l’équipement à la réanalyse : même Opération, lien équipement ajouté ; cible résolue plus tard (document rattaché) : lien ajouté à la même Opération', async () => {
    const { compte, bien } = await nouveauCompte();
    const [{ id: chaudiere }] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${bien.id}, 'Chaudière', 'BOILER') RETURNING id`;
    const base = { summary: 'Entretien annuel', provider: 'Chauffage Plus', businessReferences: [ref('INVOICE', 'CH-81')], temporalHints: { realizedDate: '2026-02-02' }, financialHints: [fh('REALIZED_COST', 14000)] };
    const f = await k.document(compte, bien.id, [cand({ ...base, targetHints: [cible(bien.id)] })], { type: 'MAINTENANCE_INVOICE' });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    expect(await k.liensEquipement(op.id)).toEqual([]);
    await k.t1(compte, f, [cand({ ...base, targetHints: [cibleEquipement(chaudiere)] })], true);
    await k.passer(compte);
    const ops = await k.actives(compte);
    expect(ops.map((o) => o.id)).toEqual([op.id]);
    expect(await k.liensEquipement(op.id)).toEqual([{ equipment_id: chaudiere, asset_id: bien.id }]);
    expect((await k.liens(op.id)).map((l) => l.asset_id)).toEqual([bien.id]);

    // F-079 : document déposé sans bien → Opération sans bien ; rattaché ensuite → lien ajouté, même Opération.
    const libre = await k.document(compte, null, [cand({ summary: 'Débouchage', provider: 'Plombier', businessReferences: [ref('INVOICE', 'DB-1')], financialHints: [fh('REALIZED_COST', 9000)] })], { type: 'WORKS_INVOICE' });
    await k.passer(compte);
    const { t3_operation_id: sansBien } = (await k.candidat(libre))[0];
    expect(await k.liens(sansBien!)).toEqual([]);
    await sql`UPDATE asset_files SET asset_id = ${bien.id} WHERE id = ${libre}`;
    await k.passer(compte);
    expect((await k.liens(sansBien!)).map((l) => [l.asset_id, l.authority])).toEqual([[bien.id, 'INFERENCE']]);
    expect((await k.actives(compte)).map((o) => o.id)).toEqual([op.id, sansBien]);
  });

  // ══ Cycle de vie ═════════════════════════════════════════════════════════

  it('F-067 / F-121 / F-074 — ENVISAGED dont la date est passée reste ENVISAGED ; devis annulé par une preuve certaine → CANCELLED, prévisionnel conservé ; projet de contrat annulé avant effet → CANCELLED', async () => {
    const { compte, bien } = await nouveauCompte();
    const devis = await k.document(compte, bien.id, [cand({ summary: 'Ravalement', statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', provider: 'Façades Pro', targetHints: [cible(bien.id)], businessReferences: [ref('QUOTE', 'RV-1')], temporalHints: { plannedDate: '2026-01-15' }, financialHints: [fh('FORECAST_COST', 900000)] })], { type: 'WORKS_QUOTE' });
    await k.passer(compte);
    const { t3_operation_id: id } = (await k.candidat(devis))[0];
    expect((await k.operations(compte)).find((o) => o.id === id)).toMatchObject({ status: 'ENVISAGED', planned_date: '2026-01-15' });
    // F-067 : aucun passage du temps ne change l'état (balayage rejoué au-delà de la date).
    expect((await k.passer(compte, { reevaluateHolds: true })).changes).toBe(0);
    await k.document(compte, bien.id, [cand({ summary: 'Annulation du ravalement', statusHint: 'CANCELLED', sourceRoleHint: 'OTHER_EVIDENCE', provider: 'Façades Pro', targetHints: [cible(bien.id)], businessReferences: [ref('QUOTE', 'RV-1')] })], { type: 'WORKS_QUOTE' });
    await k.passer(compte);
    expect((await k.operations(compte)).find((o) => o.id === id)).toMatchObject({ status: 'CANCELLED', invalidated_at: null });
    expect((await k.composantes(id!)).map((c) => [c.kind, c.amount_minor])).toEqual([['FORECAST_COST', 900000]]);

    const projet = await k.document(compte, bien.id, [cand({ typeHint: 'CONTRACT', statusHint: 'ENVISAGED', sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Proposition d’assurance', provider: 'Assur', targetHints: [cible(bien.id)], businessReferences: [ref('POLICY', 'PJ-74')], temporalHints: { startDate: '2027-01-01' } })], { type: 'INSURANCE_POLICY' });
    await k.passer(compte);
    const { t3_operation_id: contrat } = (await k.candidat(projet))[0];
    expect((await k.operations(compte)).find((o) => o.id === contrat)).toMatchObject({ type_code: 'CONTRACT', status: 'ENVISAGED' });
    await k.document(compte, bien.id, [cand({ typeHint: 'CONTRACT', statusHint: 'CANCELLED', sourceRoleHint: 'OTHER_EVIDENCE', summary: 'Renonciation avant effet', provider: 'Assur', targetHints: [cible(bien.id)], businessReferences: [ref('POLICY', 'PJ-74')] })], { type: 'INSURANCE_POLICY' });
    await k.passer(compte);
    expect((await k.operations(compte)).find((o) => o.id === contrat)).toMatchObject({ status: 'CANCELLED' });
  });

  it('F-073 — contrat résilié après exécution (courrier de résiliation) : REALIZED + date de fin, jamais CANCELLED', async () => {
    const { compte, bien } = await nouveauCompte();
    const base = { typeHint: 'CONTRACT' as const, provider: 'Assur’Habitat', targetHints: [cible(bien.id)], businessReferences: [ref('POLICY', 'RES-73')] };
    const contrat = await k.document(compte, bien.id, [cand({ ...base, sourceRoleHint: 'CONTRACT_DOCUMENT', summary: 'Assurance habitation', temporalHints: { startDate: '2024-01-01' } })], { type: 'INSURANCE_POLICY' });
    await k.passer(compte);
    const { t3_operation_id: id } = (await k.candidat(contrat))[0];
    await k.document(compte, bien.id, [cand({ ...base, statusHint: 'CANCELLED', sourceRoleHint: 'OTHER_EVIDENCE', summary: 'Résiliation', temporalHints: { endDate: '2026-06-30' } })], { type: 'INSURANCE_POLICY' });
    await k.passer(compte);
    expect((await k.operations(compte)).find((o) => o.id === id)).toMatchObject({ status: 'REALIZED', end_date: '2026-06-30', invalidated_at: null });
    expect(await sql`SELECT effective_to::text AS t FROM business_operation_contract_details WHERE operation_id = ${id}`).toEqual([{ t: '2026-06-30' }]);
  });

  // ══ Finances (composantes consolidées ; le TCO lui-même est hors périmètre, Q1) ══

  it('F-096 — remise déjà intégrée au total de la facture (remise lue sur la même facture) : aucune REDUCTION, coût = total net', async () => {
    const { compte, bien } = await nouveauCompte();
    await k.document(compte, bien.id, [cand({ summary: 'Pose parquet', provider: 'Sols Plus', targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', 'SP-96')], financialHints: [fh('REALIZED_COST', 125000), fh('REDUCTION', 10000, { amountScope: null })] })], { type: 'WORKS_INVOICE' });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    expect((await k.composantes(op.id)).map((c) => [c.kind, c.amount_minor])).toEqual([['REALIZED_COST', 125000]]);
    // Un avoir distinct reste une réduction (F-095).
    await k.document(compte, bien.id, [cand({ summary: 'Avoir', sourceRoleHint: 'CREDIT_NOTE', provider: 'Sols Plus', targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', 'SP-96')], financialHints: [fh('REDUCTION', 5000)] })], { type: 'WORKS_INVOICE' });
    await k.passer(compte);
    expect(await k.coutNet(op.id)).toBe(120000);
  });

  it('F-102 / F-101 — frais de vente (facture d’agence citant l’acte) : REALIZED_COST de la même cession que le prix de vente', async () => {
    const { compte, bien } = await nouveauCompte();
    await sql`UPDATE assets SET status = 'VENDU' WHERE id = ${bien.id}`;
    const base = { typeHint: 'DISPOSAL' as const, targetHints: [cible(bien.id)], temporalHints: { realizedDate: '2026-09-01' } };
    await k.document(compte, bien.id, [cand({ ...base, sourceRoleHint: 'SALE_DOCUMENT', summary: 'Acte de vente', provider: 'Étude notariale', businessReferences: [ref('OTHER', 'ACTE-102')], financialHints: [fh('PROCEED', 25000000, { economicDate: '2026-09-01' })] })], { type: 'WORKS_INVOICE' });
    await k.passer(compte);
    await k.document(compte, bien.id, [cand({ ...base, sourceRoleHint: 'INVOICE', summary: 'Honoraires d’agence', provider: 'Agence du Parc', businessReferences: [ref('OTHER', 'ACTE-102'), ref('INVOICE', 'AG-7')], financialHints: [fh('REALIZED_COST', 50000)] })], { type: 'WORKS_INVOICE' });
    await k.passer(compte);
    const ops = await k.actives(compte);
    expect(ops.map((o) => o.type_code)).toEqual(['DISPOSAL']);
    expect((await k.composantes(ops[0].id)).map((c) => [c.kind, c.amount_minor])).toEqual([['PROCEED', 25000000], ['REALIZED_COST', 50000]]);
  });

  it('F-117 / F-120 / F-098 / INV-053 — remboursement supérieur au coût : composantes positives (signe porté par le rôle), net indicatif négatif autorisé', async () => {
    const { compte, bien } = await nouveauCompte();
    await k.document(compte, bien.id, [cand({ summary: 'Réparation volet', provider: 'Stores 2000', targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', 'ST-117')], financialHints: [fh('REALIZED_COST', 100000)] })], { type: 'WORKS_INVOICE' });
    await k.document(compte, bien.id, [cand({ summary: 'Remboursement geste commercial', sourceRoleHint: 'REFUND_PROOF', provider: 'Stores 2000', targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', 'ST-117')], financialHints: [fh('REFUND', 120000, { amountScope: null })] })], { type: 'WORKS_INVOICE' });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    expect((await k.composantes(op.id)).map((c) => [c.kind, c.amount_minor])).toEqual([['REALIZED_COST', 100000], ['REFUND', 120000]]);
    expect(await k.coutNet(op.id)).toBe(-20000);
    const { OperationDiagnosticsService } = await import('@/services/business-operations/diagnostics/service');
    const { parseOperationListFilters } = await import('@/services/business-operations/diagnostics/model');
    const liste = await new OperationDiagnosticsService().list(parseOperationListFilters(new URLSearchParams(`accountId=${compte.id}`)));
    expect(liste.items.find((i) => i.id === op.id)?.netCents).toBe(-20000);
    expect(await k.anomaliesDures(compte.id)).toEqual({});
  });

  it('F-122 / F-091 / INV-013 — facture finale après devis : prévisionnel conservé (historique) mais exclu du coût réalisé ; T2 ne compte que le réalisé', async () => {
    const { compte, bien } = await nouveauCompte();
    await k.document(compte, bien.id, [cand({ summary: 'Pompe à chaleur', statusHint: 'ENVISAGED', sourceRoleHint: 'QUOTE', provider: 'Clim Pro', targetHints: [cible(bien.id)], businessReferences: [ref('QUOTE', 'PAC-1')], financialHints: [fh('FORECAST_COST', 120000)] })], { type: 'WORKS_QUOTE' });
    await k.document(compte, bien.id, [cand({ summary: 'Pompe à chaleur', provider: 'Clim Pro', targetHints: [cible(bien.id)], businessReferences: [ref('QUOTE', 'PAC-1'), ref('INVOICE', 'PAC-F1')], temporalHints: { realizedDate: '2026-05-05' }, financialHints: [fh('REALIZED_COST', 135000)] })], { type: 'WORKS_INVOICE' });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    expect((await k.composantes(op.id)).map((c) => [c.kind, c.amount_minor])).toEqual([['FORECAST_COST', 120000], ['REALIZED_COST', 135000]]);
    const t2 = await (await can()).sumQualifiedExpenses(compte.id, { assetIds: [bien.id] });
    expect(t2.operations?.sumCents).toBe(135000);
  });

  // ══ Technique ════════════════════════════════════════════════════════════

  it('F-167 / NFR-OP-006 — échec de la projection Agenda après le commit de l’Opération : l’Opération reste ; projection rejouée → un seul événement, puis no-op', async () => {
    const { compte, bien } = await nouveauCompte();
    await k.document(compte, bien.id, [cand({ summary: 'Révision chaudière', provider: 'Chauffage Plus', targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', 'RC-167')], temporalHints: { realizedDate: '2026-04-04' }, financialHints: [fh('REALIZED_COST', 12000)] })], { type: 'MAINTENANCE_INVOICE' });
    await k.passer(compte);
    const [op] = await k.actives(compte);
    const { projectAccountOperations } = await import('@/services/business-operations/agenda-projection/service');
    await expect(projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY, beforeWrite: async () => { throw new Error('panne simulée'); } })).rejects.toThrow('panne simulée');
    expect((await k.actives(compte)).map((o) => o.id)).toEqual([op.id]);
    expect(await sql`SELECT id FROM agenda_items WHERE business_operation_id = ${op.id}`).toHaveLength(0);
    await projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY });
    expect(await sql`SELECT id FROM agenda_items WHERE business_operation_id = ${op.id}`).toHaveLength(1);
    expect((await projectAccountOperations(compte.id, { all: true, today: RECETTE_TODAY })).changes).toBe(0);
  });

  it('F-181 / F-157 / ACC-012 / INV-057 — après le passage au Sinistre structuré : la CLAIM fait foi ; claim_json n’est qu’un miroir (une écriture directe n’y change rien, aucun passage T3 ne le lit)', async () => {
    const { compte, bien } = await nouveauCompte();
    const id = await k.sinistre(compte, compte.owner, bien, { claimType: 'INCENDIE', occurredOn: '2026-04-04', status: 'DECLARE' });
    const legacy = async () => (await sql<{ claim_json: Record<string, unknown> | null }[]>`SELECT claim_json FROM asset_additional_infos WHERE asset_id = ${bien.id}`)[0]?.claim_json ?? null;
    expect(await legacy()).toMatchObject({ claimType: 'INCENDIE', status: 'DECLARE' });
    await sql`UPDATE asset_additional_infos SET claim_json = ${JSON.stringify({ claimType: 'VOL', occurredOn: '2020-01-01', status: 'CLOS' })}::jsonb WHERE asset_id = ${bien.id}`;
    const h = await k.historique(compte);
    expect((await k.passer(compte, { reevaluateHolds: true })).changes).toBe(0);
    expect(await k.historique(compte)).toBe(h);
    const { ClaimOperationService } = await import('@/services/business-operations/claims/claim-operation.service');
    const dto = await ClaimOperationService.get(compte.id, bien.id, id);
    expect(dto?.claim).toMatchObject({ claimType: 'INCENDIE', occurredOn: '2026-04-04', status: 'DECLARE' });
    expect(await sql`SELECT status FROM business_operation_claim_details WHERE operation_id = ${id}`).toEqual([{ status: 'DECLARE' }]);
  });

  // ══ « Reconsolider ce compte » (O10, point ouvert du lot 47) ═════════════

  const route = () => import('@/app/api/admin/accounts/[id]/operations-reconsolidation/route');
  const post = async (accountId: number, body: unknown) => {
    const r = await (await route()).POST(
      new NextRequest(`http://x/api/admin/accounts/${accountId}/operations-reconsolidation`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: String(accountId) }) },
    );
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const audit = (adminId: number) => sql<{ action_type: string; target_type: string; target_id: number; result: string; details: string }[]>`
    SELECT action_type, target_type, target_id, result, details FROM admin_audit_log WHERE admin_user_id = ${adminId} ORDER BY id`;

  it('O10-20 / O10-21 — route BO : motif obligatoire ; compte inconnu 404 (refus journalisé) ; succès 202 = travail T3 `business_operations` dédoublonné (code manual) + projection Agenda, audit avec motif', async () => {
    const a = await make.user({ role: 'ADMIN' });
    admin.id = a.id;
    const { compte, bien } = await nouveauCompte();
    await k.document(compte, bien.id, [cand({ targetHints: [cible(bien.id)], financialHints: [fh('REALIZED_COST', 1000)] })]);
    await k.passer(compte);
    try {
      expect((await post(compte.id, {})).status).toBe(400);
      expect((await post(compte.id, { reason: 'ok' })).body).toMatchObject({ code: 'INVALID_REASON' });
      expect((await post(999_999_999, { reason: 'Correction livrée' })).status).toBe(404);

      const r1 = await post(compte.id, { reason: 'Correction du lot 48 livrée' });
      expect(r1.status).toBe(202);
      expect(r1.body).toMatchObject({ accountId: compte.id });
      const r2 = await post(compte.id, { reason: 'Deuxième demande rapprochée' });
      // Dédoublonnée : même travail, événement ajouté.
      expect(r2.body.operationsJobId).toBe(r1.body.operationsJobId);
      expect(r2.body.agendaJobId).toBe(r1.body.agendaJobId);
      const [job] = await sql<{ target_type: string; target_id: string; trigger_code: string; origin: string; payload: { kind: string; events: Array<{ trigger: string; correlationId: string }> } }[]>`
        SELECT target_type, target_id, trigger_code, origin, payload FROM ai_job_queue WHERE id = ${r1.body.operationsJobId as number}`;
      expect(job).toMatchObject({ target_type: 'business_operations', target_id: String(compte.id), trigger_code: 'manual', origin: 'automatic' });
      expect(job.payload.events.map((e) => e.trigger)).toEqual(['admin_reconsolidation', 'admin_reconsolidation']);
      expect(job.payload.events[0].correlationId).toBe(r1.body.correlationId);
      const [agenda] = await sql<{ target_type: string; payload: { events: Array<{ all?: boolean }> } }[]>`SELECT target_type, payload FROM ai_job_queue WHERE id = ${r1.body.agendaJobId as number}`;
      expect(agenda.target_type).toBe('business_operations_agenda');
      expect(agenda.payload.events.every((e) => e.all === true)).toBe(true);

      const lignes = await audit(a.id);
      expect(lignes.map((l) => [l.action_type, l.target_type, l.target_id, l.result])).toEqual([
        ['OPERATIONS_RECONSOLIDATE', 'ACCOUNT', 999_999_999, 'DENIED'],
        ['OPERATIONS_RECONSOLIDATE', 'ACCOUNT', compte.id, 'SUCCESS'],
        ['OPERATIONS_RECONSOLIDATE', 'ACCOUNT', compte.id, 'SUCCESS'],
      ]);
      expect(JSON.parse(lignes[1].details)).toMatchObject({ reason: 'Correction du lot 48 livrée', operationsJobId: r1.body.operationsJobId });
      // Aucune écriture métier par la route elle-même (Q9) : rien n'a changé dans les Opérations.
      expect(await k.anomaliesDures(compte.id)).toEqual({});
    } finally {
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE account_id = ${compte.id} AND status = 'PENDING'`;
    }
  });

  it('O10-22 / ACC-022 / C26.2 — travail exécuté par l’exécutant T3 de production : une anomalie dure (Opération active sans source) est résorbée par la reconsolidation complète ; le compte cohérent n’est pas modifié', async () => {
    const a = await make.user({ role: 'ADMIN' });
    admin.id = a.id;
    const { compte, bien } = await nouveauCompte();
    const f1 = await k.document(compte, bien.id, [cand({ targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', 'R-1')], temporalHints: { realizedDate: '2026-02-02' }, financialHints: [fh('REALIZED_COST', 1000)] })]);
    await k.document(compte, bien.id, [cand({ provider: 'Autre', targetHints: [cible(bien.id)], businessReferences: [ref('INVOICE', 'R-2')], temporalHints: { realizedDate: '2026-03-03' }, financialHints: [fh('REALIZED_COST', 2000)] })]);
    await k.passer(compte);
    const { t3_operation_id: cassee } = (await k.candidat(f1))[0];
    // Défaut simulé (données laissées par un ancien code) : la source est retirée sans reconsolidation.
    await sql`UPDATE business_operation_sources SET active = false, superseded_at = now() WHERE operation_id = ${cassee}`;
    expect(await k.anomaliesDures(compte.id)).toMatchObject({ ACTIVE_OPERATION_WITHOUT_SOURCE: 1, ACTIVE_COMPONENT_WITHOUT_SOURCE: 1 });

    const repo = await import('@/services/ai/queue/job-queue.repository');
    const triggers = await import('@/services/ai/queue/triggers');
    triggers.__setTriggerConfigLoader(async () => null);
    await repo.setEmergencyStop(false, a.id);
    await repo.setTreatmentState('T3', 'ENABLED', a.id);
    const { registerJobHandler, runOne } = await import('@/services/ai/queue/queue-worker');
    const { t3JobHandler } = await import('@/services/ai/reconciliation/t3-queue');
    registerJobHandler('T3', t3JobHandler);
    try {
      const r = await post(compte.id, { reason: 'Anomalie dure : reconsolidation après correctif' });
      expect(r.status).toBe(202);
      // Seul ce travail est prélevable (base partagée).
      await sql`UPDATE ai_job_queue SET available_at = now() + interval '1 day' WHERE treatment = 'T3' AND status = 'PENDING' AND id <> ${r.body.operationsJobId as number}`;
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${r.body.operationsJobId as number}`;
      expect(await runOne('T3')).toBe(true);
      const [fini] = await sql<{ status: string; business_result: string; business_result_detail: { reconsolidated: number } }[]>`
        SELECT status, business_result, business_result_detail FROM ai_job_queue WHERE id = ${r.body.operationsJobId as number}`;
      expect(fini).toMatchObject({ status: 'DONE', business_result: 'APPLIED', business_result_detail: { reconsolidated: 2 } });
      expect(await k.anomaliesDures(compte.id)).toEqual({});
      // Lot 54D (E08) : la reconsolidation couvre aussi les CANDIDATS — le document
      // R-1, toujours présent et analysé, re-prouve sa réalité : l'Opération est
      // rétablie depuis ses preuves (source réactivée), sans doublon.
      const ops = await k.operations(compte);
      expect(ops.filter((o) => o.invalidated_at === null)).toHaveLength(2);
      const { t3_operation_id: apres } = (await k.candidat(f1))[0];
      expect(ops.find((o) => o.id === apres)!.invalidated_at).toBeNull();
      expect((await k.sources(apres!)).filter((x) => x.active && x.source_kind === 'DOCUMENT')).toHaveLength(1);
      expect(await k.coutNet(apres!)).toBe(1000);

      // Rejouée sur le compte désormais cohérent : aucune écriture (INV-040).
      const h = await k.historique(compte);
      const r2 = await post(compte.id, { reason: 'Contrôle de non-régression' });
      await sql`UPDATE ai_job_queue SET available_at = now() + interval '1 day' WHERE treatment = 'T3' AND status = 'PENDING' AND id <> ${r2.body.operationsJobId as number}`;
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE id = ${r2.body.operationsJobId as number}`;
      expect(await runOne('T3')).toBe(true);
      const [fini2] = await sql<{ business_result: string }[]>`SELECT business_result FROM ai_job_queue WHERE id = ${r2.body.operationsJobId as number}`;
      expect(fini2.business_result).toBe('NO_CHANGE');
      expect(await k.historique(compte)).toBe(h);
    } finally {
      await sql`UPDATE ai_job_queue SET status = 'CANCELLED' WHERE treatment = 'T3' AND status = 'PENDING' AND account_id = ${compte.id}`;
      await sql`UPDATE ai_job_queue SET available_at = now() WHERE treatment = 'T3' AND status = 'PENDING'`;
      triggers.__setTriggerConfigLoader(null);
    }
  });
});
