/**
 * Lot 116C, seconde partie (carte Trello #806 §9 « À traiter » ; CDC
 * « Opérations / Agenda V2.0 » §8 ; AC16 à AC18) — les arbitrages d'ASSOCIATION
 * posés par T3 (proposition sinistre ↔ assurance du lot 116C, association
 * refusée rapprochée par une preuve nouvelle) : compréhensibles, dédupliqués,
 * clos quand ils sont résolus, jamais redemandés. Sur PostgreSQL 16 réel, par
 * les chemins de PRODUCTION : recherche de l'assurance, façade d'écriture du
 * graphe, lecture de la file (`getToProcessPage`), route de revalidation des
 * liens (`POST /api/v2/to-process/:id/links`), résolution (`resolveArbitration`),
 * balayage horaire (`produceReferenceEventActions`). Aucune IA. Dates fixes.
 *
 *   L116CB-A01  NAVIGATION DE RETOUR : la carte est lue avec ses liens (objet réel, justificatifs) ; l'utilisateur ouvre
 *               l'objet, corrige depuis la FICHE de l'opération (associe l'un, refuse l'autre), revient : la file relue ne
 *               montre plus ces cartes (statut actualisé sans attendre un passage) ; le balayage horaire les FERME « sans
 *               objet », tracé, sans rien appliquer ; rejoué : rien ; une réponse tardive à la carte périmée n'écrit rien ;
 *               rien n'est reposé
 *   L116CB-A02  opération retirée (sinistre invalidé) : ses cartes ne sont plus montrées, puis fermées ; aucune carte
 *               obsolète ne reste ouverte
 *   L116CB-A03  CHAQUE CHOIX mène à une action AUDITÉE (journal du graphe : auteur, canal « À traiter », motif ; événement
 *               de la carte), NON DESTRUCTIVE (opérations, justificatifs, montants, événements, rappels inchangés) et
 *               ANNULABLE par les gestes existants de la fiche (dissocier après « oui », associer après « non ») ; après
 *               la décision de l'utilisateur, plus aucune redemande
 *   L116CB-A04  DÉDUPLICATION et borne : une carte par paire quel que soit le nombre de passages ; au plus 3 contrats
 *               proposés par sinistre ; chaque carte affiche deux réponses dont l'état actuel (règle §8.5 de la file)
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';
import type { OperationWriteContext } from '@/services/business-operations/operation-write.facade';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    requireAdmin: async () => session.userId,
    tryGetSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Json = Record<string, any>;
const recherche = () => import('@/services/business-operations/claims/insurance-association');
const bus = () => import('@/services/business-operations/events');
const facade = () => import('@/services/business-operations/operation-write.facade');

scenario('L116CB-A', 'Carte #806 §9 — « À traiter » : arbitrages d’association dédupliqués, clos quand ils sont résolus, jamais redemandés ; retour depuis la carte', ({ sql, make }) => {
  afterEach(async () => {
    (await bus()).resetBusinessOperationEventBusForTests();
  });
  beforeAll(async () => {
    await import('@/services/business-operations/consolidation/queue');
  });

  /** Justificatif du compte avec son Type documentaire (référentiel V2). */
  async function piece(compte: AccountRow, assetId: number, type: string): Promise<number> {
    const f = await make.assetFile(compte, { assetId });
    await sql`UPDATE asset_files SET document_type_code = ${type} WHERE id = ${f.id}`;
    return f.id;
  }
  async function operation(compte: AccountRow, type: 'CONTRACT' | 'CLAIM' | 'INTERVENTION', assetId: number, fileId: number, over: { label?: string; realized?: string | null; refs?: Array<{ kind: 'POLICY' | 'CONTRACT'; value: string }> } = {}): Promise<number> {
    const { withBusinessOperationWrite } = await import('@/services/business-operations/write');
    return withBusinessOperationWrite(compte.id, async (repo) => {
      const cree = await repo.create({
        type: { code: type }, status: 'REALIZED', technicalLabel: over.label ?? null, ...(over.realized ? { realizedDate: over.realized } : {}),
        source: { kind: 'DOCUMENT', entityKey: fileId, role: 'INVOICE', authority: 'DOCUMENT', confidence: 'certain', locator: { e2e: 'l116c-a' } },
        assets: [{ assetId, role: 'PRIMARY', authority: 'DOCUMENT' }], reasonCode: 'L116C_A_E2E',
      });
      for (const r of over.refs ?? []) await repo.addReference(cree.id, { kind: r.kind, value: r.value, sourceId: cree.sourceId });
      return cree.id;
    });
  }
  const couverture = (compte: AccountRow, fileId: number, start: string | null, end: string | null) => sql`
    INSERT INTO document_business_periods (account_id, file_id, period_kind, segment_index, start_on, end_on, origin, basis)
    VALUES (${compte.id}, ${fileId}, 'COVERAGE', 0, ${start}, ${end}, 'T1', 'T1_PERIOD_FACT')`;
  /** Contrat d'assurance du bien : police (Type INSURANCE_POLICY) et, si demandé, sa période de couverture. */
  async function assurance(compte: AccountRow, assetId: number, over: { label?: string; periode?: [string | null, string | null]; police?: string; type?: string } = {}) {
    const fileId = await piece(compte, assetId, over.type ?? 'INSURANCE_POLICY');
    if (over.periode) await couverture(compte, fileId, over.periode[0], over.periode[1]);
    const id = await operation(compte, 'CONTRACT', assetId, fileId, { label: over.label ?? 'Assurance habitation', ...(over.police ? { refs: [{ kind: 'POLICY', value: over.police }] } : {}) });
    return { id, fileId };
  }
  async function sinistre(compte: AccountRow, assetId: number, over: { label?: string; survenance?: string | null; police?: string } = {}) {
    const fileId = await piece(compte, assetId, 'CLAIM_DECLARATION');
    const id = await operation(compte, 'CLAIM', assetId, fileId, {
      label: over.label ?? 'Dégât des eaux', realized: over.survenance === undefined ? '2026-03-12' : over.survenance,
      ...(over.police ? { refs: [{ kind: 'POLICY', value: over.police }] } : {}),
    });
    return { id, fileId };
  }
  const chercher = async (compte: AccountRow, ids: number[]) => (await recherche()).syncClaimInsuranceAssociations(compte.id, { operationIds: ids });
  const relations = (compte: AccountRow) => sql<Json[]>`
    SELECT LEAST(from_operation_id, to_operation_id)::int AS a, GREATEST(from_operation_id, to_operation_id)::int AS b, nature, state, origin, reason_code, evidence
      FROM business_operation_relations WHERE account_id = ${compte.id} ORDER BY id`;
  const cartes = (compte: AccountRow) => sql<Json[]>`
    SELECT public_id, rule_code, relation_key, question, target_type, target_id::int AS target_id, trigger_context
      FROM to_process_actions WHERE account_id = ${compte.id} AND resolved_at IS NULL ORDER BY id`;
  const actives = async (compte: AccountRow) => (await sql<Json[]>`
    SELECT id::int AS id FROM business_operations WHERE account_id = ${compte.id} AND invalidated_at IS NULL AND merged_into_operation_id IS NULL ORDER BY id`).map((o) => Number(o.id));
  const repondre = async (compte: AccountRow, publicId: string, value: string) => {
    const { resolveArbitration } = await import('@/services/to-process/resolve-action.service');
    return resolveArbitration(compte.id, publicId, value, { userId: compte.ownerUserId });
  };
  const effets = async (compte: AccountRow) => (await sql<Json[]>`
    SELECT (SELECT count(*)::int FROM business_operation_financial_components WHERE account_id = ${compte.id}) AS composantes,
           (SELECT count(*)::int FROM agenda_items WHERE account_id = ${compte.id}) AS evenements,
           (SELECT count(*)::int FROM notification_outbox WHERE account_id = ${compte.id}) AS rappels,
           (SELECT count(*)::int FROM business_operation_claim_details d JOIN business_operations o ON o.id = d.operation_id
             WHERE o.account_id = ${compte.id} AND d.insurance_contract_operation_id IS NOT NULL) AS liens_specialises`)[0];

  const fiche = (c: AccountRow): OperationWriteContext => ({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } });
  const asUser = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  /** La file telle que la page « À traiter » la lit (cartes publiables, avec leurs liens). */
  const file = async (compte: AccountRow): Promise<Json[]> => {
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    const page = await getToProcessPage(compte.id, { withLinks: true }) as unknown as Json;
    return ((page.actions ?? page.items ?? []) as Json[]).filter((a) => a.ruleCode === 'OPERATION-RELATION');
  };
  const lien = async (publicId: string, target: { kind: string; id: number }): Promise<string> => {
    const route = await import('@/app/api/v2/to-process/[publicId]/links/route');
    const r = await route.POST(new NextRequest(`http://x/api/v2/to-process/${publicId}/links`, { method: 'POST', body: JSON.stringify({ target }) }),
      { params: Promise.resolve({ publicId }) });
    expect(r.status).toBe(200);
    return (await r.json()).status as string;
  };
  const balayer = async (compte: AccountRow) => (await import('@/services/to-process/reference-event-sweep')).produceReferenceEventActions(compte.id);
  const toutesLesCartes = (compte: AccountRow) => sql<Json[]>`
    SELECT id::int AS id, public_id, resolved_at, resolution_reason, trigger_context FROM to_process_actions
     WHERE account_id = ${compte.id} AND rule_code = 'OPERATION-RELATION' ORDER BY id`;
  const evenementsDe = (compte: AccountRow, actionId: number) => sql<Json[]>`
    SELECT event, actor_user_id, details FROM to_process_action_events WHERE account_id = ${compte.id} AND action_id = ${actionId} ORDER BY id`;
  const journal = (compte: AccountRow) => sql<Json[]>`
    SELECT command, action, origin, channel, actor_user_id, reason_code, operation_id::int AS op, other_operation_id::int AS autre
      FROM business_operation_graph_history WHERE account_id = ${compte.id} AND relation_kind = 'OPERATION_RELATION' ORDER BY id`;
  /** Ce qu'une décision d'association ne doit JAMAIS toucher. */
  const intact = async (compte: AccountRow) => (await sql<Json[]>`
    SELECT (SELECT COALESCE(md5(string_agg(o.id::text || o.type_code || COALESCE(o.realized_date::text, '') || COALESCE(o.technical_label, ''), '|' ORDER BY o.id)), '')
              FROM business_operations o WHERE o.account_id = ${compte.id} AND o.invalidated_at IS NULL AND o.merged_into_operation_id IS NULL) AS operations,
           (SELECT count(*)::int FROM asset_files WHERE account_id = ${compte.id} AND deleted_at IS NULL) AS justificatifs,
           (SELECT count(*)::int FROM business_operation_documents WHERE account_id = ${compte.id} AND active) AS liens_justificatifs,
           (SELECT count(*)::int FROM business_operation_sources WHERE account_id = ${compte.id} AND active) AS sources,
           (SELECT count(*)::int FROM business_operation_financial_components WHERE account_id = ${compte.id}) AS composantes,
           (SELECT count(*)::int FROM agenda_items WHERE account_id = ${compte.id}) AS evenements,
           (SELECT count(*)::int FROM agenda_file_links l JOIN agenda_items i ON i.id = l.agenda_item_id WHERE i.account_id = ${compte.id}) AS liens_directs,
           (SELECT count(*)::int FROM notification_outbox WHERE account_id = ${compte.id}) AS rappels`)[0];
  const paire = (x: Json, a: number, b: number) => x.a === Math.min(a, b) && x.b === Math.max(a, b);

  /** Un sinistre et DEUX assurances possibles sur le même bien : deux questions ciblées. */
  async function deuxAssurances() {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const habitation = await assurance(compte, maison.id, { label: 'Assurance habitation', periode: ['2026-01-01', '2026-12-31'] });
    const proprietaire = await assurance(compte, maison.id, { label: 'Assurance propriétaire non occupant', periode: ['2025-07-01', '2026-06-30'] });
    const s = await sinistre(compte, maison.id);
    expect((await chercher(compte, [s.id])).outcomes).toMatchObject([{ claimOperationId: s.id, outcome: 'ASKED' }]);
    asUser(compte);
    return { compte, maison, habitation, proprietaire, s };
  }

  it('L116CB-A01 — retour depuis la carte : ouvrir l’objet, corriger depuis la fiche, revenir — statut actualisé, carte fermée sans rien appliquer, jamais reposée', async () => {
    const d = await deuxAssurances();
    const lues = await file(d.compte);
    expect(lues).toHaveLength(2);
    const carteDe = (l: Json[], contratId: number) => l.find((c) => Number((c.links?.object ?? {}).id) === (contratId === d.habitation.id ? d.habitation.fileId : d.proprietaire.fileId));
    // Carte compréhensible : question ciblée, objet RÉEL ouvrable (le justificatif d'assurance), deux réponses.
    for (const c of lues) {
      expect(c.question).toMatch(/^Faut-il associer « /);
      expect(c.links.object).toMatchObject({ kind: 'document' });
      expect(c.links.objectUnavailable).toBeNull();
      expect(c.proposals.map((p: Json) => p.value)).toEqual(['ASSOCIATE', 'KEEP_SEPARATE']);
    }
    const cHabitation = carteDe(lues, d.habitation.id)!;
    const cProprietaire = carteDe(lues, d.proprietaire.id)!;
    expect(cHabitation).toBeTruthy();
    expect(cProprietaire).toBeTruthy();
    // 1. OUVRIR L'OBJET : le lien est revalidé au clic, dans le compte de la session.
    expect(await lien(cHabitation.publicId, { kind: 'document', id: d.habitation.fileId })).toBe('ok');
    // Un objet qui n'est pas celui de la carte, ou la carte lue depuis un autre compte : rien ne s'ouvre.
    expect(await lien(cHabitation.publicId, { kind: 'document', id: d.proprietaire.fileId })).toBe('gone');
    const autre = await make.account({ plan: 'premium' });
    asUser(autre);
    expect(await lien(cHabitation.publicId, { kind: 'document', id: d.habitation.fileId })).toBe('gone');
    asUser(d.compte);
    const avant = await intact(d.compte);

    // 2. CORRIGER DEPUIS LA FICHE DE L'OPÉRATION : associer le sinistre à l'habitation, refuser l'autre contrat.
    const f = await facade();
    expect(await f.associateOperations(fiche(d.compte), { fromOperationId: d.s.id, toOperationId: d.habitation.id, nature: 'ASSOCIATED', evidence: [], reasonCode: 'USER_ASSOCIATION' }))
      .toMatchObject({ status: 'APPLIED' });
    // 3. REVENIR : la file relue ne montre plus la carte résolue ailleurs — sans attendre aucun passage.
    const retour = await file(d.compte);
    expect(retour.map((c) => c.publicId)).toEqual([cProprietaire.publicId]);
    expect(await f.dissociateOperations(fiche(d.compte), { operationAId: d.s.id, operationBId: d.proprietaire.id, evidence: [], reasonCode: 'USER_DISSOCIATION' }))
      .toMatchObject({ status: 'APPLIED' });
    expect(await file(d.compte)).toEqual([]);

    // 4. Le balayage horaire FERME les deux cartes « sans objet », tracé, sans rien appliquer.
    const etatAvant = await relations(d.compte);
    const passage = await balayer(d.compte);
    expect(passage.closed).toBe(2);
    expect(passage.created).toBe(0);
    const fermees = await toutesLesCartes(d.compte);
    expect(fermees).toHaveLength(2);
    for (const c of fermees) {
      expect(c.resolved_at).not.toBeNull();
      expect(c.resolution_reason).toBe('OBSOLETE');
      const ev = await evenementsDe(d.compte, c.id);
      expect(ev.at(-1)).toMatchObject({ event: 'OBSOLETE', actor_user_id: null });
      expect(ev.at(-1)!.details).toMatchObject({ ruleCode: 'OPERATION-RELATION', reason: 'ASSOCIATION_ALREADY_SETTLED' });
    }
    // La fermeture n'a rien appliqué : les relations sont celles que l'utilisateur a posées depuis la fiche.
    expect(await relations(d.compte)).toEqual(etatAvant);
    expect((await relations(d.compte)).map((x) => [paire(x, d.s.id, d.habitation.id) ? 'habitation' : 'proprietaire', x.state, x.origin]).sort())
      .toEqual([['habitation', 'ACTIVE', 'USER'], ['proprietaire', 'REJECTED', 'USER']]);
    expect(await intact(d.compte)).toEqual(avant);
    // Rejoué : rien de plus (idempotent).
    expect((await balayer(d.compte)).closed).toBe(0);
    // Une réponse tardive à la carte périmée (onglet resté ouvert) n'écrit rien ; le lien dit « déjà traitée ».
    expect(await lien(cHabitation.publicId, { kind: 'document', id: d.habitation.fileId })).toBe('resolved');
    const tardive = await repondre(d.compte, cProprietaire.publicId, 'ASSOCIATE').catch((e: Error) => ({ ok: false, error: e.message }));
    expect(tardive).toMatchObject({ ok: false });
    expect(await relations(d.compte)).toEqual(etatAvant);
    // Plus aucune redemande après la décision de l'utilisateur, quel que soit le nombre de passages.
    for (let n = 0; n < 3; n++) {
      await chercher(d.compte, [d.s.id, d.habitation.id, d.proprietaire.id]);
      await balayer(d.compte);
    }
    expect(await cartes(d.compte)).toEqual([]);
    expect(await toutesLesCartes(d.compte)).toHaveLength(2);
  });

  it('L116CB-A02 — opération retirée : ses cartes ne sont plus montrées, puis fermées ; aucune carte obsolète ne reste ouverte', async () => {
    const d = await deuxAssurances();
    expect(await file(d.compte)).toHaveLength(2);
    // Le sinistre est retiré (invalidation logique : rien n'est supprimé).
    await sql`UPDATE business_operations SET invalidated_at = now(), invalidation_reason = 'L116CB_E2E' WHERE id = ${d.s.id} AND account_id = ${d.compte.id}`;
    expect(await file(d.compte)).toEqual([]);
    expect((await balayer(d.compte)).closed).toBe(2);
    expect(await cartes(d.compte)).toEqual([]);
    expect((await toutesLesCartes(d.compte)).every((c) => c.resolution_reason === 'OBSOLETE')).toBe(true);
    // Aucune relation n'a été écrite par la fermeture ; les deux contrats sont intacts.
    expect(await relations(d.compte)).toEqual([]);
    expect(await actives(d.compte)).toEqual([d.habitation.id, d.proprietaire.id].sort((x, y) => x - y));
  });

  it('L116CB-A03 — chaque choix : action auditée, non destructive, annulable par les gestes de la fiche ; aucune redemande ensuite', async () => {
    const d = await deuxAssurances();
    const avant = await intact(d.compte);
    const posees = await cartes(d.compte);
    const carteDe = (contratId: number) => posees.find((c) => Number(c.trigger_context.toOperationId) === contratId)!;
    const [idOui] = (await toutesLesCartes(d.compte)).filter((c) => c.public_id === carteDe(d.habitation.id).public_id).map((c) => c.id);
    const [idNon] = (await toutesLesCartes(d.compte)).filter((c) => c.public_id === carteDe(d.proprietaire.id).public_id).map((c) => c.id);

    // « Oui » et « Non » : appliqués par la façade, au nom de l'utilisateur.
    expect(await repondre(d.compte, carteDe(d.habitation.id).public_id, 'ASSOCIATE')).toMatchObject({ ok: true });
    expect(await repondre(d.compte, carteDe(d.proprietaire.id).public_id, 'KEEP_SEPARATE')).toMatchObject({ ok: true });
    // AUDIT — journal du graphe : auteur, canal « À traiter », motif, les deux opérations.
    const lignes = await journal(d.compte);
    expect(lignes.filter((l) => l.channel === 'TO_PROCESS').map((l) => [l.command, l.origin, l.actor_user_id, l.reason_code]).sort()).toEqual([
      ['associateOperations', 'USER', d.compte.ownerUserId, 'TO_PROCESS_ASSOCIATION_ACCEPTED'],
      ['dissociateOperations', 'USER', d.compte.ownerUserId, 'TO_PROCESS_ASSOCIATION_REFUSED'],
    ]);
    // AUDIT — événement de chaque carte : choix, auteur, paire.
    for (const [id, choix] of [[idOui, 'ASSOCIATE'], [idNon, 'KEEP_SEPARATE']] as const) {
      const ev = (await evenementsDe(d.compte, id)).at(-1)!;
      expect(ev).toMatchObject({ event: 'RESOLVED_ARBITRATION', actor_user_id: d.compte.ownerUserId });
      expect(ev.details).toMatchObject({ ruleCode: 'OPERATION-RELATION', choice: choix });
    }
    expect((await toutesLesCartes(d.compte)).map((c) => c.resolution_reason)).toEqual(['USER_ARBITRATED', 'USER_ARBITRATED']);
    // NON DESTRUCTIF : ni opération, ni justificatif, ni lien direct, ni montant, ni événement, ni rappel n'a changé ;
    // les trois opérations restent distinctes (rien n'est fusionné).
    expect(await intact(d.compte)).toEqual(avant);
    expect(await actives(d.compte)).toHaveLength(3);
    expect((await effets(d.compte)).liens_specialises).toBe(0);

    // ANNULABLE par les gestes existants de la fiche — « oui » défait : les deux opérations sont dissociées…
    const f = await facade();
    expect(await f.dissociateOperations(fiche(d.compte), { operationAId: d.s.id, operationBId: d.habitation.id, evidence: [], reasonCode: 'USER_DISSOCIATION' }))
      .toMatchObject({ status: 'APPLIED' });
    // … « non » défait : l'utilisateur associe lui-même ce qu'il avait refusé.
    expect(await f.associateOperations(fiche(d.compte), { fromOperationId: d.s.id, toOperationId: d.proprietaire.id, nature: 'ASSOCIATED', evidence: [], reasonCode: 'USER_ASSOCIATION' }))
      .toMatchObject({ status: 'APPLIED' });
    const apres = await relations(d.compte);
    expect(apres.find((x) => paire(x, d.s.id, d.habitation.id))).toMatchObject({ state: 'REJECTED', origin: 'USER' });
    expect(apres.find((x) => paire(x, d.s.id, d.proprietaire.id))).toMatchObject({ state: 'ACTIVE', origin: 'USER' });
    expect(await intact(d.compte)).toEqual(avant);
    // Chaque geste est au journal (quatre écritures de l'utilisateur, aucune d'un traitement).
    expect((await journal(d.compte)).map((l) => l.origin)).toEqual(['USER', 'USER', 'USER', 'USER']);

    // PAS DE REDEMANDE : la décision de l'utilisateur tient face aux passages suivants.
    for (let n = 0; n < 3; n++) {
      await chercher(d.compte, [d.s.id, d.habitation.id, d.proprietaire.id]);
      await balayer(d.compte);
    }
    expect(await cartes(d.compte)).toEqual([]);
    expect(await file(d.compte)).toEqual([]);
    expect(await relations(d.compte)).toEqual(apres);
  });

  it('L116CB-A04 — déduplication et borne : une carte par paire quel que soit le nombre de passages ; au plus 3 contrats par sinistre ; deux réponses dont l’état actuel', async () => {
    const compte = await make.account({ plan: 'premium' });
    const maison = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const contrats: number[] = [];
    for (const n of [1, 2, 3, 4]) contrats.push((await assurance(compte, maison.id, { label: `Assurance ${n}`, periode: ['2026-01-01', '2026-12-31'] })).id);
    const s = await sinistre(compte, maison.id);
    for (let n = 0; n < 4; n++) {
      await chercher(compte, [s.id]);
      await balayer(compte);
    }
    const ouvertes = await cartes(compte);
    // Borne du lot 116C : au plus 3 contrats proposés par sinistre ; jamais deux cartes pour la même paire.
    expect(ouvertes).toHaveLength(3);
    const paires = ouvertes.map((c) => c.trigger_context.pairKey as string);
    expect(new Set(paires).size).toBe(3);
    expect(new Set(ouvertes.map((c) => c.relation_key)).size).toBe(3);
    expect(await toutesLesCartes(compte)).toHaveLength(3);
    for (const c of ouvertes) expect(contrats).toContain(Number(c.trigger_context.toOperationId));
    // Règle §8.5 de la file : deux propositions au plus, plus la valeur actuelle — ici deux réponses dont l'état actuel.
    const { selectDisplayedProposals, DISPLAYED_PROPOSALS_MAX } = await import('@/services/to-process/action-model');
    asUser(compte);
    for (const c of await file(compte)) {
      const affichees = selectDisplayedProposals(c.proposals, 'OPERATION-RELATION');
      expect(affichees.map((p) => p.value)).toEqual(['ASSOCIATE', 'KEEP_SEPARATE']);
      expect(affichees.filter((p) => p.isCurrentValue)).toHaveLength(1);
      expect(affichees.filter((p) => !p.isCurrentValue).length).toBeLessThanOrEqual(DISPLAYED_PROPOSALS_MAX);
    }
    // Aucune association d'office dans le doute.
    expect(await relations(compte)).toEqual([]);
  });
});
