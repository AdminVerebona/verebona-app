/**
 * Lot 114B (Trello #753, CDC T2 §9, §14.3 W01 / W03, §14.5, M19-M21) — CRÉER
 * ET SUPPRIMER UN BIEN DEPUIS L'ASSISTANT, de bout en bout sur PostgreSQL
 * réel : plan figé, confirmation par identifiant seul, exécution par la
 * façade métier (celle de la route /api/assets).
 *
 *   E01  W01 : « ajoute une voiture nommée Mégane » → bien créé après
 *        confirmation seulement, dans le bon compte, avec sa catégorie ;
 *   E02  W01 : quota de l'offre atteint → aucun plan proposé ;
 *   E03  W03 : aperçu avec le décompte réel ; confirmation → bien et contenu
 *        supprimés ; les autres biens sont intacts ;
 *   E04  W03 : contenu modifié entre l'aperçu et la confirmation → rien n'est supprimé ;
 *   E05  cloisonnement : le bien d'un autre compte n'est jamais trouvé.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

scenario('L114B-BIENS', 'Lot 114B — créer et supprimer un bien depuis l’Assistant', ({ sql, make }) => {
  const compte = async (plan: 'standard' | 'premium' = 'premium'): Promise<Compte> => {
    const a = await make.account({ plan });
    return { id: a.id, ownerUserId: a.ownerUserId };
  };
  const bien = async (c: Compte, name: string) => {
    const b = await make.asset(c as never, { name, category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${b.id}`;
    return b.id as number;
  };
  const demander = async (c: Compte, message: string) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId: c.ownerUserId, planType: 'PREMIUM', message, clientRequestId: `l114b-${Math.random()}`, locale: 'fr-FR' } as never);
  };
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  const biens = async (c: Compte) => await sql`SELECT id, name, category, subtype FROM assets WHERE account_id = ${c.id} ORDER BY id` as unknown as Array<{ id: number; name: string; category: string; subtype: string | null }>;
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };

  it('L114B-BIENS-E01 — W01 : bien créé après confirmation seulement', async () => {
    const c = await compte();
    const r = planDe(await demander(c, 'Ajoute une voiture nommée Mégane'));
    expect(r.preview.summary).toBe('Créer le bien « Mégane » (voiture). Confirmez-vous ?');
    expect(await biens(c)).toHaveLength(0);
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await biens(c)).toEqual([expect.objectContaining({ name: 'Mégane', category: 'VEHICULE', subtype: 'Voiture' })]);
    // Un plan ne s'exécute qu'une fois : aucun second bien.
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await biens(c)).toHaveLength(1);
  });

  it('L114B-BIENS-E02 — W01 : quota de l’offre atteint, aucun plan', async () => {
    const c = await compte('standard');
    const { getEntitlements } = await import('@/services/entitlements.service');
    const max = (await getEntitlements(c.id)).quotas.maxAssets;
    for (let i = 0; i < max; i += 1) await bien(c, `Bien ${i + 1}`);
    const r = await demander(c, 'Ajoute une voiture nommée Mégane');
    expect(r).toMatchObject({ kind: 'need_info' });
    expect(await biens(c)).toHaveLength(max);
  });

  it('L114B-BIENS-E03 — W03 : décompte réel, puis suppression du bien et de son contenu', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    const polo = await bien(c, 'Polo');
    await make.assetFile(c as never, { assetId: clio });
    await make.assetFile(c as never, { assetId: clio });
    const gardee = await make.assetFile(c as never, { assetId: polo });
    const r = planDe(await demander(c, 'Supprime la Clio'));
    expect(r.preview.summary).toMatch(/^Supprimer définitivement le bien « Clio » et tout ce qui lui est rattaché : 2 documents\. Confirmez-vous \?$/);
    expect(r.plan.actions[0].effects).toContain('Cette action est irréversible.');
    expect(await biens(c)).toHaveLength(2);
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    expect((await biens(c)).map((b) => b.name)).toEqual(['Polo']);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM asset_files WHERE id = ${gardee.id} AND deleted_at IS NULL` as unknown as Array<{ n: number }>;
    expect(n).toBe(1);
  });

  it('L114B-BIENS-E04 — W03 : contenu modifié depuis l’aperçu → rien n’est supprimé', async () => {
    const c = await compte();
    const clio = await bien(c, 'Clio');
    await make.assetFile(c as never, { assetId: clio });
    const r = planDe(await demander(c, 'Supprime la Clio'));
    await make.assetFile(c as never, { assetId: clio });
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/a changé depuis l’aperçu/);
    expect((await biens(c)).map((b) => b.name)).toEqual(['Clio']);
  });

  it('L114B-BIENS-E05 — cloisonnement', async () => {
    const a = await compte();
    const b = await compte();
    await bien(a, 'Clio');
    const r = await demander(b, 'Supprime la Clio');
    expect(r).toMatchObject({ kind: 'need_info' });
    expect(await biens(a)).toHaveLength(1);
  });

  it('L114B-BIENS-E06 — W02 (passage 114AA) : catégorie et statut d’un bien, après confirmation seulement', async () => {
    const c = await compte();
    const autre = await compte();
    const clio = await bien(c, 'Clio');
    await sql`UPDATE assets SET subtype = 'Voiture' WHERE id = ${clio}`;
    const lire = async (id: number) => (await sql<Array<{ subtype: string | null; status: string; deleted_at: string | null; name: string }>>`
      SELECT subtype, status, deleted_at, name FROM assets WHERE id = ${id}`)[0];

    // Catégorie : du référentiel, écrite par le service de la fiche.
    const r = planDe(await demander(c, 'Change la catégorie de la Clio en moto'));
    expect(r.preview.summary).toBe('Modifier « Catégorie de bien » de Clio : Voiture → Moto. Confirmez-vous ?');
    expect((await lire(clio)).subtype).toBe('Voiture');
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED', undoUntil: null });
    expect((await lire(clio)).subtype).toBe('Moto');
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    // Déjà en place : aucun plan.
    expect(await demander(c, 'Change la catégorie de la Clio en moto'))
      .toMatchObject({ kind: 'need_info', message: 'La catégorie de Clio est déjà « Moto ».' });

    // Catégorie modifiée entre l'aperçu et la confirmation : rien n'est écrit.
    const p = planDe(await demander(c, 'Change la catégorie de la Clio en vélo'));
    await sql`UPDATE assets SET subtype = 'Camion' WHERE id = ${clio}`;
    const conf = await confirmer(c, p.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/La catégorie de ce bien a changé depuis l’aperçu : rien n’a été écrit/);
    expect((await lire(clio)).subtype).toBe('Camion');

    // Archivage : jamais depuis l'assistant.
    expect(await demander(c, 'Marque la Clio comme archivée'))
      .toMatchObject({ kind: 'need_info', message: 'L’archivage d’un bien ne se fait pas depuis l’assistant : ouvrez la fiche de Clio.' });

    // Cloisonnement : le bien d'un autre compte n'est jamais atteint.
    expect(await demander(autre, 'Change la catégorie de la Clio en moto')).toMatchObject({ kind: 'need_info' });
    expect(await demander(autre, 'Marque la Clio comme vendue')).toMatchObject({ kind: 'need_info' });

    // Statut : le bien sort du portefeuille actif, rien n'est supprimé — et l'assistant ne le retrouve plus
    // ensuite par son nom (règle existante `core/asset-availability`, annoncée dans l'aperçu).
    const s = planDe(await demander(c, 'Marque la Clio comme vendue'));
    expect(s.preview.summary).toBe('Modifier « Statut » de Clio : En service → Vendu. Confirmez-vous ?');
    expect(s.plan.actions[0].effects).toContain('L’assistant ne le retrouvera plus par son nom : pour revenir en arrière, passez par sa fiche.');
    expect(await confirmer(c, s.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(await lire(clio)).toMatchObject({ status: 'VENDU', deleted_at: null, name: 'Clio', subtype: 'Camion' });
    expect(await demander(c, 'Marque la Clio comme transmise'))
      .toMatchObject({ kind: 'need_info', message: expect.stringMatching(/^Je n’ai pas trouvé ce bien dans votre compte\./) });
  });
});
