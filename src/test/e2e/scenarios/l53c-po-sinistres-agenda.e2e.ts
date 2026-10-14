/**
 * Lot 53C — retour PO D10, D11, Q17, D14 — base PostgreSQL réelle.
 *
 *   PO-D10 : « Ajouter un sinistre » ne crée rien en base ; seule la première
 *            sauvegarde effective crée le sinistre (route de production) ;
 *   PO-D11 : facture retirée d'une action : rattachement conservé s'il reste
 *            justifié, sinon carte « garder / dissocier » — jamais de
 *            dissociation automatique ;
 *   PO-Q17 : bien retiré d'un sinistre : exclusion mémorisée ; un nouveau
 *            document qui le cite → carte de décision (document à l'origine),
 *            jamais de réintégration automatique ;
 *   PO-D14 : projection agenda incertaine → carte « À traiter » avec
 *            candidats et provenance, actionnable, jamais dupliquée.
 *
 * Écritures par les routes / services de production (session simulée),
 * candidats documentaires par la persistance T1 réelle, consolidation et
 * projection par les moteurs de production. Aucun appel IA.
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
    summary: 'Recherche de fuite', sourceRoleHint: 'INVOICE', provider: 'Plombier Martin',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: 'TOTAL', economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1' }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });

type Json = Record<string, unknown>;

scenario('L53C-D10-D14', 'Sinistres (brouillon, dissociation, exclusion) et agenda incertain : décisions utilisateur', ({ sql, make }) => {
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
  async function creer(assetId: number, body: Json = {}) {
    const r = await (await routeList()).POST(req('POST', `/api/assets/${assetId}/claims`, body), { params: Promise.resolve({ id: String(assetId) }) });
    return { status: r.status, body: await r.json() as Json };
  }
  async function modifier(assetId: number, claimId: number, body: Json) {
    const r = await (await routeOne()).PATCH(req('PATCH', `/api/assets/${assetId}/claims/${claimId}`, body), { params: Promise.resolve({ id: String(assetId), claimId: String(claimId) }) });
    return { status: r.status, body: await r.json() as Json };
  }
  async function document(compte: AccountRow, assetId: number, candidats: AnchoredOperationCandidate[], titre?: string) {
    const f = await make.assetFile(compte, { assetId });
    if (titre) await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    const [x] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${f.id}) RETURNING id`;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, { accountId: compte.id, fileId: f.id, extractionId: x.id, analysisRunId: null, reanalysis: false, candidates: candidats, facts: new Map() });
    });
    return f.id;
  }
  const passer = async (compte: AccountRow, opts: { reevaluateHolds?: boolean } = {}) =>
    (await import('@/services/business-operations/consolidation/consolidator')).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, operationMatch: false, ...opts });
  const cartes = (compte: AccountRow, rule: string) => sql<{ id: number; public_id: string; target_type: string; target_id: number; relation_key: string; question: string; proposals_json: Array<{ value: string; label: string; isCurrentValue?: boolean }>; trigger_context: Json; resolved_at: string | null; resolution_reason: string | null }[]>`
    SELECT id, public_id, target_type, target_id, relation_key, question, proposals_json, trigger_context, resolved_at::text AS resolved_at, resolution_reason
      FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = ${rule} ORDER BY id`;
  const ouvertes = async (compte: AccountRow, rule: string) => (await cartes(compte, rule)).filter((c) => c.resolved_at === null);
  const resoudre = async (compte: AccountRow, publicId: string, value: string) => {
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    return resolveArbitration(compte.id, publicId, value, { userId: compte.ownerUserId });
  };
  const liens = async (opId: number) => (await sql<{ a: number }[]>`
    SELECT asset_id AS a FROM business_operation_asset_links WHERE operation_id = ${opId} AND active ORDER BY 1`).map((x) => x.a);
  const parent = async (opId: number) => (await sql<{ p: number | null }[]>`SELECT parent_operation_id::int AS p FROM business_operations WHERE id = ${opId}`)[0].p;

  // ══ D10 ════════════════════════════════════════════════════════════════════

  it('PO-D10-04 — brouillon : un envoi vide ne crée RIEN en base (422) ; la première saisie effective crée le sinistre (201)', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    connecter(compte);
    const compter = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operations WHERE account_id = ${compte.id}`)[0].n;
    for (const corps of [{}, { claim: {} }, { claim: { claimType: null, occurredOn: null } }, { assetIds: [maison.id] }]) {
      const r = await creer(maison.id, corps);
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ code: 'EMPTY_CLAIM' });
    }
    expect(await compter()).toBe(0);
    expect(await sql`SELECT 1 FROM business_operation_history WHERE account_id = ${compte.id}`).toHaveLength(0);
    const ok = await creer(maison.id, { claim: { claimType: 'DEGAT_DES_EAUX' }, assetIds: [maison.id] });
    expect(ok.status).toBe(201);
    expect(await compter()).toBe(1);
  });

  // ══ D11 ════════════════════════════════════════════════════════════════════

  async function sinistreAvecFacture(compte: AccountRow, maison: number, over: Partial<AnchoredOperationCandidate> = {}) {
    const facture = await document(compte, maison, [cand({ targetHints: [cible(maison)], temporalHints: { realizedDate: '2026-07-10' }, financialHints: [fh('REALIZED_COST', 30000)], ...over })], 'Facture plombier');
    await passer(compte);
    const [inter] = await sql<{ id: number }[]>`SELECT id::int AS id FROM business_operations WHERE account_id = ${compte.id} AND type_code = 'INTERVENTION'`;
    const c = await creer(maison, { claim: { claimType: 'DEGAT_DES_EAUX', occurredOn: '2026-07-01', actions: [{ id: 'a1', title: 'Recherche de fuite', invoiceDocumentId: facture }] }, version: 0 });
    expect(c.status).toBe(201);
    const id = c.body.id as number;
    expect(await parent(inter.id)).toBe(id);
    return { facture, inter: inter.id, claim: id, version: c.body.version as number };
  }

  it('PO-D11-03 — facture retirée sans autre justification : rattachement CONSERVÉ, carte « garder / dissocier » ; « Dissocier » → plus de parent ; annulation → rétabli', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    connecter(compte);
    const s = await sinistreAvecFacture(compte, maison.id);
    const r = await modifier(maison.id, s.claim, { claim: { actions: [{ id: 'a1', title: 'Recherche de fuite' }] }, version: s.version });
    expect(r.status).toBe(200);
    // Jamais de dissociation automatique.
    expect(await parent(s.inter)).toBe(s.claim);
    const [carte, ...autres] = await ouvertes(compte, 'OPERATION-CLAIM-DETACH');
    expect(autres).toEqual([]);
    expect(carte).toMatchObject({ target_type: 'DOCUMENT', target_id: s.facture, relation_key: `operationDetach:${s.inter}` });
    expect(carte.question).toContain('fait-elle toujours suite');
    expect(carte.proposals_json.map((p) => p.value)).toEqual(['DETACH', 'KEEP']);
    // Passage T3 suivant : la même carte, jamais une seconde.
    await passer(compte, { reevaluateHolds: true });
    await (await import('@/services/business-operations/consolidation/consolidator')).reconsolidateOperations(compte.id, [s.inter]);
    expect(await ouvertes(compte, 'OPERATION-CLAIM-DETACH')).toHaveLength(1);
    expect(await resoudre(compte, carte.public_id, 'DETACH')).toMatchObject({ ok: true });
    expect(await parent(s.inter)).toBeNull();
    expect(await sql`SELECT 1 FROM business_operation_history WHERE operation_id = ${s.inter} AND reason_code = 'USER_CLAIM_DETACHED'`).toHaveLength(2);
    // Plus reproposé : la décision « aucun sinistre » est durable.
    await (await import('@/services/business-operations/consolidation/consolidator')).reconsolidateOperations(compte.id, [s.inter]);
    expect(await ouvertes(compte, 'OPERATION-CLAIM-DETACH')).toEqual([]);
    expect(await parent(s.inter)).toBeNull();
    // Annulation : le rattachement est rétabli.
    const { undoArbitration } = await import('@/services/to-process/resolve-action.service');
    expect(await undoArbitration(compte.id, carte.public_id, null)).toMatchObject({ ok: true });
    expect(await parent(s.inter)).toBe(s.claim);
  });

  it('PO-D11-04 — facture retirée mais rattachement justifié (référence de sinistre commune) : conservé, aucune carte ; « Garder » : décision durable', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER' });
    connecter(compte);
    const s = await sinistreAvecFacture(compte, maison.id, { businessReferences: [{ kind: 'CLAIM', value: 'SIN-42' }] });
    const v = await modifier(maison.id, s.claim, { claim: { insurerClaimRef: 'SIN-42' } });
    const r = await modifier(maison.id, s.claim, { claim: { actions: [{ id: 'a1', title: 'Recherche de fuite' }] }, version: v.body.version });
    expect(r.status).toBe(200);
    expect(await parent(s.inter)).toBe(s.claim);
    expect(await ouvertes(compte, 'OPERATION-CLAIM-DETACH')).toEqual([]);

    // Sans référence commune : carte, puis « Garder » — plus jamais reposée.
    const compte2 = await make.account({ plan: 'standard' });
    const maison2 = await make.asset(compte2, { category: 'IMMOBILIER' });
    connecter(compte2);
    const s2 = await sinistreAvecFacture(compte2, maison2.id);
    await modifier(maison2.id, s2.claim, { claim: { actions: [{ id: 'a1', title: 'Recherche de fuite' }] }, version: s2.version });
    const [carte] = await ouvertes(compte2, 'OPERATION-CLAIM-DETACH');
    expect(await resoudre(compte2, carte.public_id, 'KEEP')).toMatchObject({ ok: true });
    expect(await parent(s2.inter)).toBe(s2.claim);
    await (await import('@/services/business-operations/consolidation/consolidator')).reconsolidateOperations(compte2.id, [s2.inter]);
    expect(await ouvertes(compte2, 'OPERATION-CLAIM-DETACH')).toEqual([]);
    expect(await sql`SELECT 1 FROM business_operation_sources WHERE operation_id = ${s2.inter} AND active AND source_kind = 'USER_ARBITRATION'
                      AND locator->>'decision' = 'CLAIM_PARENT' AND (locator->>'parentOperationId')::bigint = ${s2.claim}`).toHaveLength(1);
  });

  // ══ Q17 ════════════════════════════════════════════════════════════════════

  it('PO-Q17-04 — bien retiré : exclusion mémorisée ; documents connus sans carte ; NOUVEAU document → carte avec le document à l\'origine ; jamais de réintégration automatique', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    connecter(compte);
    const c = await creer(maison.id, { claim: { claimType: 'EVENEMENT_CLIMATIQUE', occurredOn: '2026-06-01', insurerClaimRef: 'TEMP-26' }, assetIds: [maison.id, garage.id] });
    const claim = c.body.id as number;
    const claimDoc = (titre: string, assets: number[]) => document(compte, maison.id, [cand({
      typeHint: 'CLAIM', sourceRoleHint: 'CLAIM_DOCUMENT', summary: 'Tempête', provider: 'Assureur', targetHints: assets.map(cible),
      businessReferences: [{ kind: 'CLAIM', value: 'TEMP-26' }], temporalHints: { realizedDate: '2026-06-01' },
    })], titre);
    const constat = await claimDoc('Constat tempête', [maison.id, garage.id]);
    await passer(compte);
    expect(await liens(claim)).toEqual([maison.id, garage.id].sort((a, b) => a - b));

    // L'utilisateur retire le garage.
    expect((await modifier(maison.id, claim, { assetIds: [maison.id] })).status).toBe(200);
    expect(await liens(claim)).toEqual([maison.id]);
    const [ex] = await sql<{ asset_id: number; active: boolean; ack: number[] }[]>`
      SELECT asset_id, active, acknowledged_file_ids AS ack FROM business_operation_asset_exclusions WHERE operation_id = ${claim}`;
    expect(ex).toMatchObject({ asset_id: garage.id, active: true, ack: [constat] });
    // Le constat (connu au moment du retrait) ne réintègre pas le garage et ne produit pas de carte.
    await passer(compte, { reevaluateHolds: true });
    await (await import('@/services/business-operations/consolidation/consolidator')).reconsolidateOperations(compte.id, [claim]);
    expect(await liens(claim)).toEqual([maison.id]);
    expect(await ouvertes(compte, 'OPERATION-CLAIM-ASSET')).toEqual([]);

    // Nouveau document qui cite le garage (seul) : rattaché au sinistre, garage NON relié, carte de décision.
    const courrier = await claimDoc('Courrier assureur garage', [garage.id]);
    await passer(compte);
    expect(await liens(claim)).toEqual([maison.id]);
    const [carte, ...autres] = await ouvertes(compte, 'OPERATION-CLAIM-ASSET');
    expect(autres).toEqual([]);
    expect(carte).toMatchObject({ target_type: 'DOCUMENT', target_id: courrier, relation_key: `operationAssetExclusion:${claim}:${garage.id}` });
    expect(carte.question).toContain('« Garage »');
    expect(carte.trigger_context).toMatchObject({ fileIds: [courrier], documents: [{ fileId: courrier, title: 'Courrier assureur garage' }] });
    expect(carte.proposals_json.find((p) => p.isCurrentValue)?.value).toBe('KEEP_EXCLUDED');
    // Pas de doublon au passage suivant.
    await passer(compte, { reevaluateHolds: true });
    await (await import('@/services/business-operations/consolidation/consolidator')).reconsolidateOperations(compte.id, [claim]);
    expect(await ouvertes(compte, 'OPERATION-CLAIM-ASSET')).toHaveLength(1);

    // « Il reste hors du sinistre » : mémorisé pour CE document.
    expect(await resoudre(compte, carte.public_id, 'KEEP_EXCLUDED')).toMatchObject({ ok: true });
    await (await import('@/services/business-operations/consolidation/consolidator')).reconsolidateOperations(compte.id, [claim]);
    expect(await ouvertes(compte, 'OPERATION-CLAIM-ASSET')).toEqual([]);
    expect(await liens(claim)).toEqual([maison.id]);

    // Un autre nouveau document → nouvelle carte ; « Le rattacher à nouveau » → garage relié, exclusion levée (tracée).
    await claimDoc('Expertise garage', [garage.id]);
    await passer(compte);
    const [carte2] = await ouvertes(compte, 'OPERATION-CLAIM-ASSET');
    expect(carte2).toBeDefined();
    expect(await resoudre(compte, carte2.public_id, 'REINSTATE')).toMatchObject({ ok: true });
    expect(await liens(claim)).toEqual([maison.id, garage.id].sort((a, b) => a - b));
    expect(await sql`SELECT 1 FROM business_operation_asset_exclusions WHERE operation_id = ${claim} AND active`).toHaveLength(0);
    expect(await sql`SELECT release_reason FROM business_operation_asset_exclusions WHERE operation_id = ${claim}`).toEqual([{ release_reason: 'USER_CLAIM_ASSET_REINSTATED' }]);
  });

  it('PO-Q17-05 — re-cocher le bien dans le formulaire lève l\'exclusion (nouvel arbitrage) ; sans document, rien d\'autre ne change', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    connecter(compte);
    const c = await creer(maison.id, { claim: { claimType: 'VOL', occurredOn: '2026-01-01' }, assetIds: [maison.id, garage.id] });
    const claim = c.body.id as number;
    await modifier(maison.id, claim, { assetIds: [maison.id] });
    expect(await sql`SELECT 1 FROM business_operation_asset_exclusions WHERE operation_id = ${claim} AND active`).toHaveLength(1);
    await modifier(maison.id, claim, { assetIds: [maison.id, garage.id] });
    expect(await sql`SELECT release_reason FROM business_operation_asset_exclusions WHERE operation_id = ${claim}`).toEqual([{ release_reason: 'CLAIM_FORM_ASSET_READDED' }]);
    expect(await liens(claim)).toEqual([maison.id, garage.id].sort((a, b) => a - b));
  });

  // ══ D14 ════════════════════════════════════════════════════════════════════

  async function interventionEtDeuxEvenements(compte: AccountRow) {
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f = await make.assetFile(compte, { assetId: maison.id });
    await sql`UPDATE asset_files SET retained_title = 'Facture chauffagiste' WHERE id = ${f.id}`;
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const op = (await withBusinessOperationWrite(compte.id, (repo) => repo.create({
      type: { code: 'INTERVENTION' }, status: 'REALIZED', realizedDate: '2026-03-10', technicalLabel: 'Remplacement chaudière',
      source: { kind: 'DOCUMENT', entityKey: f.id, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain' },
      assets: [{ assetId: maison.id, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'E2E',
    }))).id;
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const a = await createAgendaItem({ title: 'Entretien', startDate: '2026-03-10', assetIds: [maison.id], homeCategory: 'information' }, compte.id, compte.ownerUserId);
    const b = await createAgendaItem({ title: 'Réparation', startDate: '2026-03-10', assetIds: [maison.id], homeCategory: 'information' }, compte.id, compte.ownerUserId);
    return { maison, f: f.id, op, a: a.id, b: b.id };
  }
  const projeter = async (compte: AccountRow, ids: number[]) =>
    (await import('@/services/business-operations/agenda-projection/service')).projectAccountOperations(compte.id, { operationIds: ids, correlationId: 'e2e' });
  const items = (compte: AccountRow) => sql<{ id: number; title: string; op: number | null; projection_origin: string | null; manual_status: string | null }[]>`
    SELECT id, title, business_operation_id::int AS op, projection_origin, manual_status FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`;

  it('PO-D14-06 / F-147 — doute entre deux événements : ni lien ni doublon, carte avec les candidats et la provenance ; non dupliquée ; « Oui, celui-ci » → lien, carte résolue, plus reposée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const x = await interventionEtDeuxEvenements(compte);
    const r = await projeter(compte, [x.op]);
    expect(r).toMatchObject({ created: 0, linked: 0, abstained: 1, matchCards: 1 });
    expect((await items(compte)).map((i) => i.op)).toEqual([null, null]);
    const [carte, ...autres] = await ouvertes(compte, 'AGENDA-PROJECTION-MATCH');
    expect(autres).toEqual([]);
    expect(carte).toMatchObject({ target_type: 'ASSET', target_id: x.maison.id, relation_key: `agendaProjectionMatch:${x.op}:INTERVENTION` });
    expect(carte.question).toContain('« Facture chauffagiste »');
    expect(carte.proposals_json.map((p) => p.value)).toEqual([`ITEM:${x.a}`, `ITEM:${x.b}`, 'NEW']);
    expect(carte.trigger_context).toMatchObject({
      operationId: x.op, provenance: { documents: [{ fileId: x.f, title: 'Facture chauffagiste' }] },
      candidates: [expect.objectContaining({ itemId: x.a, reason: expect.any(String) }), expect.objectContaining({ itemId: x.b })],
    });
    // Passage suivant (T3 / balayage) : la MÊME carte, jamais une seconde, aucune hypothèse promue.
    await projeter(compte, [x.op]);
    await projeter(compte, [x.op]);
    expect(await cartes(compte, 'AGENDA-PROJECTION-MATCH')).toHaveLength(1);
    expect((await items(compte)).every((i) => i.op === null && i.manual_status === null)).toBe(true);
    // Choix de l'utilisateur : l'événement « Entretien » est celui-là.
    expect(await resoudre(compte, carte.public_id, `ITEM:${x.a}`)).toMatchObject({ ok: true });
    expect((await items(compte)).find((i) => i.id === x.a)).toMatchObject({ op: x.op, title: 'Entretien' });
    expect((await items(compte)).find((i) => i.id === x.b)).toMatchObject({ op: null });
    expect(await projeter(compte, [x.op])).toMatchObject({ created: 0, abstained: 0, matchCards: 0 });
    expect(await ouvertes(compte, 'AGENDA-PROJECTION-MATCH')).toEqual([]);
    expect(await items(compte)).toHaveLength(2);
  });

  it('PO-D14-07 — « Non, ajouter un nouvel événement » → UN événement projeté, aucun lien hasardeux ; « Ne rien ajouter » → suppression mémorisée ; carte fermée d\'elle-même si le doute disparaît', async () => {
    const compte = await make.account({ plan: 'premium' });
    const x = await interventionEtDeuxEvenements(compte);
    await projeter(compte, [x.op]);
    const [carte] = await ouvertes(compte, 'AGENDA-PROJECTION-MATCH');
    expect(await resoudre(compte, carte.public_id, 'NEW')).toMatchObject({ ok: true });
    const apres = await items(compte);
    expect(apres).toHaveLength(3);
    expect(apres.filter((i) => i.op === x.op)).toEqual([expect.objectContaining({ projection_origin: 'OPERATION', title: 'Remplacement chaudière' })]);
    expect(await projeter(compte, [x.op])).toMatchObject({ created: 0, changes: 0 });

    const compte2 = await make.account({ plan: 'premium' });
    const y = await interventionEtDeuxEvenements(compte2);
    await projeter(compte2, [y.op]);
    const [carte2] = await ouvertes(compte2, 'AGENDA-PROJECTION-MATCH');
    expect(await resoudre(compte2, carte2.public_id, 'NONE')).toMatchObject({ ok: true });
    expect(await sql`SELECT projection_key FROM business_operation_projection_suppressions WHERE operation_id = ${y.op}`).toEqual([{ projection_key: 'INTERVENTION' }]);
    expect(await projeter(compte2, [y.op])).toMatchObject({ created: 0, suppressed: 1 });
    expect(await ouvertes(compte2, 'AGENDA-PROJECTION-MATCH')).toEqual([]);

    // Le doute disparaît sans réponse (un des événements est supprimé) : carte fermée (OBSOLETE).
    const compte3 = await make.account({ plan: 'premium' });
    const z = await interventionEtDeuxEvenements(compte3);
    await projeter(compte3, [z.op]);
    expect(await ouvertes(compte3, 'AGENDA-PROJECTION-MATCH')).toHaveLength(1);
    await sql`UPDATE agenda_items SET manual_status = 'annule' WHERE id = ${z.b}`;
    await projeter(compte3, [z.op]);
    expect(await ouvertes(compte3, 'AGENDA-PROJECTION-MATCH')).toEqual([]);
    expect((await cartes(compte3, 'AGENDA-PROJECTION-MATCH'))[0]).toMatchObject({ resolution_reason: 'OBSOLETE' });
  });
});
