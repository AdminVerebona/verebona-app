/**
 * Relecture du lot 14 (volet B), sur PostgreSQL réel — AI_T4_EFFECTS=enabled.
 *
 *  1. réanalyse vide ou dégradée : aucun retrait ; analyse complète : retrait
 *     TRACÉ (agenda_item_removals : clé, date, source, motif, liens) ;
 *  2. mise à jour automatique gardée : un élément modifié par l'utilisateur
 *     n'est pas écrasé (WHERE gardé, 0 ligne → protégé) ;
 *  3. annulation d'une carte AGENDA-PROPOSAL : élément modifié depuis la
 *     résolution → conservé, carte rouverte ; autre compte → rien ;
 *  4. effets après validation : « Oui » sur une vente → carte ASSET-STATUS
 *     (D-15) ; statut « réalisé » posé depuis une carte → recopie « achat » (D-13).
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AgendaDecision } from '@/services/ai/agenda';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/coherence/impact-propagation.service', async (orig) => ({
  ...(await orig<object>()), emitAgendaItemCreated: async () => {},
}));

const echeance = (fileId: number, field: string, date: string, over: Partial<AgendaDecision> = {}): AgendaDecision => ({
  action: 'create', title: field, date, category: 'action', confidence: 'certain', reasonCode: 'E2E', deterministic: true,
  sourceFileId: fileId, originFieldKey: field, occurrenceIndex: 'single', ...over,
});

scenario('T4-L14-RELECTURE', 'Relecture du lot 14 : retraits, courses, annulation, effets', ({ sql, make }) => {
  const env = { ...process.env };
  let persist: typeof import('@/services/agenda/agenda-persistence').persistAgendaDecisions;
  let prim: typeof import('@/services/agenda/agenda-write-primitive');
  let resolve: typeof import('@/services/to-process/resolve-action.service');
  let write: typeof import('@/services/agenda/AgendaWriteService');
  let cards: typeof import('@/services/to-process/agenda-status-cards');
  beforeAll(async () => {
    ({ persistAgendaDecisions: persist } = await import('@/services/agenda/agenda-persistence'));
    prim = await import('@/services/agenda/agenda-write-primitive');
    resolve = await import('@/services/to-process/resolve-action.service');
    write = await import('@/services/agenda/AgendaWriteService');
    cards = await import('@/services/to-process/agenda-status-cards');
  });
  afterEach(() => {
    if (env.AI_T4_EFFECTS === undefined) delete process.env.AI_T4_EFFECTS; else process.env.AI_T4_EFFECTS = env.AI_T4_EFFECTS;
  });
  const ids = async (accountId: number) => (await sql<{ id: number }[]>`SELECT id FROM agenda_items WHERE account_id = ${accountId} ORDER BY id`).map((x) => x.id);

  it('1. réanalyse dégradée : rien retiré ; complète : retrait tracé et rattrapable', async () => {
    process.env.AI_T4_EFFECTS = 'enabled';
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const deux = [echeance(doc.id, 'nextInspection', '2027-03-01'), echeance(doc.id, 'maintenanceDueDate', '2027-06-01')];
    await persist(deux, compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    const avant = await ids(compte.id);
    expect(avant).toHaveLength(2);

    await persist([], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: false, incompleteReasons: ['PARTIAL_EXTRACTION'] });
    await persist([deux[0]], compte.id, bien.id, { sourceFileId: doc.id });
    expect(await ids(compte.id)).toEqual(avant);
    expect(await sql`SELECT 1 FROM agenda_item_removals WHERE account_id = ${compte.id}`).toHaveLength(0);

    await persist([deux[0]], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    expect(await ids(compte.id)).toEqual([avant[0]]);
    const [trace] = await sql<{ item: number; k: string; d: string; src: number; bien: number; motif: string; liens: { assets: number[] }; titre: string }[]>`
      SELECT agenda_item_id AS item, functional_key AS k, start_date::text AS d, source_file_id AS src, asset_id AS bien,
             reason AS motif, links_snapshot AS liens, item_snapshot->>'title' AS titre
        FROM agenda_item_removals WHERE account_id = ${compte.id}`;
    expect(trace).toMatchObject({ item: avant[1], d: '2027-06-01', src: doc.id, bien: bien.id, motif: 'SOURCE_SYNC', titre: 'maintenanceDueDate' });
    expect(trace.k).toMatch(/^[0-9a-f]{40}$/);
    expect(trace.liens.assets).toEqual([bien.id]);
  });

  it('2. mise à jour automatique gardée : élément modifié par l’utilisateur (même concurrent) jamais écrasé', async () => {
    process.env.AI_T4_EFFECTS = 'enabled';
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const cree = await prim.upsertAgendaItem({
      accountId: compte.id, assetId: bien.id, origin: 'AUTOMATIC', category: 'action', date: '2027-03-01', title: 'CT',
      originFieldKey: 'nextInspection', sources: [{ fileId: doc.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    });
    for (const geste of [sql`UPDATE agenda_items SET is_automatic_modified = true WHERE id = ${cree.id}`,
      sql`UPDATE agenda_items SET is_automatic_modified = false, manual_status = 'annule' WHERE id = ${cree.id}`]) {
      await geste;
      const r = await prim.upsertAgendaItem(
        { itemId: cree.id, accountId: compte.id, assetId: null, origin: 'AUTOMATIC', title: 'CT écrasé', date: '2027-09-09', sources: [] },
        { onlyIfUntouched: true },
      );
      expect(r).toMatchObject({ id: cree.id, protected: true });
      const [e] = await sql<{ t: string; d: string }[]>`SELECT title AS t, start_date::text AS d FROM agenda_items WHERE id = ${cree.id}`;
      expect(e).toEqual({ t: 'CT', d: '2027-03-01' });
    }
    // Via la synchronisation (applySyncStep) : même garde.
    await persist([echeance(doc.id, 'nextInspection', '2027-10-10', { title: 'CT' })], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    const [e] = await sql<{ d: string }[]>`SELECT start_date::text AS d FROM agenda_items WHERE id = ${cree.id}`;
    expect(e.d).toBe('2027-03-01');
  });

  const devis = (fileId: number, over: Partial<AgendaDecision> = {}): AgendaDecision => ({
    action: 'propose', title: 'Remplacement chaudière', date: '2027-05-12', category: 'action', confidence: 'certain',
    reasonCode: 'SOURCE_TYPE_NOT_AUTHORIZED', deterministic: true, sourceFileId: fileId, businessType: 'repair', nature: 'DEADLINE',
    occurrenceIndex: 'single', mayCreateAgenda: false, sources: [{ fileId, role: 'SOURCE' }], ...over,
  });
  const carte = async (accountId: number, fileId: number) => (await sql<{ public_id: string; resolved_at: Date | null }[]>`
    SELECT public_id, resolved_at FROM to_process_actions WHERE account_id = ${accountId} AND target_id = ${fileId} AND rule_code = 'AGENDA-PROPOSAL'`)[0];

  it('3. annulation AGENDA-PROPOSAL : élément modifié depuis → conservé, carte rouverte ; autre compte → rien', async () => {
    process.env.AI_T4_EFFECTS = 'enabled';
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await persist([devis(doc.id)], compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    const c = await carte(compte.id, doc.id);
    expect(await resolve.resolveArbitration(compte.id, c.public_id, 'YES', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    const [cree] = await ids(compte.id);
    await write.updateAgendaItem(cree, { title: 'Chaudière — RDV confirmé' }, compte.id);

    const autre = await make.account();
    expect(await resolve.undoArbitration(autre.id, c.public_id, null)).toMatchObject({ ok: false, error: 'NOT_FOUND' });
    expect(await resolve.undoArbitration(compte.id, c.public_id, null)).toMatchObject({ ok: true, kept: true });
    expect(await ids(compte.id)).toEqual([cree]);
    expect((await carte(compte.id, doc.id)).resolved_at).toBeNull();
  });

  it('4. effets après validation : vente acceptée → ASSET-STATUS (D-15) ; « réalisé » depuis une carte → recopie achat (D-13)', async () => {
    process.env.AI_T4_EFFECTS = 'enabled';
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    await persist([devis(doc.id, { title: 'Vente du véhicule', businessType: 'sale', nature: 'HISTORICAL', date: '2026-02-01', category: 'information' })],
      compte.id, bien.id, { sourceFileId: doc.id, analysisComplete: true });
    const c = await carte(compte.id, doc.id);
    await resolve.resolveArbitration(compte.id, c.public_id, 'YES', { userId: compte.ownerUserId });
    const statut = await sql`SELECT 1 FROM to_process_actions WHERE account_id = ${compte.id} AND target_type = 'ASSET' AND target_id = ${bien.id} AND rule_code = 'ASSET-STATUS' AND resolved_at IS NULL`;
    expect(statut).toHaveLength(1);

    const velo = await make.asset(compte);
    const achat = await write.createAgendaItem({ title: 'Achat du vélo', startDate: '2026-01-10', assetIds: [velo.id], homeCategory: 'information' }, compte.id, compte.ownerUserId);
    await sql`UPDATE assets SET purchase_date = NULL WHERE id = ${velo.id}`;
    await cards.proposeAgendaStatus({ accountId: compte.id, itemId: achat.id, kind: 'propose_done', sourceFileId: null });
    const [s] = await sql<{ public_id: string }[]>`SELECT public_id FROM to_process_actions WHERE account_id = ${compte.id} AND target_id = ${achat.id} AND rule_code = 'AGENDA-DONE'`;
    expect(await resolve.resolveArbitration(compte.id, s.public_id, 'realise', { userId: compte.ownerUserId })).toMatchObject({ ok: true });
    const [p] = await sql<{ d: string | null }[]>`SELECT purchase_date::text AS d FROM assets WHERE id = ${velo.id}`;
    expect(p.d).toBe('2026-01-10');
  });
});
