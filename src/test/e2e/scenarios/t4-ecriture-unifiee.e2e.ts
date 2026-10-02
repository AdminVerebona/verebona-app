/**
 * Lot 14 (volet B) — écriture agenda unifiée, sur PostgreSQL réel
 * (CDC 15 T4-07, T4-08, T4-09, X-04, §14 points 5 et 6).
 *
 *  · même événement, manuel ou automatique → même état, à l'origine près ;
 *  · `upsertAgendaItem` par clé : création puis mise à jour, élément
 *    modifié par l'utilisateur protégé ;
 *  · liens source ↔ agenda : `agenda_file_links` + `agenda_item_sources`
 *    (rôles SOURCE / ATTACHMENT), `listAgendaItemsForDocument` ;
 *  · `removeAgendaItemsFromSource` : clés conservées, bien ciblé, manuel
 *    et modifié jamais retirés, analyse incomplète sans retrait ;
 *  · rattrapages §14.5 (liens depuis origin_ref) et §14.6 (doublons).
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/lib/asset-quota-guard', () => ({ assetModificationDecision: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));
vi.mock('@/services/coherence/impact-propagation.service', async (orig) => ({
  ...(await orig<object>()), emitAgendaItemCreated: async () => {},
}));

scenario('T4-L14-UNIFIE', 'Écriture agenda unifiée', ({ sql, make }) => {
  const env = { ...process.env };
  let prim: typeof import('@/services/agenda/agenda-write-primitive');
  let links: typeof import('@/services/agenda/agenda-source-links');
  let write: typeof import('@/services/agenda/AgendaWriteService');
  let backfill: typeof import('@/services/agenda/backfill/agenda-backfill');

  beforeAll(async () => {
    prim = await import('@/services/agenda/agenda-write-primitive');
    links = await import('@/services/agenda/agenda-source-links');
    write = await import('@/services/agenda/AgendaWriteService');
    backfill = await import('@/services/agenda/backfill/agenda-backfill');
  });
  afterEach(() => {
    if (env.AI_T4_EFFECTS === undefined) delete process.env.AI_T4_EFFECTS; else process.env.AI_T4_EFFECTS = env.AI_T4_EFFECTS;
  });

  const etat = async (id: number) => (await sql<Record<string, unknown>[]>`
    SELECT title, start_date::text AS start_date, home_category, event_nature, business_type, origin_field_key,
           is_automatic, origin_type, functional_key,
           (SELECT array_agg(asset_id ORDER BY asset_id) FROM agenda_asset_links WHERE agenda_item_id = i.id) AS assets,
           (SELECT array_agg(asset_file_id ORDER BY asset_file_id) FROM agenda_file_links WHERE agenda_item_id = i.id) AS files,
           (SELECT array_agg(source_role ORDER BY source_role) FROM agenda_item_sources WHERE agenda_item_id = i.id) AS roles
      FROM agenda_items i WHERE id = ${id}`)[0];

  it('T4-09 : même événement créé à la main ou automatiquement → même état, à l’origine près', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const manuel = await write.createAgendaItem({
      title: 'Contrôle technique', startDate: '2027-03-01', assetIds: [bien.id], fileIds: [doc.id], originFieldKey: 'nextInspection', homeCategory: 'action',
    }, compte.id, compte.ownerUserId);
    const auto = await prim.upsertAgendaItem({
      accountId: compte.id, assetId: bien.id, origin: 'AUTOMATIC', category: 'action', date: '2027-03-01', title: 'Contrôle technique',
      originFieldKey: 'nextInspection', sources: [{ fileId: doc.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    });
    const [m, a] = [await etat(manuel.id), await etat(auto.id)];
    for (const k of ['title', 'start_date', 'home_category', 'event_nature', 'business_type', 'origin_field_key', 'assets', 'files']) {
      expect(m[k], k).toEqual(a[k]);
    }
    expect(a.event_nature).toBe('DEADLINE');
    expect([m.is_automatic, a.is_automatic]).toEqual([false, true]);
    expect([m.functional_key, typeof a.functional_key]).toEqual([null, 'string']);
    expect([m.roles, a.roles]).toEqual([['ATTACHMENT'], ['SOURCE']]);
  });

  it('T4-08 : upsert par clé — 01/03 corrigé en 01/04 → un seul élément ; modifié par l’utilisateur → protégé', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const entree = (date: string) => ({
      accountId: compte.id, assetId: bien.id, origin: 'AUTOMATIC' as const, category: 'action' as const, date, title: 'Contrôle technique',
      originFieldKey: 'nextInspection', sources: [{ fileId: doc.id, role: 'SOURCE' as const }], occurrenceIndex: 'single',
    });
    const r1 = await prim.upsertAgendaItem(entree('2027-03-01'));
    const r2 = await prim.upsertAgendaItem(entree('2027-04-01'));
    expect(r1.created).toBe(true);
    expect(r2).toMatchObject({ id: r1.id, created: false });
    const n = await sql`SELECT i.id, i.start_date::text AS d FROM agenda_items i JOIN agenda_asset_links l ON l.agenda_item_id = i.id WHERE l.asset_id = ${bien.id}`;
    expect(n).toEqual([{ id: r1.id, d: '2027-04-01' }]);
    const [{ c }] = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM agenda_item_sources WHERE agenda_item_id = ${r1.id}`;
    expect(c).toBe(1);

    await sql`UPDATE agenda_items SET is_automatic_modified = true WHERE id = ${r1.id}`;
    const r3 = await prim.upsertAgendaItem(entree('2027-05-01'));
    expect(r3).toMatchObject({ id: r1.id, protected: true });
    expect((await etat(r1.id)).start_date).toBe('2027-04-01');
  });

  it('T4-07 : depuis le document, tous ses événements (automatiques, pièces jointes)', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const a1 = await prim.upsertAgendaItem({ accountId: compte.id, assetId: bien.id, origin: 'AUTOMATIC', category: 'action', date: '2027-01-10', title: 'Entretien', originFieldKey: 'maintenanceDueDate', sources: [{ fileId: doc.id, role: 'SOURCE' }], occurrenceIndex: 'single' });
    const a2 = await prim.upsertAgendaItem({ accountId: compte.id, assetId: bien.id, origin: 'AUTOMATIC', category: 'information', date: '2026-01-10', title: 'Entretien réalisé', originFieldKey: 'lastRevision', sources: [{ fileId: doc.id, role: 'SOURCE' }], occurrenceIndex: 'single' });
    const m = await write.createAgendaItem({ title: 'Garage', startDate: '2027-02-01', assetIds: [bien.id], fileIds: [doc.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    const tous = await links.listAgendaItemsForDocument(doc.id, { accountId: compte.id });
    expect(tous.map((x) => x.id)).toEqual([a2.id, a1.id, m.id]);
    const autos = await links.listAgendaItemsForDocument(doc.id, { accountId: compte.id, automaticOnly: true });
    expect(autos.map((x) => x.id).sort()).toEqual([a1.id, a2.id].sort());
    // Un autre compte ne voit rien.
    const autre = await make.account();
    expect(await links.listAgendaItemsForDocument(doc.id, { accountId: autre.id })).toEqual([]);

    // Lot 16b-2 : variable retirée encore posée — sans effet, les liens
    // source sont tracés comme en mode cible.
    process.env.AI_T4_EFFECTS = 'legacy';
    const doc2 = await make.assetFile(compte, { assetId: bien.id });
    const m2 = await write.createAgendaItem({ title: 'Garage 2', startDate: '2027-02-02', assetIds: [bien.id], fileIds: [doc2.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);
    expect((await etat(m2.id)).roles).toEqual(['ATTACHMENT']);
    expect((await etat(m2.id)).files).toEqual([doc2.id]);
  });

  it('removeAgendaItemsFromSource : clés conservées, bien ciblé, élément modifié et manuel épargnés ; analyse incomplète sans retrait', async () => {
    const compte = await make.account();
    const b1 = await make.asset(compte);
    const b2 = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: b1.id });
    const cree = (assetId: number, field: string, date: string) => prim.upsertAgendaItem({
      accountId: compte.id, assetId, origin: 'AUTOMATIC', category: 'action', date, title: field, originFieldKey: field,
      sources: [{ fileId: doc.id, role: 'SOURCE' }], occurrenceIndex: 'single',
    });
    const garde = await cree(b1.id, 'nextInspection', '2027-01-01');
    const perime = await cree(b1.id, 'maintenanceDueDate', '2027-02-01');
    const modifie = await cree(b1.id, 'insuranceExpiry', '2027-03-01');
    const autreBien = await cree(b2.id, 'maintenanceDueDate', '2027-02-01');
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${modifie.id}`;
    const manuel = await write.createAgendaItem({ title: 'Manuel', startDate: '2027-01-05', assetIds: [b1.id], fileIds: [doc.id], homeCategory: 'action' }, compte.id, compte.ownerUserId);

    const ombre = await prim.removeAgendaItemsFromSource({ accountId: compte.id, sourceFileId: doc.id, assetId: b1.id, keepKeys: [garde.functionalKey!] });
    expect(ombre).toEqual({ removed: [perime.id], dryRun: true, skipped: 'ANALYSIS_INCOMPLETE' });
    expect(await etat(perime.id)).toBeDefined();

    const r = await prim.removeAgendaItemsFromSource({ accountId: compte.id, sourceFileId: doc.id, assetId: b1.id, keepKeys: [garde.functionalKey!], analysisComplete: true });
    expect(r).toEqual({ removed: [perime.id], dryRun: false });
    const restants = (await sql<{ id: number }[]>`SELECT id FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`).map((x) => x.id);
    expect(restants).toEqual([garde.id, modifie.id, autreBien.id, manuel.id]);
  });

  it('§14.5 : liens reconstruits depuis origin_ref ; références inexploitables au rapport', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const autre = await make.account();
    const docAutre = await make.assetFile(autre);
    const [{ id: ok }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id)
      VALUES (${compte.id}, 'CT', '2027-01-01', true, 'qualified_document', 'asset_file', ${doc.id}) RETURNING id`;
    const [{ id: ko }] = await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_ref_type, origin_ref_id)
      VALUES (${compte.id}, 'CT', '2027-01-01', true, 'qualified_document', 'asset_file', ${docAutre.id}) RETURNING id`;

    const simu = await backfill.backfillAgendaSourceLinks(sql);
    expect(simu.applied).toBe(false);
    expect((await etat(ok)).files).toBeNull();
    const r = await backfill.backfillAgendaSourceLinks(sql, { apply: true });
    expect((await etat(ok)).files).toEqual([doc.id]);
    expect((await etat(ok)).roles).toEqual(['SOURCE']);
    expect(r.orphans).toContainEqual(expect.objectContaining({ agendaItemId: ko, reason: 'OTHER_ACCOUNT' }));
    expect((await etat(ko)).files).toBeNull();
    const again = await backfill.backfillAgendaSourceLinks(sql, { apply: true });
    expect(again.fileLinksCreated + again.sourceTracesCreated).toBe(0);
  });

  it('§14.6 : doublons automatiques retirés, élément modifié et élément manuel intacts', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte);
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const ins = async (auto: boolean, modifie = false) => {
      const [{ id }] = await sql<{ id: number }[]>`
        INSERT INTO agenda_items (account_id, title, start_date, is_automatic, is_automatic_modified, origin_type, origin_field_key, origin_ref_type, origin_ref_id)
        VALUES (${compte.id}, 'CT', '2027-01-01', ${auto}, ${modifie}, ${auto ? 'asset_field' : 'manual'}, 'nextInspection', 'asset_file', ${doc.id}) RETURNING id`;
      await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${id}, ${bien.id})`;
      return id;
    };
    const d1 = await ins(true);
    const d2 = await ins(true);
    const mod = await ins(true, true);
    const man = await ins(false);
    const simu = await backfill.dedupeAutomaticAgendaItems(sql, { fromAccountId: compte.id - 1 });
    const g = simu.groups.find((x) => x.accountId === compte.id)!;
    expect(g).toMatchObject({ keep: [mod], remove: [d1, d2], protected: [mod] });
    expect(simu.removed).toEqual([]);
    const r = await backfill.dedupeAutomaticAgendaItems(sql, { apply: true, fromAccountId: compte.id - 1 });
    expect(r.removed.sort()).toEqual([d1, d2].sort());
    const restants = (await sql<{ id: number }[]>`SELECT id FROM agenda_items WHERE account_id = ${compte.id} ORDER BY id`).map((x) => x.id);
    expect(restants).toEqual([mod, man]);
  });
});
