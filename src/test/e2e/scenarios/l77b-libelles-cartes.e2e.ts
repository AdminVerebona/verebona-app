/**
 * Lot 77B — libellés des cartes « À traiter » (décision PO du 21/10/2026),
 * base réelle (PG16).
 *
 *   L77B-E2E-01 : carte d'un événement d'agenda — la cible est le TITRE de
 *                 l'événement et son bien (« Contrôle technique · Peugeot
 *                 208 »), jamais « #9 ».
 *   L77B-E2E-02 : cible introuvable (supprimée) → « Événement d’agenda »,
 *                 jamais « #id » (une cible d'un autre compte est refusée
 *                 par la base : CROSS_ACCOUNT_LINK).
 *   L77B-E2E-03 : action LINK-ASSET DÉJÀ ENREGISTRÉE avec la justification
 *                 technique de T3 → recalculée à la lecture : « Déjà 3
 *                 documents de Cardif IARD sur Maison » (page, API, mascotte).
 *   L77B-E2E-04 : cible équipement → nom de l'équipement et de son bien ;
 *                 équipement supprimé → « Équipement ».
 */
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

const INTERDIT = /#\d+|serveur|fourni par/i;

scenario('L77B', 'Libellés des cartes « À traiter » : formulations utilisateur', ({ sql, make }) => {
  async function action(accountId: number, p: {
    targetType: string; targetId: number; fieldKey?: string | null; relationKey?: string | null;
    kind?: string; rule: string; question: string; proposals?: unknown[]; priority?: string;
  }) {
    await sql`INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, relation_key, action_kind, rule_code, question, proposals_json, priority)
              VALUES (${accountId}, ${p.targetType}, ${p.targetId}, ${p.fieldKey ?? null}, ${p.relationKey ?? null}, ${p.kind ?? 'COMPLETE'},
                      ${p.rule}, ${p.question}, ${p.proposals ? JSON.stringify(p.proposals) : null}::jsonb, ${p.priority ?? 'DO_NEXT'})`;
  }
  const page = async (accountId: number) => {
    const { getToProcessPage } = await import('@/services/to-process/to-process-query.service');
    return getToProcessPage(accountId);
  };

  it('L77B-E2E-01 — événement d’agenda : titre de l’événement et bien, jamais « #id »', async () => {
    const c = await make.account({ plan: 'premium' });
    const bien = await make.asset(c, { category: 'VEHICULE', name: 'Peugeot 208' });
    const evt = await make.agendaItem(c, { title: 'Contrôle technique', assetIds: [bien.id] });
    await action(c.id, { targetType: 'AGENDA_ITEM', targetId: evt.id, fieldKey: 'date', rule: 'DATA-AGENDA-DATE', question: 'À quelle date « Contrôle technique » a-t-il lieu ?' });
    const carte = (await page(c.id)).actions.find((a) => a.targetType === 'AGENDA_ITEM' && a.targetId === evt.id)!;
    expect(carte.target.label).toBe('Contrôle technique');
    expect(carte.target.assetName).toBe('Peugeot 208');
    expect(carte.target.assetId).toBe(bien.id);
    expect(carte.target.label).not.toMatch(INTERDIT);
  });

  it('L77B-E2E-02 — cible introuvable : « Événement d’agenda », jamais « #id »', async () => {
    const c = await make.account({ plan: 'premium' });
    const supprime = await make.agendaItem(c, { title: 'Ancien événement' });
    await action(c.id, { targetType: 'AGENDA_ITEM', targetId: supprime.id, fieldKey: 'date', rule: 'DATA-AGENDA-DATE', question: 'À quelle date cet événement a-t-il lieu ?' });
    await sql`DELETE FROM agenda_items WHERE id = ${supprime.id}`;
    const cartes = (await page(c.id)).actions.filter((a) => a.targetType === 'AGENDA_ITEM');
    expect(cartes).toHaveLength(1);
    expect(cartes[0].target.label).toBe('Événement d’agenda');
    expect(cartes[0].target.assetName ?? null).toBeNull();
  });

  it('L77B-E2E-03 — LINK-ASSET enregistrée avec la justification de T3 : recalculée à la lecture (page, API, mascotte)', async () => {
    const c = await make.account({ plan: 'premium' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const doc = await make.assetFile(c, { name: 'contacts.pdf' });
    await sql`UPDATE asset_files SET retained_title = 'Fiche de contacts Cardif IARD BNP Paribas' WHERE id = ${doc.id}`;
    await action(c.id, {
      targetType: 'DOCUMENT', targetId: doc.id, relationKey: 'assetIds', kind: 'ARBITRATE', rule: 'LINK-ASSET', priority: 'DO_FIRST',
      question: 'À quel bien rattacher ce document ?',
      proposals: [{ value: maison.id, label: 'Maison', confidence: 0.8, sourceContext: { label: 'Historique fournisseur fourni par le serveur : 3 documents du même émetteur Cardif IARD sont déjà rattachés à ce bien' } }],
    });
    const carte = (await page(c.id)).actions.find((a) => a.targetType === 'DOCUMENT' && a.targetId === doc.id)!;
    expect(carte.proposals[0].sourceContext?.label).toBe('Déjà 3 documents de Cardif IARD sur Maison');
    expect(carte.target.label).toBe('Fiche de contacts Cardif IARD BNP Paribas');

    session.currentAccountId = c.id;
    session.userId = c.ownerUserId;
    const { GET } = await import('@/app/api/v2/to-process/route');
    const api = (await (await GET(new NextRequest('http://x/api/v2/to-process?order=priority'))).json()) as { actions: Array<{ targetId: number; proposals: Array<{ sourceContext?: { label: string } }> }> };
    expect(api.actions.find((a) => a.targetId === doc.id)!.proposals[0].sourceContext?.label).toBe('Déjà 3 documents de Cardif IARD sur Maison');

    const { buildTodoBlock } = await import('@/services/home/mascot/todo-items');
    const p = await page(c.id);
    const bloc = buildTodoBlock(p.actions, p.total)!;
    const item = bloc.items.find((i) => i.entityId === doc.id)!;
    expect(item.card.proposals[0].sourceContext?.label).toBe('Déjà 3 documents de Cardif IARD sur Maison');
    expect(JSON.stringify(item)).not.toMatch(/serveur|fourni par/i);

    // La ligne enregistrée n'est pas réécrite (recalcul à la lecture, aucune migration).
    const [ligne] = await sql<{ p: Array<{ sourceContext: { label: string } }> }[]>`
      SELECT proposals_json AS p FROM to_process_actions WHERE account_id = ${c.id} AND target_id = ${doc.id}`;
    expect(ligne.p[0].sourceContext.label).toMatch(/fourni par le serveur/);
  });

  it('L77B-E2E-04 — équipement : nom et bien ; équipement supprimé → « Équipement »', async () => {
    const c = await make.account({ plan: 'premium' });
    const maison = await make.asset(c, { category: 'IMMOBILIER', name: 'Maison' });
    const [eq] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${maison.id}, 'Chaudière') RETURNING id`;
    const [eq2] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${maison.id}, 'Ancien ballon') RETURNING id`;
    for (const id of [eq.id, eq2.id]) {
      await action(c.id, { targetType: 'EQUIPMENT', targetId: id, relationKey: 'assetId', rule: 'LINK-EQUIP-ASSET', question: 'À quel bien cet équipement appartient-il ?' });
    }
    await sql`DELETE FROM equipments WHERE id = ${eq2.id}`;
    const cartes = (await page(c.id)).actions.filter((a) => a.targetType === 'EQUIPMENT');
    const mien = cartes.find((a) => a.targetId === eq.id)!;
    expect(mien.target.label).toBe('Chaudière');
    expect(mien.target.assetName).toBe('Maison');
    expect(cartes.find((a) => a.targetId === eq2.id)!.target.label).toBe('Équipement');
  });
});
