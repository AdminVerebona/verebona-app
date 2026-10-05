/**
 * Lot 14 (volet B) — primitive d'écriture agenda, sur PostgreSQL réel
 * (CDC 15 T4-07, T4-08, T4-09, D-13, D-14, D-15, X-04).
 *
 *  · T4-08 : réanalyse idempotente (une seule ligne, clé posée), 01/03 → 01/04
 *            met à jour le même élément, un événement disparu est retiré ;
 *  · §14.6 : un élément modifié à la main n'est jamais mis à jour ni retiré ;
 *  · T4-07 : depuis le document source, tous ses événements automatiques ;
 *  · D-13  : achat manuel réalisé → recopie (champ vide) ; achat automatique → aucune ;
 *  · D-14  : HISTORICAL jamais notifié, exclu des prochaines échéances ;
 *  · lot 16b-2 : AI_T4_EFFECTS retiré, une valeur encore posée est sans effet.
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AgendaDecision } from '@/services/ai/agenda';

const notifications = vi.hoisted(() => [] as Array<{ assetId: number; itemId: number }>);
vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/ai/reconciliation/coherence-impact', () => ({ hasCoherenceImpact: async () => false }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/coherence/impact-propagation.service', async (orig) => ({
  ...(await orig<object>()),
  emitAgendaItemCreated: async (_accountId: number, assetId: number, itemId: number) => {
    notifications.push({ assetId, itemId });
  },
}));

const decision = (fileId: number, date: string, over: Partial<AgendaDecision> = {}): AgendaDecision => ({
  action: 'create', title: 'Contrôle technique', date, category: 'action', confidence: 'certain',
  reasonCode: 'E2E', deterministic: true, sourceFileId: fileId, originFieldKey: 'nextInspection', ...over,
});

scenario('T4-L14', 'Primitive d’écriture agenda, clé fonctionnelle et natures', ({ sql, make }) => {
  const env = { ...process.env };
  let persist: typeof import('@/services/agenda/agenda-persistence').persistAgendaDecisions;
  let write: typeof import('@/services/agenda/AgendaWriteService');
  let query: typeof import('@/services/agenda/AgendaQueryService');

  beforeAll(async () => {
    ({ persistAgendaDecisions: persist } = await import('@/services/agenda/agenda-persistence'));
    write = await import('@/services/agenda/AgendaWriteService');
    query = await import('@/services/agenda/AgendaQueryService');
  });
  beforeEach(() => { notifications.length = 0; });
  afterEach(() => {
    for (const k of ['AI_T4_EFFECTS', 'CANONICAL_WRITE_MODE']) {
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
    }
  });

  const itemsDe = async (assetId: number) => sql<{
    id: number; title: string; start_date: string; functional_key: string | null; event_nature: string | null;
    business_type: string | null; is_automatic: boolean;
  }[]>`
    SELECT i.id, i.title, i.start_date::text AS start_date, i.functional_key, i.event_nature, i.business_type, i.is_automatic
      FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id
     WHERE l.asset_id = ${assetId} ORDER BY i.id`;

  it('T4-08 (enabled) : réanalyse idempotente, 01/03 → 01/04 met à jour, disparition → retrait', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });

    await persist([decision(doc.id, '2027-03-01')], compte.id, bien.id);
    await persist([decision(doc.id, '2027-03-01')], compte.id, bien.id);
    let items = await itemsDe(bien.id);
    expect(items).toHaveLength(1);
    expect(items[0].functional_key).toMatch(/^[0-9a-f]{40}$/);
    expect(items[0].event_nature).toBe('DEADLINE');
    expect(items[0].business_type).toBe('inspection');
    const id = items[0].id;

    await persist([decision(doc.id, '2027-04-01')], compte.id, bien.id);
    items = await itemsDe(bien.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, start_date: '2027-04-01' });

    // Lien canonique source ↔ agenda (T4-07) et lecture depuis le document.
    const [lien] = await sql`SELECT 1 FROM agenda_file_links WHERE agenda_item_id = ${id} AND asset_file_id = ${doc.id}`;
    expect(lien).toBeDefined();
    const depuisDoc = await query.getAgendaItems({ accountId: compte.id, fileId: doc.id });
    expect(depuisDoc.map((i) => i.id)).toEqual([id]);

    // Réanalyse sans aucun événement : l'élément automatique intact est retiré.
    await persist([], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    expect(await itemsDe(bien.id)).toHaveLength(0);
  });

  it('§14.6 (enabled) : un élément modifié à la main n’est ni mis à jour ni retiré', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await persist([decision(doc.id, '2027-03-01')], compte.id, bien.id);
    const [{ id }] = await itemsDe(bien.id);
    await sql`UPDATE agenda_items SET is_automatic_modified = true, title = 'CT — garage Martin' WHERE id = ${id}`;

    await persist([decision(doc.id, '2027-04-01')], compte.id, bien.id);
    let items = await itemsDe(bien.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id, title: 'CT — garage Martin', start_date: '2027-03-01' });

    await persist([], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    items = await itemsDe(bien.id);
    expect(items.map((i) => i.id)).toEqual([id]);

    // Statut posé par l'utilisateur : même protection.
    const doc2 = await make.assetFile(compte, { assetId: bien.id });
    await persist([decision(doc2.id, '2027-05-01')], compte.id, bien.id);
    const id2 = (await itemsDe(bien.id)).find((i) => i.id !== id)!.id;
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${id2}`;
    await persist([], compte.id, bien.id, { sourceFileId: doc2.id, analysisComplete: true });
    expect((await itemsDe(bien.id)).map((i) => i.id)).toEqual([id, id2]);
  });

  // Lot 16b-2 : AI_T4_EFFECTS retiré — une valeur encore posée (legacy,
  // shadow) n'a plus d'effet : clé fonctionnelle, nature et retrait par source.
  for (const reste of ['legacy', 'shadow'] as const) {
    it(`variable retirée encore posée (AI_T4_EFFECTS=${reste}) : comportement cible`, async () => {
      process.env.AI_T4_EFFECTS = reste;
      const compte = await make.account();
      const bien = await make.asset(compte);
      const doc = await make.assetFile(compte, { assetId: bien.id });
      await persist([decision(doc.id, '2027-03-01')], compte.id, bien.id);
      await persist([decision(doc.id, '2027-04-01')], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
      const items = await itemsDe(bien.id);
      expect(items).toHaveLength(1);
      expect(items[0].functional_key).not.toBeNull();
      expect(items[0].start_date).toBe('2027-04-01');
      await persist([], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
      expect(await itemsDe(bien.id)).toHaveLength(0);
    });
  }

  // Lot 16b-3 : CANONICAL_WRITE_MODE retiré — posé à legacy, il est ignoré.
  for (const canonique of ['legacy', 'absent'] as const) {
    it(`D-13 (CANONICAL_WRITE_MODE retiré, ${canonique}) : achat manuel réalisé recopié si vide ; achat automatique jamais`, async () => {
      if (canonique === 'legacy') process.env.CANONICAL_WRITE_MODE = 'legacy'; else delete process.env.CANONICAL_WRITE_MODE;
      const compte = await make.account();

      const auto = await make.asset(compte);
      const doc = await make.assetFile(compte, { assetId: auto.id });
      await persist([decision(doc.id, '2024-01-10', { title: 'Achat du véhicule', originFieldKey: 'acquisitionDate', category: 'information' })], compte.id, auto.id);
      const [a] = await sql<{ p: string | null }[]>`SELECT purchase_date::text AS p FROM assets WHERE id = ${auto.id}`;
      expect(a.p).toBeNull();
      expect((await itemsDe(auto.id))[0].event_nature).toBe('HISTORICAL');

      const manuel = await make.asset(compte);
      await write.createAgendaItem({
        title: 'Achat du véhicule', startDate: '2024-02-15', manualStatus: 'realise', assetIds: [manuel.id], homeCategory: 'information',
      }, compte.id, compte.ownerUserId);
      const [m] = await sql<{ p: string | null; kc: string | null }[]>`
        SELECT purchase_date::text AS p, key_characteristics AS kc FROM assets WHERE id = ${manuel.id}`;
      expect(m.p).toBe('2024-02-15');
      expect(JSON.parse(m.kc ?? '{}').acquisitionDate__origin).toBe('USER');

      // Champ déjà renseigné : rien n'est écrasé.
      const rempli = await make.asset(compte, { purchaseDate: '2020-05-05' });
      await write.createAgendaItem({
        title: 'Achat du véhicule', startDate: '2024-03-01', manualStatus: 'realise', assetIds: [rempli.id], homeCategory: 'information',
      }, compte.id, compte.ownerUserId);
      const [r] = await sql<{ p: string | null }[]>`SELECT purchase_date::text AS p FROM assets WHERE id = ${rempli.id}`;
      expect(r.p).toBe('2020-05-05');
    });
  }

  it('D-14 (enabled) : un événement HISTORICAL n’est pas notifié et sort des prochaines échéances', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { purchaseDate: '2020-01-01' });
    const futur = '2099-06-01';
    const historique = await write.createAgendaItem({
      title: 'Achat (facture)', startDate: futur, assetIds: [bien.id], originFieldKey: 'acquisitionDate', homeCategory: 'information',
    }, compte.id, compte.ownerUserId);
    const echeance = await write.createAgendaItem({
      title: 'Contrôle technique', startDate: futur, assetIds: [bien.id], originFieldKey: 'nextInspection', homeCategory: 'action',
    }, compte.id, compte.ownerUserId);

    expect(notifications.map((n) => n.itemId)).toEqual([echeance.id]);
    const prochaines = await query.getUpcomingDeadlines(compte.id, { assetIds: [bien.id] });
    expect(prochaines.map((i) => i.id)).toEqual([echeance.id]);
    expect(await query.upcomingDeadlinesSqlFilter('a')).toContain('HISTORICAL');
    const [nat] = await sql<{ n: string }[]>`SELECT event_nature AS n FROM agenda_items WHERE id = ${historique.id}`;
    expect(nat.n).toBe('HISTORICAL');
  });
});
