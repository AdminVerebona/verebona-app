/**
 * X-02 — exports en lecture canonique (CDC 15 X-02 P0, §12, §14 point 8,
 * T3-05 ; plan lot 16 volet B ; commutateur `EXPORTS_CANONICAL_SOURCE`),
 * sur base réelle. Données du snapshot seulement : aucun rendu Chromium.
 *
 *   · recette X-02 : un document lié par CHACUN des chemins historiques
 *     (`asset_id`, `linked_asset_id`, `linked_room_id`, lien N-N SECONDARY,
 *     lien USER, colonnes seules avant rattrapage) est présent en `enabled` ;
 *     un document seulement MENTIONED ne l'est pas ;
 *   · `legacy` inchangé, `shadow` : source historique utilisée, rapport
 *     d'écarts journalisé sans valeur ;
 *   · recette T3-05 : même `acquisitionDate` dans la fiche, T2 et l'export ;
 *   · agenda : nature D-14 et statut à 4 états.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

const MODE_INITIAL = process.env.EXPORTS_CANONICAL_SOURCE;
const WRITE_INITIAL = process.env.CANONICAL_WRITE_MODE;
const T2_INITIAL = process.env.ASSISTANT_CANONICAL_READ;

scenario('X-02', 'Exports V12 : source canonique (champs, pièces N-N, agenda)', ({ sql, make }) => {
  afterEach(() => {
    if (MODE_INITIAL === undefined) delete process.env.EXPORTS_CANONICAL_SOURCE; else process.env.EXPORTS_CANONICAL_SOURCE = MODE_INITIAL;
    if (T2_INITIAL === undefined) delete process.env.ASSISTANT_CANONICAL_READ; else process.env.ASSISTANT_CANONICAL_READ = T2_INITIAL;
    if (WRITE_INITIAL === undefined) delete process.env.CANONICAL_WRITE_MODE; else process.env.CANONICAL_WRITE_MODE = WRITE_INITIAL;
    vi.restoreAllMocks();
  });

  const charger = async (compte: { id: number; ownerUserId: number }, assetId: number, mode: string) => {
    process.env.EXPORTS_CANONICAL_SOURCE = mode;
    const { loadExportSource } = await import('@/services/exports/v12/data/source');
    return loadExportSource({ assetId, accountId: compte.id, userId: compte.ownerUserId, exportType: 'DOSSIER_COMPLET' });
  };

  it('recette X-02 : chaque chemin historique présent en enabled ; MENTIONED exclu ; legacy et shadow', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison' });
    const autre = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const [piece] = await sql<{ id: number }[]>`
      INSERT INTO rooms (asset_id, account_id, name, room_type) VALUES (${bien.id}, ${compte.id}, 'Cuisine', 'KITCHEN') RETURNING id`;
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');

    const parAssetId = await make.assetFile(compte, { assetId: bien.id, name: 'par-asset-id.pdf' });
    const parLinkedAsset = await make.assetFile(compte, { assetId: autre.id, name: 'par-linked-asset.pdf' });
    await sql`UPDATE asset_files SET linked_asset_id = ${bien.id} WHERE id = ${parLinkedAsset.id}`;
    const parPiece = await make.assetFile(compte, { assetId: null, name: 'par-piece.pdf' });
    await sql`UPDATE asset_files SET linked_room_id = ${piece.id} WHERE id = ${parPiece.id}`;
    const parSecondaire = await make.assetFile(compte, { assetId: autre.id, name: 'nn-secondary.pdf' });
    await linkDocumentToAsset({ accountId: compte.id, fileId: parSecondaire.id, target: { assetId: bien.id }, role: 'SECONDARY', origin: 'MIGRATION' });
    const parUser = await make.assetFile(compte, { assetId: null, name: 'lien-user.pdf' });
    await linkDocumentToAsset({ accountId: compte.id, fileId: parUser.id, target: { assetId: bien.id }, role: 'PRIMARY', origin: 'USER' });
    const mentionne = await make.assetFile(compte, { assetId: autre.id, name: 'mentionne.pdf' });
    await linkDocumentToAsset({ accountId: compte.id, fileId: mentionne.id, target: { assetId: bien.id }, role: 'MENTIONED', origin: 'AI' });
    // Lien AI accepté (ACTIVE) : inclus ; lien AI PROPOSED : exclu (arbitrage lot 16).
    const parIa = await make.assetFile(compte, { assetId: null, name: 'ia-active.pdf' });
    await linkDocumentToAsset({ accountId: compte.id, fileId: parIa.id, target: { assetId: bien.id }, role: 'SECONDARY', origin: 'AI' });
    const propose = await make.assetFile(compte, { assetId: null, name: 'ia-proposee.pdf' });
    await linkDocumentToAsset({ accountId: compte.id, fileId: propose.id, target: { assetId: bien.id }, role: 'PRIMARY', origin: 'AI', status: 'PROPOSED' });
    // Avant rattrapage §14.8 : colonnes posées, AUCUNE ligne de lien.
    const colonneSeule = await make.assetFile(compte, { assetId: bien.id, name: 'colonne-seule.pdf' });
    const linkedSeule = await make.assetFile(compte, { assetId: null, name: 'linked-seule.pdf' });
    await sql`UPDATE asset_files SET linked_asset_id = ${bien.id} WHERE id = ${linkedSeule.id}`;
    await sql`DELETE FROM document_asset_links WHERE file_id IN (${colonneSeule.id}, ${linkedSeule.id})`;
    // Document retiré par l'utilisateur : la colonne ne le repêche pas.
    const retire = await make.assetFile(compte, { assetId: bien.id, name: 'retire.pdf' });
    await sql`UPDATE document_asset_links SET status = 'REMOVED', removed_at = now() WHERE file_id = ${retire.id}`;

    const attendus = [parAssetId, parLinkedAsset, parPiece, parSecondaire, parUser, parIa, colonneSeule, linkedSeule].map((f) => f.id).sort((a, b) => a - b);

    const canon = await charger(compte, bien.id, 'enabled');
    expect(canon.documents.map((d) => d.id).sort((a, b) => a - b)).toEqual(attendus);
    expect(canon.sourceTrace).toMatchObject({ mode: 'enabled', source: 'canonical', registryVersion: expect.any(String) });
    const chemins = canon.sourceTrace!.documentPaths!;
    expect(chemins[parLinkedAsset.id]).toEqual(['link:SECONDARY']);
    expect(chemins[parPiece.id]).toEqual(['link:PRIMARY']);
    expect(chemins[parSecondaire.id]).toEqual(['link:SECONDARY']);
    expect(chemins[parUser.id]).toEqual(['link:PRIMARY']);
    expect(chemins[colonneSeule.id]).toEqual(['column:asset_id']);
    expect(chemins[linkedSeule.id]).toEqual(['column:linked_asset_id']);
    expect(chemins[mentionne.id]).toBeUndefined();
    expect(chemins[parIa.id]).toEqual(['link:SECONDARY']);
    expect(chemins[propose.id]).toBeUndefined();

    // Relecture lot 16 : rattachements non confirmés marqués, proposés décochés.
    const nonConfirmes = [parLinkedAsset, parPiece, parIa, linkedSeule].map((f) => f.id).sort((a, b) => a - b);
    expect([...canon.sourceTrace!.unconfirmedDocuments!].sort((a, b) => a - b)).toEqual(nonConfirmes);
    expect(canon.documents.filter((d) => d.unconfirmedLink).map((d) => d.id).sort((a, b) => a - b)).toEqual(nonConfirmes);
    const { buildDefaultChoices } = await import('@/services/exports/v12/data/choices');
    const { parisDate } = await import('@/services/exports/v12/generation/clock');
    await sql`UPDATE asset_files SET document_type_code = 'MAINTENANCE_INVOICE' WHERE account_id = ${compte.id}`;
    const canon2 = await charger(compte, bien.id, 'enabled');
    const choix = buildDefaultChoices('DOSSIER_COMPLET', canon2, { today: parisDate() });
    const coches = choix.items.filter((i) => i.sourceType === 'document' && i.selected).map((i) => i.sourceId).sort((a, b) => a - b);
    expect(coches).toEqual([parAssetId, parSecondaire, parUser, colonneSeule].map((f) => f.id).sort((a, b) => a - b));

    // legacy : strictement la lecture historique (asset_id seul ici).
    const legacy = await charger(compte, bien.id, 'legacy');
    expect(legacy.documents.map((d) => d.id).sort((a, b) => a - b)).toEqual([parAssetId.id, colonneSeule.id, retire.id].sort((a, b) => a - b));
    expect(legacy.sourceTrace).toMatchObject({ mode: 'legacy', source: 'legacy' });

    // shadow : historique utilisé, écarts journalisés sans valeur.
    await sql`UPDATE assets SET address = '12 rue des Lilas' WHERE id = ${bien.id}`;
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const ombre = await charger(compte, bien.id, 'shadow');
    expect(ombre.documents.map((d) => d.id).sort((a, b) => a - b)).toEqual(legacy.documents.map((d) => d.id).sort((a, b) => a - b));
    expect(ombre.sourceTrace).toMatchObject({
      mode: 'shadow', source: 'legacy', shadowDiff: { documentsOnlyLegacy: 1, documentsOnlyCanonical: 6, addedConfirmed: 2, addedUnconfirmed: 4 },
    });
    const ligne = info.mock.calls.find((c) => c[0] === '[exports:canonical-shadow]');
    expect(ligne).toBeDefined();
    const rapport = JSON.parse(String(ligne![1]));
    expect(rapport.documents.onlyLegacy).toEqual([retire.id]);
    expect(rapport.documents.addedInCanonical).toEqual({ confirmed: 2, unconfirmed: 4 });
    expect(rapport.documents.onlyCanonical.map((d: { id: number }) => d.id).sort((a: number, b: number) => a - b))
      .toEqual([parLinkedAsset.id, parPiece.id, parSecondaire.id, parUser.id, parIa.id, linkedSeule.id].sort((a, b) => a - b));
    expect(String(ligne![1])).not.toContain('Lilas');
  });

  it('recette T3-05 : même acquisitionDate dans la fiche, T2 et l’export (colonne divergente)', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, {
      category: 'VEHICULE', name: 'Clio', purchaseDate: '2019-01-01', purchasePriceCents: 1_000_000,
      keyCharacteristics: { acquisitionDate: '2021-05-25', acquisitionPrice: 12500.5 },
    });

    // Fiche : route de la fiche détaillée.
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    const { GET } = await import('@/app/api/assets/[id]/details/route');
    const res = await GET(new NextRequest(`http://localhost/api/assets/${bien.id}/details`), { params: Promise.resolve({ id: String(bien.id) }) });
    const fiche = (await res.json()) as { sections: { common: { acquisitionDate: string; acquisitionPrice: number } } };
    expect(fiche.sections.common.acquisitionDate).toBe('2021-05-25');

    // T2 : lecture canonique de l'assistant.
    process.env.ASSISTANT_CANONICAL_READ = 'enabled';
    const { readCanonicalField } = await import('@/services/verebona-assistant/canonical/field-reader');
    const t2 = await readCanonicalField(compte.id, bien.id, 'acquisitionDate');
    expect(t2?.value).toBe('2021-05-25');
    const { answerFromData } = await import('@/services/verebona-assistant/core/data-answer.service');
    const { accountDataRepository } = await import('@/services/verebona-assistant/core/account-data.repository');
    const { DEFAULT_THRESHOLDS } = await import('@/services/verebona-assistant/core/sufficiency');
    const r = await answerFromData({
      port: accountDataRepository, accountId: compte.id, message: 'Quelle est la date d’achat de la Clio ?', thresholds: DEFAULT_THRESHOLDS,
    });
    expect(r.strategy).toBe('structured.asset_field');
    expect(r.answer).toContain('25 mai 2021');

    // Export : source canonique = fiche = T2 ; unités (euros → centimes exacts).
    const exp = await charger(compte, bien.id, 'enabled');
    expect(exp.asset.purchaseDate).toBe('2021-05-25');
    expect(exp.asset.purchasePriceCents).toBe(1_250_050);
    expect(exp.asset.characteristics.acquisitionPrice).toBe(12500.5);
    // Constat X-02 : la lecture historique imprimait la colonne divergente.
    expect((await charger(compte, bien.id, 'legacy')).asset.purchaseDate).toBe('2019-01-01');
  });

  it('agenda : pas d’échéance tirée d’un fait historique ; échéance passée non prouvée hors historique', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const { HISTORICAL_FIELD_KEYS } = await import('@/services/verebona-assistant/canonical/agenda');
    const fait = await make.agendaItem(compte, { title: 'Achat', startDate: '2099-01-01', assetIds: [bien.id] });
    await sql`UPDATE agenda_items SET origin_field_key = ${HISTORICAL_FIELD_KEYS[0]} WHERE id = ${fait.id}`;
    const futur = await make.agendaItem(compte, { title: 'Contrôle technique', startDate: '2099-06-01', assetIds: [bien.id] });
    const passe = await make.agendaItem(compte, { title: 'Vidange', startDate: '2020-03-01', assetIds: [bien.id] });
    const fait2 = await make.agendaItem(compte, { title: 'Révision', startDate: '2020-04-01', assetIds: [bien.id] });
    await sql`UPDATE agenda_items SET manual_status = 'realise' WHERE id = ${fait2.id}`;

    const { eventSection } = await import('@/services/exports/v12/data/choices');
    const { parisDate } = await import('@/services/exports/v12/generation/clock');
    const today = parisDate();
    const sections = (s: Awaited<ReturnType<typeof charger>>) =>
      Object.fromEntries(s.events.map((e) => [e.key, eventSection('DOSSIER_COMPLET', e, today)]));

    const canon = sections(await charger(compte, bien.id, 'enabled'));
    expect(canon[`agenda:${fait.id}`]).toBeNull();
    expect(canon[`agenda:${futur.id}`]).toBe('deadlines');
    expect(canon[`agenda:${passe.id}`]).toBe('deadlines'); // rubrique « à confirmer » (arbitrage lot 16)
    expect(canon[`agenda:${fait2.id}`]).toBe('history');

    const legacy = sections(await charger(compte, bien.id, 'legacy'));
    expect(legacy[`agenda:${fait.id}`]).toBe('deadlines');
    expect(legacy[`agenda:${passe.id}`]).toBe('history');
  });

  it('export brut, transmission, aperçu admin : même commutateur (legacy inchangé, shadow, enabled)', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', purchaseDate: '2019-01-01', keyCharacteristics: { acquisitionDate: '2021-05-25' } });
    const autre = await make.asset(compte, { category: 'IMMOBILIER', name: 'Studio' });
    const direct = await make.assetFile(compte, { assetId: bien.id, name: 'direct.pdf' });
    const secondaire = await make.assetFile(compte, { assetId: autre.id, name: 'secondaire.pdf' });
    await sql`UPDATE asset_files SET linked_asset_id = ${bien.id} WHERE id = ${secondaire.id}`;
    const confirme = await make.assetFile(compte, { assetId: autre.id, name: 'lien-user.pdf' });
    const { linkDocumentToAsset } = await import('@/services/documents/document-asset-links');
    await linkDocumentToAsset({ accountId: compte.id, fileId: confirme.id, target: { assetId: bien.id }, role: 'SECONDARY', origin: 'USER' });
    const { buildExportAssetSnapshot } = await import('@/services/exports/export-snapshot-source');
    const ids = (s: { documents: Array<{ id: number }> }) => s.documents.map((d) => d.id).sort((a, b) => a - b);

    process.env.EXPORTS_CANONICAL_SOURCE = 'legacy';
    const { buildAssetSnapshot } = await import('@/services/export-snapshot.service');
    const brut = await buildAssetSnapshot(bien.id, compte.ownerUserId, { accountId: compte.id });
    const l = await buildExportAssetSnapshot(bien.id, compte.ownerUserId, { accountId: compte.id }, 'EXPORT_BRUT');
    expect({ ...l, snapshotAt: '' }).toEqual({ ...brut, snapshotAt: '' });
    expect(l.dataSource).toBeUndefined();

    process.env.EXPORTS_CANONICAL_SOURCE = 'enabled';
    for (const [scope, ctx] of [[{ accountId: compte.id }, 'EXPORT_BRUT'], [undefined, 'TRANSMISSION']] as const) {
      const e = await buildExportAssetSnapshot(bien.id, compte.ownerUserId, scope, ctx);
      // Sans étape de choix : le rattachement non confirmé (linked_asset_id) est exclu.
      expect(ids(e)).toEqual([direct.id, confirme.id].sort((a, b) => a - b));
      expect(e.dataSource?.unconfirmedDocuments).toEqual([secondaire.id]);
      expect(e.purchaseDate).toBe('2021-05-25');
      expect(e.detailSections.common?.acquisitionDate).toBe('2021-05-25');
      expect(e.dataSource).toMatchObject({ mode: 'enabled', source: 'canonical' });
    }
    const { analysePreview } = await import('@/services/admin/export-preview.service');
    const apercu = await analysePreview('EXPORT_BRUT', { id: bien.id, ownerUserId: compte.ownerUserId } as never);
    expect(ids(apercu.snapshot)).toEqual([direct.id, confirme.id].sort((a, b) => a - b));

    process.env.EXPORTS_CANONICAL_SOURCE = 'shadow';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const o = await buildExportAssetSnapshot(bien.id, compte.ownerUserId, undefined, 'TRANSMISSION');
    expect(ids(o)).toEqual([direct.id]);
    expect(o.purchaseDate).toBe('2019-01-01');
    expect(o.dataSource).toMatchObject({ mode: 'shadow', source: 'legacy', shadowDiff: { documentsOnlyCanonical: 2, addedConfirmed: 1, addedUnconfirmed: 1 } });
    const ligne = info.mock.calls.find((c) => c[0] === '[exports:canonical-shadow]');
    const rapport = JSON.parse(String(ligne![1]));
    expect(rapport).toMatchObject({ context: 'TRANSMISSION', documents: { addedInCanonical: { confirmed: 1, unconfirmed: 1 } } });
    expect(rapport.documents.onlyCanonical).toEqual(expect.arrayContaining([
      { id: secondaire.id, paths: ['link:SECONDARY'], confirmed: false }, { id: confirme.id, paths: ['link:SECONDARY'], confirmed: true },
    ]));
    expect(rapport.fields).toContain('asset.purchaseDate');
    expect(String(ligne![1])).not.toContain('2021-05-25');
  });

  it('adresse : fiche, vue canonique et export alignés dès qu’un commutateur canonique est enabled ; legacy inchangé', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'IMMOBILIER', name: 'Maison', keyCharacteristics: { address1: '2 rue Fiche', city: 'Lyon' } });
    await sql`UPDATE assets SET address = '1 rue Colonne', city = 'Villeurbanne' WHERE id = ${bien.id}`;
    session.currentAccountId = compte.id; session.userId = compte.ownerUserId;
    const { GET } = await import('@/app/api/assets/[id]/details/route');
    const fiche = async () => {
      const res = await GET(new NextRequest(`http://localhost/api/assets/${bien.id}/details`), { params: Promise.resolve({ id: String(bien.id) }) });
      return ((await res.json()) as { sections: { location_identification: { address1: string; city: string } } }).sections.location_identification;
    };
    delete process.env.EXPORTS_CANONICAL_SOURCE; delete process.env.CANONICAL_WRITE_MODE;
    expect(await fiche()).toMatchObject({ address1: '1 rue Colonne', city: 'Villeurbanne' });

    process.env.CANONICAL_WRITE_MODE = 'enabled';
    expect(await fiche()).toMatchObject({ address1: '2 rue Fiche', city: 'Lyon' });
    delete process.env.CANONICAL_WRITE_MODE;

    const exp = await charger(compte, bien.id, 'enabled');
    expect(await fiche()).toMatchObject({ address1: '2 rue Fiche', city: 'Lyon' });
    expect(exp.asset).toMatchObject({ address: '2 rue Fiche', city: 'Lyon' });
    const { getCanonicalAssetState } = await import('@/services/canonical/asset-state');
    expect((await getCanonicalAssetState(bien.id, compte.id))?.fields.address1?.value).toBe('2 rue Fiche');
  });
});
