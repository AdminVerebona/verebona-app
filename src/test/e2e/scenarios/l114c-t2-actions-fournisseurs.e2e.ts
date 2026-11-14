/**
 * Lot 114 (Trello #753, CDC T2 §9, §14.3 W18 – W20, X65 – X68, M30) — CRÉER,
 * MODIFIER ET ARCHIVER UN FOURNISSEUR DEPUIS L'ASSISTANT, de bout en bout sur
 * PostgreSQL réel : plan figé, confirmation par identifiant seul, exécution
 * par la façade métier (celle des routes /api/suppliers).
 *
 *   E01  W18 : fournisseur créé après confirmation seulement, une seule fois ; doublon certain jamais créé ;
 *   E02  W18 : fiches proches → décision « distinct » conservée à la confirmation (X66, X67) ;
 *   E03  W19 : coordonnée modifiée et protégée (SET), puis effacée volontairement (CLEARED, X68) ;
 *   E04  W19 : fiche modifiée entre l'aperçu et la confirmation → rien n'est écrit ;
 *   E05  W20 : archivage — rien n'est supprimé, relations conservées, fiche réactivable ;
 *   E06  cloisonnement des comptes ; compte en lecture seule.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;

scenario('L114C-FOURNISSEURS', 'Lot 114 — créer, modifier et archiver un fournisseur depuis l’Assistant', ({ sql, make }) => {
  const compte = async (): Promise<Compte> => {
    const a = await make.account({ plan: 'premium' });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const demander = async (c: Compte, message: string) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message, clientRequestId: `l114c-${Math.random()}`, locale: 'fr-FR' } as never);
  };
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };
  const fiches = (c: Compte) => sql<Json[]>`SELECT id, name, status, phone, email, website, source, created_by_user_id, user_field_decisions FROM suppliers WHERE account_id = ${c.id} ORDER BY id`;
  const creer = async (c: Compte, name: string, o: { phone?: string } = {}) => {
    const { createSupplierForAccount } = await import('@/services/suppliers/supplier-write.facade');
    return (await createSupplierForAccount({ accountId: c.id, userId: c.ownerUserId, input: { name, phone: o.phone ?? null } })).id;
  };

  it('L114C-E01 — W18 : créé après confirmation seulement, une seule fois ; doublon certain jamais créé', async () => {
    const c = await compte();
    const r = planDe(await demander(c, 'Ajoute le fournisseur Toiture Lambert, téléphone 06 12 34 56 78, email contact@lambert.fr'));
    expect(r.preview.summary).toBe('Créer le fournisseur « Toiture Lambert ». Confirmez-vous ?');
    expect(await fiches(c)).toHaveLength(0);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await fiches(c)).toEqual([expect.objectContaining({
      name: 'Toiture Lambert', status: 'active', phone: '06 12 34 56 78', email: 'contact@lambert.fr', source: 'manual', created_by_user_id: c.ownerUserId,
    })]);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await fiches(c)).toHaveLength(1);
    // Même nom redemandé : la fiche existe, aucun plan, aucun doublon.
    const encore = await demander(c, 'Ajoute le fournisseur Toiture Lambert');
    expect(encore).toMatchObject({ kind: 'need_info' });
    expect(JSON.stringify(encore)).toMatch(/existe déjà dans votre compte/);
    expect(await fiches(c)).toHaveLength(1);
    // X65 : nom absent → seule question, rien d'écrit.
    expect(await demander(c, 'Ajoute un fournisseur')).toMatchObject({ kind: 'need_info', message: 'Quel est le nom du fournisseur à créer ?' });
  });

  it('L114C-E02 — W18 : fiches proches annoncées ; confirmer = décision « distinct » conservée', async () => {
    const c = await compte();
    const existante = await creer(c, 'Plomberie Durand');
    const { checkSupplierDuplicate } = await import('@/services/agenda/agenda-suppliers');
    // Nom PROCHE selon le rapprochement RÉEL du référentiel (nom contenu mot pour mot) : aucune règle propre à l'Assistant.
    const nom = 'Plomberie Durand Chauffage';
    expect(await checkSupplierDuplicate(c.id, nom)).toMatchObject({ decision: 'uncertain', candidates: [{ id: existante, name: 'Plomberie Durand' }] });
    const r = planDe(await demander(c, `Ajoute le fournisseur ${nom}`));
    expect(r.plan.actions[0].params).toMatchObject({ kind: 'supplier_create', distinctFrom: [existante] });
    expect(r.plan.actions[0].effects.join(' ')).toMatch(/un fournisseur proche existe déjà : « Plomberie Durand »/);
    // Tant que rien n'est confirmé : aucune fiche, aucune décision.
    expect(await fiches(c)).toHaveLength(1);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const apres = await fiches(c);
    // Aucune fusion par similarité : deux fiches distinctes.
    expect(apres.map((f) => f.name)).toEqual(['Plomberie Durand', nom]);
    // X67 : la décision « distinct » de l'utilisateur est conservée (paire mémorisée, auteur tracé).
    const decisions = await sql<Json[]>`SELECT supplier_low_id, supplier_high_id, decision, decided_by_user_id FROM supplier_identity_decisions WHERE account_id = ${c.id}`;
    expect(decisions).toEqual([expect.objectContaining({ supplier_low_id: existante, supplier_high_id: apres[1].id, decision: 'DISTINCT', decided_by_user_id: c.ownerUserId })]);
  });

  it('L114C-E03 — W19 : coordonnée modifiée (protégée), puis effacée volontairement (X68)', async () => {
    const c = await compte();
    const id = await creer(c, 'Chauffage Martin', { phone: '01 23 45 67 89' });
    const r = planDe(await demander(c, 'Change le téléphone du fournisseur Chauffage Martin : 06 98 76 54 32'));
    expect(r.preview.summary).toBe('Modifier le téléphone du fournisseur « Chauffage Martin » : 01 23 45 67 89 → 06 98 76 54 32. Confirmez-vous ?');
    expect((await fiches(c))[0].phone).toBe('01 23 45 67 89');
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    let [f] = await fiches(c);
    expect(f).toMatchObject({ id, phone: '06 98 76 54 32' });
    expect(f.user_field_decisions.phone).toMatchObject({ action: 'SET', userId: c.ownerUserId });

    const e = planDe(await demander(c, 'Efface le téléphone du fournisseur Chauffage Martin'));
    expect(e.preview.summary).toBe('Effacer le téléphone du fournisseur « Chauffage Martin » (06 98 76 54 32). Confirmez-vous ?');
    expect(await confirmer(c, e.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    [f] = await fiches(c);
    expect(f.phone).toBeNull();
    expect(f.user_field_decisions.phone).toMatchObject({ action: 'CLEARED', userId: c.ownerUserId });

    const n = planDe(await demander(c, 'Renomme le fournisseur Chauffage Martin en Martin Énergies'));
    expect(await confirmer(c, n.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await fiches(c))[0].name).toBe('Martin Énergies');
  });

  it('L114C-E04 — W19 : fiche modifiée depuis l’aperçu → rien n’est écrit', async () => {
    const c = await compte();
    const id = await creer(c, 'Chauffage Martin', { phone: '01 23 45 67 89' });
    const r = planDe(await demander(c, 'Change le téléphone du fournisseur Chauffage Martin : 06 98 76 54 32'));
    await sql`UPDATE suppliers SET phone = '04 00 00 00 00' WHERE id = ${id}`;
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/a été modifié depuis l’aperçu/);
    expect((await fiches(c))[0].phone).toBe('04 00 00 00 00');
  });

  it('L114C-E05 — W20 : archivage, rien n’est supprimé, relations conservées, fiche réactivable', async () => {
    const c = await compte();
    const id = await creer(c, 'Chauffage Martin');
    const bien = await make.asset(c as never, { name: 'Maison', category: 'IMMOBILIER' });
    const doc = await make.assetFile(c as never, { assetId: bien.id });
    await sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed) VALUES (${doc.id}, ${id}, true)`;
    const r = planDe(await demander(c, 'Supprime le fournisseur Chauffage Martin'));
    expect(r.preview.summary).toBe('Archiver le fournisseur « Chauffage Martin ». Confirmez-vous ?');
    expect(r.plan.actions[0].effects[0]).toBe('Un fournisseur ne se supprime pas : il est archivé.');
    expect(r.plan.actions[0].effects[1]).toMatch(/1 document/);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await fiches(c)).toEqual([expect.objectContaining({ id, status: 'archived', name: 'Chauffage Martin' })]);
    expect(await sql`SELECT 1 FROM document_suppliers WHERE document_id = ${doc.id} AND supplier_id = ${id}`).toHaveLength(1);
    // Déjà archivé : aucun nouveau plan. Réactivation par la façade de la fiche : toujours possible.
    expect(await demander(c, 'Supprime le fournisseur Chauffage Martin')).toMatchObject({ kind: 'need_info' });
    const { setSupplierArchived } = await import('@/services/suppliers/supplier-write.facade');
    expect(await setSupplierArchived({ accountId: c.id, supplierId: id, restore: true })).toEqual({ ok: true, status: 'active' });
  });

  it('L114C-E06 — cloisonnement : le fournisseur d’un autre compte n’est jamais trouvé ni modifié', async () => {
    const a = await compte();
    const b = await compte();
    await creer(a, 'Chauffage Martin', { phone: '01 23 45 67 89' });
    expect(await demander(b, 'Supprime le fournisseur Chauffage Martin')).toMatchObject({ kind: 'need_info' });
    expect(await demander(b, 'Change le téléphone du fournisseur Chauffage Martin : 06 98 76 54 32')).toMatchObject({ kind: 'need_info' });
    // Un plan du compte A ne se confirme pas depuis le compte B.
    const r = planDe(await demander(a, 'Supprime le fournisseur Chauffage Martin'));
    expect(await confirmer(b, r.plan.planId)).toMatchObject({ ok: false });
    expect((await fiches(a))[0]).toMatchObject({ status: 'active', phone: '01 23 45 67 89' });
  });
});
