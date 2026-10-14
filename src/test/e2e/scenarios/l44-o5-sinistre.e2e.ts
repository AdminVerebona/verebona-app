/**
 * Lot 44 — O5, refonte du Sinistre (CDC Opérations V1 ch. 15, B14, C13.1,
 * C14, C14.1 à C14.3, C19, C22, C23, F-148 à F-160 ; décisions PO Q2, Q3, Q4,
 * Q11) — base PostgreSQL réelle.
 *
 * Écritures par les ROUTES de production (`/api/assets/[id]/claims*`, session
 * simulée), candidats documentaires par la persistance T1 réelle,
 * consolidation par le moteur T3 de production, migration par la tâche
 * interne réelle. Aucun appel IA.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

const AUJOURDHUI = '2026-10-12';
const bus = () => import('@/services/business-operations/events');

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Réparation', sourceRoleHint: 'INVOICE', provider: 'Plombier Martin',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1' }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });

type Json = Record<string, unknown>;

scenario('L44-O5', 'Sinistre = Opération CLAIM : fiche, multi-biens, indemnité, migration, export', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  const routeList = () => import('@/app/api/assets/[id]/claims/route');
  const routeOne = () => import('@/app/api/assets/[id]/claims/[claimId]/route');

  function connecter(c: AccountRow) {
    session.currentAccountId = c.id;
    session.userId = c.ownerUserId;
  }
  const req = (method: string, path: string, body?: unknown) =>
    new NextRequest(`http://x${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) });
  async function lister(assetId: number) {
    const r = await (await routeList()).GET(req('GET', `/api/assets/${assetId}/claims`), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: r.status, body: await r.json() as Json };
  }
  async function creer(assetId: number, body: Json = {}) {
    const r = await (await routeList()).POST(req('POST', `/api/assets/${assetId}/claims`, body), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: r.status, body: await r.json() as Json };
  }
  async function lire(assetId: number, claimId: number) {
    const r = await (await routeOne()).GET(req('GET', `/api/assets/${assetId}/claims/${claimId}`), { params: Promise.resolve({ id: String(assetId), claimId: String(claimId) }) });
    return { status: r.status, body: await r.json() as Json };
  }
  async function modifier(assetId: number, claimId: number, body: Json) {
    const r = await (await routeOne()).PATCH(req('PATCH', `/api/assets/${assetId}/claims/${claimId}`, body), { params: Promise.resolve({ id: String(assetId), claimId: String(claimId) }) });
    return { status: r.status, body: await r.json() as Json };
  }
  async function supprimer(assetId: number, claimId: number) {
    const r = await (await routeOne()).DELETE(req('DELETE', `/api/assets/${assetId}/claims/${claimId}`), { params: Promise.resolve({ id: String(assetId), claimId: String(claimId) }) });
    return { status: r.status, body: await r.json() as Json };
  }
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
  const passerDocs = async (compte: AccountRow) =>
    (await import('@/services/business-operations/consolidation/consolidator')).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, operationMatch: false });
  const claims = (compte: AccountRow) => sql<{ id: number; status: string; realized_date: string | null; closed_at: string | null; invalidated_at: string | null }[]>`
    SELECT id::int AS id, status, realized_date::text AS realized_date, closed_at::text AS closed_at, invalidated_at::text AS invalidated_at
      FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'CLAIM' ORDER BY id`;
  const ops = async (compte: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id}`)[0].n;
  const details = async (id: number) => (await sql<Json[]>`
    SELECT claim_type, declared_on::text AS declared_on, insurer_claim_ref, insurance_contract_operation_id::int AS insurance_contract_operation_id,
           policy_reference_text, status, status_detail, circumstances, consequences, estimated_damage_minor::int AS estimated_damage_minor,
           history_event_id
      FROM business_operation_claim_details WHERE operation_id = ${id}`)[0];
  const composantes = (id: number) => sql<{ kind: string; amount_minor: number; target_asset_id: number | null }[]>`
    SELECT kind, amount_minor::int AS amount_minor, target_asset_id FROM business_operation_financial_components WHERE operation_id = ${id} AND active ORDER BY id`;
  const historique = async (compte: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${compte.id}`)[0].n;
  const legacy = async (assetId: number) => (await sql<{ claim_json: Json }[]>`SELECT claim_json FROM asset_additional_infos WHERE asset_id = ${assetId}`)[0]?.claim_json ?? null;
  async function invariants(compte: AccountRow) {
    expect(await sql`SELECT o.id FROM business_operations o WHERE o.account_id = ${compte.id} AND o.invalidated_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM business_operation_sources s WHERE s.operation_id = o.id AND s.active)`).toHaveLength(0);
    expect(await sql`SELECT c.id FROM business_operation_financial_components c WHERE c.account_id = ${compte.id} AND c.active
      AND NOT EXISTS (SELECT 1 FROM business_operation_financial_component_sources cs JOIN business_operation_sources s ON s.id = cs.operation_source_id
                       WHERE cs.component_id = c.id AND s.active)`).toHaveLength(0);
  }

  // ══ Saisie et statuts ══════════════════════════════════════════════════════

  it('O5-E01 / F-015 / F-148 / Q3 — compte STANDARD : sinistre saisi « À déclarer » → CLAIM REALIZED, dossier A_DECLARER, source CLAIM_FORM', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    connecter(compte);
    const c = await creer(maison.id, { claim: { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', status: 'A_DECLARER' } });
    expect(c.status).toBe(201);
    const [op, ...autres] = await claims(compte);
    expect(autres).toEqual([]);
    expect(op).toMatchObject({ id: c.body.id, status: 'REALIZED', realized_date: '2026-03-12', closed_at: null });
    expect(await details(op.id)).toMatchObject({ claim_type: 'DEGAT_DES_EAUX', status: 'A_DECLARER' });
    expect(await sql`SELECT source_kind, source_entity_key, authority FROM business_operation_sources WHERE operation_id = ${op.id} AND active`)
      .toEqual([{ source_kind: 'CLAIM_FORM', source_entity_key: String(maison.id), authority: 'USER' }]);
    expect(await sql`SELECT asset_id, link_role, authority FROM business_operation_asset_links WHERE operation_id = ${op.id} AND active`)
      .toEqual([{ asset_id: maison.id, link_role: 'PRIMARY', authority: 'USER' }]);
    expect((c.body.claim as Json)).toMatchObject({ claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', status: 'A_DECLARER' });
    // P09 : aucun terme technique dans la réponse.
    expect(JSON.stringify(c.body)).not.toMatch(/Op[ée]ration/);
    await invariants(compte);
  });

  it('O5-E02 / C14.1 / F-149 / F-150 / INV-FINAL-022 — Clos → closed_at, Refusé → ouvert, toujours REALIZED ; réouverture', async () => {
    const compte = await make.account({ plan: 'standard' });
    const bien = await make.asset(compte);
    connecter(compte);
    const { body } = await creer(bien.id, { claim: { claimType: 'ACCIDENT', occurredOn: '2026-05-02' } });
    const id = body.id as number;
    await modifier(bien.id, id, { claim: { status: 'CLOS' } });
    expect((await claims(compte))[0]).toMatchObject({ status: 'REALIZED' });
    expect((await claims(compte))[0].closed_at).not.toBeNull();
    await modifier(bien.id, id, { claim: { status: 'REFUSE' } });
    expect((await claims(compte))[0]).toMatchObject({ status: 'REALIZED', closed_at: null });
    expect(await details(id)).toMatchObject({ status: 'REFUSE' });
    expect((await lire(bien.id, id)).body.closed).toBe(false);
  });

  it('O5-E03 / Q2 — plusieurs sinistres par bien : liste triée par survenue, chacun son formulaire', async () => {
    const compte = await make.account({ plan: 'standard' });
    const bien = await make.asset(compte, { name: 'Clio' });
    connecter(compte);
    const a = await creer(bien.id, { claim: { claimType: 'BRIS_DE_GLACE', occurredOn: '2025-01-10' } });
    const b = await creer(bien.id, { claim: { claimType: 'VOL', occurredOn: '2026-02-20' } });
    const l = await lister(bien.id);
    expect(l.status).toBe(200);
    expect((l.body.claims as Json[]).map((c) => c.id)).toEqual([b.body.id, a.body.id]);
    expect((l.body.claims as Json[])[0]).toMatchObject({ label: 'Vol ou cambriolage · 20/02/2026', otherAssets: [] });
    expect(await claims(compte)).toHaveLength(2);
  });

  it('O5-E04 / F-158 / 15.5 — sinistre multi-biens : UNE Opération, deux biens, visible des deux fiches ; retrait d\'un bien', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    connecter(compte);
    const c = await creer(maison.id, { assetIds: [maison.id, garage.id], claim: { claimType: 'EVENEMENT_CLIMATIQUE', occurredOn: '2026-06-01' } });
    expect(c.status).toBe(201);
    expect(await claims(compte)).toHaveLength(1);
    expect(await sql`SELECT asset_id, link_role FROM business_operation_asset_links WHERE operation_id = ${c.body.id as number} AND active ORDER BY asset_id`)
      .toEqual([{ asset_id: maison.id, link_role: 'PRIMARY' }, { asset_id: garage.id, link_role: 'CONCERNED' }]);
    const duGarage = await lister(garage.id);
    expect((duGarage.body.claims as Json[])[0]).toMatchObject({ id: c.body.id, otherAssets: [{ id: maison.id, name: 'Maison' }] });
    // Retrait du garage depuis la fiche de la maison.
    const r = await modifier(maison.id, c.body.id as number, { assetIds: [maison.id] });
    expect(r.status).toBe(200);
    expect((await lister(garage.id)).body.claims).toEqual([]);
    expect(await sql`SELECT count(*)::int AS n FROM business_operation_sources WHERE operation_id = ${c.body.id as number} AND active AND source_kind = 'CLAIM_FORM'`).toEqual([{ n: 1 }]);
    // Un sinistre concerne au moins un bien.
    expect((await modifier(maison.id, c.body.id as number, { assetIds: [] })).status).toBe(422);
    await invariants(compte);
  });

  it('O5-E20 / F-083 / C25 — Premium Duo : le co-titulaire voit et modifie le MÊME sinistre ; un autre compte ne le voit pas', async () => {
    const compte = await make.account({ plan: 'premium_duo' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER' });
    const membre = await make.user();
    await sql`INSERT INTO account_memberships (account_id, user_id, role, status) VALUES (${compte.id}, ${membre.id}, 'member', 'active')`;
    connecter(compte);
    const { body } = await creer(bien.id, { claim: { claimType: 'INCENDIE', occurredOn: '2026-04-04' } });
    session.userId = membre.id;
    expect((await modifier(bien.id, body.id as number, { claim: { status: 'DECLARE' } })).status).toBe(200);
    expect(await claims(compte)).toHaveLength(1);
    expect(await details(body.id as number)).toMatchObject({ status: 'DECLARE' });
    expect(await sql`SELECT actor_user_id FROM business_operation_history WHERE operation_id = ${body.id as number} ORDER BY id DESC LIMIT 1`).toEqual([{ actor_user_id: membre.id }]);
    const autre = await make.account({ plan: 'premium' });
    connecter(autre);
    expect((await lister(bien.id)).status).toBe(404);
    expect((await lire(bien.id, body.id as number)).status).toBe(404);
    expect((await modifier(bien.id, body.id as number, { claim: { status: 'CLOS' } })).status).toBe(404);
  });

  // ══ Montants (Q4) ══════════════════════════════════════════════════════════

  it('O5-E05 / Q4 / F-159 / F-160 — indemnité → INDEMNITY (attribuée au bien seul, globale si multi-biens) ; coût brut jamais diminué, net = brut − indemnité', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const cave = await make.asset(compte, { category: 'IMMOBILIER', name: 'Cave' });
    connecter(compte);
    const { body } = await creer(maison.id, { claim: { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', compensationCents: 120000, estimatedDamageCents: 350000 } });
    const id = body.id as number;
    expect(await composantes(id)).toEqual([{ kind: 'INDEMNITY', amount_minor: 120000, target_asset_id: maison.id }]);
    expect(await details(id)).toMatchObject({ estimated_damage_minor: 350000 });
    // Réparation prouvée par une facture, enfant du sinistre (via action avec facture).
    const facture = await document(compte, maison.id, [cand({ targetHints: [cible(maison.id)], businessReferences: [{ kind: 'INVOICE', value: 'FP-77' }], temporalHints: { realizedDate: '2026-04-02' }, financialHints: [fh('REALIZED_COST', 200000)] })]);
    await passerDocs(compte);
    const v = (await lire(maison.id, id)).body.version as number;
    await modifier(maison.id, id, { claim: { actions: [{ id: 'r1', title: 'Remplacement du plafond', status: 'REALISEE', invoiceDocumentId: facture }] }, version: v });
    const dto = (await lire(maison.id, id)).body;
    expect(dto.costs).toMatchObject({ grossCents: 200000, indemnityCents: 120000, netCents: 80000, complete: true });
    const [inter] = await sql<{ id: number; parent: number }[]>`SELECT id::int AS id, parent_operation_id::int AS parent FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'INTERVENTION'`;
    expect(inter.parent).toBe(id);
    expect(await composantes(inter.id)).toEqual([{ kind: 'REALIZED_COST', amount_minor: 200000, target_asset_id: null }]);
    // Multi-biens : l'indemnité devient globale (jamais ventilée).
    await modifier(maison.id, id, { assetIds: [maison.id, cave.id], claim: { compensationCents: 130000 } });
    expect(await composantes(id)).toEqual([{ kind: 'INDEMNITY', amount_minor: 130000, target_asset_id: null }]);
    // Retirée : composante supersédée, aucune autre.
    await modifier(maison.id, id, { claim: { compensationCents: null } });
    expect(await composantes(id)).toEqual([]);
    await invariants(compte);
  });

  // ══ Police et contrat (C13.1) ═════════════════════════════════════════════

  it('O5-E06 / F-155 / F-156 — police reconnue (un seul contrat) → lien ; ambiguë → texte seul ; non précisée → contrat de la fiche', async () => {
    const compte = await make.account({ plan: 'premium' });
    const clio = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const polo = await make.asset(compte, { category: 'IMMOBILIER', name: 'Loft' });
    const facade = await import('@/services/asset-details-write.service');
    const adc = await import('@/services/business-operations/consolidation/asset-data-consolidator');
    await facade.updateAssetDetails({ assetId: clio.id, accountId: compte.id, section: 'insurance', fields: { insurer: 'MAAF', insuranceContractNumber: 'AU-778' }, actorUserId: compte.ownerUserId });
    await adc.consolidateAssetData(compte.id, clio.id, { today: AUJOURDHUI });
    const [contrat] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'CONTRACT'`;
    expect(contrat).toBeTruthy();
    connecter(compte);
    const a = await creer(clio.id, { claim: { claimType: 'ACCIDENT', occurredOn: '2026-01-05', policyReference: 'au 778' } });
    expect(await details(a.body.id as number)).toMatchObject({ insurance_contract_operation_id: contrat.id, policy_reference_text: 'au 778' });
    expect(a.body.contractLabel).toMatch(/MAAF/);
    const b = await creer(clio.id, { claim: { claimType: 'VANDALISME', occurredOn: '2026-02-05' } });
    expect(await details(b.body.id as number)).toMatchObject({ insurance_contract_operation_id: contrat.id, policy_reference_text: null });
    // Un second contrat (issu d'un document) porte la même police : deux contrats possibles → texte seul, aucun faux lien.
    const attestation = await make.assetFile(compte, { assetId: polo.id });
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo) => {
      const k = await repo.create({ type: { code: 'CONTRACT' }, status: 'REALIZED', source: { kind: 'DOCUMENT', entityKey: attestation.id, authority: 'DOCUMENT', locator: { e2e: 'police' } }, reasonCode: 'E2E' });
      await repo.addReference(k.id, { kind: 'POLICY', value: 'AU 778', sourceId: k.sourceId });
    });
    const c = await creer(polo.id, { claim: { claimType: 'ACCIDENT', occurredOn: '2026-03-05', policyReference: 'AU-778' } });
    expect(await details(c.body.id as number)).toMatchObject({ insurance_contract_operation_id: null, policy_reference_text: 'AU-778' });
  });

  // ══ Actions, dommages, échanges (C14.2) ═══════════════════════════════════

  it('O5-E07 / F-151 / F-152 / F-153 / F-154 — action sans facture, dommage, échange : jamais une Opération ; action avec facture → INTERVENTION enfant rapprochée, pas créée', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    connecter(compte);
    const { body } = await creer(maison.id, { claim: { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12' } });
    const id = body.id as number;
    const avant = await ops(compte);
    let v = (await lire(maison.id, id)).body.version as number;
    const r = await modifier(maison.id, id, {
      version: v,
      claim: {
        actions: [{ id: 'a1', title: 'Couper l’eau', status: 'REALISEE', date: '2026-03-12' }],
        damages: [{ id: 'd1', zone: 'Salle de bain', element: 'Plafond', estimatedAmountCents: 80000 }],
        exchanges: [{ id: 'x1', date: '2026-03-13', summary: 'Déclaration à l’assureur', party: 'ASSUREUR', channel: 'TELEPHONE', direction: 'ENVOYE' }],
      },
    });
    expect(r.status).toBe(200);
    expect(await ops(compte)).toBe(avant);
    expect((r.body.claim as Json).damages).toEqual([{ id: 'd1', zone: 'Salle de bain', element: 'Plafond', estimatedAmountCents: 80000 }]);
    // Facture d'une intervention déjà consolidée : rapprochée comme enfant, aucune nouvelle Opération.
    const facture = await document(compte, maison.id, [cand({ targetHints: [cible(maison.id)], businessReferences: [{ kind: 'INVOICE', value: 'FP-12' }], temporalHints: { realizedDate: '2026-03-20' }, financialHints: [fh('REALIZED_COST', 45000)] })]);
    await passerDocs(compte);
    const n = await ops(compte);
    v = (await lire(maison.id, id)).body.version as number;
    await modifier(maison.id, id, { version: v, claim: { actions: [{ id: 'a1', title: 'Couper l’eau', status: 'REALISEE' }, { id: 'a2', title: 'Réparation de la fuite', status: 'REALISEE', invoiceDocumentId: facture }] } });
    expect(await ops(compte)).toBe(n);
    const actions = await sql<{ item_key: string; child: number | null }[]>`SELECT item_key, child_operation_id::int AS child FROM business_operation_claim_actions WHERE operation_id = ${id} ORDER BY sort_order`;
    const [inter] = await sql<{ id: number; parent: number }[]>`SELECT id::int AS id, parent_operation_id::int AS parent FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'INTERVENTION'`;
    expect(actions).toEqual([{ item_key: 'a1', child: null }, { item_key: 'a2', child: inter.id }]);
    expect(inter.parent).toBe(id);
  });

  it('O5-E08 / C14.2 — facture analysée APRÈS la saisie de l\'action : T3 rattache l\'intervention au sinistre (sans nouvelle question)', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    connecter(compte);
    const f = await make.assetFile(compte, { assetId: maison.id });
    const { body } = await creer(maison.id, { claim: { claimType: 'INCENDIE', occurredOn: '2026-07-01', actions: [{ id: 'a1', title: 'Expertise', invoiceDocumentId: f.id }] }, version: 0 });
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, {
        accountId: compte.id, fileId: f.id, extractionId: x.id, analysisRunId: null, reanalysis: false, facts: new Map(),
        candidates: [cand({ targetHints: [cible(maison.id)], summary: 'Expertise incendie', temporalHints: { realizedDate: '2026-07-10' }, financialHints: [fh('REALIZED_COST', 30000)] })],
      });
    });
    await passerDocs(compte);
    const [inter] = await sql<{ id: number; parent: number }[]>`SELECT id::int AS id, parent_operation_id::int AS parent FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'INTERVENTION'`;
    expect(inter.parent).toBe(body.id);
    expect(await sql`SELECT child_operation_id::int AS c FROM business_operation_claim_actions WHERE operation_id = ${body.id as number}`).toEqual([{ c: inter.id }]);
  });

  // ══ Verrou optimiste ═══════════════════════════════════════════════════════

  it('O5-E09 — verrou optimiste : liste avec version dépassée → 409 + état courant ; champ simple sans version accepté ; liste sans version refusée', async () => {
    const compte = await make.account({ plan: 'standard' });
    const bien = await make.asset(compte);
    connecter(compte);
    const { body } = await creer(bien.id, { claim: { claimType: 'ACCIDENT' } });
    const id = body.id as number;
    const v = body.version as number;
    expect((await modifier(bien.id, id, { version: v, claim: { damages: [{ id: 'd1', zone: 'Avant' }] } })).status).toBe(200);
    const conflit = await modifier(bien.id, id, { version: v, claim: { damages: [{ id: 'd2', zone: 'Arrière' }] } });
    expect(conflit.status).toBe(409);
    expect(((conflit.body.details as Json).current as Json).claim).toMatchObject({ damages: [{ id: 'd1', zone: 'Avant' }] });
    expect((await modifier(bien.id, id, { claim: { statusDetail: 'Expert passé' } })).status).toBe(200);
    expect((await modifier(bien.id, id, { claim: { damages: [] } })).status).toBe(422);
  });

  // ══ Rapprochement des documents (T3) ══════════════════════════════════════

  it('O5-E10 / C19 / F-040 — sinistre établi par un courrier (réf. SIN-42) puis saisi avec la même référence → UNE seule CLAIM, la saisie prime', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    await document(compte, maison.id, [cand({ typeHint: 'CLAIM', sourceRoleHint: 'CLAIM_DOCUMENT', provider: 'Assur', summary: 'Sinistre', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'CLAIM', value: 'SIN-42' }], temporalHints: { realizedDate: '2026-03-11' } })]);
    await passerDocs(compte);
    expect(await claims(compte)).toHaveLength(1);
    connecter(compte);
    // La liste montre déjà le sinistre documentaire (préremplissage 15.2).
    expect(((await lister(maison.id)).body.claims as Json[])).toEqual([expect.objectContaining({ documented: true, occurredOn: '2026-03-11' })]);
    const c = await creer(maison.id, { claim: { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', insurerClaimRef: 'sin 42' } });
    const actives = (await claims(compte)).filter((x) => x.invalidated_at === null);
    expect(actives.map((x) => x.id)).toEqual([c.body.id]);
    expect(actives[0].realized_date).toBe('2026-03-12');
    expect(await details(c.body.id as number)).toMatchObject({ insurer_claim_ref: 'sin 42' });
    expect(await sql`SELECT source_kind FROM business_operation_sources WHERE operation_id = ${c.body.id as number} AND active ORDER BY source_kind`)
      .toEqual([{ source_kind: 'CLAIM_FORM' }, { source_kind: 'DOCUMENT' }]);
    // Repasse T3 : aucun doublon, la saisie reste.
    await passerDocs(compte);
    expect((await claims(compte)).filter((x) => x.invalidated_at === null)).toHaveLength(1);
    expect(await details(c.body.id as number)).toMatchObject({ insurer_claim_ref: 'sin 42', claim_type: 'DEGAT_DES_EAUX' });
    await invariants(compte);
  });

  // ══ Suppression (annulation) ══════════════════════════════════════════════

  it('O5-E11 / F-088 / F-089 — suppression : sans preuve → invalidée (disparaît) ; établie par un document → reste', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    connecter(compte);
    const seul = await creer(maison.id, { claim: { claimType: 'VOL', occurredOn: '2026-01-01', compensationCents: 5000 } });
    const r = await supprimer(maison.id, seul.body.id as number);
    expect(r.body).toEqual({ removed: true, remains: false });
    expect((await claims(compte))[0].invalidated_at).not.toBeNull();
    expect((await lister(maison.id)).body.claims).toEqual([]);
    await document(compte, maison.id, [cand({ typeHint: 'CLAIM', sourceRoleHint: 'CLAIM_DOCUMENT', summary: 'Constat', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'CLAIM', value: 'SIN-9' }], temporalHints: { realizedDate: '2026-05-01' } })]);
    await passerDocs(compte);
    const doc = (await claims(compte)).find((x) => x.invalidated_at === null)!;
    await modifier(maison.id, doc.id, { claim: { claimType: 'INCENDIE' } });
    const r2 = await supprimer(maison.id, doc.id);
    expect(r2.body).toEqual({ removed: true, remains: true });
    expect((await claims(compte)).find((x) => x.id === doc.id)!.invalidated_at).toBeNull();
    await invariants(compte);
  });

  it('O5-E12 / F-187 / lot 39 — suppression d\'un bien : sinistre multi-biens conservé avec l\'autre bien ; mono-bien invalidé', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    connecter(compte);
    const multi = await creer(maison.id, { assetIds: [maison.id, garage.id], claim: { claimType: 'EVENEMENT_CLIMATIQUE', occurredOn: '2026-06-01' } });
    const mono = await creer(garage.id, { claim: { claimType: 'VOL', occurredOn: '2026-07-01' } });
    const { deleteAssetCompletely } = await import('@/services/assets/asset-deletion.service');
    await deleteAssetCompletely({ id: garage.id });
    const etat = await claims(compte);
    expect(etat.find((x) => x.id === multi.body.id)!.invalidated_at).toBeNull();
    expect(etat.find((x) => x.id === mono.body.id)!.invalidated_at).not.toBeNull();
    expect(await sql`SELECT asset_id FROM business_operation_asset_links WHERE operation_id = ${multi.body.id as number} AND active`).toEqual([{ asset_id: maison.id }]);
    await invariants(compte);
  });

  // ══ Agenda (claimEventKey) ════════════════════════════════════════════════

  it('O5-E13 / F-147 / C14 — événement d\'agenda lié : business_operation_id posé, aucun élément créé ; déjà lié à un autre sinistre → refusé', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const evt = await make.agendaItem(compte, { title: 'Sinistre — dégât des eaux', startDate: '2026-03-12', assetIds: [maison.id] });
    connecter(compte);
    const n = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`)[0].n;
    const a = await creer(maison.id, { claim: { claimType: 'DEGAT_DES_EAUX', claimEventKey: `agenda:${evt.id}` } });
    expect(a.status).toBe(201);
    expect(await sql`SELECT business_operation_id::int AS op FROM agenda_items WHERE id = ${evt.id}`).toEqual([{ op: a.body.id }]);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`)[0].n).toBe(n);
    expect((a.body.claim as Json).claimEventKey).toBe(`agenda:${evt.id}`);
    const b = await creer(maison.id, { claim: { claimType: 'VOL', claimEventKey: `agenda:${evt.id}` } });
    expect(b.status).toBe(422);
    // Délié : plus d'ancre, l'élément reste.
    await modifier(maison.id, a.body.id as number, { claim: { claimEventKey: null } });
    expect(await sql`SELECT business_operation_id FROM agenda_items WHERE id = ${evt.id}`).toEqual([{ business_operation_id: null }]);
  });

  // ══ Migration C14.3 ═══════════════════════════════════════════════════════

  async function ancienneSaisie(compte: AccountRow, assetId: number, claim: Json) {
    await sql`INSERT INTO asset_additional_infos (asset_id, account_id, claim_json, version) VALUES (${assetId}, ${compte.id}, ${JSON.stringify(claim)}::jsonb, 3)
              ON CONFLICT (asset_id) DO UPDATE SET claim_json = EXCLUDED.claim_json`;
  }
  const migration = () => import('@/services/business-operations/consolidation/claim-migration');

  it('O5-E14 / C14.3 / F-180 — migration : ancien formulaire complet → sinistre (détails, listes, pièces, photos, indemnité, agenda lié), source MIGRATION', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    const piece = await make.assetFile(compte, { assetId: maison.id });
    const photoFile = await make.assetFile(compte, { assetId: maison.id, mimeType: 'image/jpeg' });
    const [photo] = await sql<{ id: number }[]>`INSERT INTO asset_photos (asset_id, user_id, file_id) VALUES (${maison.id}, ${compte.ownerUserId}, ${photoFile.id}) RETURNING id`;
    const evt = await make.agendaItem(compte, { title: 'Dégât des eaux', startDate: '2026-03-12', assetIds: [maison.id] });
    const agendaAvant = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`)[0].n;
    await ancienneSaisie(compte, maison.id, {
      claimEventKey: `agenda:${evt.id}`, claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', declaredOn: '2026-03-13', insurerClaimRef: 'SIN-2026-88',
      status: 'EXPERTISE_PREVUE', circumstances: 'Fuite du ballon', estimatedDamageCents: 420000, compensationCents: 100000,
      damages: [{ id: 'r1', zone: 'Cuisine', photoIds: [photo.id], documentIds: [piece.id] }],
      actions: [{ id: 'r2', title: 'Séchage', invoiceDocumentId: piece.id }],
      exchanges: [{ id: 'r3', date: '2026-03-14', summary: 'Convocation expert' }],
    });
    const m = await migration();
    const r = await m.runClaimMigration({ apply: true, accountId: compte.id, today: AUJOURDHUI });
    expect(r.failed).toEqual([]);
    expect(r.outcomes).toEqual({ CREATED: 1 });
    const [op] = await claims(compte);
    expect(op).toMatchObject({ status: 'REALIZED', realized_date: '2026-03-12' });
    expect(await details(op.id)).toMatchObject({ claim_type: 'DEGAT_DES_EAUX', insurer_claim_ref: 'SIN-2026-88', status: 'EXPERTISE_PREVUE', estimated_damage_minor: 420000 });
    expect(await composantes(op.id)).toEqual([{ kind: 'INDEMNITY', amount_minor: 100000, target_asset_id: maison.id }]);
    expect(await sql`SELECT source_kind, authority, source_entity_key FROM business_operation_sources WHERE operation_id = ${op.id} AND active`)
      .toEqual([{ source_kind: 'MIGRATION', authority: 'USER', source_entity_key: `claim_json:C14.3-v1:a${compte.id}:b${maison.id}` }]);
    expect(await sql`SELECT dd.file_id FROM business_operation_claim_damage_documents dd JOIN business_operation_claim_damages d ON d.id = dd.damage_id WHERE d.operation_id = ${op.id}`).toEqual([{ file_id: piece.id }]);
    expect(await sql`SELECT dp.photo_id FROM business_operation_claim_damage_photos dp JOIN business_operation_claim_damages d ON d.id = dp.damage_id WHERE d.operation_id = ${op.id}`).toEqual([{ photo_id: photo.id }]);
    expect(await sql`SELECT invoice_file_id FROM business_operation_claim_actions WHERE operation_id = ${op.id}`).toEqual([{ invoice_file_id: piece.id }]);
    // claimEventKey → lien, jamais un doublon d'agenda.
    expect(await sql`SELECT business_operation_id::int AS op FROM agenda_items WHERE id = ${evt.id}`).toEqual([{ op: op.id }]);
    expect((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`)[0].n).toBe(agendaAvant);
    // Rejouée : 0 changement, aucun historique.
    const h = await historique(compte);
    const encore = await m.runClaimMigration({ apply: true, accountId: compte.id, today: AUJOURDHUI });
    expect(encore).toMatchObject({ scanned: 0, changes: 0 });
    expect(await historique(compte)).toBe(h);
    // Le miroir reflète le sinistre (forme du lot 43).
    expect(await legacy(maison.id)).toMatchObject({ claimType: 'DEGAT_DES_EAUX', claimEventKey: `agenda:${evt.id}`, compensationCents: 100000 });
    await invariants(compte);
  });

  it('O5-E15 / C14.3 — simulation : rapport exact, AUCUNE écriture ; seuil minimal : texte seul → rien créé, ancienne saisie lisible et reprenable', async () => {
    const compte = await make.account({ plan: 'standard' });
    const a = await make.asset(compte, { name: 'Avec type' });
    const b = await make.asset(compte, { name: 'Texte seul' });
    await ancienneSaisie(compte, a.id, { claimType: 'VOL' });
    await ancienneSaisie(compte, b.id, { circumstances: 'Rayure constatée', damages: [{ id: 'r1', zone: 'Portière' }] });
    const compter = async () => (await sql<{ n: number }[]>`
      SELECT ((SELECT count(*) FROM business_operations WHERE account_id = ${compte.id})
            + (SELECT count(*) FROM business_operation_history WHERE account_id = ${compte.id})
            + (SELECT count(*) FROM business_operation_claim_migration_marks WHERE account_id = ${compte.id}))::int AS n`)[0].n;
    const m = await migration();
    const avant = await compter();
    const json = await legacy(b.id);
    const sim = await m.runClaimMigration({ apply: false, accountId: compte.id, today: AUJOURDHUI });
    expect(sim.outcomes).toEqual({ CREATED: 1, BELOW_THRESHOLD: 1 });
    expect(await compter()).toBe(avant);
    const app = await m.runClaimMigration({ apply: true, accountId: compte.id, today: AUJOURDHUI });
    expect(app.outcomes).toEqual(sim.outcomes);
    expect(app.holds).toEqual([expect.objectContaining({ assetId: b.id, outcome: 'BELOW_THRESHOLD' })]);
    expect(await claims(compte)).toHaveLength(1);
    // Sous le seuil : JSON intact (jamais écrasé par le miroir), lecture legacy dans la fiche.
    expect(await legacy(b.id)).toEqual(json);
    connecter(compte);
    const l = await lister(b.id);
    expect(l.body.claims).toEqual([]);
    expect(l.body.legacy).toMatchObject({ reason: 'BELOW_THRESHOLD', claim: { circumstances: 'Rayure constatée' } });
    // Reprise explicite (« Reprendre en sinistre ») : sans seuil.
    const repris = await creer(b.id, { resumeLegacy: true });
    expect(repris.status).toBe(201);
    expect((repris.body.claim as Json)).toMatchObject({ circumstances: 'Rayure constatée', damages: [{ id: 'r1', zone: 'Portière' }] });
    expect((await lister(b.id)).body.legacy).toBeNull();
  });

  it('O5-E16 / C14.3 étape 21 — ancienne saisie avec la référence d\'un sinistre documentaire → rapprochée (MATCHED), jamais dupliquée', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    await document(compte, maison.id, [cand({ typeHint: 'CLAIM', sourceRoleHint: 'CLAIM_DOCUMENT', summary: 'Courrier assureur', targetHints: [cible(maison.id)], businessReferences: [{ kind: 'CLAIM', value: 'SIN-7' }], temporalHints: { realizedDate: '2026-02-01' } })]);
    await passerDocs(compte);
    await ancienneSaisie(compte, maison.id, { claimType: 'INCENDIE', insurerClaimRef: 'SIN-7', circumstances: 'Court-circuit' });
    const r = await (await migration()).runClaimMigration({ apply: true, accountId: compte.id, today: AUJOURDHUI });
    expect(r.outcomes).toEqual({ MATCHED: 1 });
    const actives = (await claims(compte)).filter((x) => x.invalidated_at === null);
    expect(actives).toHaveLength(1);
    // Saisie prioritaire, date documentaire conservée.
    expect(await details(actives[0].id)).toMatchObject({ claim_type: 'INCENDIE', circumstances: 'Court-circuit', insurer_claim_ref: 'SIN-7' });
    expect(actives[0].realized_date).toBe('2026-02-01');
  });

  // ══ Compatibilité (Q11) ═══════════════════════════════════════════════════

  it('O5-E17 / Q11 — miroir claim_json = sinistre le plus récent ; suppression → suivant ; écriture d\'un ANCIEN client → reportée sur le sinistre', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte, { category: 'IMMOBILIER' });
    connecter(compte);
    const ancien = await creer(bien.id, { claim: { claimType: 'VOL', occurredOn: '2025-01-01' } });
    const recent = await creer(bien.id, { claim: { claimType: 'INCENDIE', occurredOn: '2026-01-01', compensationCents: 9900 } });
    expect(await legacy(bien.id)).toMatchObject({ claimType: 'INCENDIE', occurredOn: '2026-01-01', compensationCents: 9900 });
    // Le formulaire « Préparation des dossiers » garde sa version (le miroir ne la change pas).
    expect(await sql`SELECT version FROM asset_additional_infos WHERE asset_id = ${bien.id}`).toEqual([{ version: 1 }]);
    await supprimer(bien.id, recent.body.id as number);
    expect(await legacy(bien.id)).toMatchObject({ claimType: 'VOL', occurredOn: '2025-01-01' });
    // Ancien client (lot 43) : PATCH de la sous-rubrique `claim` de l'ancienne route.
    const { PATCH } = await import('@/app/api/assets/[id]/additional-infos/route');
    const r = await PATCH(req('PATCH', `/api/assets/${bien.id}/additional-infos`, { claim: { statusDetail: 'Plainte déposée' } }), { params: Promise.resolve({ id: String(bien.id) }) });
    expect(r.status).toBe(200);
    expect(await details(ancien.body.id as number)).toMatchObject({ status_detail: 'Plainte déposée', claim_type: 'VOL' });
    expect(await sql`SELECT outcome FROM business_operation_claim_migration_marks WHERE asset_id = ${bien.id}`).toEqual([{ outcome: 'RESYNCED' }]);
    expect((await (await migration()).runClaimMigration({ apply: true, accountId: compte.id })).scanned).toBe(0);
  });

  // ══ Export Assurance-sinistre ═════════════════════════════════════════════

  it('O5-E18 / F-157 / Q2 / Q3 — export : choix du sinistre, présélection depuis sa date, montants imprimés, snapshot figé ; Standard refusé', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    connecter(compte);
    const a = await creer(maison.id, { claim: { claimType: 'VOL', occurredOn: '2025-05-01' } });
    const b = await creer(maison.id, { claim: { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12', estimatedDamageCents: 350000, compensationCents: 120000 } });
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const defaut = await loadExportSource({ assetId: maison.id, accountId: compte.id, userId: compte.ownerUserId, exportType: 'ASSURANCE_SINISTRE' });
    expect(defaut.claim).toMatchObject({ selectedOperationId: b.body.id, origin: 'operation' });
    expect(defaut.claim!.options.map((o) => o.id)).toEqual([b.body.id, a.body.id]);
    expect(defaut.additionalInfo.claim).toMatchObject({ claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-03-12' });
    const choisi = await loadExportSource({ assetId: maison.id, accountId: compte.id, userId: compte.ownerUserId, exportType: 'ASSURANCE_SINISTRE', claimOperationId: a.body.id as number });
    expect(choisi.additionalInfo.claim).toMatchObject({ claimType: 'VOL', occurredOn: '2025-05-01' });
    // Montants imprimés (mappeur).
    const { buildDefaultChoices, planSelection } = await import('@/services/exports/v12/data/choices');
    const { mapDossierData } = await import('@/services/exports/v12/data/mappers');
    const plan = planSelection('ASSURANCE_SINISTRE', defaut, buildDefaultChoices('ASSURANCE_SINISTRE', defaut, { today: AUJOURDHUI }), AUJOURDHUI);
    const meta = { reference: 'R', generatedAt: `${AUJOURDHUI}T00:00:00+00:00`, preparedBy: null, templateLabel: '', zipName: null, label: '' };
    const data = mapDossierData('ASSURANCE_SINISTRE', { source: defaut, plan, resolved: null, meta, today: AUJOURDHUI }) as { claim: Json };
    expect(data.claim).toMatchObject({ typeLabel: 'Dégât des eaux', estimatedDamage: expect.stringMatching(/3\s?500/), compensation: expect.stringMatching(/1\s?200/) });
    // Préparation : choix exposé ; génération : sinistre figé dans la demande.
    const { prepareDossier } = await import('@/services/exports/v12/preparation/load');
    const { findAccessibleAssetForExport } = await import('@/services/exports/export-access');
    const acces = (await findAccessibleAssetForExport({ userId: compte.ownerUserId, currentAccountId: compte.id } as never, maison.id))!;
    const p = await prepareDossier({ asset: acces, userId: compte.ownerUserId, body: { exportType: 'ASSURANCE_SINISTRE', claimOperationId: a.body.id } });
    expect(p.ok && p.body.claim).toMatchObject({ selectedOperationId: a.body.id, origin: 'operation' });
    const { enqueueGeneration } = await import('@/services/exports/v12/generation/enqueue');
    const g = await enqueueGeneration({ asset: acces, userId: compte.ownerUserId, code: 'ASSURANCE_SINISTRE', body: { choices: { outputFormat: 'PDF', claimOperationId: a.body.id } } });
    expect(g.ok).toBe(true);
    const [snap] = await sql<{ s: Json }[]>`SELECT snapshot_json AS s FROM export_generation WHERE asset_id = ${maison.id} ORDER BY id DESC LIMIT 1`;
    expect((snap.s.request as Json).claimOperationId ?? ((snap.s.request as Json).choices as Json).claimOperationId).toBe(a.body.id);
    // Standard : saisie permise, export refusé (Premium).
    const std = await make.account({ plan: 'standard' });
    const velo = await make.asset(std, { name: 'Vélo' });
    connecter(std);
    expect((await creer(velo.id, { claim: { claimType: 'VOL', occurredOn: '2026-01-01' } })).status).toBe(201);
    const accesStd = (await findAccessibleAssetForExport({ userId: std.ownerUserId, currentAccountId: std.id } as never, velo.id))!;
    const refus = await prepareDossier({ asset: accesStd, userId: std.ownerUserId, body: { exportType: 'ASSURANCE_SINISTRE' } });
    expect(refus).toMatchObject({ ok: false, status: 403 });
  });

  it('O5-E19 / Q11 — export sans sinistre : lecture de l\'ancienne saisie (compatibilité)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const bien = await make.asset(compte);
    await ancienneSaisie(compte, bien.id, { circumstances: 'Choc en stationnement' });
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    const s = await loadExportSource({ assetId: bien.id, accountId: compte.id, userId: compte.ownerUserId, exportType: 'ASSURANCE_SINISTRE' });
    expect(s.claim).toMatchObject({ selectedOperationId: null, origin: 'legacy' });
    expect(s.additionalInfo.claim).toMatchObject({ circumstances: 'Choc en stationnement' });
  });
});
