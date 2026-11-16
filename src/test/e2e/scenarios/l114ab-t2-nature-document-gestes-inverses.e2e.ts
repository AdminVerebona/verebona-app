/**
 * Passage 114AB (Trello #753, CDC T2 §9, §14.3 W02 / W12 / W14, §14.4 « Documents ») — de bout en bout sur
 * PostgreSQL réel : plan figé, confirmation par identifiant seul, état relu, écriture par les façades métier
 * (celle du tiroir du document pour la nature, celle de la carte #744 pour les gestes inverses). Aucune IA.
 *
 *   E01  W12 : nature d'un document — rubrique écrite après confirmation seulement, une seule fois ; origine
 *        USER posée (valeur protégée des analyses) ; type d'une autre rubrique → rubrique DÉDUITE ;
 *   E02  W12 : classement modifié entre l'aperçu et la confirmation → RIEN n'est écrit ;
 *   E03  W12 : façade partagée — la route du tiroir (`PATCH …/classification`) rend le même résultat qu'avant ;
 *   E04  W14 : plusieurs documents supprimés en une confirmation ; TOUT OU RIEN si l'un d'eux a changé ;
 *   E05  W02 : catégorie d'un bien de la famille OBJET écrite par le service de la fiche, relue sous verrou ;
 *   E06  gestes inverses (#744) : document retiré, fournisseur retiré, événements dissociés, échéance
 *        rattachée, événement rétabli — par la vraie façade, sans simulation ;
 *   E07  cloisonnement des comptes et compte passé en lecture seule.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;

scenario('L114AB-NATURE-DOCUMENT', 'Passage 114AB — nature d’un document, suppression multiple, catégorie d’un objet, gestes inverses', ({ sql, make }) => {
  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string, category = 'VEHICULE') => {
    const b = await make.asset(c as never, { name, category });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${b.id}`;
    return b.id as number;
  };
  const demander = async (c: Compte, message: string, extra: Json = {}) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message, clientRequestId: `l114ab-${Math.random()}`, locale: 'fr-FR', ...extra } as never);
  };
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };
  const faire = async (c: Compte, message: string) => {
    const r = planDe(await demander(c, message));
    return { plan: r, conf: await confirmer(c, r.plan.planId) };
  };
  const document = async (c: Compte, assetId: number, titre: string) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET original_filename = ${`${titre}.pdf`}, retained_title = ${titre}, document_date = '2026-03-10'::date WHERE id = ${f.id}`;
    return f.id as number;
  };
  const classement = (c: Compte) => sql<Json[]>`
    SELECT id::int AS id, rubric_code, document_type_code, rubric_origin, type_origin, rubric_user_validated, type_user_validated,
           classification_referential_version AS version, deleted_at
      FROM asset_files WHERE account_id = ${c.id} ORDER BY id`;
  const fournisseur = async (c: Compte, name: string) => {
    const { createSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    return (await createSupplierForAccount({ accountId: c.id, userId: c.ownerUserId, input: { name } })).id;
  };
  const evenements = (c: Compte) => sql<Json[]>`
    SELECT id::int AS id, type_code, technical_label, version, invalidated_at IS NOT NULL AS invalide, invalidation_reason AS motif
      FROM business_operations WHERE account_id = ${c.id} ORDER BY id`;
  const lectureSeule = async (c: Compte) => {
    await sql`DELETE FROM account_subscriptions WHERE account_id = ${c.id}`;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${c.id}, 'premium', 'trialing', now() - interval '1 day')`;
  };

  it('L114AB-E01 — W12 : rubrique puis type, écrits après confirmation seulement, origine USER', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const id = await document(c, clio, 'Facture EDF');

    const r = planDe(await demander(c, 'Change la rubrique du document Facture EDF en Entretien et travaux'));
    expect(r.preview.summary).toBe('Modifier « Rubrique » du document « Facture EDF » : Sans rubrique → Entretien et travaux. Confirmez-vous ?');
    // Rien n'est écrit avant la confirmation.
    expect((await classement(c))[0]).toMatchObject({ rubric_code: null, rubric_origin: null, rubric_user_validated: false });
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    let [d] = await classement(c);
    expect(d).toMatchObject({ id, rubric_code: 'MAINTENANCE_WORKS', rubric_origin: 'USER', rubric_user_validated: true, document_type_code: null });
    expect(d.version).toBeTruthy();
    // Un second envoi de la même confirmation ne rejoue pas l'écriture.
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });

    // Déjà en place : aucune proposition.
    expect(await demander(c, 'Change la rubrique du document Facture EDF en Entretien et travaux'))
      .toMatchObject({ kind: 'need_info', message: 'La rubrique de « Facture EDF » est déjà « Entretien et travaux ».' });

    // Type de cette rubrique : écrit, rubrique conservée.
    const t = await faire(c, 'Change le type du document Facture EDF en Facture de réparation');
    expect(t.conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    [d] = await classement(c);
    expect(d).toMatchObject({ rubric_code: 'MAINTENANCE_WORKS', document_type_code: 'REPAIR_INVOICE', type_origin: 'USER', type_user_validated: true });

    // Type d'une AUTRE rubrique : la rubrique est DÉDUITE, et l'aperçu l'annonçait.
    const g = planDe(await demander(c, 'Change le type du document Facture EDF en Garantie'));
    expect(g.plan.actions[0].effects.join(' | ')).toMatch(/Rubrique : Entretien et travaux → Contrats, garanties et notices/);
    expect(await confirmer(c, g.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    [d] = await classement(c);
    expect(d).toMatchObject({ rubric_code: 'CONTRACTS_WARRANTIES_DOCS', document_type_code: 'WARRANTY_CERTIFICATE' });

    // Valeur hors référentiel : question, aucune écriture.
    expect(await demander(c, 'Change la rubrique du document Facture EDF en Trésorerie')).toMatchObject({ kind: 'need_info' });
    expect((await classement(c))[0]).toMatchObject({ rubric_code: 'CONTRACTS_WARRANTIES_DOCS' });
  });

  it('L114AB-E02 — W12 : classement modifié depuis l’aperçu → rien n’est écrit', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const id = await document(c, clio, 'Facture EDF');
    const r = planDe(await demander(c, 'Change la rubrique du document Facture EDF en Entretien et travaux'));
    // Un autre onglet classe le document entre-temps.
    await sql`UPDATE asset_files SET rubric_code = 'MEDIA' WHERE id = ${id}`;
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/Le classement de ce document a changé depuis l’aperçu/);
    expect((await classement(c))[0]).toMatchObject({ rubric_code: 'MEDIA' });
  });

  it('L114AB-E03 — W12 : façade partagée — le tiroir du document garde ses règles et son JSON', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const id = await document(c, clio, 'Facture EDF');
    const [{ public_id: publicId }] = await sql<Json[]>`SELECT public_id FROM asset_files WHERE id = ${id}`;
    const { updateDocumentClassificationForAccount } = await import('@/services/documents/document-write.facade');
    const session = { userId: c.ownerUserId, currentAccountId: c.id };

    const ok = await updateDocumentClassificationForAccount(session, { publicId }, { rubricCode: 'MEDIA' });
    expect(ok).toMatchObject({ ok: true, classification: { rubricCode: 'MEDIA', rubricOrigin: 'USER', rubricUserValidated: true } });
    expect((await classement(c))[0]).toMatchObject({ rubric_code: 'MEDIA' });

    // Codes inconnus refusés avant toute écriture, comme avant l'extraction.
    expect(await updateDocumentClassificationForAccount(session, { publicId }, { rubricCode: 'INCONNUE' }))
      .toMatchObject({ ok: false, status: 400, error: 'UNKNOWN_RUBRIC' });
    expect(await updateDocumentClassificationForAccount(session, { publicId }, { documentTypeCode: 'INCONNU' }))
      .toMatchObject({ ok: false, status: 400, error: 'UNKNOWN_TYPE' });
    expect(await updateDocumentClassificationForAccount(session, { publicId: '00000000-0000-4000-8000-000000000000' }, { rubricCode: 'MEDIA' }))
      .toMatchObject({ ok: false, status: 404, error: 'NOT_FOUND' });
    expect((await classement(c))[0]).toMatchObject({ rubric_code: 'MEDIA' });

    // État relu : la façade refuse si le classement n'est plus celui présenté.
    expect(await updateDocumentClassificationForAccount(session, { documentId: id }, {
      rubricCode: 'MAINTENANCE_WORKS', expectedCurrent: { rubricCode: null, documentTypeCode: null },
    })).toMatchObject({ ok: false, status: 409, error: 'STATE_CHANGED' });
    expect((await classement(c))[0]).toMatchObject({ rubric_code: 'MEDIA' });
  });

  it('L114AB-E04 — W14 : plusieurs documents supprimés en une confirmation, tout ou rien', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const a = await document(c, clio, 'Facture EDF');
    const b = await document(c, clio, 'Facture GDF');
    const reste = await document(c, clio, 'Notice chaudière');

    const r = planDe(await demander(c, 'Supprime les documents Facture EDF et Facture GDF'));
    expect(r.preview.summary).toMatch(/^Supprimer 2 documents : « Facture EDF » du 10 mars 2026 \(Clio\), « Facture GDF » du 10 mars 2026 \(Clio\)\./);
    expect((await classement(c)).every((d) => d.deleted_at === null)).toBe(true);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    const apres = await classement(c);
    expect(apres.filter((d) => d.deleted_at === null).map((d) => d.id)).toEqual([reste]);
    expect(apres.find((d) => d.id === a)!.deleted_at).not.toBeNull();
    expect(apres.find((d) => d.id === b)!.deleted_at).not.toBeNull();

    // Tout ou rien : un seul document modifié depuis l'aperçu et AUCUN n'est supprimé.
    const c2 = await compte();
    const m = await bien(c2, 'Maison', 'IMMOBILIER');
    const x = await document(c2, m, 'Facture EDF');
    await document(c2, m, 'Facture GDF');
    const r2 = planDe(await demander(c2, 'Supprime les documents Facture EDF et Facture GDF'));
    await sql`UPDATE asset_files SET retained_title = 'Facture EDF 2026' WHERE id = ${x}`;
    const conf = await confirmer(c2, r2.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/aucun document n’a été supprimé/);
    expect((await classement(c2)).every((d) => d.deleted_at === null)).toBe(true);
  });

  it('L114AB-E05 — W02 : catégorie d’un bien de la famille OBJET, relue sous verrou', async () => {
    const c = await compte();
    const velo = await bien(c, 'Vélo cargo', 'OBJECT');
    const r = planDe(await demander(c, 'Change la catégorie du Vélo cargo en sport'));
    expect(r.preview.summary).toBe('Modifier « Catégorie d’objet » de Vélo cargo : non renseigné → Loisir / Sport. Confirmez-vous ?');
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [apres] = await sql<Json[]>`SELECT object_category, key_characteristics FROM assets WHERE id = ${velo}`;
    expect(apres.object_category).toBe('OBJECT_CATEGORY_SPORT');

    // Catégorie d'une autre famille : refus annoncé, rien d'écrit.
    expect(await demander(c, 'Change la catégorie du Vélo cargo en moto')).toMatchObject({ kind: 'need_info' });

    // Durcissement du passage 114AB : le STATUT présenté est revérifié SOUS VERROU par le service de la fiche.
    const clio = await bien(c, 'Clio');
    const s = planDe(await demander(c, 'Marque la Clio comme vendue'));
    await sql`UPDATE assets SET status = 'TRANSMIS' WHERE id = ${clio}`;
    const conf = await confirmer(c, s.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    const [bienApres] = await sql<Json[]>`SELECT status FROM assets WHERE id = ${clio}`;
    expect(bienApres.status).toBe('TRANSMIS');
  });

  it('L114AB-E06 — gestes inverses, par la vraie façade de la carte #744', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const docId = await document(c, clio, 'Facture Norauto');
    const fId = await fournisseur(c, 'Garage Martin');

    // Deux événements déclarés depuis l'Assistant, associés puis dissociés.
    expect((await faire(c, 'Déclare une intervention « Vidange » réalisée le 12 mars 2025 pour la Clio')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await faire(c, 'Déclare un financement « Prêt auto » réalisé le 3 mai 2021')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await faire(c, 'Déclare un achat « Achat de la voiture » réalisé le 3 mai 2021 pour la Clio')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await faire(c, 'Associe le financement Prêt auto à l’achat de la Clio')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const liens = async () => sql<Json[]>`SELECT nature, state FROM business_operation_relations WHERE account_id = ${c.id} ORDER BY id`;
    expect((await liens()).filter((l) => l.state === 'ACTIVE')).toHaveLength(1);

    const dis = await faire(c, 'Dissocie le financement Prêt auto de l’achat de la Clio');
    expect(dis.plan.preview.summary).toMatch(/^Dissocier les événements de référence/);
    expect(dis.conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await liens()).filter((l) => l.state === 'ACTIVE')).toHaveLength(0);
    // Les deux événements restent.
    expect((await evenements(c)).filter((e) => !e.invalide)).toHaveLength(3);

    // Document rattaché puis retiré : le document reste dans le compte.
    expect((await faire(c, 'Rattache le document Facture Norauto à l’intervention Vidange')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const retrait = await faire(c, 'Retire le document Facture Norauto de l’intervention Vidange');
    expect(retrait.plan.preview.summary).toMatch(/^Retirer le document « Facture Norauto » de l’événement de référence/);
    expect(retrait.conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await classement(c)).find((d) => d.id === docId)!.deleted_at).toBeNull();

    // Fournisseur relié puis retiré : sa fiche reste.
    expect((await faire(c, 'Relie le fournisseur Garage Martin à l’intervention Vidange')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const sortie = await faire(c, 'Retire le fournisseur Garage Martin de l’intervention Vidange');
    expect(sortie.conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [lienF] = await sql<Json[]>`SELECT status FROM business_operation_suppliers WHERE account_id = ${c.id} AND supplier_id = ${fId}`;
    expect(lienF.status).toBe('REJECTED');
    const [ficheF] = await sql<Json[]>`SELECT status FROM suppliers WHERE id = ${fId}`;
    expect(ficheF.status).toBe('active');

    // Échéance rattachée : elle garde sa date.
    const ech = await faire(c, 'Ajoute un rappel Vidange pour la Clio');
    expect(ech.conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const rattache = await faire(c, 'Rattache l’échéance Vidange à l’intervention Vidange');
    expect(rattache.plan.preview.summary).toMatch(/^Rattacher l’échéance « Vidange »/);
    expect(rattache.conf).toMatchObject({ ok: true, status: 'EXECUTED' });

    // Supprimé puis RÉTABLI : seules les suppressions de l'utilisateur sont rétablissables.
    expect(await demander(c, 'Rétablis l’intervention Vidange')).toBeNull();
    expect((await faire(c, 'Supprime l’intervention Vidange de la Clio')).conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const supprime = (await evenements(c)).find((e) => e.invalide);
    expect(supprime).toMatchObject({ motif: 'USER_INVALIDATED' });
    const reta = planDe(await demander(c, 'Rétablis l’intervention Vidange'));
    expect(reta.preview.summary).toMatch(/^Rétablir l’événement de référence « Intervention — Vidange »/);
    expect(await confirmer(c, reta.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await evenements(c)).find((e) => e.id === supprime!.id)).toMatchObject({ invalide: false });
    // Rétabli : il n'est plus dans les suppressions, la phrase redevient une réponse normale.
    expect(await demander(c, 'Rétablis l’intervention Vidange')).toBeNull();
  });

  it('L114AB-E07 — cloisonnement des comptes et compte en lecture seule', async () => {
    const a = await compte();
    const b = await compte();
    const clio = await bien(a, 'Clio');
    const id = await document(a, clio, 'Facture EDF');

    // Le document d'un autre compte n'est jamais trouvé ni classé.
    expect(await demander(b, 'Change la rubrique du document Facture EDF en Médias')).toMatchObject({ kind: 'need_info' });
    expect(await demander(b, 'Supprime les documents Facture EDF et Facture GDF')).toMatchObject({ kind: 'need_info' });
    const { updateDocumentClassificationForAccount } = await import('@/services/documents/document-write.facade');
    expect(await updateDocumentClassificationForAccount({ userId: b.ownerUserId, currentAccountId: b.id }, { documentId: id }, { rubricCode: 'MEDIA' }))
      .toMatchObject({ ok: false, status: 404 });
    expect((await classement(a))[0]).toMatchObject({ rubric_code: null });

    // Compte passé en lecture seule après la préparation : la confirmation est refusée, rien n'est écrit.
    const r = planDe(await demander(a, 'Change la rubrique du document Facture EDF en Entretien et travaux'));
    await lectureSeule(a);
    const conf = await confirmer(a, r.plan.planId);
    expect(conf).toMatchObject({ ok: false });
    expect((await classement(a))[0]).toMatchObject({ rubric_code: null });
  });
});
