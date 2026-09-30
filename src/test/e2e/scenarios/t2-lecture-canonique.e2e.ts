/**
 * Lot 15 (X) — couche de lecture canonique de l'assistant, sur PostgreSQL
 * réel (CDC 15 T2-01, T2-02, T2-04, T2-05, T2-15, T2-18, T2-22 à T2-26,
 * T2-32, T2-40).
 *
 *  · fiche canonique vs colonnes : la date d'achat de la fiche (USER) prime
 *    sur `purchase_date` en enabled ; legacy lit toujours la colonne ;
 *  · conflit ouvert (À traiter) et preuve active portés par la lecture ;
 *  · document multi-biens : biens N-N, comptage par bien (legacy : colonne) ;
 *  · agenda : un élément HISTORICAL n'est jamais une échéance à venir ;
 *    objet agenda complet (nature, statut à 4 états, sources) ;
 *  · dépenses qualifiées, informations manquantes, fournisseurs dédoublonnés,
 *    règles d'offre, contenu de synthèse ; bornage au compte.
 */
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';

vi.mock('@/services/verebona-assistant/events/business-events', () => ({
  emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('T2-L15-LECTURE', 'Lecture canonique de l’assistant', ({ sql, make }) => {
  const env = { ...process.env };
  let can: typeof import('@/services/verebona-assistant/canonical');
  let repo: typeof import('@/services/verebona-assistant/core/account-data.repository');
  let da: typeof import('@/services/verebona-assistant/core/data-answer.service');
  let thresholds: typeof import('@/services/verebona-assistant/core/sufficiency')['DEFAULT_THRESHOLDS'];
  beforeAll(async () => {
    can = await import('@/services/verebona-assistant/canonical');
    repo = await import('@/services/verebona-assistant/core/account-data.repository');
    da = await import('@/services/verebona-assistant/core/data-answer.service');
    ({ DEFAULT_THRESHOLDS: thresholds } = await import('@/services/verebona-assistant/core/sufficiency'));
  });
  afterEach(() => {
    if (env.ASSISTANT_CANONICAL_READ === undefined) delete process.env.ASSISTANT_CANONICAL_READ;
    else process.env.ASSISTANT_CANONICAL_READ = env.ASSISTANT_CANONICAL_READ;
  });
  const ask = (accountId: number, message: string) =>
    da.answerFromData({ port: repo.accountDataRepository, accountId, message, thresholds });

  it('fiche canonique vs colonnes : date d’achat et immatriculation de la fiche ; legacy : colonne', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, {
      category: 'VEHICULE', name: 'Clio', purchaseDate: '2019-01-01', registrationNumber: null,
      keyCharacteristics: { acquisitionDate: '2021-05-25', acquisitionDate__origin: 'USER', registrationNumber: 'EF-456-GH' },
    });
    const r = await can.readCanonicalField(compte.id, bien.id, 'acquisitionDate');
    expect(r).toMatchObject({ value: '2021-05-25', origin: 'USER', display: '25 mai 2021', from: 'key' });
    expect(await can.readCanonicalField(compte.id, bien.id, 'immatriculation')).toMatchObject({ key: 'registrationNumber', value: 'EF-456-GH' });
    const autre = await make.account();
    expect(await can.readCanonicalField(autre.id, bien.id, 'acquisitionDate')).toBeNull();

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const on = await ask(compte.id, 'Quand ai-je acheté la Clio ?');
    expect(on.answer).toContain('25 mai 2021');
    expect(on.sources[0].id).toBe(`asset_field:${bien.id}:acquisitionDate`);
    const immat = await ask(compte.id, 'Quelle est l’immatriculation de la Clio ?');
    expect(immat.answer).toContain('EF-456-GH');

    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    const off = await ask(compte.id, 'Quand ai-je acheté la Clio ?');
    expect(off.strategy).toBe('structured.purchase_date');
    expect(off.answer).toContain('1 janvier 2019');
  });

  it('conflit ouvert (À traiter) et preuve active portés par la lecture du champ', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', keyCharacteristics: { acquisitionPrice: 12000 } });
    const { upsertAction } = await import('@/services/to-process/to-process-action.service');
    await upsertAction({
      accountId: compte.id, targetType: 'ASSET', targetId: bien.id, fieldKey: 'acquisitionPrice', actionKind: 'ARBITRATE',
      ruleCode: 'DATA-ACQUISITION-PRICE', proposals: [{ value: 12500, label: '12 500 €', confidence: 0.8 }],
    });
    const r = await can.readCanonicalField(compte.id, bien.id, 'acquisitionPrice');
    expect(r?.value).toBe(12000);
    expect(r?.openConflict?.proposals).toEqual(['12 500 €']);
    expect(can.assetFieldSource(r!).meta?.openConflict).toBe(true);
  });

  it('document multi-biens : biens N-N ; comptage et liste par bien (enabled) ; legacy : colonne seule', async () => {
    const compte = await make.account();
    const a = await make.asset(compte, { name: 'Clio' });
    const b = await make.asset(compte, { name: 'Tesla' });
    const doc = await make.assetFile(compte, { assetId: a.id });
    await sql`UPDATE asset_files SET retained_title = 'Facture garage', amount_cents = 45000, document_type_code = 'MAINTENANCE_INVOICE',
              supplier = 'Garage Martin', document_date = '2025-03-01' WHERE id = ${doc.id}`;
    await sql`INSERT INTO document_asset_links (account_id, file_id, asset_id, link_role, origin, status)
              VALUES (${compte.id}, ${doc.id}, ${b.id}, 'SECONDARY', 'USER', 'ACTIVE') ON CONFLICT DO NOTHING`;
    const etat = await can.getCanonicalDocumentState(compte.id, doc.id);
    expect(etat).toMatchObject({ title: 'Facture garage', amountCents: 45000, supplier: 'Garage Martin', catalogCode: 'FACTURE' });
    expect(etat!.assets.map((x) => x.name).sort()).toEqual(['Clio', 'Tesla']);
    expect(await can.getCanonicalDocumentState((await make.account()).id, doc.id)).toBeNull();

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    expect(await repo.accountDataRepository.countDocuments(compte.id, { assetIds: [b.id] })).toBe(1);
    expect((await repo.accountDataRepository.listDocuments!(compte.id, { assetIds: [b.id] })).map((d) => d.fileId)).toEqual([doc.id]);
    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    expect(await repo.accountDataRepository.countDocuments(compte.id, { assetIds: [b.id] })).toBe(0);
  });

  it('agenda : HISTORICAL exclu des échéances à venir (enabled) ; objet agenda complet', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { name: 'Clio' });
    const doc = await make.assetFile(compte, { assetId: bien.id });
    const cree = async (title: string, date: string, nature: string | null, field: string | null) => {
      const [{ id }] = await sql<{ id: number }[]>`
        INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, origin_field_key, event_nature, business_type)
        VALUES (${compte.id}, ${title}, ${date}, true, 'asset_field', ${field}, ${nature}, NULL) RETURNING id`;
      await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${id}, ${bien.id})`;
      return id;
    };
    const achat = await cree('Achat (facture)', '2099-01-10', 'HISTORICAL', 'acquisitionDate');
    const achatAncien = await cree('Achat ancien', '2099-01-11', null, 'acquisitionDate');
    const ct = await cree('Contrôle technique', '2099-02-01', 'DEADLINE', 'nextInspection');
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${ct}, ${doc.id})`;

    const liste = await can.listUpcomingAgenda(compte.id, { assetIds: [bien.id], from: '2099-01-01', windowDays: 60 });
    expect(liste.map((r) => r.id)).toEqual([ct]);
    expect(await can.countUpcomingAgenda(compte.id, { assetIds: [bien.id], from: '2099-01-01' })).toBe(1);

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const prochaines = await repo.accountDataRepository.upcomingAgenda(compte.id, { assetIds: [bien.id], limit: 5 });
    expect(prochaines.map((r) => r.id)).toEqual([ct]);
    process.env.ASSISTANT_CANONICAL_READ = 'legacy';
    const legacy = await repo.accountDataRepository.upcomingAgenda(compte.id, { assetIds: [bien.id], limit: 5 });
    expect(legacy.map((r) => r.id)).toEqual([achat, achatAncien, ct]);

    const item = await can.getCanonicalAgendaItem(compte.id, ct);
    expect(item).toMatchObject({ nature: 'DEADLINE', businessType: 'inspection', status: 'unknown', forecast: false });
    expect(item!.assets.map((x) => x.name)).toEqual(['Clio']);
    expect(item!.sources.map((x) => x.fileId)).toEqual([doc.id]);
    // Date passée, sans statut ni carte : not_proven (à venir : unknown).
    const passe = await cree('Entretien 2020', '2020-01-10', 'DEADLINE', 'maintenanceDueDate');
    expect((await can.getCanonicalAgendaItem(compte.id, passe))?.status).toBe('not_proven');
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${achat}`;
    expect((await can.getCanonicalAgendaItem(compte.id, achat))?.status).toBe('completed');
    expect(await can.getCanonicalAgendaItem((await make.account()).id, ct)).toBeNull();
  });

  it('dépenses qualifiées, informations manquantes, fournisseurs, offre, synthèse', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const docs = [
      ['MAINTENANCE_INVOICE', null, 20000, 'Garage Martin'],
      ['MAINTENANCE_INVOICE', null, 25000, 'garage martin'],
      ['REPAIR_QUOTE', null, 90000, 'Carrosserie X'],
      [null, 'FACTURE', 7000, null],
    ] as const;
    for (const [v2, legacy, cents, sup] of docs) {
      const f = await make.assetFile(compte, { assetId: bien.id });
      await sql`UPDATE asset_files SET document_type_code = ${v2}, document_type = ${legacy}, amount_cents = ${cents}, supplier = ${sup},
                document_date = '2025-06-01', retained_title = ${`Doc ${cents}`} WHERE id = ${f.id}`;
    }
    const q = await can.sumQualifiedExpenses(compte.id, { assetIds: [bien.id], theme: 'maintenance' });
    expect(q).toMatchObject({ qualifiedSumCents: 45000, qualifiedCount: 2, complete: false, unqualified: { count: 1 }, excluded: { count: 1 } });

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const r = await ask(compte.id, 'Combien ai-je dépensé en entretien pour la Polo ?');
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(r.answer).toMatch(/450,00\s€ \(2 documents\)/);
    const manque = await ask(compte.id, 'Qu’est-ce qui manque sur la fiche de la Polo ?');
    expect(manque.answer).toContain('date d’achat');
    expect(manque.answer).toContain('immatriculation');

    const miss = await can.listMissingInformation(compte.id, { assetIds: [bien.id] });
    expect(miss[0].missing.map((m) => m.key).sort()).toEqual(['acquisitionDate', 'registrationNumber']);

    await sql`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, city)
              VALUES (${compte.id}, ${compte.ownerUserId}, 'Garage Martin', 'garage martin', 'Lyon')`;
    const fournisseurs = await can.listSuppliersDeduplicated(compte.id);
    const martin = fournisseurs.filter((s) => /martin/i.test(s.name));
    expect(martin).toHaveLength(1);
    expect(martin[0]).toMatchObject({ documentCount: 2, interventionCount: 2 });

    const offre = await can.ProductRuleProvider.sources(compte.id);
    expect(offre[0]).toMatchObject({ id: 'product_rule:plan', type: 'product_rule' });

    const synthese = await can.buildSynthesisContent(compte.id, { assetIds: [bien.id], maxDocuments: 2 });
    expect(synthese).toHaveLength(2);
    expect(synthese[0].type).toBe('document_extraction');
    expect(synthese[0].content).toContain('montant');
    expect(await can.buildSynthesisContent((await make.account()).id, { assetIds: [bien.id] })).toEqual([]);
  });

  it('relecture : année demandée et date absente (non qualifié), doublon « fusion possible » compté une fois', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const docs = [
      // [date, empreinte, état, fournisseur, montant]
      ['2025-06-01', 'h-a', 'ANALYZED', null, 20000],
      ['2025-06-01', 'h-a', 'FUSION_SUGGESTED', 'Garage Martin', 20000], // doublon exact, plus informé : gardé
      [null, 'h-b', 'ANALYZED', null, 5000], // sans date
      ['2024-02-01', 'h-c', 'ANALYZED', null, 9900], // autre année
    ] as const;
    const ids: number[] = [];
    for (const [date, hash, state, sup, cents] of docs) {
      const f = await make.assetFile(compte, { assetId: bien.id });
      await sql`UPDATE asset_files SET document_type_code = 'MAINTENANCE_INVOICE', amount_cents = ${cents}, supplier = ${sup},
                document_date = ${date}, sha256_hash = ${hash}, analysis_state = ${state} WHERE id = ${f.id}`;
      ids.push(f.id);
    }
    const q = await can.sumQualifiedExpenses(compte.id, { assetIds: [bien.id], theme: 'maintenance', year: 2025 });
    expect(q).toMatchObject({
      qualifiedSumCents: 20000, qualifiedCount: 1, complete: false,
      unqualified: { count: 1, undatedCount: 1, fileIds: [ids[2]] }, duplicates: { count: 1, fileIds: [ids[0]] },
    });
    expect(q.byTheme[0].fileIds).toEqual([ids[1]]);
    // Sans année : le document sans date est compté normalement.
    const tout = await can.sumQualifiedExpenses(compte.id, { assetIds: [bien.id], theme: 'maintenance' });
    expect(tout).toMatchObject({ qualifiedSumCents: 34900, complete: true, duplicates: { count: 1 } });

    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const r = await ask(compte.id, 'Combien ai-je dépensé en entretien pour la Polo en 2025 ?');
    expect(r.strategy).toBe('structured.sum_qualified');
    expect(r.answer).toMatch(/200,00\s€ \(1 document\)/);
    expect(r.answer).toContain('pas de date');
    expect(r.answer).toContain('fusion possible');
  });
});
