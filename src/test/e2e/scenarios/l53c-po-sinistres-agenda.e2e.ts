/**
 * Lot 53C — retour PO D10, D11, Q17, D14 — base PostgreSQL réelle.
 *
 *   PO-D10, PO-D11 : RETIRÉS au lot 83D (CDC v5 §15–§17, V-Q1, V-Q2) avec le
 *            formulaire « Sinistres » des biens, les actions et la hiérarchie
 *            parent / enfant (absence prouvée par L83D-E02 et L83D-U01…) ;
 *   PO-Q17 : bien retiré d'un sinistre (lot 83D : par le service unique de
 *            regroupement 82D) : exclusion mémorisée ; un nouveau
 *            document qui le cite → carte de décision (document à l'origine),
 *            jamais de réintégration automatique ;
 *   PO-D14 : projection agenda incertaine → carte « À traiter » avec
 *            candidats et provenance, actionnable, jamais dupliquée.
 *
 * Écritures par les services de production (session simulée),
 * candidats documentaires par la persistance T1 réelle, consolidation et
 * projection par les moteurs de production. Aucun appel IA.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
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
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });

type Json = Record<string, unknown>;

scenario('L53C-D10-D14', 'Sinistres (brouillon, dissociation, exclusion) et agenda incertain : décisions utilisateur', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  /** Sinistre tel qu'existant en préproduction (source CLAIM_FORM, lot 44) — lot 83D : plus de route de saisie. */
  async function creer(compte: AccountRow, assetIds: number[], d: { claimType: string; occurredOn: string; insurerClaimRef?: string }): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (r) => {
      const c = await r.create({
        type: { code: 'CLAIM' }, status: 'REALIZED', realizedDate: d.occurredOn,
        source: { kind: 'CLAIM_FORM', entityKey: assetIds[0], authority: 'USER', confidence: 'certain' },
        assets: assetIds.map((assetId, i) => ({ assetId, role: i === 0 ? 'PRIMARY' : 'CONCERNED', authority: 'USER' })), reasonCode: 'E2E',
      } as never);
      await r.upsertClaimDetails(c.id, { claimType: d.claimType, insurerClaimRef: d.insurerClaimRef ?? null } as never);
      if (d.insurerClaimRef) await r.addReference(c.id, { kind: 'CLAIM', value: d.insurerClaimRef, sourceId: c.sourceId }, 'E2E');
      return c.id;
    });
  }
  /** Bien retiré / ajouté par l'utilisateur : service unique de regroupement (82D). */
  async function bien(compte: AccountRow, operationId: number, assetId: number, action: 'retirer' | 'ajouter') {
    const g = await import('@/services/business-operations/grouping/service');
    return g.withGroupingWrite(compte.id, (ctx) => action === 'retirer'
      ? g.detachAsset(ctx, { operationId, assetId, origin: 'USER', reasonCode: 'USER_CLAIM_ASSET_REMOVED' })
      : g.attachAsset(ctx, { operationId, assetId, origin: 'USER', reasonCode: 'USER_CLAIM_ASSET_READDED' }), { actorUserId: compte.ownerUserId });
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

  // ══ Q17 ════════════════════════════════════════════════════════════════════

  it('PO-Q17-04 — bien retiré : exclusion mémorisée ; documents connus sans carte ; NOUVEAU document → carte avec le document à l\'origine ; jamais de réintégration automatique', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    const claim = await creer(compte, [maison.id, garage.id], { claimType: 'EVENEMENT_CLIMATIQUE', occurredOn: '2026-06-01', insurerClaimRef: 'TEMP-26' });
    const claimDoc = (titre: string, assets: number[]) => document(compte, maison.id, [cand({
      typeHint: 'CLAIM', sourceRoleHint: 'CLAIM_DOCUMENT', summary: 'Tempête', provider: 'Assureur', targetHints: assets.map(cible),
      businessReferences: [{ kind: 'CLAIM', value: 'TEMP-26' }], temporalHints: { realizedDate: '2026-06-01' },
    })], titre);
    const constat = await claimDoc('Constat tempête', [maison.id, garage.id]);
    await passer(compte);
    expect(await liens(claim)).toEqual([maison.id, garage.id].sort((a, b) => a - b));

    // L'utilisateur retire le garage.
    expect(await bien(compte, claim, garage.id, 'retirer')).toBe(true);
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

  it('PO-Q17-05 — ré-ajouter le bien (regroupement 82D) lève l\'exclusion (nouvel arbitrage) ; sans document, rien d\'autre ne change', async () => {
    const compte = await make.account({ plan: 'standard' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const garage = await make.asset(compte, { category: 'IMMOBILIER', name: 'Garage' });
    const claim = await creer(compte, [maison.id, garage.id], { claimType: 'VOL', occurredOn: '2026-01-01' });
    await bien(compte, claim, garage.id, 'retirer');
    expect(await sql`SELECT 1 FROM business_operation_asset_exclusions WHERE operation_id = ${claim} AND active`).toHaveLength(1);
    await bien(compte, claim, garage.id, 'ajouter');
    expect(await sql`SELECT release_reason FROM business_operation_asset_exclusions WHERE operation_id = ${claim}`).toEqual([{ release_reason: 'USER_CLAIM_ASSET_READDED' }]);
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

    // Le doute disparaît sans réponse (plus aucun candidat) : carte fermée (OBSOLETE).
    // Lot 87B : un candidat restant n'est plus rattaché sur de simples signaux (même bien, type, date) —
    // la carte reste posée tant qu'il reste un candidat ; elle se ferme quand il n'y en a plus.
    const compte3 = await make.account({ plan: 'premium' });
    const z = await interventionEtDeuxEvenements(compte3);
    await projeter(compte3, [z.op]);
    expect(await ouvertes(compte3, 'AGENDA-PROJECTION-MATCH')).toHaveLength(1);
    await sql`UPDATE agenda_items SET manual_status = 'annule' WHERE id = ${z.b}`;
    await projeter(compte3, [z.op]);
    expect(await ouvertes(compte3, 'AGENDA-PROJECTION-MATCH')).toHaveLength(1);
    await sql`UPDATE agenda_items SET manual_status = 'annule' WHERE id = ${z.a}`;
    await projeter(compte3, [z.op]);
    expect(await ouvertes(compte3, 'AGENDA-PROJECTION-MATCH')).toEqual([]);
    expect((await cartes(compte3, 'AGENDA-PROJECTION-MATCH'))[0]).toMatchObject({ resolution_reason: 'OBSOLETE' });
  });
});
