/**
 * Carte Trello #806 §4 — SCISSION ET REFUSION (AC46) : une scission MANUELLE
 * interdit durablement toute refusion AUTOMATIQUE des deux opérations, même
 * sur des preuves nouvelles ; refusion seulement sur décision explicite de
 * l'utilisateur. Sur PostgreSQL 16 réel, par les chemins de PRODUCTION : T1
 * persisté (`replaceOperationCandidates`), consolidation T3 d'un compte
 * (`consolidateAccountOperations`), façade d'écriture du graphe. Aucun appel à
 * un fournisseur d'IA (rapprochement sémantique désactivé : `operationMatch:
 * false`). Dates fixes.
 *
 *   L116C-S01  TÉMOIN : sans scission, une facture qui cite la référence de DEUX opérations les FUSIONNE (voie
 *              `T3_MERGE_COMMON_REFERENCE`) — le scénario provoque bien une fusion automatique
 *   L116C-S02  après une scission (qui ne déplace qu'un événement de l'Agenda, ensuite PARTAGÉ entre les deux : aucune
 *              décision de rapprochement ne protège plus la paire), la MÊME preuve nouvelle ne refusionne pas ; reprise et trois passes T3 successives,
 *              puis une SECONDE preuve nouvelle : toujours deux opérations ; rien n'est perdu ; graphe sans anomalie
 *   L116C-S03  la mémoire est DURABLE : dissociation puis nouvelle association de la paire (le motif de la relation
 *              est réécrit) → la paire reste non fusionnable ; la garde du dépôt refuse toute fusion automatique
 *              (les trois motifs de T3), sans rien écrire, abstention tracée UNE fois
 *   L116C-S04  la mémoire SUIT l'identité : l'opération issue de la scission est fusionnée par l'utilisateur avec une
 *              troisième → la paire (origine, troisième) est protégée à son tour
 *   L116C-S05  REFUSION EXPLICITE : la commande `mergeOperations` de la façade (utilisateur) réunit les deux
 *              opérations scindées ; une inférence (T3) qui l'appelle est refusée (USER_ONLY)
 *   L116C-S06  la scission CONTRÔLE et fait AVANCER la version de l'opération scindée : vue périmée → conflit, rien
 *              d'écrit ; même clé d'idempotence rejouée → même résultat, rien de plus ; journal des deux côtés
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJOURDHUI = '2026-10-12';
const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');
const facade = () => import('@/services/business-operations/operation-write.facade');

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Remplacement des plaquettes de frein', sourceRoleHint: 'INVOICE', provider: 'Garage Martin',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1' }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });

scenario('L116C-S', 'Opérations / Agenda #806 §4 — une scission manuelle n’est jamais refusionnée automatiquement (AC46)', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  const user = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const t3: (c: AccountRow) => OperationWriteContext = (c) => ({ accountId: c.id, actor: { kind: 'AI', treatment: 'T3' } });

  async function document(compte: AccountRow, assetId: number, candidats: AnchoredOperationCandidate[]): Promise<number> {
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
  const passer = async (compte: AccountRow) => (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, operationMatch: false });
  const actifs = async (compte: AccountRow) => (await sql<Json[]>`
    SELECT id::int AS id FROM business_operations
     WHERE account_id = ${compte.id} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY id`).map((o) => Number(o.id));
  const candidat = async (fileId: number) => (await sql<Json[]>`
    SELECT t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`)[0];
  const audit = async (compte: AccountRow) => {
    const { auditOperationGraph } = await import('@/services/business-operations/graph/store');
    const { postgresRunner } = await import('@/services/business-operations/grouping/runner');
    return auditOperationGraph(postgresRunner(sql as never), compte.id);
  };
  const porte = async (compte: AccountRow, ids: number[]) => {
    const { __loadNonMergeableForTests } = await consolidator();
    const { db } = await import('@/db');
    return [...await db.transaction((tx) => __loadNonMergeableForTests(tx as never, compte.id, ids))].sort();
  };
  const paire = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const sourcesActives = async (opId: number) => (await sql<Json[]>`
    SELECT source_entity_key AS k FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_kind = 'DOCUMENT' ORDER BY id`).map((s) => Number(s.k));

  /**
   * Une opération née d'un devis (référence D1), avec un événement de l'Agenda ; la scission ne déplace QUE cet
   * événement, que l'utilisateur partage ensuite entre les deux opérations : ni la règle « document retiré » (lot 84E)
   * ni la règle « confirmé ici, refusé là » (F-046) ne protègent donc la paire — vérifié par mutation : sans la mémoire
   * de la scission, L116C-S02 fusionne. L'ordre de travail OT9 est ensuite rattaché par l'utilisateur à l'opération
   * issue de la scission.
   */
  async function monter(compte: AccountRow, scinder: boolean) {
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const devis = await document(compte, clio.id, [cand({
      sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }],
      financialHints: [fh('FORECAST_COST', 30000)],
    })]);
    await passer(compte);
    const [origine] = await actifs(compte);
    const f = await facade();
    let seconde: number;
    if (scinder) {
      const etape = await make.agendaItem(compte, { title: 'Géométrie des trains', startDate: '2026-01-10', assetIds: [clio.id] });
      expect(await f.linkAgendaItem(user(compte), { operationId: origine, agendaItemId: etape.id, reasonCode: 'L116C_S' })).toMatchObject({ status: 'APPLIED' });
      const scission = await f.splitOperation(user(compte), { operationId: origine, label: 'Géométrie des trains', agendaItemIds: [etape.id], reasonCode: 'L116C_S' });
      expect(scission).toMatchObject({ status: 'APPLIED', changed: true });
      seconde = scission.data!.newOperationId;
      // L'utilisateur PARTAGE ensuite l'événement entre les deux opérations (lien N↔N) : son refus sur l'origine est levé.
      // Plus AUCUNE décision de rapprochement ne sépare la paire — seule la mémoire de la scission la protège.
      expect(await f.linkAgendaItem(user(compte), { operationId: origine, agendaItemId: etape.id, reasonCode: 'L116C_S' })).toMatchObject({ status: 'APPLIED', changed: true });
      expect(await sql`SELECT 1 FROM business_operation_match_decisions WHERE account_id = ${compte.id} AND decision = 'REJECTED' AND active`).toHaveLength(0);
    } else {
      // Témoin : une seconde opération créée par déclaration, jamais scindée de la première.
      const creee = await f.createOperation(user(compte), {
        declaration: 'Géométrie des trains de la Clio', type: { code: 'INTERVENTION' }, status: 'ENVISAGED', label: 'Géométrie des trains', assetIds: [clio.id],
      });
      expect(creee).toMatchObject({ status: 'APPLIED' });
      seconde = creee.data!.operationId;
    }
    // L'ordre de travail OT9 : rattaché par l'utilisateur à la seconde opération, puis consolidé (référence OT9 portée par elle).
    const ot = await document(compte, clio.id, [cand({
      provider: null, summary: 'Ordre de travail géométrie', sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED', targetHints: [cible(clio.id)],
      businessReferences: [{ kind: 'WORK_ORDER', value: 'OT9' }], temporalHints: { plannedDate: '2026-01-10' },
    })]);
    expect(await f.linkDocument(user(compte), { operationId: seconde, fileId: ot })).toMatchObject({ status: 'APPLIED' });
    await passer(compte);
    expect(await candidat(ot)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: seconde });
    expect(await actifs(compte)).toEqual([origine, seconde]);
    return { clio, devis, ot, origine, seconde };
  }
  /** PREUVE NOUVELLE : une facture qui cite la référence des DEUX opérations (devis D1 et ordre de travail OT9). */
  const factureCommune = (compte: AccountRow, assetId: number, numero: string) => document(compte, assetId, [cand({
    targetHints: [cible(assetId)], temporalHints: { realizedDate: '2026-01-20' }, financialHints: [fh('REALIZED_COST', 31000)],
    businessReferences: [{ kind: 'QUOTE', value: 'D1' }, { kind: 'WORK_ORDER', value: 'OT9' }, { kind: 'INVOICE', value: numero }],
  })]);

  it('L116C-S01 — TÉMOIN : sans scission, la preuve nouvelle fusionne les deux opérations (la voie automatique existe bien)', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { clio, origine, seconde } = await monter(compte, false);
    const facture = await factureCommune(compte, clio.id, 'F-100');
    await passer(compte);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_MERGE', t3_operation_id: origine });
    expect(await actifs(compte)).toEqual([origine]);
    expect((await sql<Json[]>`SELECT merged_into_operation_id::int AS m FROM business_operations WHERE id = ${seconde}`)[0].m).toBe(origine);
  });

  it('L116C-S02 — après une scission : la même preuve nouvelle ne refusionne pas ; reprise, trois passes T3 puis une seconde preuve : toujours deux opérations', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { clio, devis, ot, origine, seconde } = await monter(compte, true);
    // La paire est connue de la porte unique des fusions automatiques, sans aucune décision documentaire.
    expect(await porte(compte, [origine, seconde])).toEqual([paire(origine, seconde)]);
    expect(await sql`SELECT 1 FROM business_operation_match_decisions WHERE account_id = ${compte.id} AND decision = 'REJECTED' AND active`).toHaveLength(0);

    const facture = await factureCommune(compte, clio.id, 'F-100');
    const fusions = async () => (await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_history WHERE account_id = ${compte.id} AND event_type = 'MERGED'`)[0].n;
    for (let passe = 1; passe <= 3; passe++) {
      await passer(compte);
      expect(await actifs(compte), `passe ${passe}`).toEqual([origine, seconde]);
      expect(await fusions(), `passe ${passe}`).toBe(0);
    }
    // La facture n'a fusionné personne : elle attend la décision de l'utilisateur (à quelle opération appartient-elle ?).
    const decision = await candidat(facture);
    expect(decision.t3_reason).not.toBe('MATCH_MERGE');
    expect(decision.t3_outcome).toBe('ARBITRATION_REQUIRED');
    // Rien n'est perdu : chaque opération garde ses justificatifs.
    expect(await sourcesActives(origine)).toEqual([devis]);
    expect(await sourcesActives(seconde)).toEqual([ot]);

    // REPRISE après une demande de réexamen de TOUT le compte, puis une SECONDE preuve nouvelle.
    await sql`UPDATE document_operation_candidates SET t3_processed_at = NULL WHERE account_id = ${compte.id}`;
    await passer(compte);
    await factureCommune(compte, clio.id, 'F-200');
    for (let passe = 4; passe <= 6; passe++) {
      await passer(compte);
      expect(await actifs(compte), `passe ${passe}`).toEqual([origine, seconde]);
    }
    expect(await fusions()).toBe(0);
    expect((await sql<Json[]>`SELECT state, nature, split_apart_at IS NOT NULL AS scindee FROM business_operation_relations WHERE account_id = ${compte.id}`))
      .toEqual([{ state: 'ACTIVE', nature: 'ASSOCIATED', scindee: true }]);
    expect(await audit(compte)).toEqual([]);
  });

  it('L116C-S03 — mémoire durable : dissociation puis nouvelle association (motif réécrit) → paire toujours non fusionnable ; la garde du dépôt refuse les trois voies de T3 sans rien écrire', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { origine, seconde } = await monter(compte, true);
    const f = await facade();
    expect(await f.dissociateOperations(user(compte), { operationAId: origine, operationBId: seconde, reasonCode: 'L116C_S03' })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await porte(compte, [origine, seconde])).toEqual([paire(origine, seconde)]);
    expect(await f.associateOperations(user(compte), { fromOperationId: seconde, toOperationId: origine, nature: 'ASSOCIATED', reasonCode: 'L116C_S03' })).toMatchObject({ status: 'APPLIED', changed: true });
    // Le motif de la relation n'est plus « USER_SPLIT » : la mémoire ne tient plus qu'à la colonne durable.
    expect((await sql<Json[]>`SELECT reason_code, split_apart_at IS NOT NULL AS scindee FROM business_operation_relations WHERE account_id = ${compte.id}`))
      .toEqual([{ reason_code: 'L116C_S03', scindee: true }]);
    expect(await porte(compte, [origine, seconde])).toEqual([paire(origine, seconde)]);
    const { wasSplitApart } = await import('@/services/business-operations/graph/read');
    expect(await wasSplitApart(compte.id, seconde, origine)).toBe(true);

    // DERNIÈRE GARDE (dépôt) : quelle que soit la voie de T3, rien n'est écrit ; l'abstention est tracée UNE fois.
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    const empreinte = async () => (await sql<Json[]>`
      SELECT md5(concat_ws('#',
        (SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) FROM business_operation_sources t WHERE t.account_id = ${compte.id}),
        (SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) FROM business_operation_relations t WHERE t.account_id = ${compte.id}),
        (SELECT md5(string_agg(t::text, '|' ORDER BY t.id)) FROM business_operation_agenda_links t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM business_operation_history t WHERE t.account_id = ${compte.id}))) AS h`)[0].h;
    const avant = await empreinte();
    for (const motif of ['T3_RETRO_MERGE', 'T3_SERIES_MERGE', 'T3_MERGE_COMMON_REFERENCE']) {
      expect(await withBusinessOperationWrite(compte.id, (repo) => repo.mergeOperations(seconde, origine, motif)), motif).toBe(false);
      expect(await withBusinessOperationWrite(compte.id, (repo) => repo.mergeOperations(origine, seconde, motif)), motif).toBe(false);
    }
    expect(await empreinte()).toBe(avant);
    expect(await actifs(compte)).toEqual([origine, seconde]);
    expect((await sql<Json[]>`
      SELECT reason_code, action, origin FROM business_operation_graph_history
       WHERE account_id = ${compte.id} AND reason_code = 'ABSTAIN_USER_SPLIT_APART'`)).toEqual([{ reason_code: 'ABSTAIN_USER_SPLIT_APART', action: 'NO_CHANGE', origin: 'SYSTEM' }]);
  });

  it('L116C-S04 — la mémoire suit l’identité : l’opération issue de la scission fusionnée (par l’utilisateur) avec une troisième → la paire (origine, troisième) est protégée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { clio, origine, seconde } = await monter(compte, true);
    const f = await facade();
    const tierce = (await f.createOperation(user(compte), {
      declaration: 'Réglage du parallélisme de la Clio', type: { code: 'INTERVENTION' }, status: 'ENVISAGED', label: 'Parallélisme', assetIds: [clio.id],
    })).data!.operationId;
    // La troisième est ASSOCIÉE à l'origine avant la fusion : la mémoire doit être reportée sur CETTE relation existante.
    expect(await f.associateOperations(user(compte), { fromOperationId: origine, toOperationId: tierce, nature: 'ASSOCIATED' })).toMatchObject({ status: 'APPLIED' });
    expect(await porte(compte, [origine, tierce])).toEqual([]);
    expect(await f.mergeOperations(user(compte), { absorbedOperationId: seconde, canonicalOperationId: tierce })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await actifs(compte)).toEqual([origine, tierce]);
    expect(await porte(compte, [origine, tierce])).toEqual([paire(origine, tierce)]);
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    expect(await withBusinessOperationWrite(compte.id, (repo) => repo.mergeOperations(tierce, origine, 'T3_MERGE_COMMON_REFERENCE'))).toBe(false);
    expect(await actifs(compte)).toEqual([origine, tierce]);
    expect(await audit(compte)).toEqual([]);
  });

  it('L116C-S05 — refusion EXPLICITE : l’utilisateur réunit les deux opérations scindées ; une inférence qui appelle la commande est refusée', async () => {
    const compte = await make.account({ plan: 'premium' });
    const { devis, ot, origine, seconde } = await monter(compte, true);
    const f = await facade();
    expect(await f.mergeOperations(t3(compte), { absorbedOperationId: seconde, canonicalOperationId: origine, evidence: [{ kind: 'DOCUMENT', ref: String(ot) }] }))
      .toMatchObject({ status: 'FORBIDDEN', code: 'USER_ONLY', changed: false });
    expect(await actifs(compte)).toEqual([origine, seconde]);
    expect(await f.mergeOperations(user(compte), { absorbedOperationId: seconde, canonicalOperationId: origine, reasonCode: 'L116C_S05' }))
      .toMatchObject({ status: 'APPLIED', changed: true, data: { canonicalOperationId: origine, absorbedOperationId: seconde } });
    expect(await actifs(compte)).toEqual([origine]);
    expect(await sourcesActives(origine)).toEqual([devis, ot]);
    // Les passes suivantes ne défont rien et ne recréent pas la seconde.
    await passer(compte);
    await passer(compte);
    expect(await actifs(compte)).toEqual([origine]);
    expect(await audit(compte)).toEqual([]);
  });

  it('L116C-S06 — la scission contrôle et fait avancer la version : vue périmée → conflit sans écriture ; clé d’idempotence rejouée → même résultat ; journal des deux côtés', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const f = await facade();
    const op = (await f.createOperation(user(compte), {
      declaration: 'Travaux de la maison regroupés à tort', type: { code: 'INTERVENTION' }, status: 'REALIZED', label: 'Travaux', assetIds: [maison.id],
    })).data!.operationId;
    const e1 = await make.agendaItem(compte, { title: 'Pose des fenêtres', startDate: '2026-03-02', assetIds: [maison.id] });
    const e2 = await make.agendaItem(compte, { title: 'Ravalement', startDate: '2026-09-14', assetIds: [maison.id] });
    for (const el of [e1, e2]) expect(await f.linkAgendaItem(user(compte), { operationId: op, agendaItemId: el.id })).toMatchObject({ status: 'APPLIED' });
    const version = async () => Number((await sql<Json[]>`SELECT version FROM business_operations WHERE id = ${op}`)[0].version);
    const lue = await version();
    const journal = async () => (await sql<Json[]>`SELECT count(*)::int AS n FROM business_operation_graph_history WHERE account_id = ${compte.id}`)[0].n;

    const cle = { ...user(compte), idempotencyKey: 'l116c-s06-scission-ravalement' };
    const entree = { operationId: op, expectedVersion: lue, label: 'Ravalement de la façade', agendaItemIds: [e2.id] };
    const premiere = await f.splitOperation(cle, entree);
    expect(premiere).toMatchObject({ status: 'APPLIED', changed: true, replayed: false });
    const apres = await version();
    expect(apres).toBeGreaterThan(lue);
    expect(premiere.data!.version).toBe(apres);
    const lignes = await journal();

    // Même clé, même entrée : le résultat enregistré est rendu, rien n'est réécrit (aucune troisième opération).
    expect(await f.splitOperation(cle, entree)).toMatchObject({ status: 'APPLIED', changed: false, replayed: true, data: { newOperationId: premiere.data!.newOperationId } });
    expect(await journal()).toBe(lignes);
    expect(await actifs(compte)).toHaveLength(2);
    expect(await version()).toBe(apres);

    // Une AUTRE scission demandée depuis la vue lue AVANT la première : conflit, rien d'écrit.
    expect(await f.splitOperation(user(compte), { operationId: op, expectedVersion: lue, label: 'Fenêtres', agendaItemIds: [e1.id] }))
      .toMatchObject({ status: 'CONFLICT', code: 'VERSION_MISMATCH', changed: false, data: { currentVersion: apres } });
    expect(await journal()).toBe(lignes);
    expect(await actifs(compte)).toHaveLength(2);
    // Vue rechargée : la scission s'applique.
    expect(await f.splitOperation(user(compte), { operationId: op, expectedVersion: apres, label: 'Fenêtres', agendaItemIds: [e1.id] })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await version()).toBeGreaterThan(apres);

    // Journal : la création du nouveau, la relation gardée (mémoire de la séparation) et la mise à jour de l'origine.
    const traces = await sql<Json[]>`
      SELECT relation_kind, action, operation_id::int AS op, (after_json->>'splitApart') AS memoire, actor_user_id
        FROM business_operation_graph_history
       WHERE account_id = ${compte.id} AND command = 'splitOperation' AND reason_code = 'USER_SPLIT' AND relation_kind IN ('OPERATION', 'OPERATION_RELATION')
         AND (operation_id = ${premiere.data!.newOperationId} OR other_operation_id = ${premiere.data!.newOperationId}) ORDER BY id`;
    expect(traces.map((t) => `${t.relation_kind}:${t.action}`)).toEqual(['OPERATION:CREATED', 'OPERATION_RELATION:CREATED', 'OPERATION:UPDATED']);
    expect(traces[1].memoire).toBe('true');
    expect(traces.every((t) => Number(t.actor_user_id) === compte.ownerUserId)).toBe(true);
  });
});
