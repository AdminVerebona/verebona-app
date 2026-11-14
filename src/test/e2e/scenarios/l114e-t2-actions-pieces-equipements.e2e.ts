/**
 * Lot 114 (Trello #753, CDC T2 §9, §14.3 W04 – W09, E2E-07) — PIÈCES ET
 * ÉQUIPEMENTS DEPUIS L'ASSISTANT, de bout en bout sur PostgreSQL réel : plan
 * figé, confirmation par identifiant seul, exécution par la façade métier
 * (celle des routes du bien).
 *
 *   E01  W07 / W08 / W09 : pièce créée, renommée, supprimée ; documents et équipements conservés dans le bien ;
 *   E02  W04 / W05 / W06 : équipement créé dans une pièce, renommé, archivé (rien n'est supprimé) ;
 *   E03  E2E-07 : compte Standard — aucun plan, le refus de l'offre est dit ; type de bien incompatible ;
 *   E04  élément modifié entre l'aperçu et la confirmation → rien n'est fait ;
 *   E05  cloisonnement des comptes.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };
type Json = Record<string, any>;

scenario('L114E-STRUCTURE', 'Lot 114 — pièces et équipements depuis l’Assistant', ({ sql, make }) => {
  const compte = async (plan: 'standard' | 'premium' = 'premium'): Promise<Compte> => {
    const a = await make.account({ plan });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const logement = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'IMMOBILIER' });
    await sql`UPDATE assets SET status = 'EN_SERVICE', subtype = 'Maison' WHERE id = ${b.id}`;
    return b.id as number;
  };
  const demander = async (c: Compte, message: string, plan = 'PREMIUM') => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId: c.ownerUserId, planType: plan, message, clientRequestId: `l114e-${Math.random()}`, locale: 'fr-FR' } as never);
  };
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };
  const pieces = (assetId: number) => sql<Json[]>`SELECT id, name FROM substructures WHERE asset_id = ${assetId} ORDER BY id`;
  const equipements = (assetId: number) => sql<Json[]>`SELECT id, name, substructure_id, archived_at, status FROM equipments WHERE asset_id = ${assetId} ORDER BY id`;

  it('L114E-E01 — pièce créée, renommée, supprimée ; son contenu reste dans le bien', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    const r = planDe(await demander(c, 'Ajoute une pièce Salle de bain dans la maison'));
    expect(r.preview.summary).toBe('Créer la pièce « Salle de bain » dans Maison. Confirmez-vous ?');
    expect(await pieces(maison)).toHaveLength(0);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [sdb] = await pieces(maison);
    expect(sdb.name).toBe('Salle de bain');
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await pieces(maison)).toHaveLength(1);
    // Même nom dans le même bien : jamais un doublon.
    expect(await demander(c, 'Ajoute une pièce salle de bain dans la maison')).toMatchObject({ kind: 'need_info', message: 'La pièce « Salle de bain » existe déjà dans Maison.' });

    const n = planDe(await demander(c, 'Renomme la pièce Salle de bain en Salle d’eau'));
    expect(n.preview.summary).toBe('Renommer la pièce « Salle de bain » (Maison) en « Salle d’eau ». Confirmez-vous ?');
    expect(await confirmer(c, n.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await pieces(maison))[0]).toMatchObject({ id: sdb.id, name: 'Salle d’eau' });

    // Un document et un équipement dans la pièce : annoncés, puis conservés dans le bien.
    const doc = await make.assetFile(c as never, { assetId: maison });
    await sql`UPDATE asset_files SET substructure_id = ${sdb.id} WHERE id = ${doc.id}`;
    await sql`INSERT INTO equipments (asset_id, substructure_id, name, status, created_at, updated_at) VALUES (${maison}, ${sdb.id}, 'Sèche-serviettes', 'EN_SERVICE', now(), now())`;
    const s = planDe(await demander(c, 'Supprime la pièce Salle d’eau de la maison'));
    expect(s.plan.actions[0].effects[0]).toBe('Conservés dans Maison, sans pièce : 1 document, 1 équipement.');
    expect(s.plan.actions[0].effects).toContain('Cette action est irréversible.');
    expect(await confirmer(c, s.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    expect(await pieces(maison)).toHaveLength(0);
    expect((await sql<Json[]>`SELECT asset_id, substructure_id, deleted_at FROM asset_files WHERE id = ${doc.id}`)[0]).toMatchObject({ asset_id: maison, substructure_id: null, deleted_at: null });
    expect(await equipements(maison)).toEqual([expect.objectContaining({ name: 'Sèche-serviettes', substructure_id: null, archived_at: null })]);
  });

  it('L114E-E02 — équipement créé dans une pièce, renommé, archivé (rien n’est supprimé)', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    await sql`INSERT INTO substructures (asset_id, name, order_index, scope, public_id, created_at, updated_at) VALUES (${maison}, 'Cellier', 0, 'personal', gen_random_uuid(), now(), now())`;
    const [cellier] = await pieces(maison);
    const r = planDe(await demander(c, 'Ajoute un équipement Chaudière dans la pièce Cellier de la maison'));
    expect(r.preview.summary).toBe('Créer l’équipement « Chaudière » dans Maison (pièce « Cellier »). Confirmez-vous ?');
    expect(await equipements(maison)).toHaveLength(0);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [ch] = await equipements(maison);
    expect(ch).toMatchObject({ name: 'Chaudière', substructure_id: cellier.id, status: 'EN_SERVICE', archived_at: null });

    const n = planDe(await demander(c, 'Renomme l’équipement Chaudière en Chaudière gaz'));
    expect(await confirmer(c, n.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await equipements(maison))[0]).toMatchObject({ id: ch.id, name: 'Chaudière gaz' });

    const doc = await make.assetFile(c as never, { assetId: maison });
    await sql`UPDATE asset_files SET equipment_id = ${ch.id} WHERE id = ${doc.id}`;
    const a = planDe(await demander(c, 'Retire l’équipement Chaudière gaz'));
    expect(a.preview.summary).toBe('Retirer l’équipement « Chaudière gaz » de Maison. Confirmez-vous ?');
    expect(a.plan.actions[0].effects).toEqual(['L’équipement est archivé : il n’apparaît plus dans le bien, rien n’est supprimé.', 'Conservés : 1 document.']);
    expect(await confirmer(c, a.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    const [apres] = await equipements(maison);
    expect(apres.archived_at).not.toBeNull();
    expect((await sql<Json[]>`SELECT equipment_id, deleted_at FROM asset_files WHERE id = ${doc.id}`)[0]).toMatchObject({ equipment_id: ch.id, deleted_at: null });
    // Archivé : il n'est plus désignable.
    expect(await demander(c, 'Renomme l’équipement Chaudière gaz en X')).toMatchObject({ kind: 'need_info' });
  });

  it('L114E-E03 — E2E-07 : offre Standard et type de bien incompatible → aucun plan, refus dit', async () => {
    const std = await compte('standard');
    const maison = await logement(std, 'Maison');
    const r = await demander(std, 'Ajoute une pièce Bureau dans la maison', 'STANDARD');
    expect(r).toMatchObject({ kind: 'need_info', message: 'Cette fonctionnalité est disponible avec Premium et Premium Duo.' });
    expect(await demander(std, 'Ajoute un équipement Chaudière dans la maison', 'STANDARD')).toMatchObject({ kind: 'need_info', message: 'Cette fonctionnalité est disponible avec Premium et Premium Duo.' });
    expect(await pieces(maison)).toHaveLength(0);
    const prem = await compte();
    const voiture = await make.asset(prem as never, { name: 'Clio', category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${voiture.id}`;
    expect(await demander(prem, 'Ajoute une pièce Coffre dans la Clio')).toMatchObject({ kind: 'need_info', message: 'Ce type de bien ne supporte pas la gestion des pièces' });
  });

  it('L114E-E04 — pièce modifiée depuis l’aperçu → rien n’est fait', async () => {
    const c = await compte();
    const maison = await logement(c, 'Maison');
    await sql`INSERT INTO substructures (asset_id, name, order_index, scope, public_id, created_at, updated_at) VALUES (${maison}, 'Bureau', 0, 'personal', gen_random_uuid(), now(), now())`;
    const [bureau] = await pieces(maison);
    const r = planDe(await demander(c, 'Supprime la pièce Bureau'));
    // Un document y est rattaché entre-temps : le décompte présenté n'est plus vrai.
    const doc = await make.assetFile(c as never, { assetId: maison });
    await sql`UPDATE asset_files SET substructure_id = ${bureau.id} WHERE id = ${doc.id}`;
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/a été modifié depuis l’aperçu/);
    expect(await pieces(maison)).toHaveLength(1);
  });

  it('L114E-E05 — cloisonnement : pièces et équipements d’un autre compte jamais trouvés ni modifiés', async () => {
    const a = await compte();
    const b = await compte();
    const maisonA = await logement(a, 'Maison');
    const chaletB = await logement(b, 'Chalet');
    await sql`INSERT INTO substructures (asset_id, name, order_index, scope, public_id, created_at, updated_at) VALUES (${maisonA}, 'Bureau', 0, 'personal', gen_random_uuid(), now(), now())`;
    await sql`INSERT INTO equipments (asset_id, name, status, created_at, updated_at) VALUES (${maisonA}, 'Chaudière', 'EN_SERVICE', now(), now())`;
    expect(await demander(b, 'Supprime la pièce Bureau')).toMatchObject({ kind: 'need_info' });
    expect(await demander(b, 'Retire l’équipement Chaudière')).toMatchObject({ kind: 'need_info' });
    // « la maison » du compte B désigne SON logement (de type maison), jamais celui du compte A.
    expect(planDe(await demander(b, 'Ajoute une pièce Bureau dans la maison')).plan.actions[0].params).toMatchObject({ kind: 'room_create', roomAssetId: chaletB });
    const r = planDe(await demander(a, 'Supprime la pièce Bureau'));
    expect(await confirmer(b, r.plan.planId)).toMatchObject({ ok: false });
    expect(await pieces(maisonA)).toHaveLength(1);
    expect((await equipements(maisonA))[0].archived_at).toBeNull();
  });
});
