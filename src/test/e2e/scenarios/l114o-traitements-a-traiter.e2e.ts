/**
 * Carte Trello #744 (CDC « Opérations / Agenda V2.0 », point E de la carte :
 * « IA T1 / T2 / T3 / T4 et À traiter ») — sur PostgreSQL 16 réel, par les
 * chemins de PRODUCTION : T1 persisté (`replaceOperationCandidates`),
 * consolidation T3 d'un document et d'un élément d'Agenda, façade d'écriture
 * du graphe, file « À traiter » (`getToProcessPage`, `resolveArbitration`).
 * Aucune IA, aucun appel réseau. Dates fixes (aucune dépendance au jour).
 *
 *   L114O-T01  AC13, AC47 : événement de référence supprimé par l'utilisateur — T3 ne le réactive pas ET n'en crée
 *              pas un nouveau à partir du même document (même candidat ; candidat renommé et requalifié par une
 *              réanalyse) ; la source reste (restauration possible) ; un AUTRE document reste une preuve nouvelle
 *   L114O-T02  même règle pour un élément d'Agenda saisi : il reste dans l'Agenda, à sa date, sans nouvel événement
 *              de référence
 *   L114O-T03  AC14, AC16, AC17 : la façade répond « arbitrage requis » → UNE carte, question neutre, deux choix ;
 *              même preuve → pas de carte ; rejeu → pas de doublon ; réponse « Non » par la façade ; même preuve
 *              rejouée → aucune carte ; preuve jamais présentée → nouvelle carte ; réponse « Oui » par la façade
 *              (refus levé par l'utilisateur, journal, aucun coût, aucune date, aucun événement, aucun rappel)
 *   L114O-T04  AC15, AC18 : isolation du compte (lecture, résolution, preuve d'un autre compte) ; acteur non membre ;
 *              carte périmée (relation modifiée entre-temps) fermée sans rien appliquer ; sans document réel : aucune carte
 *   L114O-T05  AC23, AC28, AC31 : les cartes lisent le GRAPHE N↔N, plus le rôle « principal » ni la colonne
 *              historique — lien d'une carte sans aucun rôle posé, événement partagé cité par ses DEUX événements de
 *              référence, colonne historique intacte, isolation du compte
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { AnchoredOperationCandidate } from '@/services/ai/source-analysis/operation-candidates/prepare';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const AUJOURDHUI = '2040-01-10';
const facade = () => import('@/services/business-operations/operation-write.facade');
const pont = () => import('@/services/business-operations/graph/arbitration');
const consolidator = () => import('@/services/business-operations/consolidation/consolidator');
const bus = () => import('@/services/business-operations/events');

function cand(over: Partial<AnchoredOperationCandidate> = {}): AnchoredOperationCandidate {
  return {
    candidateKey: 'op1', established: true, confidence: 'certain', typeHint: 'INTERVENTION', statusHint: 'REALIZED',
    summary: 'Remplacement du ballon d’eau chaude', sourceRoleHint: 'INVOICE', provider: 'Plomberie Durand',
    targetHints: [], businessReferences: [], temporalHints: { realizedDate: '2039-06-05' }, financialHints: [], evidenceFactRefs: ['f1'],
    visualOnlyEvidence: false, exclusionReason: null, origin: 'PASS_1', adjustments: [], ...over,
  };
}
const cible = (entityId: number) => ({ type: 'ASSET' as const, entityId, rawLabel: null, confidence: 'certain' as const });

scenario('L114O-T', 'Opérations / Agenda CDC V2.0 — traitements et « À traiter » : refus de l’utilisateur tenu par T3, carte d’arbitrage d’une association', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  const user = (c: AccountRow, userId = c.ownerUserId): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId, channel: 'UI' } });
  const t3 = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'AI', treatment: 'T3' } });
  const doc = (ref: number | string) => ({ kind: 'DOCUMENT' as const, ref: String(ref) });

  async function t1(compte: AccountRow, fileId: number, candidats: AnchoredOperationCandidate[], reanalysis = false) {
    const [x] = await sql<{ id: number }[]>`SELECT id FROM document_extractions WHERE file_id = ${fileId}`;
    const extractionId = x?.id ?? (await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id) VALUES (${compte.id}, ${fileId}) RETURNING id`)[0].id;
    const { replaceOperationCandidates } = await import('@/services/ai/source-analysis/operation-candidates/persist');
    const { pgClient } = await import('@/db');
    await pgClient.begin(async (tx) => {
      await replaceOperationCandidates(tx as never, { accountId: compte.id, fileId, extractionId, analysisRunId: null, reanalysis, candidates: candidats, facts: new Map() });
    });
  }
  async function document(compte: AccountRow, titre: string, assetId: number | null = null): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET retained_title = ${titre} WHERE id = ${f.id}`;
    return f.id;
  }
  const consolider = async (compte: AccountRow, fileId: number) => (await consolidator()).consolidateDocument(compte.id, fileId, { today: AUJOURDHUI });
  const evenements = (compte: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, type_code, invalidated_at IS NOT NULL AS invalide, invalidation_reason AS motif
      FROM business_operations WHERE account_id = ${compte.id} AND merged_into_operation_id IS NULL ORDER BY id`;
  const candidat = async (fileId: number) => (await sql<Json[]>`
    SELECT candidate_key, t3_outcome, t3_reason, t3_operation_id::int AS t3_operation_id FROM document_operation_candidates WHERE file_id = ${fileId} AND status = 'ACTIVE'`)[0];
  const sourcesActives = (opId: number) => sql<Json[]>`
    SELECT source_kind AS kind, source_entity_key AS k FROM business_operation_sources WHERE operation_id = ${opId} AND active ORDER BY id`;

  /** Événement de référence créé par le dépôt (avec sa source : jamais d'événement sans fondement). */
  async function operation(compte: AccountRow, type: string, label: string): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => (await repo.create({
      type: { code: type } as never, status: 'REALIZED', technicalLabel: label,
      source: { kind: 'MIGRATION', entityKey: `l114o-t-${Math.random().toString(36).slice(2)}`, authority: 'STRUCTURED' }, reasonCode: 'L114O_T_E2E',
    })).id);
  }
  const relations = (compte: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, from_operation_id::int AS f, to_operation_id::int AS t, nature, state, origin, version FROM business_operation_relations
     WHERE account_id = ${compte.id} ORDER BY id`;
  const journal = (compte: AccountRow) => sql<Json[]>`
    SELECT action, origin, channel, actor_user_id, command FROM business_operation_graph_history WHERE account_id = ${compte.id} ORDER BY id`;
  const cartes = (compte: AccountRow) => sql<Json[]>`
    SELECT id, public_id::text AS public_id, target_type, target_id, relation_key, question, proposals_json, trigger_context,
           resolved_at IS NULL AS ouverte, resolution_reason, cycle_number
      FROM to_process_actions WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-RELATION' ORDER BY id`;
  const ouvertes = async (compte: AccountRow) => (await cartes(compte)).filter((c) => c.ouverte);
  const resoudre = async (compte: AccountRow, publicId: string, value: string, userId: number | null = compte.ownerUserId) => {
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    return resolveArbitration(compte.id, publicId, value, { userId });
  };
  const file = async (compte: AccountRow) => {
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    return (await getToProcessPage(compte.id, { withLinks: true })).actions as unknown as Json[];
  };
  /** Tout ce qu'une association ne doit JAMAIS toucher : coûts, événements d'Agenda, rappels, événements de référence. */
  async function empreinte(compte: AccountRow): Promise<string> {
    const [r] = await sql<{ h: string }[]>`
      SELECT md5(concat_ws('#',
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_financial_components t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operations t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM business_operation_sources t WHERE t.account_id = ${compte.id}),
        (SELECT COALESCE(md5(string_agg(t::text, '|' ORDER BY t.id)), '') FROM agenda_items t WHERE t.account_id = ${compte.id}),
        (SELECT count(*)::text FROM notification_outbox t WHERE t.account_id = ${compte.id}))) AS h`;
    return r.h;
  }

  // ══ T3 : un refus de l'utilisateur reste un refus ══════════════════════════

  it('L114O-T01 — événement de référence supprimé par l’utilisateur : T3 ne le réactive pas et n’en crée pas un nouveau à partir du même document ; un autre document reste une preuve nouvelle', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const facture = await document(compte, 'Facture ballon d’eau chaude', maison.id);
    await t1(compte, facture, [cand({ targetHints: [cible(maison.id)] })]);
    await consolider(compte, facture);
    const [x, ...autres] = await evenements(compte);
    expect(autres).toEqual([]);
    expect(x).toMatchObject({ type_code: 'INTERVENTION', invalide: false });
    expect(await candidat(facture)).toMatchObject({ t3_outcome: 'CREATE_NEW', t3_operation_id: x.id });

    // L'utilisateur supprime l'événement « créé à tort » (façade, jamais un DELETE).
    const f = await facade();
    expect(await f.invalidateOperation(user(compte), { operationId: x.id })).toMatchObject({ status: 'APPLIED', changed: true });
    expect(await evenements(compte)).toEqual([{ id: x.id, type_code: 'INTERVENTION', invalide: true, motif: 'USER_INVALIDATED' }]);

    // 1. Nouveau passage T3 sur le MÊME candidat : rien n'est créé, rien n'est réactivé, la source reste.
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${facture}`;
    await consolider(compte, facture);
    expect(await evenements(compte)).toEqual([{ id: x.id, type_code: 'INTERVENTION', invalide: true, motif: 'USER_INVALIDATED' }]);
    expect((await candidat(facture)).t3_outcome).not.toBe('CREATE_NEW');
    expect(await sourcesActives(x.id)).toEqual([{ kind: 'DOCUMENT', k: String(facture) }]);

    // 2. Réanalyse du document : candidat RENOMMÉ et REQUALIFIÉ (T3 ne retrouve plus l'ancien) — avant ce passage,
    //    T3 créait ici un nouvel événement de référence identique. Désormais : aucune création, motif tracé.
    await t1(compte, facture, [cand({ candidateKey: 'op9', typeHint: 'CONTRACT', summary: 'Contrat d’entretien du ballon d’eau chaude', targetHints: [cible(maison.id)] })], true);
    await consolider(compte, facture);
    expect(await evenements(compte)).toEqual([{ id: x.id, type_code: 'INTERVENTION', invalide: true, motif: 'USER_INVALIDATED' }]);
    expect(await candidat(facture)).toMatchObject({ candidate_key: 'op9', t3_outcome: 'NO_OPERATION', t3_reason: 'USER_INVALIDATED_REFERENCE_EVENT', t3_operation_id: null });
    // La source de l'événement supprimé n'est pas retirée par ce passage : la restauration reste possible.
    expect(await sourcesActives(x.id)).toEqual([{ kind: 'DOCUMENT', k: String(facture) }]);
    // Rejoué : toujours rien (idempotent).
    await sql`UPDATE document_operation_candidates SET t3_pending = true WHERE file_id = ${facture}`;
    await consolider(compte, facture);
    expect((await evenements(compte)).length).toBe(1);

    // 3. Un AUTRE document est une preuve nouvelle : il n'est pas concerné par le refus (AC14).
    const autre = await document(compte, 'Facture chaudière', maison.id);
    await t1(compte, autre, [cand({ summary: 'Remplacement de la chaudière', provider: 'Chauffage Martin', temporalHints: { realizedDate: '2039-09-12' }, targetHints: [cible(maison.id)] })]);
    await consolider(compte, autre);
    const apres = await evenements(compte);
    expect(apres.map((e) => e.invalide)).toEqual([true, false]);
    expect(await candidat(autre)).toMatchObject({ t3_outcome: 'CREATE_NEW', t3_operation_id: apres[1].id });

    // 4. Seul l'utilisateur lève son refus : la restauration rend le MÊME événement (aucun doublon).
    expect(await f.restoreOperation(user(compte), { operationId: x.id })).toMatchObject({ status: 'APPLIED', changed: true });
    expect((await evenements(compte)).map((e) => [e.id, e.invalide])).toEqual([[x.id, false], [apres[1].id, false]]);
    // Le document du fichier supprimé, lui, retire bien sa source (la protection ne vaut que pour un document valide).
  });

  it('L114O-T02 — élément d’Agenda saisi qui fondait un événement de référence supprimé : il reste dans l’Agenda, à sa date ; T3 n’en recrée pas', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    const evt = await createAgendaItem({ title: 'Remplacement chaudière prévu', startDate: '2040-06-12', assetIds: [maison.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    const { consolidateAgendaItems } = await import('@/services/business-operations/consolidation/agenda-source-consolidator');
    const passer = async () => (await consolidateAgendaItems(compte.id, [evt.id], { today: AUJOURDHUI }))[0];
    expect(await passer()).toMatchObject({ outcome: 'CREATE_NEW' });
    const [x, ...reste] = await evenements(compte);
    expect(reste).toEqual([]);
    expect(await sql<Json[]>`SELECT business_operation_id::int AS op FROM agenda_items WHERE id = ${evt.id}`).toEqual([{ op: x.id }]);

    const f = await facade();
    expect(await f.invalidateOperation(user(compte), { operationId: x.id })).toMatchObject({ status: 'APPLIED', changed: true });
    const rappels = await sql<Json[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`;

    // T3 réexamine l'élément (modification, balayage) : aucun nouvel événement de référence, motif tracé.
    for (let i = 0; i < 2; i++) {
      const r = await passer();
      expect(r).toMatchObject({ reason: 'USER_INVALIDATED_REFERENCE_EVENT', operationId: null });
      expect(r.outcome).not.toBe('CREATE_NEW');
    }
    expect(await evenements(compte)).toEqual([{ id: x.id, type_code: 'INTERVENTION', invalide: true, motif: 'USER_INVALIDATED' }]);
    // L'élément est toujours dans l'Agenda, à SA date, détaché, sans rappel ajouté ni retiré.
    expect(await sql<Json[]>`SELECT start_date::text AS date, business_operation_id AS op, title FROM agenda_items WHERE id = ${evt.id}`)
      .toEqual([{ date: '2040-06-12', op: null, title: 'Remplacement chaudière prévu' }]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM notification_outbox WHERE account_id = ${compte.id}`).toEqual(rappels);
  });

  // ══ « À traiter » : arbitrage d'une association ════════════════════════════

  it('L114O-T03 — « arbitrage requis » : une carte, question neutre, résolution par la façade, jamais reposée sur les mêmes preuves ; preuve nouvelle : nouvel arbitrage', async () => {
    const compte = await make.account({ plan: 'premium' });
    const pret = await operation(compte, 'FINANCING', 'Prêt immobilier');
    const achat = await operation(compte, 'ACQUISITION', 'Achat de la maison');
    const offre = await document(compte, 'Offre de prêt');
    const acte = await document(compte, 'Acte de vente');
    const tableau = await document(compte, 'Tableau d’amortissement');
    const f = await facade();
    const { associateOperationsOrAsk } = await pont();
    const demander = (preuves: number[]) => associateOperationsOrAsk(t3(compte), { fromOperationId: pret, toOperationId: achat, nature: 'FINANCING', evidence: preuves.map(doc) });

    // L'utilisateur refuse d'associer (preuve connue : l'offre de prêt).
    expect(await f.dissociateOperations(user(compte), { operationAId: pret, operationBId: achat, evidence: [doc(offre)] })).toMatchObject({ status: 'APPLIED', data: { state: 'REJECTED', version: 1 } });
    const avant = await empreinte(compte);

    // Même preuve : refus muet, aucune carte (un simple nouveau passage ne redemande rien).
    const muet = await demander([offre]);
    expect(muet).toMatchObject({ status: 'FORBIDDEN', code: 'USER_REJECTED' });
    expect(muet.arbitration).toBeUndefined();
    expect(await cartes(compte)).toEqual([]);

    // Preuve NOUVELLE : la façade n'écrit rien et répond « arbitrage requis » → UNE carte, sur le justificatif réel.
    const r1 = await demander([acte]);
    expect(r1).toMatchObject({ status: 'ARBITRATION_REQUIRED', code: 'NEW_EVIDENCE_AFTER_REFUSAL', changed: false, arbitration: { status: 'POSTED' } });
    const [carte, ...trop] = await cartes(compte);
    expect(trop).toEqual([]);
    expect(carte).toMatchObject({ target_type: 'DOCUMENT', target_id: acte, relation_key: `operationRelation:${Math.min(pret, achat)}:${Math.max(pret, achat)}`, ouverte: true });
    // Question neutre, sans le mot interdit, qui nomme les deux événements ; deux choix, aucun mis en avant.
    expect(carte.question).toMatch(/^Vous aviez choisi de ne pas associer « .*Prêt immobilier.* » et « .*Achat de la maison.* »\. Un nouveau justificatif les rapproche : faut-il les associer \?$/);
    expect(carte.question).not.toMatch(/op[ée]ration/i);
    expect((carte.proposals_json as Json[]).map((p) => [p.value, p.label, p.emphasis ?? null, p.isCurrentValue ?? false])).toEqual([
      ['ASSOCIATE', 'Oui, les associer', 'neutral', false], ['KEEP_SEPARATE', 'Non, ne pas les associer', null, true],
    ]);
    expect(carte.trigger_context).toMatchObject({ kind: 'operation_relation', relationVersion: 1, nature: 'FINANCING', evidenceKeys: [`DOCUMENT|${acte}`], documents: [{ fileId: acte, title: 'Acte de vente' }] });
    // La carte est dans la file du compte, avec son justificatif consultable.
    const vue = (await file(compte)).find((a) => a.publicId === carte.public_id)!;
    expect(vue).toMatchObject({ ruleCode: 'OPERATION-RELATION', question: carte.question });
    expect(vue.proposals.map((p: Json) => p.value)).toEqual(['ASSOCIATE', 'KEEP_SEPARATE']);
    // Rien d'autre n'a bougé : ni relation, ni journal, ni coût, ni Agenda, ni rappel.
    expect(await relations(compte)).toMatchObject([{ state: 'REJECTED', version: 1 }]);
    expect(await empreinte(compte)).toBe(avant);

    // Rejeu du traitement (même preuve nouvelle) : la MÊME carte, jamais une seconde.
    expect((await demander([acte])).arbitration).toMatchObject({ status: 'UPDATED' });
    expect((await demander([offre, acte])).arbitration).toMatchObject({ status: 'UPDATED' });
    expect((await cartes(compte)).length).toBe(1);

    // Réponse « Non » : par la façade (acteur utilisateur, canal « À traiter ») ; la relation reste refusée.
    const carteAJour = (await ouvertes(compte))[0];
    expect(await resoudre(compte, carteAJour.public_id, 'INVENTE')).toMatchObject({ ok: false, error: 'INVALID_VALUE' });
    expect(await resoudre(compte, carteAJour.public_id, 'KEEP_SEPARATE')).toMatchObject({ ok: true, undoable: false });
    expect(await ouvertes(compte)).toEqual([]);
    expect((await cartes(compte))[0]).toMatchObject({ ouverte: false, resolution_reason: 'USER_ARBITRATED' });
    expect(await relations(compte)).toMatchObject([{ state: 'REJECTED', version: 1 }]);
    expect(await resoudre(compte, carteAJour.public_id, 'ASSOCIATE')).toMatchObject({ ok: false, error: 'ALREADY_RESOLVED' });

    // NON RÉGÉNÉRÉE : les preuves déjà présentées ne font plus poser la question (la façade, elle, répond toujours
    // « arbitrage requis » : c'est la file qui se souvient de la réponse).
    for (const preuves of [[acte], [offre, acte]]) {
      const r = await demander(preuves);
      expect(r).toMatchObject({ status: 'ARBITRATION_REQUIRED', arbitration: { status: 'ALREADY_ANSWERED' } });
    }
    expect((await cartes(compte)).length).toBe(1);
    expect(await ouvertes(compte)).toEqual([]);

    // Preuve JAMAIS présentée : nouvel arbitrage explicite (AC14), nouvelle carte.
    expect((await demander([acte, tableau])).arbitration).toMatchObject({ status: 'POSTED' });
    const [seconde, ...trop2] = await ouvertes(compte);
    expect(trop2).toEqual([]);
    expect(seconde.public_id).not.toBe(carteAJour.public_id);
    expect(seconde.trigger_context.evidenceKeys).toEqual([`DOCUMENT|${acte}`, `DOCUMENT|${tableau}`]);

    // Réponse « Oui » : la façade lève le refus AU NOM DE L'UTILISATEUR ; journal ; aucun effet dérivé.
    expect(await resoudre(compte, seconde.public_id, 'ASSOCIATE')).toMatchObject({ ok: true, undoable: false });
    expect(await relations(compte)).toMatchObject([{ f: pret, t: achat, nature: 'FINANCING', state: 'ACTIVE', origin: 'USER', version: 2 }]);
    expect((await journal(compte)).map((j) => [j.action, j.origin, j.channel, j.actor_user_id, j.command])).toEqual([
      ['REJECTED', 'USER', 'UI', compte.ownerUserId, 'dissociateOperations'],
      ['REACTIVATED', 'USER', 'TO_PROCESS', compte.ownerUserId, 'associateOperations'],
    ]);
    expect(await ouvertes(compte)).toEqual([]);
    expect(await empreinte(compte)).toBe(avant);
    // Une fois associés : plus rien à demander (la façade répond « déjà fait »).
    const fin = await demander([acte, tableau]);
    expect(fin).toMatchObject({ status: 'APPLIED', changed: false });
    expect(fin.arbitration).toBeUndefined();
    expect((await cartes(compte)).length).toBe(2);
  });

  it('L114O-T04 — isolation du compte, acteur non membre, carte périmée fermée sans rien appliquer, aucune carte sans document réel', async () => {
    const a = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const sinistre = await operation(a, 'CLAIM', 'Dégât des eaux');
    const reparation = await operation(a, 'INTERVENTION', 'Réfection du plafond');
    const rapport = await document(a, 'Rapport d’expertise');
    const devis = await document(a, 'Devis plafond');
    const etranger = await document(b, 'Document du compte B');
    const f = await facade();
    const { associateOperationsOrAsk } = await pont();
    const t3a: OperationWriteContext = t3(a);
    expect(await f.dissociateOperations(user(a), { operationAId: sinistre, operationBId: reparation, evidence: [doc(rapport)] })).toMatchObject({ status: 'APPLIED', data: { state: 'REJECTED', version: 1 } });

    // Preuve d'un AUTRE compte : ce n'est pas une preuve de ce compte — aucune carte, rien n'est exposé.
    expect((await associateOperationsOrAsk(t3a, { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [doc(etranger)] })).arbitration)
      .toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_EVIDENCE_IN_ACCOUNT' });
    // Preuve sans document, événements sans justificatif : aucun document réel pour porter la carte — aucune carte, aucun document fictif.
    expect((await associateOperationsOrAsk(t3a, { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [{ kind: 'STRUCTURED', ref: 'claim:damage' }] })).arbitration)
      .toMatchObject({ status: 'NO_ANCHOR' });
    expect(await cartes(a)).toEqual([]);
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${a.id}`).toEqual([{ n: 2 }]);
    // Un traitement du compte B ne peut rien demander sur les événements du compte A.
    expect(await associateOperationsOrAsk(t3(b), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [doc(etranger)] })).toMatchObject({ status: 'FORBIDDEN', code: 'NOT_FOUND_IN_ACCOUNT' });

    // Carte posée dans le compte A (preuve nouvelle : le devis).
    expect((await associateOperationsOrAsk(t3a, { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [doc(devis), doc(etranger)] })).arbitration).toMatchObject({ status: 'POSTED' });
    const [carte] = await ouvertes(a);
    expect(carte.trigger_context.evidenceKeys).toEqual([`DOCUMENT|${devis}`]);
    // Invisible et non résoluble depuis le compte B.
    expect(await cartes(b)).toEqual([]);
    expect((await file(b)).some((x) => x.publicId === carte.public_id)).toBe(false);
    expect(await resoudre(b, carte.public_id, 'ASSOCIATE')).toMatchObject({ ok: false, error: 'NOT_FOUND' });
    // Acteur qui n'est pas membre du compte, ou non identifié : rien n'est appliqué, la carte reste ouverte.
    expect(await resoudre(a, carte.public_id, 'ASSOCIATE', b.ownerUserId)).toMatchObject({ ok: false, error: 'FIELD_NOT_RESOLVABLE' });
    expect(await resoudre(a, carte.public_id, 'ASSOCIATE', null)).toMatchObject({ ok: false, error: 'FIELD_NOT_RESOLVABLE' });
    expect(await relations(a)).toMatchObject([{ state: 'REJECTED', version: 1 }]);
    expect((await ouvertes(a)).length).toBe(1);

    // Carte PÉRIMÉE : entre-temps l'utilisateur a associé lui-même les deux événements (autre écran).
    expect(await f.associateOperations(user(a), { fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR' })).toMatchObject({ status: 'APPLIED', data: { state: 'ACTIVE', version: 2 } });
    // Elle n'est plus proposée dans la file…
    expect((await file(a)).some((x) => x.publicId === carte.public_id)).toBe(false);
    // … et une réponse tardive « Non » ne défait PAS l'association posée par l'utilisateur : carte fermée, rien appliqué.
    expect(await resoudre(a, carte.public_id, 'KEEP_SEPARATE')).toMatchObject({ ok: false, error: 'STALE' });
    expect(await relations(a)).toMatchObject([{ state: 'ACTIVE', origin: 'USER', version: 2 }]);
    expect((await cartes(a))[0]).toMatchObject({ ouverte: false, resolution_reason: 'OBSOLETE' });

    // Événement de référence supprimé : la carte ne vaut plus (aucune écriture).
    const autre = await operation(a, 'INTERVENTION', 'Peinture du salon');
    expect(await f.dissociateOperations(user(a), { operationAId: sinistre, operationBId: autre, evidence: [doc(rapport)] })).toMatchObject({ status: 'APPLIED' });
    expect((await associateOperationsOrAsk(t3a, { fromOperationId: sinistre, toOperationId: autre, nature: 'CLAIM_REPAIR', evidence: [doc(devis)] })).arbitration).toMatchObject({ status: 'POSTED' });
    const ouverte = (await ouvertes(a))[0];
    expect(await f.invalidateOperation(user(a), { operationId: autre })).toMatchObject({ status: 'APPLIED' });
    expect(await resoudre(a, ouverte.public_id, 'ASSOCIATE')).toMatchObject({ ok: false, error: 'STALE' });
    expect((await relations(a)).find((r) => r.t === autre || r.f === autre)).toMatchObject({ state: 'REJECTED' });
    expect(await ouvertes(a)).toEqual([]);
  });

  // ══ Les cartes lisent le graphe N↔N, plus le rôle « principal » ════════════

  it('L114O-T05 — cartes : les événements d’un événement de référence sont lus dans le graphe N↔N (aucun rôle « principal »), un événement partagé est cité par ses deux événements de référence, la colonne historique reste intacte', async () => {
    const compte = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const toiture = await operation(compte, 'INTERVENTION', 'Réfection de la toiture');
    const contrat = await operation(compte, 'CONTRACT', 'Contrat d’entretien de la toiture');
    // Créé en PREMIER (identifiant le plus petit) mais le PLUS TARD dans le temps : l'ordre des dates doit l'emporter.
    const tard = await make.agendaItem(compte, { title: 'Contrôle annuel', startDate: '2041-06-01', assetIds: [maison.id] });
    const tot = await make.agendaItem(compte, { title: 'Réfection de la toiture', startDate: '2040-03-01', assetIds: [maison.id] });
    expect(tard.id).toBeLessThan(tot.id);

    const f = await facade();
    for (const i of [tard, tot]) {
      expect(await f.linkAgendaItem(user(compte), { operationId: toiture, agendaItemId: i.id })).toMatchObject({ status: 'APPLIED', data: { support: 'LEGACY_COLUMN' } });
    }
    // La façade ne pose JAMAIS le rôle « principal » : les cartes ne peuvent donc plus s'y fier.
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM agenda_items WHERE account_id = ${compte.id} AND operation_role = 'PRINCIPAL'`).toEqual([{ n: 0 }]);

    // Lien d'une carte vers « l'événement de référence » : résolu sans rôle, sur l'événement RÉEL le plus ancien.
    const devis = await document(compte, 'Devis toiture', maison.id);
    const [{ public_id: carte }] = await sql<{ public_id: string }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, relation_key, action_kind, rule_code, question, proposals_json, trigger_context)
      VALUES (${compte.id}, 'DOCUMENT', ${devis}, ${`operationAmount:${toiture}:l114ot`}, 'ARBITRATE', 'OPERATION-AMOUNT', 'Quel montant retenir ?',
              ${JSON.stringify([{ value: 'AMOUNT:120000:EUR', label: '1 200,00 €', confidence: 0.6 }])}::jsonb, ${JSON.stringify({ operationId: toiture })}::jsonb)
      RETURNING public_id::text`;
    const { resolveCardLinks } = await import('@/services/to-process/card-links');
    const { selectDisplayedProposals } = await import('@/services/to-process/action-model');
    const liens = async (compteLu: AccountRow) => {
      const [r] = await sql<Json[]>`SELECT * FROM to_process_actions WHERE public_id::text = ${carte}`;
      return (await resolveCardLinks(compteLu.id, [{
        publicId: carte, ruleCode: r.rule_code, actionKind: r.action_kind, targetType: r.target_type, targetId: r.target_id,
        fieldKey: r.field_key, relationKey: r.relation_key, proposals: selectDisplayedProposals(r.proposals_json ?? []), triggerContext: r.trigger_context,
      }])).get(carte);
    };
    expect((await liens(compte))!.related).toEqual([{ kind: 'reference', id: tot.id, label: 'Réfection de la toiture' }]);
    // Isolation : la même carte lue depuis un autre compte ne rend aucun lien vers cet événement de référence.
    expect((await liens(autre))?.related ?? []).toEqual([]);

    // Événement PARTAGÉ : second lien dans le graphe seulement — l'élément n'est ni déplacé, ni dupliqué.
    expect(await f.linkAgendaItem(user(compte), { operationId: contrat, agendaItemId: tot.id })).toMatchObject({ status: 'APPLIED', data: { support: 'EXTRA' } });
    expect(await sql<Json[]>`
      SELECT business_operation_id::int AS op, start_date::text AS date FROM agenda_items WHERE id = ${tot.id}`)
      .toEqual([{ op: toiture, date: '2040-03-01' }]);
    expect(await sql<Json[]>`
      SELECT operation_id::int AS op, legacy_column FROM business_operation_agenda_links
       WHERE account_id = ${compte.id} AND agenda_item_id = ${tot.id} AND state = 'ACTIVE' ORDER BY operation_id`)
      .toEqual([{ op: toiture, legacy_column: true }, { op: contrat, legacy_column: false }].sort((x, y) => x.op - y.op));

    // Références présentées par une carte binaire : chaque événement de référence cite SES événements, le partagé les deux.
    const { loadOperationReferences } = await import('@/services/to-process/operation-match-binary');
    const refs = await loadOperationReferences(compte.id, [toiture, contrat]);
    expect(refs.get(toiture)!.filter((r) => r.kind === 'event').map((r) => r.id).sort((x, y) => x - y)).toEqual([tard.id, tot.id].sort((x, y) => x - y));
    expect(refs.get(contrat)!.filter((r) => r.kind === 'event').map((r) => [r.id, r.title, r.date]))
      .toEqual([[tot.id, 'Réfection de la toiture', '2040-03-01']]);
    // Isolation : rien pour un autre compte.
    expect([...(await loadOperationReferences(autre.id, [toiture, contrat])).keys()]).toEqual([]);

    // Un événement de référence supprimé par l'utilisateur ne cite plus rien (règle de lecture inchangée).
    expect(await f.invalidateOperation(user(compte), { operationId: contrat })).toMatchObject({ status: 'APPLIED' });
    expect([...(await loadOperationReferences(compte.id, [contrat])).keys()]).toEqual([]);
  });

  it('L114O-T06 — AC16 : aucun justificatif, mais un événement RÉEL de l’Agenda — la carte d’arbitrage existe, portée par cet événement, sans document fictif', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const sinistre = await operation(compte, 'CLAIM', 'Dégât des eaux');
    const reparation = await operation(compte, 'INTERVENTION', 'Réfection du plafond');
    const evt = await make.agendaItem(compte, { title: 'Passage de l’expert', startDate: '2040-04-02', assetIds: [maison.id] });
    const f = await facade();
    expect(await f.linkAgendaItem(user(compte), { operationId: sinistre, agendaItemId: evt.id })).toMatchObject({ status: 'APPLIED' });
    const documents = await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id}`;
    expect(documents).toEqual([{ n: 0 }]);
    expect(await f.dissociateOperations(user(compte), { operationAId: sinistre, operationBId: reparation, evidence: [{ kind: 'AGENDA', ref: String(evt.id) }] })).toMatchObject({ status: 'APPLIED' });

    // Preuve nouvelle (un AUTRE élément d'Agenda) : la façade demande l'arbitrage ; aucun document n'existe.
    const autre = await make.agendaItem(compte, { title: 'Réfection du plafond', startDate: '2040-05-20', assetIds: [maison.id] });
    const { associateOperationsOrAsk } = await pont();
    expect(await associateOperationsOrAsk(t3(compte), {
      fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [{ kind: 'AGENDA', ref: String(autre.id) }],
    })).toMatchObject({ status: 'ARBITRATION_REQUIRED', arbitration: { status: 'POSTED' } });
    const [carte, ...trop] = await cartes(compte);
    expect(trop).toEqual([]);
    // Portée par l'ÉVÉNEMENT réel du sinistre, jamais par un document créé pour l'occasion.
    expect(carte).toMatchObject({ target_type: 'AGENDA_ITEM', target_id: evt.id, ouverte: true });
    expect(await sql<Json[]>`SELECT count(*)::int AS n FROM asset_files WHERE account_id = ${compte.id}`).toEqual([{ n: 0 }]);
    expect(carte.trigger_context).toMatchObject({ documents: [], evidenceKeys: [`AGENDA|${autre.id}`] });
    // Elle est bien proposée dans la file du compte, avec la même question neutre.
    expect((await file(compte)).find((a) => a.publicId === carte.public_id)).toMatchObject({ ruleCode: 'OPERATION-RELATION', question: carte.question });
    // Rejeu : la MÊME carte, toujours sur le même objet (jamais une seconde).
    expect((await associateOperationsOrAsk(t3(compte), {
      fromOperationId: sinistre, toOperationId: reparation, nature: 'CLAIM_REPAIR', evidence: [{ kind: 'AGENDA', ref: String(autre.id) }],
    })).arbitration).toMatchObject({ status: 'UPDATED' });
    expect((await cartes(compte)).length).toBe(1);

    // Réponse « Oui » : appliquée par la façade, comme sur un justificatif.
    expect(await resoudre(compte, carte.public_id, 'ASSOCIATE')).toMatchObject({ ok: true, undoable: false });
    expect(await relations(compte)).toMatchObject([{ nature: 'CLAIM_REPAIR', state: 'ACTIVE', origin: 'USER', version: 2 }]);
    expect(await ouvertes(compte)).toEqual([]);
    // L'événement de l'Agenda n'a pas bougé : même date, même titre, même rattachement.
    expect(await sql<Json[]>`SELECT start_date::text AS date, title, business_operation_id::int AS op FROM agenda_items WHERE id = ${evt.id}`)
      .toEqual([{ date: '2040-04-02', title: 'Passage de l’expert', op: sinistre }]);
  });
});
