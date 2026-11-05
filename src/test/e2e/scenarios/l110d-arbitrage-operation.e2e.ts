/**
 * Lot 110D — « À traiter » : arbitrage « même réalité » en Oui / Non par
 * Opération candidate (ticket « Arbitrage Opération : une question binaire au
 * lieu de « A ou B ? » », critères §6) — PostgreSQL 16 réel, chemins de
 * production (T1 persisté → `consolidateAccountOperations` → cartes →
 * `getToProcessPage` → `resolveArbitration` → consolidation), sorties IA M3
 * ENREGISTRÉES (rejeu, aucun appel réseau).
 *
 *   L110D-E2E-01  deux références (A, B) d'une même Opération + document C :
 *                 une question « la même intervention que les documents
 *                 suivants ? », A et B en contexte, Oui / Non seulement ;
 *                 Oui : C rattaché une fois (provenance USER, références
 *                 présentées, empreinte), A / B préservés, aucune Opération ni
 *                 ligne financière ni événement dupliqués ; carte fermée ;
 *                 T3 répété : idempotent, aucune nouvelle carte ;
 *   L110D-E2E-02  N références (3 documents + 1 événement de l'Agenda) : une
 *                 question, N références consultables (lien revalidé), deux
 *                 boutons ;
 *   L110D-E2E-03  Non : refus de l'Opération ENTIÈRE, aucun rattachement, aucune
 *                 création présumée (candidat probable), aucune re-proposition ;
 *   L110D-E2E-04  même bien, deux interventions distinctes : question sur la
 *                 première seule (ses références seulement) ; Non → la
 *                 seconde est examinée (nouvelle question, jamais la même) ;
 *   L110D-E2E-05  deux Opérations réellement distinctes (rapprochements exacts
 *                 incompatibles) : aucune question commune, aucune fusion ;
 *                 Opération absorbée : identifiants ramenés à la canonique ;
 *   L110D-E2E-06  types variés (achat, intervention, assurance, abonnement,
 *                 financement) : libellé métier du TYPE persisté, sans codage
 *                 immobilier ; repli « événement de référence » ;
 *   L110D-E2E-07  cartes existantes « A ou B ? » : toujours lisibles et
 *                 répondables ; contrôle COH-TODO-OPERATION-CARDS à blanc
 *                 (aucune écriture) puis correctif : MÊME carte convertie,
 *                 décision déjà prise respectée ; rejoué : rien.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import type { RecordedOutput } from '../replay-gateway';

const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');
const AUJOURDHUI = '2026-10-12';
type Json = Record<string, any>;

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Remplacement des plaquettes de frein', sourceRoleHint: 'INVOICE', provider: 'Garage Martin',
    targetHints: [], businessReferences: [], temporalHints: {}, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const fh = (role: string, amountMinor: number, over: Partial<AnchoredOperationCandidate['financialHints'][number]> = {}) =>
  ({ role, amountMinor, currency: 'EUR', amountScope: null, economicDate: null, periodStart: null, periodEnd: null, factRef: 'f1', ...over }) as AnchoredOperationCandidate['financialHints'][number];
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });
const m3 = (decision: 'SAME_OPERATION' | 'DISTINCT_OPERATION' | 'AMBIGUOUS', matchedCandidateId: number | null, confidence = 'certain', repeat = false): RecordedOutput => ({
  operationCode: 't3_operation_match', task: 'OPERATION_MATCH', repeat,
  output: { task: 'OPERATION_MATCH', decision, matchedCandidateId, confidence, concordantSignals: ['même bien'], contradictions: [], reason: 'enregistré' },
});

scenario('L110D', 'Arbitrage « même réalité » : une question Oui / Non par Opération candidate', ({ sql, make, useRecordings }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
    const { __setActiveMasterPromptsForTests } = await import('@/services/ai/master-prompts/master-prompt-runtime');
    __setActiveMasterPromptsForTests(null);
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  async function t1(compte: AccountRow, fileId: number, candidats: AnchoredOperationCandidate[]) {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    const extractionId = x?.id ?? (await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${fileId}) RETURNING id`)[0].id;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, { accountId: compte.id, fileId, extractionId, analysisRunId: null, reanalysis: false, candidates: candidats, facts: new Map() });
    });
  }
  async function document(compte: AccountRow, assetId: number | null, candidats: AnchoredOperationCandidate[], titre: string, date?: string) {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre}, document_date = ${date ?? null} WHERE id = ${f.id}`;
    await t1(compte, f.id, candidats);
    return f.id;
  }
  type PasserOpts = Parameters<Awaited<ReturnType<typeof consolidator>>['consolidateAccountOperations']>[1];
  const passer = async (compte: AccountRow, opts: PasserOpts = {}) =>
    (await consolidator()).consolidateAccountOperations(compte.id, { today: AUJOURDHUI, ...opts });
  const actives = (compte: AccountRow) => sql<{ id: number; type_code: string | null }[]>`
    SELECT id::int AS id, type_code FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL ORDER BY id`;
  const candidat = async (fileId: number) => (await sql<Json[]>`
    SELECT t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`)[0];
  const ouvertes = (compte: AccountRow) => sql<Json[]>`
    SELECT id, public_id::text AS public_id, target_id, relation_key, question, proposals_json, trigger_context, cycle_number
      FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-MATCH' AND resolved_at IS NULL ORDER BY id`;
  const toutes = (compte: AccountRow) => sql<Json[]>`
    SELECT id, resolution_reason, trigger_context FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-MATCH' ORDER BY id`;
  const decisions = (compte: AccountRow) => sql<Json[]>`
    SELECT candidate_operation_id::int AS candidate_operation_id, decision, reason_code, origin, active, source_entity_key
      FROM business_operation_match_decisions WHERE account_id = ${compte.id} ORDER BY id`;
  const sourcesActives = (opId: number) => sql<{ k: string }[]>`
    SELECT source_entity_key AS k FROM business_operation_sources WHERE operation_id = ${opId} AND active AND source_kind = 'DOCUMENT' ORDER BY id`;
  const composantes = async (compte: AccountRow) => (await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM business_operation_financial_components fc JOIN business_operations o ON o.id = fc.operation_id
     WHERE o.account_id = ${compte.id} AND fc.active`)[0].n;
  const agenda = async (compte: AccountRow) => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id}`)[0].n;
  const resoudre = async (compte: AccountRow, publicId: string, value: string) => {
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    return resolveArbitration(compte.id, publicId, value, { userId: compte.ownerUserId });
  };
  const vue = async (compte: AccountRow, publicId: string) => {
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const page = await getToProcessPage(compte.id, { withLinks: true });
    return { page, carte: page.actions.find((a) => a.publicId === publicId)! };
  };

  /**
   * Devis (référence DV-77) puis bon de commande citant DV-77 : même Opération
   * (deux références), puis facture sans référence du même garage : M3 requis.
   */
  async function deuxReferencesPuisFacture(compte: AccountRow, bienId: number, factureOver: Partial<AnchoredOperationCandidate> = {}) {
    const devis = await document(compte, bienId, [cand({ sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', targetHints: [cible(bienId)], temporalHints: { plannedDate: '2026-06-03' }, businessReferences: [{ kind: 'QUOTE', value: 'DV-77' }], financialHints: [fh('FORECAST_COST', 25500)] })], 'Devis freinage', '2026-06-01');
    await passer(compte, { operationMatch: false });
    const commande = await document(compte, bienId, [cand({ sourceRoleHint: 'ORDER', statusHint: 'ENVISAGED', targetHints: [cible(bienId)], temporalHints: { plannedDate: '2026-06-03' }, businessReferences: [{ kind: 'QUOTE', value: 'DV-77' }] })], 'Bon de commande freinage', '2026-06-02');
    await passer(compte, { operationMatch: false });
    const [op] = await actives(compte);
    expect((await sourcesActives(op.id)).map((s) => Number(s.k))).toEqual([devis, commande]);
    const facture = await document(compte, bienId, [cand({ targetHints: [cible(bienId)], temporalHints: { realizedDate: '2026-06-05' }, ...factureOver })], 'Facture freinage', '2026-06-05');
    return { devis, commande, facture, op };
  }

  it('L110D-E2E-01 — deux références, une Opération : « la même intervention que les documents suivants ? » + Oui / Non ; Oui : rattachement unique, provenance, rien de dupliqué, T3 répété idempotent', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const { devis, commande, facture, op } = await deuxReferencesPuisFacture(compte, clio.id);
    const replay = await useRecordings([m3('AMBIGUOUS', null, 'probable')]);
    await passer(compte);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'ARBITRATION_REQUIRED' });
    const [carte, ...autres] = await ouvertes(compte);
    expect(autres).toEqual([]);
    expect(carte.question).toBe('Ce document concerne-t-il la même intervention que les documents suivants ?');
    expect(carte.proposals_json.map((p: Json) => [p.value, p.label])).toEqual([[`YES:${op.id}`, 'Oui'], [`NO:${op.id}`, 'Non']]);
    expect(carte.trigger_context).toMatchObject({
      kind: 'operation_match', form: 'BINARY', operationId: op.id, candidateOperationId: op.id, operationIds: [op.id], otherCandidateOperationIds: [],
      operationType: 'INTERVENTION', referenceCount: 2, contextFingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(carte.trigger_context.references.map((r: Json) => `${r.kind}:${r.id}`)).toEqual([`document:${devis}`, `document:${commande}`]);
    expect([carte.question, ...carte.proposals_json.map((p: Json) => p.label)].join(' ')).not.toMatch(/op[ée]ration/i);

    // Vue de la file (web et mobile : même réponse) : références consultables, deux boutons, pas de « Autre ».
    const { page, carte: v } = await vue(compte, carte.public_id);
    expect(page.total).toBe(1);
    expect(v.choiceMode).toBe('BINARY');
    expect(v.proposals.map((p) => p.label)).toEqual(['Oui', 'Non']);
    expect(v.references!.items.map((r) => [r.kind, r.id, r.title, r.meta])).toEqual([
      ['document', devis, 'Devis freinage', 'Document · 01/06/2026'], ['document', commande, 'Bon de commande freinage', 'Document · 02/06/2026'],
    ]);
    const { checkCardLink } = await import('@/services/to-process/card-links');
    expect(await checkCardLink(compte.id, carte.public_id, { kind: 'document', id: devis })).toBe('ok');
    expect(await checkCardLink(compte.id, carte.public_id, { kind: 'document', id: commande })).toBe('ok');
    const autreCompte = await make.account();
    expect(await checkCardLink(autreCompte.id, carte.public_id, { kind: 'document', id: devis })).toBe('gone');

    // T3 répété (même contexte) : même carte, aucun doublon, aucun rappel IA.
    await passer(compte, { reevaluateHolds: true });
    expect((await ouvertes(compte)).map((c) => c.id)).toEqual([carte.id]);
    expect(replay.calls).toHaveLength(1);

    const avant = { ops: (await actives(compte)).length, composantes: await composantes(compte), agenda: await agenda(compte) };
    const r = await resoudre(compte, carte.public_id, `YES:${op.id}`);
    expect(r.ok).toBe(true);
    expect(await decisions(compte)).toEqual([{ candidate_operation_id: op.id, decision: 'CONFIRMED', reason_code: 'USER_SAME_OPERATION', origin: 'USER_ARBITRATION', active: true, source_entity_key: String(facture) }]);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_reason: 'MATCH_M0', t3_operation_id: op.id });
    // A et B préservés, C ajouté une fois.
    expect((await sourcesActives(op.id)).map((s) => Number(s.k))).toEqual([devis, commande, facture]);
    expect((await actives(compte)).length).toBe(avant.ops);
    expect(await composantes(compte)).toBe(avant.composantes);
    expect(await agenda(compte)).toBe(avant.agenda);
    // Provenance : utilisateur, Opération, choix, références présentées, empreinte, date.
    const [ev] = await sql<Json[]>`SELECT actor_user_id, previous_value, new_value, details, created_at FROM to_process_action_events WHERE action_id = ${carte.id} AND event = 'RESOLVED_ARBITRATION'`;
    expect(ev.actor_user_id).toBe(compte.ownerUserId);
    expect(ev.new_value).toEqual({ kind: 'SAME', operationId: op.id });
    expect(ev.previous_value).toMatchObject({ operationId: op.id, form: 'BINARY', presented: { references: [{ kind: 'document', id: devis }, { kind: 'document', id: commande }], cardFingerprint: carte.trigger_context.contextFingerprint } });
    expect(ev.previous_value.presented.contextFingerprint).toBe(carte.trigger_context.contextFingerprint);
    expect(ev.created_at).toBeTruthy();
    expect(await ouvertes(compte)).toEqual([]);
    expect((await vue(compte, carte.public_id)).page.total).toBe(0);

    // Réponse rejouée (double clic, ancien onglet) : refusée, rien d'écrit.
    expect(await resoudre(compte, carte.public_id, `YES:${op.id}`)).toMatchObject({ ok: false, error: 'ALREADY_RESOLVED' });
    // T3 répété : stable, aucune carte.
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${facture}`;
    await passer(compte, { reevaluateHolds: true });
    expect(await ouvertes(compte)).toEqual([]);
    expect((await sourcesActives(op.id)).map((s) => Number(s.k))).toEqual([devis, commande, facture]);
    expect((await decisions(compte)).length).toBe(1);
  });

  it('L110D-E2E-02 — N références (3 documents + 1 événement de l’Agenda) : une seule question, N références consultables, deux boutons ; carte mise à jour sans doublon quand une référence s’ajoute', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Kangoo' });
    const { devis, commande, facture, op } = await deuxReferencesPuisFacture(compte, bien.id);
    const [evt] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, business_operation_id, operation_role)
      VALUES (${compte.id}, 'Rendez-vous garage', '2026-06-04', ${op.id}, 'PRINCIPAL') RETURNING id`;
    await useRecordings([m3('AMBIGUOUS', null, 'probable', true)]);
    await passer(compte);
    const [carte] = await ouvertes(compte);
    expect(carte.question).toBe('Ce document concerne-t-il la même intervention que les documents et événements suivants ?');
    let v = (await vue(compte, carte.public_id)).carte;
    expect(v.references!.items.map((r) => `${r.kind}:${r.id}`)).toEqual([`document:${devis}`, `document:${commande}`, `event:${evt.id}`]);
    expect(v.references!.items[2].meta).toBe('Événement · 04/06/2026');
    expect(v.proposals).toHaveLength(2);
    // L'événement listé n'est pas répété en « Voir l'événement de référence ».
    expect((v.links?.related ?? []).filter((r) => r.id === evt.id)).toEqual([]);
    const { checkCardLink } = await import('@/services/to-process/card-links');
    expect(await checkCardLink(compte.id, carte.public_id, { kind: 'echeance', id: evt.id })).toBe('ok');

    // Une 3e pièce rejoint l'Opération (référence DV-77) : affichage actualisé, même carte, même sens.
    const avenant = await document(compte, bien.id, [cand({ candidateKey: 'op1', sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', targetHints: [cible(bien.id)], businessReferences: [{ kind: 'QUOTE', value: 'DV-77' }] })], 'Avenant au devis', '2026-06-03');
    await passer(compte, { operationMatch: false });
    expect((await sourcesActives(op.id)).map((s) => Number(s.k))).toContain(avenant);
    v = (await vue(compte, carte.public_id)).carte;
    expect(v.references!.items.map((r) => `${r.kind}:${r.id}`)).toEqual([`document:${devis}`, `document:${commande}`, `document:${avenant}`, `event:${evt.id}`]);
    expect(v.proposals.map((p) => p.value)).toEqual([`YES:${op.id}`, `NO:${op.id}`]);
    expect((await ouvertes(compte)).map((c) => c.id)).toEqual([carte.id]);
    expect(await checkCardLink(compte.id, carte.public_id, { kind: 'document', id: avenant })).toBe('ok');
    expect(await checkCardLink(compte.id, carte.public_id, { kind: 'document', id: facture })).toBe('ok'); // objet de la carte
    expect((await resoudre(compte, carte.public_id, `YES:${op.id}`)).ok).toBe(true);
    expect(await agenda(compte)).toBe(1);
  });

  it('L110D-E2E-03 — Non : refus de l’Opération entière, aucun rattachement, aucune création présumée, jamais reproposé à l’identique', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    // Candidat seulement PROBABLE : un « Non » ne vaut pas « crée une nouvelle réalité ».
    const { devis, commande, facture, op } = await deuxReferencesPuisFacture(compte, bien.id, { confidence: 'probable' });
    const replay = await useRecordings([m3('AMBIGUOUS', null, 'probable')]);
    await passer(compte);
    const [carte] = await ouvertes(compte);
    const nOps = (await actives(compte)).length;
    expect((await resoudre(compte, carte.public_id, `NO:${op.id}`)).ok).toBe(true);
    expect(await decisions(compte)).toEqual([expect.objectContaining({ candidate_operation_id: op.id, decision: 'REJECTED', reason_code: 'USER_NOT_SAME_OPERATION', origin: 'USER_ARBITRATION', active: true })]);
    expect((await sourcesActives(op.id)).map((s) => Number(s.k))).toEqual([devis, commande]);
    expect((await actives(compte)).length).toBe(nOps);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'HOLD_UNRESOLVED', t3_reason: 'PROBABLE_WITHOUT_MATCH' });
    const [ev] = await sql<Json[]>`SELECT new_value FROM to_process_action_events WHERE action_id = ${carte.id} AND event = 'RESOLVED_ARBITRATION'`;
    expect(ev.new_value).toEqual({ kind: 'NOT_SAME', operationId: op.id });
    // Passages T3 suivants : aucune re-proposition, aucun rappel IA.
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${facture}`;
    await passer(compte, { reevaluateHolds: true });
    await passer(compte, { reevaluateHolds: true });
    expect(await ouvertes(compte)).toEqual([]);
    expect(replay.calls).toHaveLength(1);
    // Contrôle de propagation (lot 85B) : refus appliqué.
    const { getCheck } = await import('@/services/coherence/registry');
    const { pgClient } = await import('@/db');
    const insp = await getCheck('COH-TODO-RESOLUTION-PROPAGATION')!.inspect!({ sql: pgClient as never, now: new Date(), today: AUJOURDHUI, mode: 'DRY_RUN', correlationId: 'e2e-110d' } as never, compte.id, [carte.id]);
    expect(insp.get(carte.id)).toMatchObject({ verdict: 'CONSISTENT', detail: { choice: 'DISTINCT' } });
  });

  it('L110D-E2E-04 — même bien, deux interventions distinctes : question sur la première seule (ses références) ; Non → la seconde est examinée, jamais la même question', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const freins = await document(compte, bien.id, [cand({ sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', targetHints: [cible(bien.id)], temporalHints: { plannedDate: '2026-06-03' }, businessReferences: [{ kind: 'QUOTE', value: 'DV-1' }] })], 'Devis freins', '2026-06-01');
    await passer(compte, { operationMatch: false });
    const pneus = await document(compte, bien.id, [cand({ summary: 'Remplacement des pneus avant', sourceRoleHint: 'QUOTE', statusHint: 'ENVISAGED', targetHints: [cible(bien.id)], temporalHints: { plannedDate: '2026-06-04' }, businessReferences: [{ kind: 'QUOTE', value: 'DV-2' }] })], 'Devis pneus', '2026-06-02');
    // Deux interventions RÉELLEMENT distinctes du même bien (verdict M3 certain : autre réalité).
    await useRecordings([m3('DISTINCT_OPERATION', null)]);
    await passer(compte);
    const ops = await actives(compte);
    expect(ops).toHaveLength(2);
    const facture = await document(compte, bien.id, [cand({ targetHints: [cible(bien.id)], temporalHints: { realizedDate: '2026-06-05' } })], 'Facture atelier', '2026-06-05');
    const replay = await useRecordings([m3('AMBIGUOUS', null, 'probable', true)]);
    await passer(compte);
    const [carte, ...autres] = await ouvertes(compte);
    expect(autres).toEqual([]);
    expect(carte.target_id).toBe(facture);
    const premiere = carte.trigger_context.operationId as number;
    const seconde = ops.map((o) => o.id).find((id) => id !== premiere)!;
    expect(carte.trigger_context.otherCandidateOperationIds).toEqual([seconde]);
    // Seules les références de la première : jamais un regroupement sur le seul bien.
    const refsPremiere = carte.trigger_context.references.map((r: Json) => r.id);
    expect(refsPremiere).toHaveLength(1);
    expect([freins, pneus]).toContain(refsPremiere[0]);
    expect(carte.proposals_json).toHaveLength(2);

    expect((await resoudre(compte, carte.public_id, `NO:${premiere}`)).ok).toBe(true);
    await passer(compte);
    const [suivante, ...encore] = await ouvertes(compte);
    expect(encore).toEqual([]);
    expect(suivante.id).not.toBe(carte.id);
    expect(suivante.trigger_context.operationId).toBe(seconde);
    expect(suivante.trigger_context.references.map((r: Json) => r.id)).not.toContain(refsPremiere[0]);
    expect(suivante.proposals_json.map((p: Json) => p.value)).toEqual([`YES:${seconde}`, `NO:${seconde}`]);
    // Une réponse sur l'ancienne Opération (ancien onglet) : refusée STALE, jamais réinterprétée.
    expect(await resoudre(compte, suivante.public_id, `YES:${premiere}`)).toMatchObject({ ok: false, error: 'STALE' });
    expect((await ouvertes(compte)).map((c) => c.id)).toEqual([suivante.id]);
    expect(replay.calls.length).toBeGreaterThanOrEqual(1);
    expect((await decisions(compte)).filter((d) => d.decision === 'CONFIRMED')).toEqual([]);
  });

  it('L110D-E2E-05 — deux Opérations réellement distinctes (références exactes incompatibles) : aucune question commune ni fusion ; Opération absorbée ramenée à la canonique', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte);
    const a = await document(compte, clio.id, [cand({ provider: 'Garage A', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }] })], 'Devis A');
    const b = await document(compte, clio.id, [cand({ provider: 'Garage B', targetHints: [cible(clio.id)], businessReferences: [{ kind: 'WORK_ORDER', value: 'OT9' }] })], 'Ordre B');
    await passer(compte, { operationMatch: false });
    const deux = await document(compte, clio.id, [cand({ provider: null, targetHints: [cible(clio.id)], businessReferences: [{ kind: 'QUOTE', value: 'D1' }, { kind: 'WORK_ORDER', value: 'OT9' }], financialHints: [fh('REALIZED_COST', 1000)] })], 'Facture commune');
    await passer(compte, { operationMatch: false });
    const ops = await actives(compte);
    expect(ops).toHaveLength(2);
    const [carte] = await ouvertes(compte);
    expect(carte.target_id).toBe(deux);
    expect(carte.question).toBe('Ce document concerne-t-il la même intervention que le document suivant ?');
    const refs = carte.trigger_context.references.map((r: Json) => r.id);
    expect(refs).toHaveLength(1);
    expect([a, b]).toContain(refs[0]);
    expect(carte.trigger_context.otherCandidateOperationIds).toHaveLength(1);
    expect((await actives(compte)).length).toBe(2); // aucune fusion

    // L'utilisateur (hors carte) réunit les deux réalités : la carte, réévaluée, ne garde qu'UNE Opération et TOUTES ses références.
    const [garde, absorbee] = [carte.trigger_context.operationId as number, carte.trigger_context.otherCandidateOperationIds[0] as number];
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    await withBusinessOperationWrite(compte.id, async (repo) => { await repo.mergeOperations(absorbee, garde, 'E2E_USER_MERGE'); });
    const { syncOperationCards } = await import('@/services/to-process/operation-cards');
    const { emptyCardNeeds } = await import('@/services/business-operations/consolidation/card-needs');
    const needs = emptyCardNeeds();
    needs.match.push({ fileId: deux, candidateKey: 'op1', basis: 'CERTAIN', operationIds: [absorbee, garde], typeHint: 'INTERVENTION' });
    needs.reviewedFiles.push(deux);
    await syncOperationCards(compte.id, needs);
    const [maj, ...rien] = await ouvertes(compte);
    expect(rien).toEqual([]);
    expect(maj.id).toBe(carte.id);
    expect(maj.trigger_context).toMatchObject({ operationId: garde, otherCandidateOperationIds: [] });
    expect(maj.trigger_context.references.map((r: Json) => r.id).sort()).toEqual([a, b].sort());
    expect(maj.question).toBe('Ce document concerne-t-il la même intervention que les documents suivants ?');
  });

  it('L110D-E2E-06 — types variés (achat, intervention, assurance, abonnement, financement) : libellé du type persisté, aucun codage immobilier ; repli « événement de référence »', async () => {
    const compte = await make.account();
    const velo = await make.asset(compte, { category: 'VEHICULE', name: 'Vélo' });
    const cas: Array<{ type: string | null; titre: string; attendu: string }> = [
      { type: 'ACQUISITION', titre: 'Facture d’achat vélo', attendu: 'le même achat' },
      { type: 'INTERVENTION', titre: 'Réparation dérailleur', attendu: 'la même intervention' },
      { type: 'CONTRACT', titre: 'Assurance vélo', attendu: 'le même contrat' },
      { type: 'CONTRACT', titre: 'Abonnement entretien', attendu: 'le même contrat' },
      { type: 'FINANCING', titre: 'Crédit vélo', attendu: 'le même financement' },
      { type: null, titre: 'Pièce sans type', attendu: 'le même événement de référence' },
    ];
    const { syncOperationCards } = await import('@/services/to-process/operation-cards');
    const { emptyCardNeeds } = await import('@/services/business-operations/consolidation/card-needs');
    for (const [i, c] of cas.entries()) {
      const source = await document(compte, velo.id, [cand({ candidateKey: `k${i}`, typeHint: (c.type ?? 'INTERVENTION') as never, provider: `Tiers ${i}`, targetHints: [cible(velo.id)], businessReferences: [{ kind: 'INVOICE', value: `F-${i}` }] })], c.titre, '2026-05-0' + (i + 1));
      await passer(compte, { operationMatch: false });
      const op = (await sql<{ id: number }[]>`SELECT operation_id::int AS id FROM business_operation_sources WHERE source_entity_key = ${String(source)} AND active`)[0].id;
      if (c.type === null) await sql`UPDATE business_operations SET type_code = NULL WHERE id = ${op}`;
      const nouveau = await make.assetFile(compte, { assetId: velo.id });
      const needs = emptyCardNeeds();
      needs.match.push({ fileId: nouveau.id, candidateKey: `k${i}`, basis: 'M3', operationIds: [op], typeHint: 'ACQUISITION' });
      await syncOperationCards(compte.id, needs);
      const carte = (await ouvertes(compte)).find((x) => x.target_id === nouveau.id)!;
      expect(carte.question, c.titre).toBe(`Ce document concerne-t-il ${c.attendu} que le document suivant ?`);
      expect(carte.question).not.toMatch(/op[ée]ration/i);
      expect(carte.trigger_context.references).toEqual([expect.objectContaining({ kind: 'document', id: source, title: c.titre })]);
    }
  });

  it('L110D-E2E-07 — cartes existantes « A ou B ? » : lisibles et répondables ; contrôle à blanc sans écriture, puis correctif : même carte convertie, décisions respectées ; rejoué : rien', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const { devis, commande, facture, op } = await deuxReferencesPuisFacture(compte, bien.id);
    await useRecordings([m3('AMBIGUOUS', null, 'probable', true)]);
    await passer(compte);
    const [carte] = await ouvertes(compte);
    // Carte produite avant le lot 110D (ancienne forme, telle qu'en base).
    const ancien = { kind: 'operation_match', candidateKey: 'op1', basis: 'M3', operationIds: [op.id] };
    await sql`UPDATE to_process_actions SET question = ${'Ce document concerne-t-il la même intervention que « Bon de commande freinage du 03/06/2026 » ?'},
      proposals_json = ${JSON.stringify([{ value: `SAME:${op.id}`, label: 'Oui', confidence: 0.6 }, { value: 'DISTINCT', label: 'Non, c’est une autre intervention', confidence: 1, isCurrentValue: true }])}::jsonb,
      trigger_context = ${JSON.stringify(ancien)}::jsonb, trigger_context_hash = NULL WHERE id = ${carte.id}`;
    // Toujours lisible : présentée comme avant (sans forme binaire).
    const v = (await vue(compte, carte.public_id)).carte;
    expect(v.choiceMode).toBeUndefined();
    expect(v.proposals.map((p) => p.value)).toEqual([`SAME:${op.id}`, 'DISTINCT']);

    const [{ controlObjects }, { getCheck }, { pgClient }] = await Promise.all([
      import('@/services/coherence/engine'), import('@/services/coherence/registry'), import('@/db'),
    ]);
    const check = getCheck('COH-TODO-OPERATION-CARDS')!;
    expect(check.version).toBe(2);
    const controler = (mode: 'DRY_RUN' | 'CORRECTIVE') => controlObjects({
      ctx: { sql: pgClient as never, now: new Date(), today: AUJOURDHUI, mode, correlationId: `coherence:e2e-110d:${mode}` },
      check, accountId: compte.id, ids: [carte.id], trigger: 'MANUAL', campaignId: null,
      stillEligible: async () => ({ eligible: true, reason: 'e2e' }),
    });
    const blanc = await controler('DRY_RUN');
    expect(blanc.results).toMatchObject({ WOULD_REPAIR: 1 });
    expect(blanc.aiCalls).toBe(0);
    expect((await ouvertes(compte))[0].trigger_context).toEqual(ancien);

    const corr = await controler('CORRECTIVE');
    expect(corr.results).toMatchObject({ REPAIRED: 1 });
    expect(corr.aiCalls).toBe(0);
    const [convertie, ...rien] = await ouvertes(compte);
    expect(rien).toEqual([]);
    expect(convertie.id).toBe(carte.id);
    expect(convertie.public_id).toBe(carte.public_id);
    expect(convertie.trigger_context).toMatchObject({ form: 'BINARY', operationId: op.id });
    expect(convertie.trigger_context.references.map((r: Json) => r.id)).toEqual([devis, commande]);
    expect(convertie.proposals_json.map((p: Json) => p.label)).toEqual(['Oui', 'Non']);
    const rejoue = await controler('CORRECTIVE');
    expect(rejoue.results.REPAIRED ?? 0).toBe(0);
    expect(rejoue.results).toMatchObject({ CONSISTENT: 1 });

    // Une ancienne carte déjà répondue reste lue et sa décision respectée (aucune nouvelle carte).
    expect((await resoudre(compte, convertie.public_id, `YES:${op.id}`)).ok).toBe(true);
    const hist = await toutes(compte);
    expect(hist.map((h) => h.resolution_reason)).toEqual(['USER_ARBITRATED']);
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${facture}`;
    await passer(compte, { reevaluateHolds: true });
    expect(await ouvertes(compte)).toEqual([]);
  });

  it('L110D-E2E-08 — ancienne carte encore ouverte répondue avec son ancien choix (onglet resté ouvert) : décision appliquée comme avant', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const { facture, op } = await deuxReferencesPuisFacture(compte, bien.id);
    await useRecordings([m3('AMBIGUOUS', null, 'probable', true)]);
    await passer(compte);
    const [carte] = await ouvertes(compte);
    await sql`UPDATE to_process_actions SET proposals_json = ${JSON.stringify([{ value: `SAME:${op.id}`, label: 'Oui', confidence: 0.6 }])}::jsonb,
      trigger_context = ${JSON.stringify({ kind: 'operation_match', candidateKey: 'op1', basis: 'M3', operationIds: [op.id] })}::jsonb WHERE id = ${carte.id}`;
    expect((await resoudre(compte, carte.public_id, `SAME:${op.id}`)).ok).toBe(true);
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'MATCH_AND_ENRICH', t3_operation_id: op.id });
  });
});
