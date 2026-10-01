/**
 * Corpus §15 (CDC 15) — documents de bout en bout : E2E-01 à E2E-09, E2E-17.
 *
 * Chaîne réelle (`chain.ts`) : `runSourceAnalysis` (prompt maître T1 par la
 * passerelle, sortie SYNTHÉTIQUE rejouée — D-08) → preuves → T3 et T4 en file
 * durable, exécutés par l'exécutant de production → fiche, agenda, liens,
 * export V12 (`loadExportSource`) et réponse de l'assistant (`runAssistant`).
 *
 * État cible (enabled / master) : AI_T1_ANALYSIS_MODE, CANONICAL_WRITE_MODE,
 * T3_NEGATIVE_RECONCILIATION, AI_T4_EFFECTS, ASSISTANT_CANONICAL_READ,
 * EXPORTS_CANONICAL_SOURCE = enabled ; T1 en architecture `master`.
 */
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import {
  agenda, analyserDocument, demander, exportDe, fiche, preuves, sortieT1, useTargetState, withIds,
} from '../chain';
import { loadT1Fixture } from '@/services/ai/source-analysis/__fixtures__/t1/load';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('CORPUS-DOCS', 'Corpus §15 — documents de bout en bout (enabled / master)', ({ sql, make, useRecordings }) => {
  useTargetState();

  const analyser = (compte: { id: number; ownerUserId: number }, fileId: number, linkedAssetId: number | null, output: Record<string, unknown>) =>
    analyserDocument(sql, useRecordings, { accountId: compte.id, userId: compte.ownerUserId, fileId, linkedAssetId, output });
  const liens = async (fileId: number) => (await sql<{ asset_id: number; link_role: string }[]>`
    SELECT asset_id, link_role FROM document_asset_links WHERE file_id = ${fileId} AND status = 'ACTIVE' ORDER BY asset_id`)
    .map((l) => [Number(l.asset_id), l.link_role]);

  it('E2E-01 — draisienne 24/04/2026 (enabled/master) : acquisitionDate, prix attribuable, événement Achat, liens source, export, T2 répond 24/04/2026', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'OBJECT', name: 'Draisienne' });
    const fichier = await make.assetFile(compte, { assetId: bien.id, name: 'ticket.jpg', mimeType: 'image/jpeg' });
    const f = loadT1Fixture('p-t1-02-ticket-draisienne.json');
    const r = await analyser(compte, fichier.id, bien.id, withIds(f.recording.output, { 184: bien.id }));
    expect(r.analysedCount).toBe(1);
    expect(r.replay.calls.map((c) => [c.operationCode, c.task])).toEqual([['t1_analyze_document', 'ANALYZE_DOCUMENT']]);

    // Fiche (T3) : date et prix, attribuables au bien.
    const fi = await fiche(sql, bien.id);
    expect(fi).toMatchObject({ acquisitionDate: '2026-04-24', acquisitionPrice: 129, _purchaseDate: '2026-04-24' });
    // Preuves actives, sources = le ticket.
    expect(await preuves(sql, bien.id)).toEqual([
      { key: 'acquisitionDate', value: '2026-04-24', sourceId: fichier.id },
      { key: 'acquisitionPrice', value: '129', sourceId: fichier.id },
    ]);
    // Événement Achat (T4, HISTORICAL) lié au document source.
    const ev = await agenda(sql, bien.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ date: '2026-04-24', nature: 'HISTORICAL', businessType: 'purchase', sources: [fichier.id] });
    expect(await liens(fichier.id)).toEqual([[bien.id, 'PRIMARY']]);
    // Export : même date, document et événement.
    const ex = await exportDe(compte, bien.id);
    expect(ex.asset).toMatchObject({ purchaseDate: '2026-04-24', characteristics: { acquisitionDate: '2026-04-24', acquisitionPrice: 129 } });
    expect(ex.documents.map((d) => d.id)).toEqual([fichier.id]);
    expect(ex.events.map((e) => [e.date, e.nature])).toEqual([['2026-04-24', 'HISTORICAL']]);
    // T2.
    const t2 = await demander(compte, 'Quand ai-je acheté la draisienne ?');
    expect(t2.answer).toContain('24 avril 2026');
    expect(t2.sources.map((s) => s.id)).toContain(`asset_field:${bien.id}:acquisitionDate`);
  });

  it('E2E-02 — montant 749 EUR (enabled/master) : jamais 74 900 € ; unité correcte de la preuve à l’export et à T2', async () => {
    const compte = await make.account();
    const bien = await make.asset(compte, { category: 'OBJECT', name: 'Draisienne' });
    const fichier = await make.assetFile(compte, { assetId: bien.id });
    const f = loadT1Fixture('t1-03-montant-749.json');
    await analyser(compte, fichier.id, bien.id, withIds(f.recording.output, { 184: bien.id }));

    const fi = await fiche(sql, bien.id);
    expect(fi.acquisitionPrice).toBe(749);
    expect(fi._purchasePriceCents).toBe(74900); // colonne historique en centimes
    expect((await preuves(sql, bien.id)).find((p) => p.key === 'acquisitionPrice')?.value).toBe('749');
    const [doc] = await sql<{ amount_cents: number }[]>`SELECT amount_cents FROM asset_files WHERE id = ${fichier.id}`;
    expect(Number(doc.amount_cents)).toBe(74900);
    const ex = await exportDe(compte, bien.id);
    expect(ex.asset.characteristics.acquisitionPrice).toBe(749);
    expect(ex.asset.purchasePriceCents).toBe(74900);
    expect(ex.documents[0].amountCents).toBe(74900);
    const t2 = await demander(compte, 'Quel est le prix d’achat de la draisienne ?');
    expect(t2.answer).toMatch(/749(,00)?\s?€/);
    expect(t2.answer).not.toMatch(/74\s?900/);
  });

  it('E2E-03 — facture réparation (enabled/master) : aucun changement de acquisitionPrice ; événement réparation', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, {
      category: 'VEHICULE', name: 'Clio',
      keyCharacteristics: { acquisitionPrice: 15000, acquisitionPrice__origin: 'USER', acquisitionDate: '2019-03-01', acquisitionDate__origin: 'USER' },
    });
    const tesla = await make.asset(compte, { category: 'VEHICULE', name: 'Tesla Model 3' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    const f = loadT1Fixture('p-t1-03-facture-reparation.json');
    await analyser(compte, fichier.id, clio.id, withIds(f.recording.output, { 12: clio.id, 13: tesla.id }));

    const fi = await fiche(sql, clio.id);
    expect(fi).toMatchObject({ acquisitionPrice: 15000, acquisitionDate: '2019-03-01', mileage: 78000 });
    const cles = (await preuves(sql, clio.id)).map((p) => p.key);
    expect(cles).not.toContain('acquisitionPrice');
    expect(cles).not.toContain('acquisitionDate');
    const ev = await agenda(sql, clio.id);
    expect(ev.map((e) => e.businessType)).toContain('repair');
    expect(ev.map((e) => e.businessType)).not.toContain('purchase');
    expect(ev.find((e) => e.businessType === 'repair')).toMatchObject({ nature: 'HISTORICAL', sources: [fichier.id] });
  });

  it('E2E-04 — entretien + prochain entretien (enabled/master) : historique réalisé ET future action', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    await analyser(compte, fichier.id, clio.id, sortieT1({
      title: 'Facture entretien Clio', date: '2026-09-03', documentTypeCode: 'MAINTENANCE_INVOICE', amountCents: 30000,
      assets: [{ id: clio.id, label: 'Clio' }],
      facts: [
        { canonicalKey: 'lastRevision', value: '2026-09-03', valueType: 'date', excerpt: 'Révision effectuée le 03/09/2026', assetId: clio.id,
          semanticEvent: { type: 'maintenance', nature: 'HISTORICAL' } },
        { canonicalKey: 'maintenanceDueDate', value: '2027-09-03', valueType: 'date', excerpt: 'Prochaine révision : 03/09/2027', assetId: clio.id,
          semanticEvent: { type: 'maintenance', nature: 'DEADLINE' } },
      ],
    }));
    expect(await fiche(sql, clio.id)).toMatchObject({ lastRevision: '2026-09-03', maintenanceDueDate: '2027-09-03' });
    const ev = await agenda(sql, clio.id);
    expect(ev.map((e) => [e.date, e.nature, e.businessType])).toEqual([
      ['2026-09-03', 'HISTORICAL', 'maintenance'],
      ['2027-09-03', 'DEADLINE', 'maintenance'],
    ]);
    expect(ev[1].category).toBe('action');
    expect(ev.every((e) => e.sources.includes(fichier.id))).toBe(true);
  });

  it('E2E-05 — entretien sans prochaine date (enabled/master) : aucun futur inventé', async () => {
    const compte = await make.account();
    const clio = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const tesla = await make.asset(compte, { category: 'VEHICULE', name: 'Tesla Model 3' });
    const fichier = await make.assetFile(compte, { assetId: clio.id });
    const f = loadT1Fixture('t1-06-dernier-entretien-seul.json');
    await analyser(compte, fichier.id, clio.id, withIds(f.recording.output, { 12: clio.id, 13: tesla.id }));

    const fi = await fiche(sql, clio.id);
    expect(fi.maintenanceDueDate).toBeUndefined();
    expect(fi.lastRevision).toBe('2026-11-15');
    const ev = await agenda(sql, clio.id);
    expect(ev.filter((e) => e.nature === 'DEADLINE')).toEqual([]);
    expect(ev.map((e) => [e.date, e.nature, e.businessType])).toEqual([['2026-11-15', 'HISTORICAL', 'maintenance']]);
  });

  it('E2E-06 — DPE simple (enabled/master) : dpeDate, sans fausse expiration ni échéance', async () => {
    const compte = await make.account();
    const appart = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement Lyon' });
    const fichier = await make.assetFile(compte, { assetId: appart.id });
    const f = loadT1Fixture('p-t1-05-dpe-realise.json');
    await analyser(compte, fichier.id, appart.id, withIds(f.recording.output, { 30: appart.id }));

    const fi = await fiche(sql, appart.id);
    expect(fi.dpeDate).toBe('2026-03-12');
    expect(fi.dpeExpiryDate).toBeUndefined();
    expect((await preuves(sql, appart.id)).map((p) => p.key)).not.toContain('dpeExpiryDate');
    const ev = await agenda(sql, appart.id);
    expect(ev.filter((e) => e.nature === 'DEADLINE')).toEqual([]);
    expect((await exportDe(compte, appart.id)).events.filter((e) => e.nature === 'DEADLINE')).toEqual([]);
  });

  it('E2E-07 — DPE + expiration explicite (enabled/master) : dpeDate, dpeExpiryDate et UNE échéance', async () => {
    const compte = await make.account();
    const appart = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement Lyon' });
    const fichier = await make.assetFile(compte, { assetId: appart.id });
    await analyser(compte, fichier.id, appart.id, sortieT1({
      title: 'Diagnostic de performance énergétique', date: '2026-03-12', documentTypeCode: 'DPE', canonicalType: 'DPE', rubricCode: 'REGULATORY_DIAGNOSTICS',
      assets: [{ id: appart.id, label: 'Appartement Lyon' }],
      facts: [
        { canonicalKey: 'dpeDate', value: '2026-03-12', valueType: 'date', excerpt: 'Date d’établissement : 12/03/2026', assetId: appart.id,
          semanticEvent: { type: 'dpe', nature: 'HISTORICAL' } },
        { canonicalKey: 'dpeExpiryDate', value: '2036-03-11', valueType: 'date', excerpt: 'Valable jusqu’au : 11/03/2036', assetId: appart.id,
          semanticEvent: { type: 'dpe', nature: 'DEADLINE' } },
      ],
    }));
    expect(await fiche(sql, appart.id)).toMatchObject({ dpeDate: '2026-03-12', dpeExpiryDate: '2036-03-11' });
    const ev = await agenda(sql, appart.id);
    const echeances = ev.filter((e) => e.nature === 'DEADLINE');
    expect(echeances.map((e) => [e.date, e.businessType])).toEqual([['2036-03-11', 'dpe']]);
    expect(echeances[0].sources).toEqual([fichier.id]);
  });

  it('E2E-08 — garantie (enabled/master) : warrantyEndDate, événement et source', async () => {
    const compte = await make.account();
    const velo = await make.asset(compte, { category: 'OBJECT', name: 'Vélo électrique' });
    const fichier = await make.assetFile(compte, { assetId: velo.id });
    await analyser(compte, fichier.id, velo.id, sortieT1({
      title: 'Certificat de garantie vélo', date: '2026-04-24', documentTypeCode: 'WARRANTY_CERTIFICATE', canonicalType: 'CERTIFICAT_GARANTIE', rubricCode: 'CONTRACTS_DOCS',
      assets: [{ id: velo.id, label: 'Vélo électrique' }],
      facts: [
        { canonicalKey: 'warrantyEndDate', value: '2028-04-24', valueType: 'date', excerpt: 'Garantie valable jusqu’au 24/04/2028', assetId: velo.id,
          semanticEvent: { type: 'warranty', nature: 'DEADLINE' } },
      ],
    }));
    expect((await fiche(sql, velo.id)).warrantyEndDate).toBe('2028-04-24');
    expect(await preuves(sql, velo.id)).toEqual([{ key: 'warrantyEndDate', value: '2028-04-24', sourceId: fichier.id }]);
    const ev = await agenda(sql, velo.id);
    expect(ev.map((e) => [e.date, e.nature, e.businessType, e.sources])).toEqual([['2028-04-24', 'DEADLINE', 'warranty', [fichier.id]]]);
    expect((await exportDe(compte, velo.id)).events.map((e) => e.date)).toEqual(['2028-04-24']);
  });

  it('E2E-09 — contrôle technique (enabled/master) : historique, et prochain contrôle SEULEMENT si le PV le justifie', async () => {
    const compte = await make.account();
    const avec = await make.asset(compte, { category: 'VEHICULE', name: 'Clio' });
    const sans = await make.asset(compte, { category: 'VEHICULE', name: 'Polo' });
    const pv = (assetId: number, label: string, next: boolean) => sortieT1({
      title: `Procès-verbal de contrôle technique ${label}`, date: '2026-05-02', documentTypeCode: 'VEHICLE_TECHNICAL_INSPECTION', canonicalType: 'CONTROLE_TECHNIQUE',
      rubricCode: 'REGULATORY_DIAGNOSTICS', assets: [{ id: assetId, label }],
      facts: [
        { canonicalKey: 'lastInspectionDate', value: '2026-05-02', valueType: 'date', excerpt: 'Date du contrôle : 02/05/2026', assetId,
          semanticEvent: { type: 'inspection', nature: 'HISTORICAL' } },
        ...(next ? [{ canonicalKey: 'nextInspection', value: '2028-05-01', valueType: 'date' as const, excerpt: 'Prochain contrôle avant le 01/05/2028', assetId,
          semanticEvent: { type: 'inspection', nature: 'DEADLINE' as const } }] : []),
      ],
    });
    const f1 = await make.assetFile(compte, { assetId: avec.id });
    const f2 = await make.assetFile(compte, { assetId: sans.id });
    await analyser(compte, f1.id, avec.id, pv(avec.id, 'Clio', true));
    await analyser(compte, f2.id, sans.id, pv(sans.id, 'Polo', false));

    expect((await agenda(sql, avec.id)).map((e) => [e.date, e.nature, e.businessType, e.category])).toEqual([
      ['2026-05-02', 'HISTORICAL', 'inspection', 'information'],
      ['2028-05-01', 'DEADLINE', 'inspection', 'action'],
    ]);
    expect((await agenda(sql, sans.id)).map((e) => [e.date, e.nature])).toEqual([['2026-05-02', 'HISTORICAL']]);
    expect((await fiche(sql, sans.id)).nextInspection).toBeUndefined();
    expect((await fiche(sql, avec.id)).nextInspection).toBe('2028-05-01');
  });

  it('E2E-17 — facture équipement (enabled/master) : faits sur l’équipement, aucune pollution du bien parent', async () => {
    const compte = await make.account();
    const appart = await make.asset(compte, { category: 'IMMOBILIER', name: 'Appartement Lyon' });
    const [eq] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, type) VALUES (${appart.id}, 'Chaudière Frisquet', 'BOILER') RETURNING id`;
    const fichier = await make.assetFile(compte, { assetId: appart.id });
    const f = loadT1Fixture('t1-04-equipement-chaudiere.json');
    await analyser(compte, fichier.id, appart.id, withIds(f.recording.output, { 30: appart.id, 501: Number(eq.id) }));

    const fi = await fiche(sql, appart.id);
    expect(fi.warrantyEndDate).toBeUndefined();
    expect(fi.serialNumber).toBeUndefined();
    const cibles = await sql<{ key: string; target_type: string; target_entity_id: number }[]>`
      SELECT coalesce(canonical_key, field_key) AS key, target_type, target_entity_id FROM field_evidence
       WHERE source_id = ${fichier.id} AND status = 'active' AND canonical_key IS NOT NULL ORDER BY 1`;
    expect(cibles.length).toBeGreaterThan(0);
    expect(cibles.every((c) => c.target_type === 'EQUIPMENT' && Number(c.target_entity_id) === Number(eq.id))).toBe(true);
    // Échéance de garantie de l'ÉQUIPEMENT : liée à lui.
    const ev = await sql<{ date: string; equipment_id: number | null }[]>`
      SELECT to_char(i.start_date, 'YYYY-MM-DD') AS date, l.equipment_id
        FROM agenda_items i JOIN agenda_equipment_links l ON l.agenda_item_id = i.id
       WHERE i.account_id = ${compte.id}`.catch(() => [] as Array<{ date: string; equipment_id: number | null }>);
    expect(ev.map((e) => [e.date, Number(e.equipment_id)])).toEqual([['2028-12-31', Number(eq.id)]]);
  });
});
