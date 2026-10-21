/**
 * Lot 71A — BUG P1 « confusion des données entre biens et équipements » et
 * ticket P1 « contexte T3 pour le rapprochement documents–équipements »,
 * sur PostgreSQL 16 réel (toutes les migrations, dont 0489).
 *
 * EQP-E01 Équipement sans date / prix d'achat : champs VIDES (BDD, API,
 *         fiche) malgré ceux du bien ; une modification du bien ne touche
 *         pas l'équipement, et inversement ; relation bien → équipements OK.
 * EQP-E02 Facture du robot analysée par T1 (sortie rejouée, chaîne de
 *         production) : date et prix d'achat sur le ROBOT, jamais sur la
 *         maison ; document rattaché au robot, visible depuis le robot ET
 *         la maison, sans duplication.
 * EQP-E03 Deux robots similaires : le n° de série départage sans IA ;
 *         sans indice discriminant → ambigu, T3 reçoit le contexte enrichi
 *         (T3EQ-06), s'abstient, carte LINK-ELT, document sur le bien seul.
 * EQP-E04 Équipement créé APRÈS ses documents (route de création) :
 *         rapprochement rétroactif automatique, sans IA quand le
 *         déterministe suffit (T3EQ-07 : sens EQUIPMENT_DOCUMENT).
 * EQP-E05 Événement « achat » lié à un équipement (règle D-13) : la date
 *         va à l'équipement, plus jamais au bien.
 * EQP-E06 TCO : dépenses de l'équipement agrégées une fois, prix d'achat du
 *         bien indépendant, facture de l'équipement jamais prise pour celle
 *         du bien.
 * EQP-E07 Rattrapage BO (simulation puis application avec motif) : provenance
 *         vérifiée, restauration / retrait, valeurs USER préservées, date
 *         identique sans preuve intacte, recopie D-13 déplacée, documents
 *         rattachés, journal 0489, idempotence, isolation des comptes.
 * EQP-E08 Isolation des comptes : aucun équipement d'un autre compte n'est
 *         jamais rattaché ; choix de l'utilisateur jamais contredit.
 */
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import { drainQueues, sortieT1, useTargetState, type FaitT1 } from '../chain';
import type { RecordedOutput } from '../replay-gateway';
import type { AccountRow } from '../factories';

const session = vi.hoisted(() => ({ currentAccountId: 0, userId: 0 }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));
vi.mock('@/lib/asset-quota-guard', () => ({
  assetModificationDecision: async () => ({ allowed: true }), refuserSiModificationBiensSuspendue: async () => null,
  countAccountAssets: async () => 0,
}));
vi.mock('@/services/entitlements.service', async (orig) => ({ ...(await orig<object>()), canUsePremiumFeature: async () => ({ allowed: true }) }));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

scenario('L71A', 'Séparation bien / équipement et rapprochement documentaire', ({ sql, make, useRecordings: rejouer }) => {
  useTargetState();
  const T3_ABSTENTION: RecordedOutput = {
    operationCode: 't3_link_ambiguity', task: 'LINK_AMBIGUITY', output: { task: 'LINK_AMBIGUITY', matches: [] }, repeat: true,
  };
  const as = (c: AccountRow) => { session.currentAccountId = c.id; session.userId = c.ownerUserId; };
  const maison = async (c: AccountRow, kc?: Record<string, unknown>, o: { purchasePriceCents?: number; purchaseDate?: string } = {}) => {
    const a = await make.asset(c, { category: 'IMMOBILIER', name: `Maison ${c.id}`, keyCharacteristics: kc, ...o });
    await sql`UPDATE assets SET subtype = 'Maison' WHERE id = ${a.id}`;
    return a;
  };
  const equipement = async (assetId: number, name: string, o: { brand?: string; model?: string; serial?: string; kc?: Record<string, unknown> } = {}) => {
    const [{ id }] = await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, key_characteristics) VALUES (${assetId}, ${name}, ${JSON.stringify(o.kc ?? {})}::jsonb) RETURNING id`;
    if (o.brand || o.model || o.serial) {
      await sql`INSERT INTO equipment_cil_specs (equipment_id, brand, model, serial_number) VALUES (${id}, ${o.brand ?? null}, ${o.model ?? null}, ${o.serial ?? null})`;
    }
    return id;
  };
  const etatBien = async (c: AccountRow, assetId: number) =>
    (await (await import('@/services/canonical/asset-state')).getCanonicalAssetState(assetId, c.id))!.fields;
  const etatEq = async (c: AccountRow, id: number) =>
    (await (await import('@/services/canonical/entity-state')).getCanonicalEntityState({ type: 'EQUIPMENT', id }, c.id))!.fields;
  const liensEq = async (fileId: number) => (await sql<{ equipment_id: number; asset_id: number; origin: string; link_role: string }[]>`
    SELECT equipment_id, asset_id, origin, link_role FROM document_asset_links WHERE file_id = ${fileId} AND status = 'ACTIVE' AND equipment_id IS NOT NULL ORDER BY equipment_id`);
  const colonneEq = async (fileId: number) => (await sql<{ equipment_id: number | null }[]>`SELECT equipment_id FROM asset_files WHERE id = ${fileId}`)[0].equipment_id;
  const docsDeLEquipement = async (c: AccountRow, id: number) => {
    as(c);
    const { GET } = await import('@/app/api/equipments/[id]/documents/route');
    const res = await GET(new NextRequest(`http://x/api/equipments/${id}/documents`), { params: Promise.resolve({ id: String(id) }) });
    return ((await res.json()) as { documents: Array<{ id: number }> }).documents.map((d) => d.id);
  };
  const docsDuBien = async (c: AccountRow, assetId: number) => {
    const { db } = await import('@/db');
    const { assetFiles } = await import('@/db/schema');
    const { documentInAssetsCondition } = await import('@/services/documents/asset-document-scope');
    const { and, eq, isNull } = await import('drizzle-orm');
    return (await db.select({ id: assetFiles.id }).from(assetFiles)
      .where(and(eq(assetFiles.accountId, c.id), isNull(assetFiles.deletedAt), documentInAssetsCondition([assetId])))).map((r) => r.id);
  };
  const analyser = async (c: AccountRow, fileId: number, output: Record<string, unknown>, extra: RecordedOutput[] = []) => {
    await sql`UPDATE asset_files SET s3_bucket = 'e2e-bucket', original_filename = coalesce(original_filename, ${`doc-${fileId}.pdf`}),
                analysis_state = NULL WHERE id = ${fileId}`;
    const replay = await rejouer([{ operationCode: 't1_analyze_document', task: 'ANALYZE_DOCUMENT', output }, ...extra]);
    const { analyzeFileSources } = await import('@/services/ai/source-analysis/entrypoint');
    const r = await analyzeFileSources([fileId], c.id, { userId: c.ownerUserId, billable: false, origin: 'e2e/l71a' });
    if (!r || r.results.length === 0) throw new Error(`[e2e] analyse du fichier ${fileId} en échec`);
    await drainQueues();
    return replay;
  };
  const appels = (replay: { calls: Array<{ operationCode?: string; prompt?: string }> }, op: string) => replay.calls.filter((x) => x.operationCode === op);
  const fait = (canonicalKey: string | null, value: string | number, excerpt: string, o: Partial<FaitT1> = {}): FaitT1 => ({
    canonicalKey, value, excerpt, assetId: null,
    valueType: canonicalKey === 'acquisitionPrice' ? 'money_eur' : canonicalKey?.endsWith('Date') ? 'date' : 'string', ...o,
  });

  // ══ EQP-E01 ════════════════════════════════════════════════════════════

  it('EQP-E01 — équipement sans date / prix : vides en BDD, API et fiche ; aucune propagation dans un sens ni dans l’autre', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c, { acquisitionDate: '2019-06-14' }, { purchasePriceCents: 30_000_000, purchaseDate: '2019-06-14' });
    as(c);
    const { POST } = await import('@/app/api/assets/[id]/equipments/route');
    const cree = await POST(new NextRequest(`http://x/api/assets/${m.id}/equipments`, { method: 'POST', body: JSON.stringify({ name: 'Robot aspirateur', type: 'Électroménager' }) }),
      { params: Promise.resolve({ id: String(m.id) }) });
    expect(cree.status).toBe(201);
    const robot = (await cree.json() as { id: number }).id;
    // BDD.
    const [ligne] = await sql<{ purchase_price_cents: number | null; kc: Record<string, unknown> }[]>`
      SELECT purchase_price_cents, key_characteristics AS kc FROM equipments WHERE id = ${robot}`;
    expect(ligne.purchase_price_cents).toBeNull();
    expect(ligne.kc).toEqual({});
    // Vue canonique et API.
    expect(await etatEq(c, robot)).not.toHaveProperty('acquisitionDate');
    expect(await etatEq(c, robot)).not.toHaveProperty('acquisitionPrice');
    const { GET: liste } = await import('@/app/api/assets/[id]/equipments/route');
    const l = await (await liste(new NextRequest(`http://x/api/assets/${m.id}/equipments`), { params: Promise.resolve({ id: String(m.id) }) })).json() as Array<{ id: number; purchasePriceCents: number | null }>;
    expect(l.find((x) => x.id === robot)).toMatchObject({ purchasePriceCents: null });
    // Bien modifié → équipement inchangé.
    const { writeCanonicalAssetField } = await import('@/services/canonical/asset-state');
    await writeCanonicalAssetField({ assetId: m.id, accountId: c.id, key: 'acquisitionDate', value: '2019-07-01', origin: 'USER' });
    expect(await etatEq(c, robot)).not.toHaveProperty('acquisitionDate');
    // Équipement modifié → bien inchangé.
    const { PUT } = await import('@/app/api/assets/[id]/equipments/[equipId]/route');
    const r = await PUT(new NextRequest(`http://x/api/assets/${m.id}/equipments/${robot}`, { method: 'PUT', body: JSON.stringify({ purchasePriceCents: 49_900 }) }),
      { params: Promise.resolve({ id: String(m.id), equipId: String(robot) }) });
    expect(r.status).toBe(200);
    expect((await etatEq(c, robot)).acquisitionPrice).toMatchObject({ value: 499, origin: 'USER' });
    const bien = await etatBien(c, m.id);
    expect(bien.acquisitionPrice?.value).toBe(300_000);
    expect(bien.acquisitionDate?.value).toBe('2019-07-01');
    // Relation bien → équipements intacte.
    expect((await sql<{ asset_id: number }[]>`SELECT asset_id FROM equipments WHERE id = ${robot}`)[0].asset_id).toBe(m.id);
  });

  // ══ EQP-E02 ════════════════════════════════════════════════════════════

  it('EQP-E02 — facture du robot déposée sur la maison : date / prix sur le robot, jamais sur la maison ; document rattaché au robot, visible des deux côtés', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const robot = await equipement(m.id, 'Robot aspirateur');
    const f = await make.assetFile(c, { assetId: m.id });
    const replay = await analyser(c, f.id, sortieT1({
      title: 'Facture Robot aspirateur', date: '2025-03-10', documentTypeCode: 'ACQUISITION_INVOICE', canonicalType: 'FACTURE',
      amountCents: 49_900, assets: [{ id: m.id, label: 'Maison' }], equipments: [{ id: robot, label: 'Robot aspirateur' }],
      facts: [
        fait('acquisitionDate', '2025-03-10', 'Date d’achat : 10/03/2025', { targetType: 'EQUIPMENT', equipmentId: robot }),
        fait('acquisitionPrice', 499, 'Robot aspirateur 499,00 €', { targetType: 'EQUIPMENT', equipmentId: robot }),
      ],
    }), [T3_ABSTENTION]);
    expect(await etatEq(c, robot)).toMatchObject({ acquisitionDate: { value: '2025-03-10' }, acquisitionPrice: { value: 499 } });
    const bien = await etatBien(c, m.id);
    expect(bien.acquisitionDate).toBeUndefined();
    expect(bien.acquisitionPrice).toBeUndefined();
    expect((await sql`SELECT id FROM field_evidence WHERE source_id = ${f.id} AND target_type IS DISTINCT FROM 'EQUIPMENT' AND field_key IN ('acquisitionDate', 'acquisitionPrice') AND COALESCE(lifecycle_status, 'ACTIVE') = 'ACTIVE'`)).toHaveLength(0);
    // Document ↔ équipement : lien N-N + colonne, sans IA, sans duplication.
    expect(await liensEq(f.id)).toEqual([expect.objectContaining({ equipment_id: robot, asset_id: m.id, link_role: 'SECONDARY' })]);
    expect(await colonneEq(f.id)).toBe(robot);
    expect(appels(replay, 't3_link_ambiguity')).toHaveLength(0);
    expect(await docsDeLEquipement(c, robot)).toEqual([f.id]);
    expect(await docsDuBien(c, m.id)).toEqual([f.id]);
    expect((await sql`SELECT id FROM asset_files WHERE account_id = ${c.id}`)).toHaveLength(1);
  });

  // ══ EQP-E03 ════════════════════════════════════════════════════════════

  it('EQP-E03 / T3EQ-06 — deux robots similaires : le n° de série départage sans IA ; sans indice, T3 reçoit le contexte enrichi, s’abstient, carte LINK-ELT', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const r1 = await equipement(m.id, 'Robot aspirateur', { brand: 'iRobot', model: 'Roomba i7', serial: 'R7-2024-0001' });
    const r2 = await equipement(m.id, 'Robot aspirateur étage', { brand: 'iRobot', model: 'Roomba i7', serial: 'R7-2024-0002' });
    // Garantie portant le n° de série du robot de l'étage (aucune cible équipement lue par T1).
    const g = await make.assetFile(c, { assetId: m.id });
    const rep1 = await analyser(c, g.id, sortieT1({
      title: 'Certificat de garantie', date: '2025-03-10', documentTypeCode: 'WARRANTY_CERTIFICATE', canonicalType: 'CERTIFICAT_GARANTIE',
      assets: [{ id: m.id, label: 'Maison' }],
      facts: [fait(null, 'R7-2024-0002', 'S/N : R7-2024-0002', { rawKey: 'numeroSerie', label: 'Numéro de série', assetId: m.id })],
    }), [T3_ABSTENTION]);
    expect(appels(rep1, 't3_link_ambiguity')).toHaveLength(0);
    expect((await liensEq(g.id)).map((x) => x.equipment_id)).toEqual([r2]);
    expect(await docsDeLEquipement(c, r2)).toEqual([g.id]);
    expect(await docsDeLEquipement(c, r1)).toEqual([]);

    // Notice « robot aspirateur » sans marque distincte ni n° de série : ambigu.
    const n = await make.assetFile(c, { assetId: m.id });
    const rep2 = await analyser(c, n.id, sortieT1({
      title: 'Notice robot aspirateur', date: '2025-01-02', documentTypeCode: 'USER_MANUAL', canonicalType: 'NOTICE',
      assets: [{ id: m.id, label: 'Maison' }], facts: [fait(null, 'Roomba i7', 'Modèle Roomba i7', { rawKey: 'modele', label: 'Modèle', assetId: m.id })],
    }), [T3_ABSTENTION]);
    const t3 = appels(rep2, 't3_link_ambiguity');
    expect(t3).toHaveLength(1);
    // Contexte réellement transmis : candidats enrichis, faits T1 du document.
    expect(t3[0].prompt).toMatch(new RegExp(`"candidateId":\\s*${r1}`));
    expect(t3[0].prompt).toContain('n° de série:R7-2024-0001');
    expect(t3[0].prompt).toContain('n° de série:R7-2024-0002');
    expect(t3[0].prompt).toContain('marque:iRobot');
    expect(t3[0].prompt).toContain(`bien parent:#${m.id}`);
    expect(t3[0].prompt).toContain('modèle(s) lu(s):Roomba i7');
    expect(t3[0].prompt).not.toMatch(/prix d.achat|acquisitionPrice/);
    expect(await liensEq(n.id)).toEqual([]);
    expect(await colonneEq(n.id)).toBeNull();
    expect(await docsDuBien(c, m.id)).toEqual(expect.arrayContaining([n.id]));
    const [carte] = await sql<{ rule_code: string }[]>`SELECT rule_code FROM to_process_actions WHERE target_type = 'DOCUMENT' AND target_id = ${n.id} AND resolved_at IS NULL AND rule_code = 'LINK-ELT'`;
    expect(carte?.rule_code).toBe('LINK-ELT');
  });

  it('T3EQ-08 — profils transmis à T3 : fiche canonique prioritaire sur la colonne historique divergente, compte borné, aucune donnée d’achat', async () => {
    const c = await make.account({ plan: 'premium' });
    const autre = await make.account({ plan: 'premium' });
    const m = await maison(c, { acquisitionDate: '2019-06-14' }, { purchasePriceCents: 30_000_000 });
    const id = await equipement(m.id, 'Chaudière', { brand: 'Ancienne marque', model: 'Prestige', serial: 'CH-777',
      kc: { brand: 'Frisquet', brand__origin: 'USER', acquisitionPrice: 2500, acquisitionDate: '2020-01-01' } });
    const etranger = await equipement((await maison(autre)).id, 'Chaudière B');
    const { loadEquipmentProfiles } = await import('@/services/equipment/document-equipment-link.service');
    const [p] = await loadEquipmentProfiles(c.id, { assetIds: [m.id], equipmentIds: [etranger] });
    expect(p).toMatchObject({ id, assetId: m.id, brand: 'Frisquet', model: 'Prestige', serialNumber: 'CH-777' });
    expect(await loadEquipmentProfiles(c.id, { equipmentIds: [etranger] })).toEqual([]);
    const { formatEquipmentCandidate } = await import('@/services/equipment/document-equipment-matching');
    expect(formatEquipmentCandidate(p)).not.toMatch(/2019|2020|2500|300000|achat/i);
  });

  // ══ EQP-E04 ════════════════════════════════════════════════════════════

  it('EQP-E04 / T3EQ-07 — équipement créé après ses documents : rapprochement rétroactif automatique, sans IA quand le déterministe suffit', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const f = await make.assetFile(c, { assetId: m.id });
    await analyser(c, f.id, sortieT1({
      title: 'Facture pompe à chaleur', date: '2024-11-02', documentTypeCode: 'WORKS_INVOICE', canonicalType: 'FACTURE',
      assets: [{ id: m.id, label: 'Maison' }], facts: [fait(null, 'PAC-998877', 'N° série PAC-998877', { rawKey: 'numeroSerie', label: 'Numéro de série', assetId: m.id })],
    }), [T3_ABSTENTION]);
    expect(await liensEq(f.id)).toEqual([]);
    // Création par la route (nom sans rapport) puis n° de série saisi → rapprochement.
    const replay = await rejouer([T3_ABSTENTION]);
    as(c);
    const { POST } = await import('@/app/api/assets/[id]/equipments/route');
    const res = await POST(new NextRequest(`http://x/api/assets/${m.id}/equipments`, { method: 'POST', body: JSON.stringify({ name: 'Chauffage salon' }) }),
      { params: Promise.resolve({ id: String(m.id) }) });
    const pac = (await res.json() as { id: number }).id;
    await sql`INSERT INTO equipment_cil_specs (equipment_id, serial_number) VALUES (${pac}, 'PAC998877')`;
    const { syncEquipmentDocumentLinks } = await import('@/services/equipment/document-equipment-link.service');
    const r = await syncEquipmentDocumentLinks({ accountId: c.id, equipmentId: pac, allowAi: true });
    expect(r).toMatchObject({ found: true, linkedDocuments: [f.id], aiCalls: 0 });
    expect(appels(replay, 't3_link_ambiguity')).toHaveLength(0);
    expect(await docsDeLEquipement(c, pac)).toEqual([f.id]);
    // Rejoué : aucun lien de plus.
    expect((await syncEquipmentDocumentLinks({ accountId: c.id, equipmentId: pac })).created).toBe(0);
    expect(await liensEq(f.id)).toHaveLength(1);
  });

  // ══ EQP-E05 ════════════════════════════════════════════════════════════

  it('EQP-E05 — événement « achat » lié à un équipement : date d’achat de l’équipement, jamais du bien (D-13)', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c);
    const robot = await equipement(m.id, 'Robot aspirateur');
    const item = await make.agendaItem(c, { title: 'Achat robot aspirateur', startDate: '2025-03-10', assetIds: [m.id] });
    await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${item.id}, ${robot})`;
    const { syncPurchaseDate } = await import('@/services/agenda/write-agenda-item');
    await syncPurchaseDate({ itemId: item.id, accountId: c.id, actorUserId: c.ownerUserId, manualStatus: 'realise', businessType: 'purchase' });
    expect((await etatEq(c, robot)).acquisitionDate).toMatchObject({ value: '2025-03-10', origin: 'USER' });
    expect((await etatBien(c, m.id)).acquisitionDate).toBeUndefined();
    // Événement d'achat du BIEN seul : règle D-13 inchangée.
    const achat = await make.agendaItem(c, { title: 'Achat maison', startDate: '2019-06-14', assetIds: [m.id] });
    await syncPurchaseDate({ itemId: achat.id, accountId: c.id, actorUserId: c.ownerUserId, manualStatus: 'realise', businessType: 'purchase' });
    expect((await etatBien(c, m.id)).acquisitionDate?.value).toBe('2019-06-14');
    expect((await etatEq(c, robot)).acquisitionDate?.value).toBe('2025-03-10');
  });

  // ══ EQP-E06 ════════════════════════════════════════════════════════════

  it('EQP-E06 — TCO : dépenses de l’équipement une seule fois, prix d’achat du bien indépendant', async () => {
    const { operationsKit, cand, cible, fh } = await import('../datasets/operations-v1');
    const k = operationsKit(sql, make);
    const c = await make.account({ plan: 'premium' });
    const m = await maison(c, undefined, { purchasePriceCents: 30_000_000 });
    const robot = await equipement(m.id, 'Robot aspirateur', { kc: { acquisitionPrice: 499, acquisitionPrice__origin: 'RECONCILIATION' } });
    const facture = await k.document(c, m.id, [cand({ typeHint: 'ACQUISITION', summary: 'Robot aspirateur', targetHints: [cible(m.id)],
      temporalHints: { realizedDate: '2025-03-10' }, financialHints: [fh('REALIZED_COST', 49_900)] })],
    { type: 'ACQUISITION_INVOICE', title: 'Facture robot', amountCents: 49_900, date: '2025-03-10' });
    // Preuve du prix lu pour le ROBOT (portée par la maison) — jamais une preuve du prix de la maison.
    const { recordEvidence } = await import('@/services/ai/evidence/field-evidence.service');
    await recordEvidence({
      accountId: c.id, assetId: m.id, fieldKey: 'acquisitionPrice', value: 499, normalizedValue: '499', sourceType: 'document', sourceId: facture,
      location: {}, excerpt: 'Robot 499,00 €', confidence: 'certain', authorityScore: 80, canonicalKey: 'acquisitionPrice',
      target: { type: 'EQUIPMENT', entityId: robot, label: 'Robot', confidence: 'certain' },
    });
    const { readAssetTco } = await import('@/services/business-operations/tco/service');
    const t = await readAssetTco(c.id, m.id, { today: '2026-10-19' });
    expect(t.lines.find((l) => l.fileId === facture && l.source === 'DOCUMENT')).toMatchObject({ status: 'RETAINED_DIRECT', category: 'ACCESSORIES' });
    expect(t.lines.find((l) => l.source === 'EQUIPMENT_DATA')).toMatchObject({ status: 'DUPLICATE', reason: 'SAME_AS_EQUIPMENT_DOCUMENT' });
    expect(t.summary).toMatchObject({ acquisitionCents: 30_000_000, cumulativeCostCents: 30_049_900 });
  });

  // ══ EQP-E07 ════════════════════════════════════════════════════════════

  it('EQP-E07 — rattrapage BO : simulation sans écriture, application tracée, provenance vérifiée, USER préservé, idempotent, comptes isolés', async () => {
    const { recordEvidence } = await import('@/services/ai/evidence/field-evidence.service');
    const preuve = (c: AccountRow, assetId: number, sourceId: number, key: string, value: string | number, excerpt: string,
      o: { equipmentId?: number; rule?: string; docType?: string; authority?: number } = {}) => recordEvidence({
      accountId: c.id, assetId, fieldKey: key, value, normalizedValue: String(value), sourceType: 'document', sourceId, location: {},
      excerpt, confidence: 'certain', authorityScore: o.authority ?? 60, documentType: o.docType, canonicalKey: key,
      projectionOrigin: o.rule ? 'DETERMINISTIC_RULE' : 'MODEL_CANONICAL', projectionRule: o.rule ?? null,
      target: o.equipmentId ? { type: 'EQUIPMENT', entityId: o.equipmentId, label: null, confidence: 'certain' } : { type: 'ASSET', entityId: assetId, label: null, confidence: 'certain' },
    });
    const historique = async () => {
      const c = await make.account({ plan: 'premium' });
      // A — maison : date déduite (règle) de la facture du robot ; l'acte porte la vraie date.
      const m = await maison(c, { acquisitionDate: '2025-03-10', acquisitionDate__origin: 'RECONCILIATION' });
      const robot = await equipement(m.id, 'Robot aspirateur', { kc: { acquisitionDate: '2025-03-10', acquisitionDate__origin: 'RECONCILIATION' } });
      const acte = (await make.assetFile(c, { assetId: m.id })).id;
      const factureRobot = (await make.assetFile(c, { assetId: m.id })).id;
      await preuve(c, m.id, acte, 'acquisitionDate', '2019-06-14', 'Signé le 14/06/2019', { docType: 'ACTE_NOTARIE', authority: 50 });
      await preuve(c, m.id, factureRobot, 'acquisitionDate', '2025-03-10', 'Date : 10/03/2025', { rule: 'PURCHASE_RECEIPT_ACQUISITION_DATE', authority: 90 });
      await preuve(c, m.id, factureRobot, 'acquisitionDate', '2025-03-10', 'Date d’achat : 10/03/2025', { equipmentId: robot });
      // B — chaudière : valeur de l'acte recopiée (même preuve) ; C — VMC : idem mais validée par l'utilisateur.
      const chaudiere = await equipement(m.id, 'Chaudière', { kc: { acquisitionDate: '2019-06-14', acquisitionDate__origin: 'RECONCILIATION' } });
      const vmc = await equipement(m.id, 'VMC', { kc: { acquisitionDate: '2019-06-14', acquisitionDate__origin: 'USER' } });
      await preuve(c, m.id, acte, 'acquisitionDate', '2019-06-14', 'Signé le 14/06/2019', { equipmentId: chaudiere, docType: 'ACTE_NOTARIE' });
      await preuve(c, m.id, acte, 'acquisitionDate', '2019-06-14', 'Signé le 14/06/2019', { equipmentId: vmc, docType: 'ACTE_NOTARIE' });
      // D — four : même date que la maison, preuve PROPRE (autre extrait) : rien ne prouve une erreur.
      const four = await equipement(m.id, 'Four', { kc: { acquisitionDate: '2019-06-14', acquisitionDate__origin: 'RECONCILIATION' } });
      const factureFour = (await make.assetFile(c, { assetId: m.id })).id;
      await preuve(c, m.id, factureFour, 'acquisitionDate', '2019-06-14', 'Four livré le 14/06/2019', { equipmentId: four });
      // E — second bien : date recopiée (D-13, ancien code) d'un événement « achat » lié à un équipement.
      const m2 = await make.asset(c, { category: 'IMMOBILIER', name: 'Studio', keyCharacteristics: { acquisitionDate: '2024-02-02', acquisitionDate__origin: 'USER' } });
      const tv = await equipement(m2.id, 'Téléviseur');
      const item = await make.agendaItem(c, { title: 'Achat téléviseur', startDate: '2024-02-02', assetIds: [m2.id] });
      await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${item.id}, ${tv})`;
      await sql`INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, old_value, new_value, origin, source_type, source_id, outcome)
                VALUES (${c.id}, ${m2.id}, 'acquisitionDate', NULL, '"2024-02-02"'::jsonb, 'USER', 'agenda_item', ${String(item.id)}, 'written')`;
      // F — document historique du four, jamais rattaché.
      const notice = (await make.assetFile(c, { assetId: m.id })).id;
      await sql`UPDATE asset_files SET retained_title = 'Notice four' WHERE id = ${notice}`;
      return { c, m, robot, chaudiere, vmc, four, m2, tv, notice };
    };
    const h = await historique();
    const autre = await historique();
    const kc = async (table: 'assets' | 'equipments', id: number) =>
      (await sql<{ kc: Record<string, unknown> }[]>`SELECT key_characteristics AS kc FROM ${sql(table)} WHERE id = ${id}`)[0].kc;
    const actives = async (accountId: number) => (await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM field_evidence WHERE account_id = ${accountId} AND COALESCE(lifecycle_status, 'ACTIVE') = 'ACTIVE'`)[0].n;
    const { runDataSeparationBackfill } = await import('@/services/equipment/data-separation-backfill');

    // Simulation : rapport exact, aucune écriture.
    const avant = { ev: await actives(h.c.id), m: await kc('assets', h.m.id), ch: await kc('equipments', h.chaudiere.valueOf()) };
    const sim = await runDataSeparationBackfill({ apply: false, accountId: h.c.id });
    expect(sim.failed).toEqual([]);
    expect(sim.cases.map((x) => [x.kind, x.equipmentId]).sort()).toEqual([
      ['AGENDA_PURCHASE_MOVED', h.tv], ['ASSET_EVIDENCE_WITHDRAWN', h.robot], ['EQUIPMENT_EVIDENCE_WITHDRAWN', h.chaudiere], ['EQUIPMENT_EVIDENCE_WITHDRAWN', h.vmc],
    ].sort());
    expect(sim.preserved).toEqual([{ type: 'EQUIPMENT', id: h.vmc, fieldKey: 'acquisitionDate' }]);
    expect(sim.documents).toMatchObject({ linked: 1, linksCreated: 1 });
    expect({ ev: await actives(h.c.id), m: await kc('assets', h.m.id), ch: await kc('equipments', h.chaudiere) }).toEqual(avant);
    expect(await liensEq(h.notice)).toEqual([]);
    expect((await sql`SELECT id FROM data_separation_corrections WHERE account_id = ${h.c.id}`)).toHaveLength(0);

    // Application (compte filtré, motif).
    const app = await runDataSeparationBackfill({ apply: true, accountId: h.c.id, reason: 'Recette EQP-E07' });
    expect(app.failed).toEqual([]);
    // A : la maison retrouve la date de l'acte (restaurée), la date du robot reste la sienne.
    expect((await etatBien(h.c, h.m.id)).acquisitionDate?.value).toBe('2019-06-14');
    expect((await etatEq(h.c, h.robot)).acquisitionDate?.value).toBe('2025-03-10');
    // B : erreur démontrée → retirée (aucune autre preuve : champ vide). C : valeur USER préservée.
    expect((await etatEq(h.c, h.chaudiere)).acquisitionDate).toBeUndefined();
    expect((await etatEq(h.c, h.vmc)).acquisitionDate).toMatchObject({ value: '2019-06-14', origin: 'USER' });
    // D : date identique sans preuve d'erreur : intacte.
    expect((await etatEq(h.c, h.four)).acquisitionDate?.value).toBe('2019-06-14');
    // E : recopie D-13 déplacée sur l'équipement.
    expect((await etatEq(h.c, h.tv)).acquisitionDate?.value).toBe('2024-02-02');
    expect((await etatBien(h.c, h.m2.id)).acquisitionDate).toBeUndefined();
    // F : document rattaché rétroactivement.
    expect((await liensEq(h.notice)).map((x) => x.equipment_id)).toEqual([h.four]);
    // Traçabilité.
    const journal = await sql<{ kind: string; reason: string; run_id: string }[]>`SELECT kind, reason, run_id::text FROM data_separation_corrections WHERE account_id = ${h.c.id} ORDER BY id`;
    // Lot 75G : la date déplacée est aussi journalisée côté ÉQUIPEMENT (2 lignes AGENDA_PURCHASE_MOVED : bien vidé, équipement renseigné).
    expect(journal.map((j) => j.kind).sort()).toEqual(['AGENDA_PURCHASE_MOVED', 'AGENDA_PURCHASE_MOVED', 'ASSET_EVIDENCE_WITHDRAWN', 'DOCUMENT_EQUIPMENT_LINKED', 'EQUIPMENT_EVIDENCE_WITHDRAWN', 'EQUIPMENT_EVIDENCE_WITHDRAWN']);
    expect(new Set(journal.map((j) => j.reason))).toEqual(new Set(['Recette EQP-E07']));
    expect(new Set(journal.map((j) => j.run_id))).toEqual(new Set([app.runId]));
    // Isolation : l'autre compte n'a pas été touché.
    expect((await etatEq(autre.c, autre.chaudiere)).acquisitionDate?.value).toBe('2019-06-14');
    expect((await etatBien(autre.c, autre.m.id)).acquisitionDate?.value).toBe('2025-03-10');
    expect(await liensEq(autre.notice)).toEqual([]);

    // Idempotence : rejoué, rien de plus.
    const encore = await runDataSeparationBackfill({ apply: true, accountId: h.c.id, reason: 'Rejeu' });
    expect(encore.cases).toEqual([]);
    expect(encore.documents.linksCreated).toBe(0);
    expect((await sql`SELECT id FROM data_separation_corrections WHERE run_id = ${encore.runId}`)).toHaveLength(0);
    // Synthèse BO.
    const { summarizeBackfill } = await import('@/services/admin/ops/backfill/report-format');
    expect(summarizeBackfill('equipment-separation', 'apply', null, { result: app }).headline).toMatch(/Application : 4 valeur\(s\).*1 valeur\(s\) utilisateur préservée/);
  });

  // ══ EQP-E08 ════════════════════════════════════════════════════════════

  it('EQP-E08 — isolation des comptes et décision utilisateur : jamais d’équipement étranger, jamais de retour sur un choix', async () => {
    const a = await make.account({ plan: 'premium' });
    const b = await make.account({ plan: 'premium' });
    const ma = await maison(a);
    const mb = await maison(b);
    await equipement(mb.id, 'Chaudière', { serial: 'CH-123456' });
    const f = await make.assetFile(a, { assetId: ma.id });
    await sql`UPDATE asset_files SET retained_title = 'Entretien chaudière CH-123456' WHERE id = ${f.id}`;
    // La seule chaudière portant ce n° de série est celle d'un AUTRE compte : jamais candidate.
    const { syncDocumentEquipmentLinks } = await import('@/services/equipment/document-equipment-link.service');
    expect((await syncDocumentEquipmentLinks({ accountId: a.id, fileId: f.id })).status).toBe('NO_EQUIPMENT');
    expect((await syncDocumentEquipmentLinks({ accountId: b.id, fileId: f.id })).status).toBe('NOT_FOUND');
    expect(await liensEq(f.id)).toEqual([]);
    // Choix de l'utilisateur : équipement retiré dans le tiroir → jamais rattaché automatiquement.
    const chaudiereA = await equipement(ma.id, 'Chaudière', { serial: 'CH-123456' });
    as(a);
    const { PUT } = await import('@/app/api/documents/[id]/route');
    await sql`UPDATE asset_files SET equipment_id = ${chaudiereA}, analysis_state = NULL WHERE id = ${f.id}`;
    const res = await PUT(new NextRequest(`http://x/api/documents/${f.id}`, { method: 'PUT', body: JSON.stringify({ fileName: 'Entretien', documentType: 'AUTRE', equipmentId: null }) }),
      { params: Promise.resolve({ id: String(f.id) }) });
    expect(res.status).toBe(200);
    const r = await syncDocumentEquipmentLinks({ accountId: a.id, fileId: f.id });
    expect(r.status).toBe('USER_PROTECTED');
    expect(await colonneEq(f.id)).toBeNull();
    expect((await liensEq(f.id)).filter((l) => l.origin === 'AI')).toEqual([]);
  });
});
