/**
 * Lot 114 (Trello #753, CDC T2 §9, §14.3 W10 / W12 / W14, §14.4 « Documents ») —
 * AJOUTER UN LIEN WEB, MODIFIER ET SUPPRIMER UN DOCUMENT DEPUIS L'ASSISTANT,
 * de bout en bout sur PostgreSQL réel : plan figé, confirmation par
 * identifiant seul, exécution par la façade métier (celle des routes
 * /api/web-links, /api/documents/[id], /api/files/[id]).
 *
 *   E01  W10 : lien créé après confirmation seulement, rattaché au bon bien, une seule fois ;
 *   E02  W12 : titre de l'utilisateur (protégé), date corrigée (protégée), note ajoutée puis effacée ;
 *   E03  W12 : document modifié entre l'aperçu et la confirmation → rien n'est écrit ;
 *   E04  W14 : suppression logique ; les autres documents sont intacts ;
 *   E05  la route du tiroir rend toujours le même résultat (façade partagée, non-régression) ;
 *   E06  cloisonnement des comptes.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;

scenario('L114D-DOCUMENTS', 'Lot 114 — lien web, modifier et supprimer un document depuis l’Assistant', ({ sql, make }) => {
  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const demander = async (c: Compte, message: string, extra: Json = {}) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message, clientRequestId: `l114d-${Math.random()}`, locale: 'fr-FR', ...extra } as never);
  };
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };
  const docs = (c: Compte) => sql<Json[]>`
    SELECT id, asset_id, original_filename, retained_title, title_source, document_date::text AS document_date, notes, is_web_link, web_link_url, web_link_title,
           user_edited_fields, deleted_at FROM asset_files WHERE account_id = ${c.id} ORDER BY id`;
  const document = async (c: Compte, assetId: number, titre: string, date: string | null = '2026-03-10') => {
    const f = await make.assetFile(c as never, { assetId });
    await sql`UPDATE asset_files SET original_filename = ${`${titre}.pdf`}, retained_title = ${titre}, document_date = ${date}::date WHERE id = ${f.id}`;
    return f.id as number;
  };

  it('L114D-E01 — W10 : lien créé après confirmation seulement, rattaché au bon bien', async () => {
    const c = await compte();
    const maison = await make.asset(c as never, { name: 'Maison', category: 'IMMOBILIER' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${maison.id}`;
    const r = planDe(await demander(c, 'Ajoute le lien https://www.fabricant.fr/notice.pdf intitulé « Notice de la chaudière » pour la maison'));
    expect(r.preview.summary).toMatch(/^Ajouter le lien « Notice de la chaudière », rattaché à Maison/);
    expect(await docs(c)).toHaveLength(0);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await docs(c)).toEqual([expect.objectContaining({
      asset_id: maison.id, is_web_link: true, web_link_url: 'https://www.fabricant.fr/notice.pdf', web_link_title: 'Notice de la chaudière', original_filename: 'Notice de la chaudière', deleted_at: null,
    })]);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await docs(c)).toHaveLength(1);
    // Sans titre : question, rien d'écrit.
    expect(await demander(c, 'Ajoute le lien https://exemple.fr/autre')).toMatchObject({ kind: 'need_info', message: 'Quel titre voulez-vous donner à ce lien ?' });
    expect(await docs(c)).toHaveLength(1);
  });

  it('L114D-E02 — W12 : titre, date et note de l’utilisateur, écrits par la façade du tiroir', async () => {
    const c = await compte();
    const maison = await make.asset(c as never, { name: 'Maison', category: 'IMMOBILIER' });
    const id = await document(c, maison.id, 'Notice chaudière');

    const t = planDe(await demander(c, 'Renomme le document Notice chaudière en Notice chaudière Saunier Duval'));
    expect(t.preview.summary).toBe('Renommer le document « Notice chaudière » en « Notice chaudière Saunier Duval ». Confirmez-vous ?');
    expect(await confirmer(c, t.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    let [d] = await docs(c);
    expect(d).toMatchObject({ id, retained_title: 'Notice chaudière Saunier Duval', title_source: 'USER', original_filename: 'Notice chaudière.pdf', document_date: '2026-03-10' });
    expect(d.user_edited_fields).toMatchObject({ retainedTitle: true });

    const dt = planDe(await demander(c, 'Change la date du document Notice chaudière Saunier Duval au 12 mars 2025'));
    expect(dt.preview.summary).toBe('Changer la date du document « Notice chaudière Saunier Duval » : 10 mars 2026 → 12 mars 2025. Confirmez-vous ?');
    expect(await confirmer(c, dt.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    [d] = await docs(c);
    expect(d).toMatchObject({ document_date: '2025-03-12', retained_title: 'Notice chaudière Saunier Duval' });
    expect(d.user_edited_fields).toMatchObject({ documentDate: true, retainedTitle: true });

    const n = planDe(await demander(c, 'Ajoute la note « À relire avant l’entretien » au document Notice chaudière Saunier Duval'));
    expect(await confirmer(c, n.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    [d] = await docs(c);
    expect(d).toMatchObject({ notes: 'À relire avant l’entretien', document_date: '2025-03-12', retained_title: 'Notice chaudière Saunier Duval' });

    const e = planDe(await demander(c, 'Efface la note du document Notice chaudière Saunier Duval'));
    expect(e.plan.actions[0].effects.join(' ')).toMatch(/Note effacée : « À relire avant l’entretien »/);
    expect(await confirmer(c, e.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    [d] = await docs(c);
    expect(d.notes).toBeNull();
    // Rien d'autre n'a bougé : titre et date de l'utilisateur intacts.
    expect(d).toMatchObject({ document_date: '2025-03-12', retained_title: 'Notice chaudière Saunier Duval', asset_id: maison.id });
  });

  it('L114D-E03 — W12 : document modifié depuis l’aperçu → rien n’est écrit', async () => {
    const c = await compte();
    const maison = await make.asset(c as never, { name: 'Maison', category: 'IMMOBILIER' });
    const id = await document(c, maison.id, 'Facture EDF');
    const r = planDe(await demander(c, 'Renomme le document Facture EDF en Facture électricité'));
    await sql`UPDATE asset_files SET document_date = '2026-01-01' WHERE id = ${id}`;
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/a été modifié depuis l’aperçu/);
    expect((await docs(c))[0]).toMatchObject({ retained_title: 'Facture EDF', document_date: '2026-01-01' });
  });

  it('L114D-E04 — W14 : suppression logique ; les autres documents sont intacts', async () => {
    const c = await compte();
    const maison = await make.asset(c as never, { name: 'Maison', category: 'IMMOBILIER' });
    const a = await document(c, maison.id, 'Facture EDF');
    const b = await document(c, maison.id, 'Notice chaudière');
    // Deux documents possibles : jamais un choix à la place de l'utilisateur.
    await document(c, maison.id, 'Facture EDF mars');
    expect(await demander(c, 'Supprime le document Facture')).toMatchObject({ kind: 'need_info' });
    const r = planDe(await demander(c, 'Supprime le document Facture EDF'));
    expect(r.preview.summary).toBe('Supprimer le document « Facture EDF » du 10 mars 2026 (Maison). Confirmez-vous ?');
    expect((await docs(c)).every((d) => d.deleted_at === null)).toBe(true);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    const apres = await docs(c);
    expect(apres.find((d) => d.id === a)!.deleted_at).not.toBeNull();
    expect(apres.filter((d) => d.deleted_at === null).map((d) => d.id)).toContain(b);
    expect(apres.filter((d) => d.deleted_at === null)).toHaveLength(2);
    // Le document supprimé n'est plus désignable.
    expect(await demander(c, 'Renomme le document Facture EDF en X')).toMatchObject({ kind: 'plan' }); // « Facture EDF mars » reste, seul candidat
    expect(await demander(c, 'Supprime le document Notice introuvable')).toMatchObject({ kind: 'need_info' });
  });

  it('L114D-E05 — façade partagée : la mise à jour par le tiroir (même fonction) garde ses règles', async () => {
    const c = await compte();
    const maison = await make.asset(c as never, { name: 'Maison', category: 'IMMOBILIER' });
    const id = await document(c, maison.id, 'Facture EDF');
    const { updateDocumentForAccount } = await import('@/services/documents/document-write.facade');
    // Corps tel que le tiroir l'envoie : titre inchangé renvoyé → pas un titre utilisateur ; date conservée.
    const res = await updateDocumentForAccount({ userId: c.ownerUserId, currentAccountId: c.id }, id, { fileName: 'Facture EDF.pdf', documentDate: '2026-03-10', retainedTitle: 'Facture EDF' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ message: 'Document mis à jour avec succès', documentId: id });
    const [inchange] = await docs(c);
    expect(inchange).toMatchObject({ retained_title: 'Facture EDF', document_date: '2026-03-10' });
    expect(inchange.title_source).not.toBe('USER');
    // Nom absent : même refus qu'avant l'extraction.
    const ko = await updateDocumentForAccount({ userId: c.ownerUserId, currentAccountId: c.id }, id, { documentDate: '2026-03-10' });
    expect(ko.status).toBe(400);
    expect(await ko.json()).toMatchObject({ error: 'MISSING_FIELD' });
  });

  it('L114D-E06 — cloisonnement : le document d’un autre compte n’est jamais trouvé, modifié ni supprimé', async () => {
    const a = await compte();
    const b = await compte();
    const maison = await make.asset(a as never, { name: 'Maison', category: 'IMMOBILIER' });
    const id = await document(a, maison.id, 'Facture EDF');
    expect(await demander(b, 'Supprime le document Facture EDF')).toMatchObject({ kind: 'need_info' });
    expect(await demander(b, 'Supprime ce document', { reference: { type: 'document', id, method: 'thread' } })).toMatchObject({ kind: 'need_info' });
    // Lien web : le bien d'un autre compte n'est jamais une cible.
    expect(await demander(b, 'Ajoute le lien https://x.fr intitulé « X » pour la maison')).toMatchObject({ kind: 'need_info' });
    const r = planDe(await demander(a, 'Supprime le document Facture EDF'));
    expect(await confirmer(b, r.plan.planId)).toMatchObject({ ok: false });
    expect((await docs(a))[0].deleted_at).toBeNull();
  });
});
