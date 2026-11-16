/**
 * Lot 114X (Trello #753, CDC T2 §9, §14.3 W21 – W26, §14.4 « Opérations », X69 – X73, E2E-04) —
 * LES ÉVÉNEMENTS DE RÉFÉRENCE DEPUIS L'ASSISTANT, de bout en bout sur PostgreSQL réel : plan figé,
 * confirmation par identifiant seul, état relu, exécution par la façade métier du graphe
 * (`operation-write.facade`, carte #744) — la vraie, sans simulation. Aucune IA.
 *
 *   E01  W21 : créé sur déclaration après confirmation seulement, une seule fois ; source durable (déclaration,
 *        auteur, canal Assistant) ; ni document, ni échéance, ni montant créés ; même déclaration redite : aucun doublon ;
 *   E02  W22 : correction écrite avec sa déclaration ; modifié depuis l'aperçu → rien n'est écrit ;
 *   E03  W23 : invalidation logique — rien n'est supprimé (document, échéance) ; l'événement n'est plus trouvé ;
 *   E04  W24 : financement ↔ achat associés, deux événements distincts, aucune fusion ; redemandé : déjà associés ;
 *   E05  W25, W26 : document rattaché, fournisseur relié (décision de l'utilisateur) ;
 *   E06  un seul plan, plusieurs actions sur le même événement ; déclaration implicite ;
 *   E07  cloisonnement des comptes ; plan d'un autre compte ; compte passé en lecture seule ;
 *   E08  passage 114Z4 : « Déclare … PUIS relie / rattache … à celui-ci » — l'événement visé est celui que la
 *        première action enregistre (identifiant posé à l'exécution) ; la déclaration refusée n'écrit rien.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;

scenario('L114X-EVENEMENTS-REFERENCE', 'Lot 114X — créer, corriger, supprimer, associer un événement de référence, y rattacher un document et un fournisseur depuis l’Assistant', ({ sql, make }) => {
  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${b.id}`;
    return b.id as number;
  };
  const demander = async (c: Compte, message: string, extra: Json = {}) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message, clientRequestId: `l114x-${Math.random()}`, locale: 'fr-FR', ...extra } as never);
  };
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };
  /** Demande, vérifie que rien n'est écrit avant, confirme. */
  const faire = async (c: Compte, message: string) => {
    const r = planDe(await demander(c, message));
    return { plan: r, conf: await confirmer(c, r.plan.planId) };
  };
  const evenements = (c: Compte) => sql<Json[]>`
    SELECT id::int AS id, type_code, status, technical_label, provider, planned_date::text AS planned, start_date::text AS debut, realized_date::text AS realise,
           end_date::text AS fin, version, invalidated_at IS NOT NULL AS invalide, invalidation_reason AS motif
      FROM business_operations WHERE account_id = ${c.id} ORDER BY id`;
  const journal = (c: Compte) => sql<Json[]>`
    SELECT relation_kind AS kind, action, origin, channel, actor_user_id, command, idempotency_key FROM business_operation_graph_history WHERE account_id = ${c.id} ORDER BY id`;
  const document = async (c: Compte, assetId: number, titre: string) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET original_filename = ${`${titre}.pdf`}, retained_title = ${titre}, document_date = '2025-03-12'::date WHERE id = ${f.id}`;
    return f.id as number;
  };
  const fournisseur = async (c: Compte, name: string) => {
    const { createSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    return (await createSupplierForAccount({ accountId: c.id, userId: c.ownerUserId, input: { name } })).id;
  };
  const lectureSeule = async (c: Compte) => {
    await sql`DELETE FROM account_subscriptions WHERE account_id = ${c.id}`;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${c.id}, 'premium', 'trialing', now() - interval '1 day')`;
  };
  const VIDANGE = 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio';

  it('L114X-E01 — W21 : créé sur déclaration, après confirmation seulement, une seule fois ; aucun doublon', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const r = planDe(await demander(c, VIDANGE));
    expect(r.preview.summary).toBe('Enregistrer l’événement de référence « Intervention — Vidange » du 12 mars 2025 pour Clio. Confirmez-vous ?');
    // La limite est dite AVANT l'écriture : rien n'est promis sur un écran.
    expect(r.plan.actions[0].effects.join(' ')).toMatch(/n’apparaît sur aucun écran de l’application \(ni fiche, ni recherche\)/);
    expect(JSON.stringify(r.preview)).not.toMatch(/op[ée]ration/i);
    // Rien n'est écrit avant la confirmation.
    expect(await evenements(c)).toHaveLength(0);
    expect(await sql`SELECT 1 FROM business_operation_declarations WHERE account_id = ${c.id}`).toHaveLength(0);
    const agendaAvant = await sql`SELECT id FROM agenda_items WHERE account_id = ${c.id}`;

    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    expect(JSON.stringify(conf)).toMatch(/Événement de référence « Intervention — Vidange » enregistré\. Pour l’instant, un événement de référence enregistré sur votre déclaration n’apparaît sur aucun écran/);
    const [ev] = await evenements(c);
    expect(ev).toMatchObject({ type_code: 'INTERVENTION', status: 'REALIZED', technical_label: 'Vidange', realise: '2025-03-12', planned: null, debut: null, fin: null, provider: null, invalide: false });
    // Source durable : la déclaration (texte, auteur, canal Assistant) et la source de l'événement ; bien lié par l'utilisateur.
    expect(await sql<Json[]>`SELECT operation_id::int AS op, purpose, channel, author_user_id, declaration_text FROM business_operation_declarations WHERE account_id = ${c.id}`)
      .toEqual([{ op: ev.id, purpose: 'CREATE', channel: 'ASSISTANT', author_user_id: c.ownerUserId, declaration_text: VIDANGE }]);
    expect(await sql<Json[]>`SELECT source_kind, authority, active FROM business_operation_sources WHERE operation_id = ${ev.id} AND account_id = ${c.id}`)
      .toEqual([{ source_kind: 'USER_DECLARATION', authority: 'USER', active: true }]);
    expect(await sql<Json[]>`SELECT asset_id, authority, active FROM business_operation_asset_links WHERE operation_id = ${ev.id}`).toEqual([{ asset_id: clio, authority: 'USER', active: true }]);
    // Rien d'inventé : ni document, ni échéance, ni montant.
    expect(await sql`SELECT id FROM agenda_items WHERE account_id = ${c.id}`).toEqual(agendaAvant);
    expect(await sql`SELECT 1 FROM business_operation_financial_components WHERE account_id = ${c.id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM asset_files WHERE account_id = ${c.id}`).toHaveLength(0);
    // Journal : geste de l'utilisateur dans l'Assistant, clé d'idempotence du plan et de l'action.
    expect(await journal(c)).toEqual([{ kind: 'OPERATION', action: 'CREATED', origin: 'USER', channel: 'ASSISTANT', actor_user_id: c.ownerUserId, command: 'createOperation', idempotency_key: `t2.${r.plan.planId}.a1` }]);

    // Un plan ne s'exécute qu'une fois.
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await evenements(c)).toHaveLength(1);

    // X73 — même déclaration redite : l'événement comparable est ANNONCÉ ; à la confirmation, rien n'est créé en double et c'est dit.
    const encore = planDe(await demander(c, VIDANGE));
    expect(encore.plan.actions[0].params).toMatchObject({ distinctFrom: [ev.id] });
    expect(encore.plan.actions[0].effects.join(' ')).toMatch(/un événement de référence comparable existe déjà : « Intervention — Vidange » du 12 mars 2025 — Clio/);
    const redit = await confirmer(c, encore.plan.planId);
    expect(redit).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(JSON.stringify(redit)).toMatch(/était déjà enregistré \(même déclaration\) : rien n’a été créé en double/);
    expect(await evenements(c)).toHaveLength(1);

    // Situation non dite : demandée, rien n'est préparé. Sinistre : refusé, rien n'est préparé.
    expect(await demander(c, 'Déclare une intervention « Freins » le 2 juin 2024 pour la Clio')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Cet événement est-il à prévoir ou a-t-il déjà eu lieu \?/) });
    expect(await demander(c, 'Déclare un sinistre « Bris de glace » réalisé le 2 juin 2024 pour la Clio')).toBeNull();
    // Sans date, sans bien : type nul conservé (« événement de référence »), aucune date inventée.
    const flou = await faire(c, 'Enregistre un événement de référence « Travaux divers » à prévoir');
    expect(flou.conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await evenements(c))[1]).toMatchObject({ type_code: null, status: 'ENVISAGED', technical_label: 'Travaux divers', planned: null, realise: null, debut: null });
  });

  it('L114X-E02 — W22 : correction écrite avec sa déclaration ; modifié depuis l’aperçu → rien n’est écrit', async () => {
    const c = await compte();
    await bien(c, 'Clio');
    expect((await faire(c, VIDANGE)).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [avant] = await evenements(c);

    const d = planDe(await demander(c, 'Corrige la date de l’intervention Vidange : 14 mars 2025'));
    expect(d.preview.summary).toBe('Modifier la date de l’événement de référence « Intervention — Vidange » du 12 mars 2025 — Clio : 12 mars 2025 → 14 mars 2025. Confirmez-vous ?');
    expect((await evenements(c))[0].realise).toBe('2025-03-12');
    expect(await confirmer(c, d.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    let [ev] = await evenements(c);
    expect(ev).toMatchObject({ realise: '2025-03-14', technical_label: 'Vidange' });
    expect(ev.version).toBeGreaterThan(avant.version);
    // La correction est une déclaration de l'utilisateur, enregistrée comme source (protégée des analyses par la façade).
    expect(await sql<Json[]>`SELECT purpose, channel FROM business_operation_declarations WHERE account_id = ${c.id} ORDER BY id`)
      .toEqual([{ purpose: 'CREATE', channel: 'ASSISTANT' }, { purpose: 'UPDATE', channel: 'ASSISTANT' }]);

    // Prestataire, intitulé, puis situation d'un événement à prévoir.
    expect((await faire(c, 'Change le prestataire de l’intervention Vidange en Garage Martin')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await faire(c, 'Renomme l’intervention Vidange en Vidange et filtres')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    [ev] = await evenements(c);
    expect(ev).toMatchObject({ provider: 'Garage Martin', technical_label: 'Vidange et filtres', realise: '2025-03-14' });
    expect((await faire(c, 'Déclare une intervention « Pneus hiver » à prévoir pour la Clio')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await faire(c, 'Indique que l’intervention Pneus hiver a eu lieu')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await evenements(c))[1]).toMatchObject({ technical_label: 'Pneus hiver', status: 'REALIZED' });

    // Modifié ailleurs entre l'aperçu et la confirmation : rien n'est écrit, et c'est dit sans code.
    const p = planDe(await demander(c, 'Change le prestataire de l’intervention Vidange et filtres en Norauto'));
    const f = await import('@/services/business-operations/operation-write.facade');
    expect((await f.updateOperation({ accountId: c.id, actor: { kind: 'USER', userId: c.ownerUserId, channel: 'UI' } }, { operationId: ev.id, declaration: 'Correction depuis un écran', attributes: { provider: 'Feu Vert' } })).status).toBe('APPLIED');
    const conf = await confirmer(c, p.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/Cet événement de référence a été modifié depuis l’aperçu : rien n’a été fait/);
    expect(JSON.stringify(conf)).not.toMatch(/VERSION_MISMATCH|op[ée]ration/i);
    expect((await evenements(c))[0].provider).toBe('Feu Vert');
  });

  it('L114X-E03 — W23 : invalidation logique — document et échéance conservés ; l’événement n’est plus trouvé', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    expect((await faire(c, VIDANGE)).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [ev] = await evenements(c);
    const fichier = await document(c, clio, 'Facture Norauto');
    const item = (await make.agendaItem(c as never, { title: 'Prochaine vidange', startDate: '2030-03-12', assetIds: [clio] })).id;
    const f = await import('@/services/business-operations/operation-write.facade');
    const moi = { accountId: c.id, actor: { kind: 'USER' as const, userId: c.ownerUserId, channel: 'UI' as const } };
    expect((await f.linkDocument(moi, { operationId: ev.id, fileId: fichier })).status).toBe('APPLIED');
    expect((await f.linkAgendaItem(moi, { operationId: ev.id, agendaItemId: item })).status).toBe('APPLIED');

    const r = planDe(await demander(c, 'Supprime l’intervention Vidange de la Clio'));
    expect(r.preview.summary).toMatch(/^Supprimer l’événement de référence « Intervention — Vidange » du 12 mars 2025 — Clio\. Confirmez-vous \?$/);
    expect(r.plan.actions[0].effects).toContain('Conservés dans votre compte : 1 document, 1 échéance, ainsi que ses fournisseurs.');
    expect(r.plan.actions[0].effects).toContain('Depuis l’assistant, cette suppression ne s’annule pas.');
    expect((await evenements(c))[0].invalide).toBe(false);
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    // Jamais un DELETE : la ligne existe, invalidée par l'utilisateur ; le document et l'échéance sont conservés.
    expect(await evenements(c)).toEqual([expect.objectContaining({ id: ev.id, invalide: true, motif: 'USER_INVALIDATED', technical_label: 'Vidange' })]);
    expect(await sql`SELECT 1 FROM asset_files WHERE id = ${fichier} AND deleted_at IS NULL`).toHaveLength(1);
    expect(await sql<Json[]>`SELECT title, start_date::text AS d FROM agenda_items WHERE id = ${item}`).toEqual([{ title: 'Prochaine vidange', d: '2030-03-12' }]);
    // L'événement supprimé n'est plus trouvé : aucune nouvelle commande ne peut le viser.
    expect(await demander(c, 'Supprime l’événement de référence Vidange')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé cet événement de référence/) });
    // Désigné par son type seulement : plus rien n'y répond — ce n'est plus une action (parcours de réponse normal).
    expect(await demander(c, 'Supprime l’intervention Vidange de la Clio')).toBeNull();
    expect(await demander(c, 'Corrige la date de l’intervention Vidange : 15 mars 2025')).toBeNull();
  });

  it('L114X-E04 — W24 : financement et achat associés, toujours deux événements ; redemandé : déjà associés', async () => {
    const c = await compte();
    await bien(c, 'Clio');
    expect((await faire(c, 'Déclare un financement « Prêt auto » réalisé le 3 mai 2021')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await faire(c, 'Déclare un achat « Achat de la voiture » réalisé le 3 mai 2021 pour la Clio')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [pret, achat] = await evenements(c);
    expect(pret).toMatchObject({ type_code: 'FINANCING', debut: '2021-05-03', realise: null });
    expect(achat).toMatchObject({ type_code: 'ACQUISITION', realise: '2021-05-03' });

    // L'ordre de la phrase ne change pas le sens : le financement est l'origine.
    const r = planDe(await demander(c, 'Associe l’achat de la Clio au financement Prêt auto'));
    expect(r.plan.actions[0].params).toMatchObject({ kind: 'reference_events_associate', fromOperationId: pret.id, toOperationId: achat.id, nature: 'FINANCING' });
    expect(r.plan.actions[0].effects).toContain('Ils restent deux événements de référence distincts : rien n’est fusionné.');
    expect(await sql`SELECT 1 FROM business_operation_relations WHERE account_id = ${c.id}`).toHaveLength(0);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await sql<Json[]>`SELECT from_operation_id::int AS f, to_operation_id::int AS t, nature, state, origin FROM business_operation_relations WHERE account_id = ${c.id}`)
      .toEqual([{ f: pret.id, t: achat.id, nature: 'FINANCING', state: 'ACTIVE', origin: 'USER' }]);
    // Aucune fusion : deux événements actifs, inchangés ; aucun montant créé.
    expect((await evenements(c)).map((e) => [e.id, e.invalide])).toEqual([[pret.id, false], [achat.id, false]]);
    expect(await sql`SELECT 1 FROM business_operation_financial_components WHERE account_id = ${c.id}`).toHaveLength(0);

    const encore = await faire(c, 'Associe le financement Prêt auto à l’achat de la Clio');
    expect(encore.conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(JSON.stringify(encore.conf)).toMatch(/étaient déjà associés : rien n’a été modifié/);
    expect(await sql`SELECT 1 FROM business_operation_relations WHERE account_id = ${c.id}`).toHaveLength(1);
  });

  it('L114X-E05 — W25, W26 : document rattaché et fournisseur relié, par décision de l’utilisateur', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    expect((await faire(c, VIDANGE)).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [ev] = await evenements(c);
    const fichier = await document(c, clio, 'Facture Norauto');
    const garage = await fournisseur(c, 'Garage Martin');

    const d = planDe(await demander(c, 'Rattache le document Facture Norauto à l’intervention Vidange'));
    expect(d.preview.summary).toBe('Rattacher le document « Facture Norauto » à l’événement de référence « Intervention — Vidange » du 12 mars 2025 — Clio. Confirmez-vous ?');
    expect(await sql`SELECT 1 FROM business_operation_documents WHERE account_id = ${c.id}`).toHaveLength(0);
    expect(await confirmer(c, d.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await sql<Json[]>`SELECT operation_id::int AS op, file_id, active, 'USER' = ANY(origins) AS utilisateur FROM business_operation_documents WHERE account_id = ${c.id}`)
      .toEqual([{ op: ev.id, file_id: fichier, active: true, utilisateur: true }]);
    // Le document reste dans le compte, rattaché à son bien.
    expect(await sql<Json[]>`SELECT asset_id, deleted_at FROM asset_files WHERE id = ${fichier}`).toEqual([{ asset_id: clio, deleted_at: null }]);
    const redit = await faire(c, 'Rattache le document Facture Norauto à l’intervention Vidange');
    expect(JSON.stringify(redit.conf)).toMatch(/était déjà rattaché/);

    const s = planDe(await demander(c, 'Relie le fournisseur Garage Martin à l’intervention Vidange comme intervenant'));
    expect(s.plan.actions[0].effects).toContain('Rôle : Intervenant');
    expect(await confirmer(c, s.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await sql<Json[]>`SELECT operation_id::int AS op, supplier_id, role, origin, status FROM business_operation_suppliers WHERE account_id = ${c.id}`)
      .toEqual([{ op: ev.id, supplier_id: garage, role: 'INTERVENER', origin: 'USER', status: 'ACTIVE' }]);
    // Document ou fournisseur inconnu : question, aucun plan.
    expect(await demander(c, 'Rattache le document Devis à l’intervention Vidange')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé ce document/) });
    expect(await demander(c, 'Relie le fournisseur Dupont à l’intervention Vidange')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé ce fournisseur/) });
    // Non-régression : sans événement de référence correspondant, « rattache le document … à … » n'est pas détourné.
    expect(await demander(c, 'Rattache le document Facture Norauto à l’intervention Toiture')).toBeNull();
    expect(await demander(c, 'Rattache le document Facture Norauto à la Clio')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/déjà rattaché/) });
  });

  it('L114X-E06 — un seul plan, plusieurs actions sur le même événement ; déclaration implicite', async () => {
    const c = await compte();
    await bien(c, 'Clio');
    const garage = await fournisseur(c, 'Garage Martin');
    expect((await faire(c, VIDANGE)).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const r = planDe(await demander(c, 'Change le prestataire de l’intervention Vidange en Garage Martin puis relie le fournisseur Garage Martin à l’intervention Vidange'));
    expect(r.plan.actions.map((a) => [a.command, a.dependsOn])).toEqual([['UPDATE_REFERENCE_EVENT', []], ['LINK_SUPPLIER_REFERENCE_EVENT', ['a1']]]);
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((conf as Json).results.map((x: Json) => x.status)).toEqual(['SUCCESS', 'SUCCESS']);
    expect((await evenements(c))[0].provider).toBe('Garage Martin');
    expect(await sql<Json[]>`SELECT supplier_id, role, origin FROM business_operation_suppliers WHERE account_id = ${c.id}`).toEqual([{ supplier_id: garage, role: 'PROVIDER', origin: 'USER' }]);
    // Chaque action a sa propre clé d'idempotence.
    expect((await journal(c)).map((j) => j.idempotency_key).filter(Boolean)).toEqual(expect.arrayContaining([`t2.${r.plan.planId}.a1`, `t2.${r.plan.planId}.a2`]));

    // « J'ai fait … de la Clio … » : proposé (jamais écrit sans confirmation) ; bien inconnu : pas une action.
    const implicite = planDe(await demander(c, 'J’ai fait le contrôle des freins de la Clio le 2 juin 2024'));
    expect(implicite.plan.actions[0]).toMatchObject({ command: 'CREATE_REFERENCE_EVENT', params: { typeCode: 'INTERVENTION', status: 'REALIZED', eventDate: '2024-06-02', eventLabel: 'Contrôle des freins' } });
    expect(await evenements(c)).toHaveLength(1);
    expect(await demander(c, 'J’ai fait le contrôle des freins de la Polo le 2 juin 2024')).toBeNull();
  });

  it('L114X-E07 — cloisonnement des comptes ; plan d’un autre compte ; lecture seule refusée à la confirmation', async () => {
    const a = await compte();
    const b = await compte();
    await bien(a, 'Clio');
    await bien(b, 'Clio');
    expect((await faire(a, VIDANGE)).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [ev] = await evenements(a);

    // Le compte B ne trouve jamais l'événement du compte A.
    for (const m of ['Supprime l’intervention Vidange', 'Corrige la date de l’intervention Vidange : 14 mars 2025', 'Indique que l’intervention Vidange a eu lieu']) {
      expect(await demander(b, m), m).toBeNull();
    }
    for (const m of ['Supprime l’événement de référence Vidange', 'Renomme l’événement de référence Vidange en Vidange B']) {
      expect(await demander(b, m), m).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé cet événement de référence/) });
    }
    // Un plan du compte A ne se confirme pas depuis le compte B.
    const r = planDe(await demander(a, 'Supprime l’intervention Vidange'));
    expect(await confirmer(b, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    // Compte A passé en lecture seule entre l'aperçu et la confirmation : refus, rien n'est écrit.
    const p = planDe(await demander(a, 'Déclare une intervention « Freins » réalisée le 2 juin 2024 pour la Clio'));
    await lectureSeule(a);
    for (const plan of [r, p]) expect(await confirmer(a, plan.plan.planId)).toMatchObject({ ok: false, code: 'WRITE_REFUSED' });
    expect(await evenements(a)).toEqual([expect.objectContaining({ id: ev.id, invalide: false })]);
    expect(await evenements(b)).toHaveLength(0);
  });

  it('L114X-E08 — passage 114Z4 : « Déclare … puis relie … à celui-ci » — une confirmation, l’événement créé est la cible', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const facture = await document(c, clio, 'Facture Norauto');
    const garage = await fournisseur(c, 'Garage Martin');

    const r = planDe(await demander(c, `${VIDANGE} puis relie le fournisseur Garage Martin à celui-ci`));
    expect(r.preview.actions).toHaveLength(2);
    expect(r.preview.actions[1].preview).toBe('Relier le fournisseur « Garage Martin » à l’événement de référence qui vient d’être enregistré.');
    expect(r.preview.actions[1].dependsOn).toEqual([r.preview.actions[0].actionId]);
    expect(JSON.stringify(r.preview)).not.toMatch(/op[ée]ration/i);
    // Rien n'est écrit avant la confirmation.
    expect(await evenements(c)).toHaveLength(0);

    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [ev] = await evenements(c);
    expect(ev).toMatchObject({ type_code: 'INTERVENTION', technical_label: 'Vidange', invalide: false });
    expect(await sql<Json[]>`SELECT supplier_id::int AS supplier_id, role, origin FROM business_operation_suppliers WHERE operation_id = ${ev.id} AND status = 'ACTIVE'`)
      .toEqual([{ supplier_id: garage, role: 'PROVIDER', origin: 'USER' }]);

    // Même forme pour un document, sur un second événement.
    const d = planDe(await demander(c, 'Déclare une intervention « Freins » réalisée le 2 juin 2024 pour la Clio puis rattache le document Facture Norauto à celui-ci'));
    expect(d.preview.actions[1].preview).toBe('Rattacher le document « Facture Norauto » à l’événement de référence qui vient d’être enregistré.');
    expect(await confirmer(c, d.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const freins = (await evenements(c)).find((x) => x.technical_label === 'Freins')!;
    expect(await sql<Json[]>`SELECT file_id::int AS file_id FROM business_operation_documents WHERE operation_id = ${freins.id} AND active`)
      .toEqual([{ file_id: facture }]);

    // La déclaration refusée (compte en lecture seule) : le lien n'est pas exécuté, rien n'est écrit.
    const p = planDe(await demander(c, `Déclare une intervention « Pneus » réalisée le 3 juin 2024 pour la Clio puis relie le fournisseur Garage Martin à celui-ci`));
    await lectureSeule(c);
    expect(await confirmer(c, p.plan.planId)).toMatchObject({ ok: false, code: 'WRITE_REFUSED' });
    expect((await evenements(c)).map((x) => x.technical_label).sort()).toEqual(['Freins', 'Vidange']);
  });
});
