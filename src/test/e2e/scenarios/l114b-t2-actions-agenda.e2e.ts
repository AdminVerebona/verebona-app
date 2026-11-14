/**
 * Lot 114B (Trello #753, CDC T2 §9, §14.3 W15-W17, §14.5) — ACTIONS AGENDA
 * DEPUIS L'ASSISTANT, de bout en bout sur PostgreSQL réel : préparation du
 * plan, confirmation par identifiant seul, exécution par le service de
 * l'Agenda (le même que le tiroir), résultat par action.
 *
 *   E01  W15 : « ajoute un entretien pour la Clio » sans date → échéance
 *        créée SANS date (et non « Sans échéance ») ;
 *   E02  W16 : déplacer une échéance ; modifiée entre l'aperçu et la
 *        confirmation → rien n'est écrit ;
 *   E03  W17 : supprimer une occurrence d'une série (les autres restent),
 *        puis toute la série (nombre annoncé) ;
 *   E04  rien n'est écrit avant confirmation ; un plan ne s'exécute qu'une fois ;
 *   E05  droits : compte en lecture seule refusé à la confirmation ; le plan
 *        d'un utilisateur n'est pas confirmable par un autre compte ;
 *   E06  cloisonnement : l'échéance d'un autre compte n'est jamais trouvée.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Compte = { id: number; ownerUserId: number };

scenario('L114B-AGENDA', 'Lot 114B — créer sans date, modifier, supprimer une échéance depuis l’Assistant', ({ sql, make }) => {
  const preparer = async (plan: 'standard' | 'premium' = 'standard') => {
    const a = await make.account({ plan });
    const bien = await make.asset(a as never, { name: 'Clio', category: 'VEHICULE' });
    await sql`UPDATE assets SET status = 'EN_SERVICE' WHERE id = ${bien.id}`;
    return { c: { id: a.id, ownerUserId: a.ownerUserId } as Compte, assetId: bien.id as number };
  };
  const creer = async (c: Compte, title: string, startDate: string | null, assetId: number) => {
    const { createAgendaItem } = await import('@/services/agenda/AgendaWriteService');
    return (await createAgendaItem({ title, startDate, assetIds: [assetId], originType: 'manual', homeCategory: 'action' }, c.id, c.ownerUserId)).id;
  };
  const demander = async (c: Compte, message: string) => {
    const { prepareCommand } = await import('@/services/verebona-assistant/commands/plan.service');
    return prepareCommand({ accountId: c.id, userId: c.ownerUserId, planType: 'STANDARD', message, clientRequestId: `l114b-${Math.random()}`, locale: 'fr-FR' } as never);
  };
  const confirmer = async (c: Compte, planId: string) => {
    const { confirmCommandPlan } = await import('@/services/verebona-assistant/commands/plan.service');
    return confirmCommandPlan({ planId, accountId: c.id, userId: c.ownerUserId });
  };
  const echeances = async (c: Compte) => await sql`SELECT id, title, to_char(start_date, 'YYYY-MM-DD') AS d, no_deadline AS nd FROM agenda_items WHERE account_id = ${c.id} ORDER BY id` as unknown as Array<{ id: number; title: string; d: string | null; nd: boolean | null }>;
  const planDe = (r: Awaited<ReturnType<typeof demander>>) => {
    if (!r || r.kind !== 'plan') throw new Error(`plan attendu, reçu ${JSON.stringify(r)}`);
    return r;
  };

  it('L114B-AGENDA-E01 — W15 : échéance créée sans date, après confirmation seulement', async () => {
    const { c } = await preparer();
    const r = planDe(await demander(c, 'Ajoute un entretien pour la Clio'));
    // Règle remplacée (carte #742) : annoncée « À prévoir » (situation par défaut d'une création manuelle), plus « Sans date ».
    expect(r.preview.summary).toMatch(/Créer l’échéance « Entretien » \(à prévoir\), rattachée à Clio\. Confirmez-vous \?/);
    // E04 : rien n'est écrit avant la confirmation.
    expect(await echeances(c)).toHaveLength(0);
    const conf = await confirmer(c, r.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    const lignes = await echeances(c);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({ title: 'Entretien', d: null });
    expect(lignes[0].nd ?? false).toBe(false);
    // E04 : un plan ne s'exécute qu'une fois (double clic, rejeu réseau).
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_ALREADY_HANDLED' });
    expect(await echeances(c)).toHaveLength(1);
  });

  it('L114B-AGENDA-E02 — W16 : déplacer ; état modifié depuis l’aperçu → rien n’est écrit', async () => {
    const { c, assetId } = await preparer();
    const id = await creer(c, 'Vidange', '2027-03-12', assetId);
    const r = planDe(await demander(c, 'Reporte l’échéance vidange de la Clio au 20 mars 2027'));
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await echeances(c)).find((x) => x.id === id)).toMatchObject({ d: '2027-03-20' });

    // Aperçu, puis modification par ailleurs (tiroir de l'Agenda), puis confirmation.
    const r2 = planDe(await demander(c, 'Reporte l’échéance vidange au 25 mars 2027'));
    await sql`UPDATE agenda_items SET title = 'Vidange et filtres', updated_at = now() + interval '1 second' WHERE id = ${id}`;
    const conf = await confirmer(c, r2.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'FAILED' });
    expect(JSON.stringify(conf)).toMatch(/modifiée depuis l’aperçu/);
    expect((await echeances(c)).find((x) => x.id === id)).toMatchObject({ d: '2027-03-20', title: 'Vidange et filtres' });
  });

  it('L114B-AGENDA-E03 — W17 : une occurrence, puis toute la série', async () => {
    const { c, assetId } = await preparer();
    const ids: number[] = [];
    for (const d of ['2027-01-10', '2027-02-10', '2027-03-10']) ids.push(await creer(c, 'Rappel vidange', d, assetId));
    await sql`UPDATE agenda_items SET series_key = 'serie-114b' WHERE id = ANY(${ids}::int[])`;
    const autre = await creer(c, 'Contrôle technique', '2027-06-01', assetId);

    const r = planDe(await demander(c, 'Supprime le rappel vidange du 10 janvier 2027'));
    expect(r.plan.actions[0].effects.join(' ')).toMatch(/les 2 autres de la série sont conservées/);
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect((await echeances(c)).map((x) => x.id)).toEqual([ids[1], ids[2], autre]);

    const s = planDe(await demander(c, 'Supprime toute la série des rappels vidange'));
    expect(s.preview.summary).toMatch(/Supprimer toute la série « Rappel vidange » : 2 échéances\./);
    const conf = await confirmer(c, s.plan.planId);
    expect(conf).toMatchObject({ ok: true, status: 'EXECUTED' });
    expect(JSON.stringify(conf)).toMatch(/2 échéances/);
    // Seule l'échéance étrangère à la série reste.
    expect((await echeances(c)).map((x) => x.id)).toEqual([autre]);
    // Aucune annulation proposée pour une suppression définitive.
    expect((conf as { undoUntil: string | null }).undoUntil).toBeNull();
  });

  it('L114B-AGENDA-E05 — droits relus à la confirmation', async () => {
    const { c, assetId } = await preparer();
    const id = await creer(c, 'Ramonage', '2027-09-01', assetId);
    const r = planDe(await demander(c, 'Supprime l’échéance ramonage'));
    // Le plan d'un compte n'est pas confirmable depuis un autre compte.
    const { c: intrus } = await preparer();
    expect(await confirmer(intrus, r.plan.planId)).toMatchObject({ ok: false, code: 'PLAN_NOT_FOUND' });
    // Compte passé en lecture seule entre l'aperçu et la confirmation : refus, rien n'est supprimé.
    await sql`DELETE FROM account_subscriptions WHERE account_id = ${c.id}`;
    await sql`INSERT INTO account_subscriptions (account_id, plan_code, status, trial_ends_at) VALUES (${c.id}, 'premium', 'trialing', now() - interval '1 day')`;
    expect(await confirmer(c, r.plan.planId)).toMatchObject({ ok: false, code: 'WRITE_REFUSED' });
    expect((await echeances(c)).map((x) => x.id)).toEqual([id]);
  });

  it('L114B-AGENDA-E06 — cloisonnement : l’échéance d’un autre compte n’est jamais trouvée', async () => {
    const a = await preparer();
    const b = await preparer();
    const idA = await creer(a.c, 'Vidange', '2027-03-12', a.assetId);
    const r = await demander(b.c, 'Supprime l’échéance vidange');
    expect(r).toMatchObject({ kind: 'need_info' });
    expect(JSON.stringify(r)).toMatch(/pas trouvé cette échéance/);
    expect((await echeances(a.c)).map((x) => x.id)).toEqual([idA]);
  });
});
