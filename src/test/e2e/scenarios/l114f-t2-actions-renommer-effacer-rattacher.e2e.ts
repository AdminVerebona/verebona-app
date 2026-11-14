/**
 * Lot 114F (Trello #753, CDC T2 §9, §14.3 W02 / W27 / W13, §14.5) — RENOMMER UN
 * BIEN, EFFACER UNE CARACTÉRISTIQUE, RATTACHER UN DOCUMENT À UN BIEN DEPUIS
 * L'ASSISTANT, de bout en bout sur PostgreSQL réel : plan figé, confirmation
 * par identifiant seul, exécution par le service de la fiche du bien
 * (`updateAssetDetails`) et par la façade des documents (celle du tiroir).
 *
 *   E01  W02 : bien renommé après confirmation seulement, une seule fois ;
 *   E02  W02 : nom modifié entre l'aperçu et la confirmation → rien n'est écrit ;
 *   E03  W27 : caractéristique effacée (marqueur d'origine de l'utilisateur, colonne recopiée vidée), le bien
 *        n'est jamais supprimé ; « Annuler » rétablit la valeur ;
 *   E04  W27 : valeur modifiée entre l'aperçu et la confirmation → rien n'est effacé ;
 *   E05  W13 : document rattaché à un second bien puis détaché du premier ; jamais supprimé ; état modifié
 *        entre l'aperçu et la confirmation → rien n'est écrit ;
 *   E06  deux comptes : rien n'est trouvé ni écrit chez l'autre ; compte en lecture seule refusé à la confirmation.
 *   E07  non-régression : la modification d'une caractéristique (corps partagé avec l'effacement) écrit et s'annule comme avant.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;

scenario('L114F-ACTIONS', 'Lot 114F — renommer un bien, effacer une caractéristique, rattacher un document depuis l’Assistant', ({ sql, make }) => {
  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string, over: Json = {}) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE', ...over });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${b.id}`;
    return b.id as number;
  };
  const demander = async (c: Compte, message: string, extra: Json = {}) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message, clientRequestId: `l114f-${Math.random()}`, locale: 'fr-FR', ...extra } as never);
  };
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };
  const lire = async (id: number) => {
    const [r] = await sql<Json[]>`SELECT id, account_id, name, key_characteristics, purchase_date::text AS purchase_date, deleted_at FROM assets WHERE id = ${id}`;
    return { ...r, kc: r.key_characteristics ? JSON.parse(r.key_characteristics) as Json : {} } as Json & { kc: Json };
  };
  const document = async (c: Compte, assetId: number, titre: string) => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET original_filename = ${`${titre}.pdf`}, retained_title = ${titre}, document_date = '2026-03-10'::date WHERE id = ${f.id}`;
    return f.id as number;
  };
  const biensDe = async (c: Compte, fileId: number) => {
    const [{ db }, { readDocumentTargets }] = await Promise.all([import('@/db'), import('@/services/documents/document-targets/service')]);
    const vue = await readDocumentTargets(db as never, c.id, fileId);
    return (vue?.assets ?? []).filter((a) => !a.implied).map((a) => a.id).sort((x, y) => x - y);
  };
  const lectureSeule = async (c: Compte) => {
    await sql`DELETE FROM account_subscriptions WHERE account_id = ${c.id}`;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${c.id}, 'premium', 'trialing', now() - interval '1 day')`;
  };

  it('L114F-E01 — W02 : bien renommé après confirmation seulement, une seule fois', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const polo = await bien(c, 'Polo');
    const r = planDe(await demander(c, 'Renomme la Clio en Clio de Paul'));
    expect(r.preview.summary).toBe('Renommer le bien « Clio » en « Clio de Paul ». Confirmez-vous ?');
    expect((await lire(clio)).name).toBe('Clio');
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    expect(JSON.stringify(conf)).toMatch(/Bien « Clio » renommé en « Clio de Paul »\./);
    expect((await lire(clio)).name).toBe('Clio de Paul');
    expect((await lire(polo)).name).toBe('Polo');
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    // Demande ambiguë : question, rien n'est préparé.
    await bien(c, 'Clio de Marie');
    expect(await demander(c, 'Renomme la Clio en Twingo')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Plusieurs biens correspondent : /) });
  });

  it('L114F-E02 — W02 : nom modifié depuis l’aperçu → rien n’est écrit', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const r = planDe(await demander(c, 'Renomme la Clio en Clio de Paul'));
    await sql`UPDATE assets SET name = 'Clio grise' WHERE id = ${clio}`;
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/a changé depuis l’aperçu : rien n’a été écrit/);
    expect((await lire(clio)).name).toBe('Clio grise');
    // Le service refuse lui-même, sous verrou, un nom attendu qui n'est plus en place.
    const { updateAssetDetails, AssetDetailsError } = await import('@/services/asset-details-write.service');
    await expect(updateAssetDetails({ assetId: clio, accountId: c.id, section: 'common', fields: { name: 'Autre' }, expectedCurrent: { name: 'Clio' } }))
      .rejects.toBeInstanceOf(AssetDetailsError);
    expect((await lire(clio)).name).toBe('Clio grise');
    // Sans nom attendu (fiche du bien) : comportement inchangé.
    await updateAssetDetails({ assetId: clio, accountId: c.id, section: 'common', fields: { name: 'Clio bleue' } });
    expect((await lire(clio)).name).toBe('Clio bleue');
  });

  it('L114F-E03 — W27 : caractéristique effacée, bien conservé ; « Annuler » rétablit la valeur', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio', { keyCharacteristics: { acquisitionDate: '2021-05-25', mileage: 45000 }, purchaseDate: '2021-05-25' });
    const r = planDe(await demander(c, 'Efface la date d’achat de la Clio'));
    expect(r.plan.actions[0].command).toBe('CLEAR_ASSET_FIELD');
    expect(r.preview.summary).toBe('Effacer « Date d’achat » de Clio (valeur actuelle : 25 mai 2021). Confirmez-vous ?');
    expect((await lire(clio)).kc.acquisitionDate).toBe('2021-05-25');
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(JSON.stringify(conf)).toMatch(/« Date d’achat » de Clio effacé\./);
    const apres = await lire(clio);
    expect(apres.deleted_at).toBeNull();
    expect(apres.name).toBe('Clio');
    expect(apres.kc.acquisitionDate).toBeUndefined();
    // Même marqueur que le formulaire : effacement d'origine humaine ; colonne recopiée vidée ; le reste intact.
    expect(apres.kc.acquisitionDate__origin).toBe('USER');
    expect(apres.purchase_date).toBeNull();
    expect(apres.kc.mileage).toBe(45000);
    // Annulable dans la fenêtre, comme une modification : la valeur revient.
    if (!conf.ok) throw new Error('confirmation attendue');
    expect(conf.undoUntil).not.toBeNull();
    const { undoCommandPlan } = await import('@/services/verebona-assistant/commands/undo.service');
    expect(await undoCommandPlan({ planId: r.plan.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: true, status: 'UNDONE' });
    const retabli = await lire(clio);
    expect(retabli.kc.acquisitionDate).toBe('2021-05-25');
    expect(retabli.purchase_date).toBe('2021-05-25');
    // Rien à effacer : aucun plan.
    expect(await demander(c, 'Efface le prix d’achat de la Clio')).toMatchObject({ kind: 'need_info', message: '« Prix d’achat » de Clio n’est pas renseigné : il n’y a rien à effacer.' });
  });

  it('L114F-E04 — W27 : valeur modifiée depuis l’aperçu → rien n’est effacé', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio', { keyCharacteristics: { mileage: 45000 } });
    const r = planDe(await demander(c, 'Efface le kilométrage de la Clio'));
    await sql`UPDATE assets SET key_characteristics = ${JSON.stringify({ mileage: 52000 })} WHERE id = ${clio}`;
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/a été modifié entre-temps : rien n’a été écrit/);
    expect((await lire(clio)).kc.mileage).toBe(52000);
  });

  it('L114F-E05 — W13 : document rattaché à un second bien, détaché du premier, jamais supprimé', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const polo = await bien(c, 'Polo');
    const id = await document(c, clio, 'Garantie');
    expect(await biensDe(c, id)).toEqual([clio]);

    const r = planDe(await demander(c, 'Rattache le document Garantie à la Polo'));
    expect(r.preview.summary).toBe('Rattacher le document « Garantie » à Polo. Confirmez-vous ?');
    expect(r.plan.actions[0].effects).toContain('Biens rattachés : Clio → Clio, Polo');
    expect(await biensDe(c, id)).toEqual([clio]);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    expect(await biensDe(c, id)).toEqual([clio, polo].sort((x, y) => x - y));
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    // Déjà rattaché : aucun plan.
    expect(await demander(c, 'Rattache le document Garantie à la Polo')).toMatchObject({ kind: 'need_info', message: '« Garantie » est déjà rattaché à Polo.' });

    const d = planDe(await demander(c, 'Détache le document Garantie de la Clio'));
    expect(d.preview.summary).toBe('Détacher le document « Garantie » de Clio. Confirmez-vous ?');
    expect(await confirmer(c, d.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await biensDe(c, id)).toEqual([polo]);
    const [f] = await sql<Json[]>`SELECT deleted_at, user_edited_fields, document_date::text AS document_date, retained_title FROM asset_files WHERE id = ${id}`;
    expect(f.deleted_at).toBeNull();
    // Décision de l'utilisateur marquée ; titre et date du document inchangés.
    expect(f.user_edited_fields).toMatchObject({ assetId: true });
    expect(f).toMatchObject({ document_date: '2026-03-10', retained_title: 'Garantie' });

    // Rattachements modifiés entre l'aperçu et la confirmation : rien n'est écrit.
    const p = planDe(await demander(c, 'Rattache le document Garantie à la Clio'));
    const autre = planDe(await demander(c, 'Détache le document Garantie de la Polo'));
    expect(await confirmer(c, autre.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await biensDe(c, id)).toEqual([]);
    const conf = await confirmer(c, p.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/modifié depuis l’aperçu : rien n’a été fait/);
    expect(await biensDe(c, id)).toEqual([]);
  });

  it('L114F-E06 — deux comptes : rien n’est trouvé ni écrit chez l’autre ; lecture seule refusée à la confirmation', async () => {
    const a = await compte();
    const b = await compte();
    const clioA = await bien(a, 'Clio', { keyCharacteristics: { mileage: 45000 } });
    const docA = await document(a, clioA, 'Garantie');
    const poloB = await bien(b, 'Polo', { keyCharacteristics: { mileage: 9000 } });
    const docB = await document(b, poloB, 'Notice');

    // Le compte B ne voit ni le bien ni le document du compte A.
    expect(await demander(b, 'Renomme la Clio en Twingo')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé ce bien/) });
    expect(await demander(b, 'Efface le kilométrage de la Clio')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé ce bien/) });
    expect(await demander(b, 'Rattache le document Garantie à la Polo')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé ce document/) });
    expect(await demander(b, 'Rattache le document Notice à la Clio')).toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé ce bien/) });
    // « ce bien » / « ce document » désignant un objet de l'autre compte : jamais résolu.
    expect(await demander(b, 'Renomme ce bien en Twingo', { reference: { type: 'asset', id: clioA } })).toMatchObject({ kind: 'need_info' });
    expect(await demander(b, 'Rattache ce document à la Polo', { reference: { type: 'document', id: docA } })).toMatchObject({ kind: 'need_info' });

    // Le plan d'un compte n'est pas confirmable depuis un autre compte.
    const r = planDe(await demander(a, 'Renomme la Clio en Clio de Paul'));
    expect(await confirmer(b, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });

    // Compte A passé en lecture seule entre l'aperçu et la confirmation : les trois commandes sont refusées.
    const e = planDe(await demander(a, 'Efface le kilométrage de la Clio'));
    const l = planDe(await demander(a, 'Détache le document Garantie de la Clio'));
    await lectureSeule(a);
    for (const plan of [r, e, l]) expect(await confirmer(a, plan.plan.planId)).toMatchObject({ ok: false, code: 'WRITE_REFUSED' });
    const apres = await lire(clioA);
    expect(apres.name).toBe('Clio');
    expect(apres.kc.mileage).toBe(45000);
    expect(await biensDe(a, docA)).toEqual([clioA]);
    // Rien n'a bougé chez B.
    expect((await lire(poloB)).name).toBe('Polo');
    expect((await lire(poloB)).kc.mileage).toBe(9000);
    expect(await biensDe(b, docB)).toEqual([poloB]);
  });

  it('L114F-E07 — non-régression : modifier une caractéristique (corps partagé avec l’effacement), puis « Annuler »', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio', { keyCharacteristics: { mileage: 45000 } });
    const r = planDe(await demander(c, 'Mets le kilométrage à 52 000 km pour la Clio'));
    expect(r.plan.actions[0]).toMatchObject({ command: 'UPDATE_ASSET_FIELD', params: { assetId: clio, field: 'mileage', value: 52000, previous: 45000 } });
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(JSON.stringify(conf)).toMatch(/« Kilométrage » de Clio mis à jour\./);
    const apres = await lire(clio);
    expect(apres.kc.mileage).toBe(52000);
    expect(apres.kc.mileage__origin).toBe('USER');
    const { undoCommandPlan } = await import('@/services/verebona-assistant/commands/undo.service');
    expect(await undoCommandPlan({ planId: r.plan.planId, accountId: c.id, userId: c.ownerUserId })).toMatchObject({ ok: true, status: 'UNDONE' });
    expect((await lire(clio)).kc.mileage).toBe(45000);
  });
});
