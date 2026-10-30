/**
 * Lot 76J — T3 : contrôle EXHAUSTIF de complétude et de cohérence de l'onglet
 * « Informations » des biens et équipements, sur PostgreSQL 16 réel.
 *
 * Ticket « [P1] T3 — Généraliser le contrôle de complétude et de cohérence
 * des données de l'onglet Informations » — tests d'acceptation T3-COH-01 à
 * T3-COH-10, cas « Maison » (date d'achat 17/02/2005, événement automatique
 * « Achat — Maison » du 06/05/2021 à confirmer, prix d'achat vide).
 *
 * Aucun appel modèle : tout est déterministe (le moteur est appelé sans
 * revue IA ; aucune preuve ambiguë n'est construite).
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Kc = Record<string, unknown>;

scenario('L76J', 'T3 — complétude et cohérence exhaustives de l’onglet Informations', ({ sql, make }) => {
  let engine: typeof import('@/services/ai/reconciliation/reconciliation-engine');
  let account: typeof import('@/services/ai/reconciliation/account-reconciliation.service');
  let evidence: typeof import('@/services/ai/evidence/field-evidence.service');
  let registry: typeof import('@/services/canonical/registry');

  beforeAll(async () => {
    engine = await import('@/services/ai/reconciliation/reconciliation-engine');
    account = await import('@/services/ai/reconciliation/account-reconciliation.service');
    evidence = await import('@/services/ai/evidence/field-evidence.service');
    registry = await import('@/services/canonical/registry');
  });

  // ── Fabriques ────────────────────────────────────────────────────────────
  const bien = async (c: AccountRow, o: { category?: string; subtype?: string; kc?: Kc; purchaseDate?: string | null; name?: string } = {}) => {
    const a = await make.asset(c, { category: o.category ?? 'IMMOBILIER', name: o.name ?? 'Maison', keyCharacteristics: o.kc, purchaseDate: o.purchaseDate ?? null });
    await sql`UPDATE assets SET subtype = ${o.subtype ?? 'Maison'} WHERE id = ${a.id}`;
    return a.id;
  };
  const fichier = async (c: AccountRow, assetId: number, documentType: string) => {
    const f = await make.assetFile(c, { assetId });
    await sql`UPDATE asset_files SET document_type = ${documentType} WHERE id = ${f.id}`;
    return f.id;
  };
  const preuve = (c: AccountRow, assetId: number, sourceId: number, key: string, value: string | number, excerpt: string,
    o: { equipmentId?: number; authority?: number; documentType?: string } = {}) => evidence.recordEvidence({
    accountId: c.id, assetId, fieldKey: key, value, normalizedValue: String(value), sourceType: 'document', sourceId, location: {},
    excerpt, confidence: 'certain', authorityScore: o.authority ?? 60, canonicalKey: key, documentType: o.documentType ?? undefined,
    projectionOrigin: 'MODEL_CANONICAL', projectionRule: null,
    target: o.equipmentId ? { type: 'EQUIPMENT', entityId: o.equipmentId, label: null, confidence: 'certain' } : { type: 'ASSET', entityId: assetId, label: null, confidence: 'certain' },
  });
  /** Candidat Opération T1 (structuré, établi, certain) avec un montant ancré sur un fait. */
  const candidatOperation = async (c: AccountRow, fileId: number, o: {
    type: string; targets: Array<{ type: 'ASSET' | 'EQUIPMENT'; entityId: number | null }>; amountMinor: number; excerpt: string;
    realizedDate?: string; scope?: string | null;
  }) => {
    const [ext] = await sql<{ id: number }[]>`INSERT INTO document_extractions (account_id, file_id, full_text, full_text_chars) VALUES (${c.id}, ${fileId}, '', 0)
      ON CONFLICT (file_id) DO UPDATE SET full_text = '' RETURNING id`;
    const [fait] = await sql<{ id: number }[]>`INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, label, value_text, confidence, excerpt)
      VALUES (${c.id}, ${fileId}, ${ext.id}, 'montant', 'Montant', ${String(o.amountMinor / 100)}, 'certain', ${o.excerpt}) RETURNING id`;
    const payload = {
      payloadVersion: 1, targetHints: o.targets.map((t) => ({ ...t, rawLabel: null, confidence: 'certain' })),
      temporalHints: o.realizedDate ? { realizedDate: o.realizedDate } : {},
      financialHints: [{ role: 'REALIZED_COST', amountMinor: o.amountMinor, currency: 'EUR', amountScope: o.scope === undefined ? 'TOTAL' : o.scope,
        economicDate: null, periodStart: null, periodEnd: null, evidence: { factId: fait.id, fingerprint: 'x', sourceUnitIds: [] } }],
      evidence: [{ factId: fait.id, fingerprint: 'x', sourceUnitIds: [] }], evidenceFactIds: [fait.id],
    };
    const [r] = await sql<{ id: number }[]>`INSERT INTO document_operation_candidates
      (account_id, file_id, extraction_id, candidate_key, established, confidence, type_hint, status_hint, summary, payload, status, t3_pending)
      VALUES (${c.id}, ${fileId}, ${ext.id}, ${`k${fait.id}`}, true, 'certain', ${o.type}, 'REALIZED', 'achat', ${JSON.stringify(payload)}::jsonb, 'ACTIVE', false)
      RETURNING id`;
    return r.id;
  };
  /** Événement « Achat » de l'agenda lié au bien (automatique et à confirmer par défaut). */
  const achatAgenda = async (c: AccountRow, assetId: number, date: string, o: { automatic?: boolean; status?: 'realise' | null; sourceFileId?: number; equipmentId?: number } = {}) => {
    const auto = o.automatic ?? true;
    const [i] = await sql<{ id: number }[]>`INSERT INTO agenda_items (account_id, title, start_date, is_automatic, origin_type, manual_status, requires_qualification, business_type)
      VALUES (${c.id}, 'Achat — Maison', ${date}, ${auto}, ${auto ? 'qualified_document' : 'manual'}, ${o.status ?? null}, ${auto}, 'purchase') RETURNING id`;
    await sql`INSERT INTO agenda_asset_links (agenda_item_id, asset_id) VALUES (${i.id}, ${assetId})`;
    if (o.equipmentId) await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${i.id}, ${o.equipmentId})`;
    if (o.sourceFileId) await sql`INSERT INTO agenda_item_sources (agenda_item_id, asset_file_id, effect_type) VALUES (${i.id}, ${o.sourceFileId}, 'created')`;
    return i.id;
  };
  const equipement = async (assetId: number, name: string) =>
    (await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${assetId}, ${name}) RETURNING id`)[0].id;

  // ── Lectures ─────────────────────────────────────────────────────────────
  const fiche = async (assetId: number) => {
    const [r] = await sql<{ kc: string | null; purchase_date: string | null; purchase_price_cents: number | null }[]>`
      SELECT key_characteristics AS kc, purchase_date::text, purchase_price_cents FROM assets WHERE id = ${assetId}`;
    return { kc: (r.kc ? JSON.parse(r.kc) : {}) as Kc, purchaseDate: r.purchase_date, priceCents: r.purchase_price_cents == null ? null : Number(r.purchase_price_cents) };
  };
  const rapport = async (c: AccountRow, assetId: number, targetType = 'ASSET', targetId = assetId) => {
    const [r] = await sql<{ id: number; counters: Record<string, number>; eid: number }[]>`
      SELECT id, counters, COALESCE(entries_report_id, id) AS eid FROM ai_execution_reports
       WHERE account_id = ${c.id} AND treatment = 'T3' AND target_type = ${targetType} AND target_id = ${targetId} ORDER BY id DESC LIMIT 1`;
    const entries = await sql<{ section: string; field_key: string; write_result: string; reason_code: string | null; value: unknown; links: Record<string, unknown> | null }[]>`
      SELECT section, field_key, write_result, reason_code, value, links FROM ai_execution_report_entries WHERE report_id = ${r.eid} ORDER BY seq`;
    return { counters: r.counters, entries };
  };
  const cartes = (assetId: number) => sql<{ rule_code: string; field_key: string; action_kind: string; resolved_at: Date | null }[]>`
    SELECT rule_code, field_key, action_kind, resolved_at FROM to_process_actions WHERE target_type = 'ASSET' AND target_id = ${assetId} ORDER BY id`;
  const t3 = (c: AccountRow, assetId: number) => engine.reconcileAsset({ accountId: c.id, assetId, triggeredBy: 'manual', aiReview: false });
  const traces = async (c: AccountRow, assetId: number) => {
    const [r] = await sql<{ w: number; u: number; e: number; t: number; ev: number }[]>`SELECT
      (SELECT count(*)::int FROM canonical_field_writes WHERE account_id = ${c.id} AND asset_id = ${assetId}) AS w,
      (SELECT count(*)::int FROM ai_field_updates WHERE account_id = ${c.id} AND asset_id = ${assetId}) AS u,
      (SELECT count(*)::int FROM to_process_action_events WHERE account_id = ${c.id}) AS e,
      (SELECT count(*)::int FROM to_process_actions WHERE account_id = ${c.id}) AS t,
      (SELECT count(*)::int FROM field_evidence WHERE account_id = ${c.id}) AS ev`;
    return r;
  };

  // ── T3-COH-01 ────────────────────────────────────────────────────────────

  it('T3-COH-01 — fiche au 17/02/2005, agenda automatique non confirmé au 06/05/2021 : divergence identifiée, date de l’agenda NON retenue', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await bien(c, { kc: { acquisitionDate: '2005-02-17', acquisitionDate__origin: 'RECONCILIATION', acquisitionDate__authority: 100 }, purchaseDate: '2005-02-17' });
    const acte = await fichier(c, m, 'ACTE_AUTHENTIQUE');
    await preuve(c, m, acte, 'acquisitionDate', '2005-02-17', 'Acte de vente signé le 17 février 2005', { authority: 100, documentType: 'ACTE_AUTHENTIQUE' });
    const avis = await fichier(c, m, 'AVIS_ECHEANCE');
    const evt = await achatAgenda(c, m, '2021-05-06', { sourceFileId: avis });

    await t3(c, m);
    const f = await fiche(m);
    expect(f.kc.acquisitionDate).toBe('2005-02-17');
    expect(f.purchaseDate).toBe('2005-02-17');
    const { entries, counters } = await rapport(c, m);
    const div = entries.find((e) => e.section === 'CROSS_SOURCE' && e.field_key === 'acquisitionDate' && e.reason_code === 'AGENDA_UNCONFIRMED_NOT_RETAINED');
    expect(div).toBeTruthy();
    expect(div!.value).toBe('2021-05-06');
    expect(div!.links).toMatchObject({ source: 'AGENDA', agendaItemId: evt, confirmed: false, independent: true });
    expect(counters.contradictions).toBeGreaterThanOrEqual(1);
    // Aucune carte d'arbitrage injustifiée : l'événement porte déjà son propre statut « à confirmer ».
    expect((await cartes(m)).filter((x) => x.resolved_at === null)).toEqual([]);

    // Fiche VIDE + seul l'événement automatique non confirmé : rien n'est inventé.
    const m2 = await bien(c, {});
    await achatAgenda(c, m2, '2021-05-06', { sourceFileId: avis });
    await t3(c, m2);
    expect((await fiche(m2)).kc.acquisitionDate).toBeUndefined();
    expect((await fiche(m2)).purchaseDate).toBeNull();
  });

  it('T3-COH-01 bis — achat CONFIRMÉ par l’utilisateur : complète le champ vide ; contredit une valeur automatique → un seul arbitrage, jamais reproposé une fois tranché', async () => {
    const c = await make.account({ plan: 'premium' });
    const vide = await bien(c, {});
    await achatAgenda(c, vide, '2021-05-06', { automatic: true, status: 'realise' });
    await t3(c, vide);
    const f = await fiche(vide);
    expect(f.kc.acquisitionDate).toBe('2021-05-06');
    expect(f.kc.acquisitionDate__origin).toBe('RECONCILIATION');
    expect(f.purchaseDate).toBe('2021-05-06');

    const m = await bien(c, { kc: { acquisitionDate: '2005-02-17', acquisitionDate__origin: 'RECONCILIATION' } });
    await achatAgenda(c, m, '2021-05-06', { automatic: false, status: 'realise' });
    await t3(c, m);
    expect((await fiche(m)).kc.acquisitionDate).toBe('2005-02-17');
    const ouvertes = (await cartes(m)).filter((x) => x.resolved_at === null);
    expect(ouvertes.map((x) => [x.rule_code, x.field_key, x.action_kind])).toEqual([['DATA-ACQUISITION-DATE', 'acquisitionDate', 'ARBITRATE']]);
    // Rejoué : toujours une seule carte.
    await t3(c, m);
    expect((await cartes(m)).filter((x) => x.resolved_at === null)).toHaveLength(1);
    // L'utilisateur tranche (garde la fiche) : la carte n'est pas reproposée à l'identique.
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'USER_ARBITRATED' WHERE target_type = 'ASSET' AND target_id = ${m} AND resolved_at IS NULL`;
    await sql`UPDATE inconsistency_registry SET status = 'resolved', resolved_at = now() WHERE asset_id = ${m} AND status = 'open'`;
    await t3(c, m);
    expect((await cartes(m)).filter((x) => x.resolved_at === null)).toEqual([]);
    const { entries } = await rapport(c, m);
    expect(entries.some((e) => e.section === 'CROSS_SOURCE' && e.reason_code === 'ALREADY_ARBITRATED')).toBe(true);
  });

  // ── T3-COH-02 / 03 ───────────────────────────────────────────────────────

  it('T3-COH-02 — prix d’acquisition fiable dans un justificatif (acte) : champ vide alimenté, miroir en centimes', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await bien(c, {});
    const acte = await fichier(c, m, 'ACTE_AUTHENTIQUE');
    await candidatOperation(c, acte, { type: 'ACQUISITION', targets: [{ type: 'ASSET', entityId: m }], amountMinor: 25_000_000, excerpt: 'Prix de vente : 250 000,00 euros' });
    await t3(c, m);
    const f = await fiche(m);
    expect(f.kc.acquisitionPrice).toBe(250000);
    expect(f.kc.acquisitionPrice__origin).toBe('RECONCILIATION');
    expect(f.priceCents).toBe(25_000_000);
    const [ev] = await sql<{ projection_rule: string; evidence_excerpt: string; source_id: number }[]>`
      SELECT projection_rule, evidence_excerpt, source_id FROM field_evidence WHERE asset_id = ${m} AND field_key = 'acquisitionPrice'`;
    expect(ev).toMatchObject({ projection_rule: 'T3_ACQUISITION_OPERATION_PRICE', evidence_excerpt: 'Prix de vente : 250 000,00 euros', source_id: acte });
    const { counters } = await rapport(c, m);
    expect(counters.completed).toBe(1);
  });

  it('T3-COH-03 — facture de travaux (Opération d’intervention, ou facture d’un bien immobilier) : aucun prix d’acquisition créé', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await bien(c, {});
    const travaux = await fichier(c, m, 'FACTURE');
    await candidatOperation(c, travaux, { type: 'INTERVENTION', targets: [{ type: 'ASSET', entityId: m }], amountMinor: 1_850_000, excerpt: 'Total travaux TTC 18 500,00 €' });
    // Même un candidat « ACQUISITION » porté par une FACTURE ne fait jamais le prix d'achat d'une maison.
    const materiaux = await fichier(c, m, 'FACTURE');
    await candidatOperation(c, materiaux, { type: 'ACQUISITION', targets: [{ type: 'ASSET', entityId: m }], amountMinor: 320_000, excerpt: 'Matériaux 3 200,00 €' });
    await t3(c, m);
    const f = await fiche(m);
    expect(f.kc.acquisitionPrice).toBeUndefined();
    expect(f.priceCents).toBeNull();
    expect((await sql`SELECT 1 FROM field_evidence WHERE asset_id = ${m} AND field_key = 'acquisitionPrice'`)).toHaveLength(0);
    expect((await cartes(m)).filter((x) => x.resolved_at === null)).toEqual([]);
  });

  // ── T3-COH-04 / 05 ───────────────────────────────────────────────────────

  it('T3-COH-04 — valeur automatique contredite par une meilleure preuve : corrigée et journalisée', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await bien(c, { kc: { acquisitionPrice: 180000, acquisitionPrice__origin: 'DOCUMENT_EXTRACTION', acquisitionPrice__authority: 850 } });
    // Valeur automatique issue d'une facture (preuve encore active, moins autoritaire que l'acte).
    const facture = await fichier(c, m, 'FACTURE');
    await preuve(c, m, facture, 'acquisitionPrice', 180000, 'Total 180 000 €', { documentType: 'FACTURE' });
    const acte = await fichier(c, m, 'ACTE_AUTHENTIQUE');
    await candidatOperation(c, acte, { type: 'ACQUISITION', targets: [{ type: 'ASSET', entityId: m }], amountMinor: 25_000_000, excerpt: 'Prix : 250 000 €' });
    await t3(c, m);
    const f = await fiche(m);
    expect(f.kc.acquisitionPrice).toBe(250000);
    expect(f.priceCents).toBe(25_000_000);
    const [j] = await sql<{ old_value: string; new_value: string; reason_code: string }[]>`
      SELECT old_value, new_value, reason_code FROM ai_field_updates WHERE asset_id = ${m} AND field_key = 'acquisitionPrice' ORDER BY id DESC LIMIT 1`;
    expect(j).toMatchObject({ old_value: '180000', new_value: '250000', reason_code: 'AUTO_VALUE_BETTER_AUTHORITY' });
    expect((await rapport(c, m)).counters.corrected).toBe(1);
  });

  it('T3-COH-05 — valeur utilisateur contredite (fiche ou colonne historique) : jamais écrasée, arbitrage proposé', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await bien(c, { kc: { acquisitionPrice: 200000, acquisitionPrice__origin: 'USER' } });
    const acte = await fichier(c, m, 'ACTE_AUTHENTIQUE');
    await candidatOperation(c, acte, { type: 'ACQUISITION', targets: [{ type: 'ASSET', entityId: m }], amountMinor: 25_000_000, excerpt: 'Prix : 250 000 €' });
    await t3(c, m);
    expect((await fiche(m)).kc.acquisitionPrice).toBe(200000);
    expect((await cartes(m)).filter((x) => x.resolved_at === null).map((x) => [x.rule_code, x.action_kind])).toEqual([['DATA-ACQUISITION-PRICE', 'ARBITRATE']]);
    // L'utilisateur tranche en gardant SA valeur : pas de nouvelle carte au passage suivant…
    await sql`UPDATE to_process_actions SET resolved_at = now(), resolution_reason = 'USER_ARBITRATED' WHERE target_type = 'ASSET' AND target_id = ${m} AND resolved_at IS NULL`;
    await t3(c, m);
    expect((await cartes(m)).filter((x) => x.resolved_at === null)).toEqual([]);
    expect((await rapport(c, m)).entries.find((e) => e.section === 'FIELD' && e.field_key === 'acquisitionPrice')?.links).toMatchObject({ reasonCode: 'ALREADY_DECIDED' });
    expect((await fiche(m)).kc.acquisitionPrice).toBe(200000);
    // … mais un élément NOUVEAU (une nouvelle preuve de la valeur proposée) rouvre un cycle.
    const copie = await fichier(c, m, 'ACTE_NOTARIE');
    await preuve(c, m, copie, 'acquisitionPrice', 250000, 'Copie authentique — prix : 250 000 €', { documentType: 'ACTE_NOTARIE' });
    await t3(c, m);
    expect((await cartes(m)).filter((x) => x.resolved_at === null).map((x) => x.rule_code)).toEqual(['DATA-ACQUISITION-PRICE']);
    expect((await fiche(m)).kc.acquisitionPrice).toBe(200000);

    // Date saisie à la création (colonne historique seule, sans clé de fiche) contredite par l'acte.
    const h = await bien(c, { purchaseDate: '2005-02-17' });
    const acte2 = await fichier(c, h, 'ACTE_AUTHENTIQUE');
    await preuve(c, h, acte2, 'acquisitionDate', '2004-12-01', 'Acte signé le 1er décembre 2004', { authority: 100, documentType: 'ACTE_AUTHENTIQUE' });
    await t3(c, h);
    const fh = await fiche(h);
    expect(fh.purchaseDate).toBe('2005-02-17');
    expect(fh.kc.acquisitionDate).toBeUndefined();
    expect((await cartes(h)).filter((x) => x.resolved_at === null).map((x) => [x.rule_code, x.action_kind])).toEqual([['DATA-ACQUISITION-DATE', 'ARBITRATE']]);
  });

  // ── T3-COH-06 ────────────────────────────────────────────────────────────

  it('T3-COH-06 — facture d’équipement : seuls les champs de l’équipement sont alimentés, jamais l’achat du bien parent', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await bien(c, {});
    const pac = await equipement(m, 'Pompe à chaleur');
    const facture = await fichier(c, m, 'FACTURE');
    await candidatOperation(c, facture, { type: 'ACQUISITION', targets: [{ type: 'ASSET', entityId: m }, { type: 'EQUIPMENT', entityId: pac }], amountMinor: 1_200_000, excerpt: 'PAC air/eau 12 000,00 € TTC' });
    await achatAgenda(c, m, '2023-03-10', { automatic: false, status: 'realise', equipmentId: pac });
    await t3(c, m);
    const f = await fiche(m);
    expect(f.kc.acquisitionPrice).toBeUndefined();
    expect(f.kc.acquisitionDate).toBeUndefined();
    expect(f.priceCents).toBeNull();
    const [e] = await sql<{ kc: unknown; purchase_price_cents: number | null }[]>`SELECT key_characteristics AS kc, purchase_price_cents FROM equipments WHERE id = ${pac}`;
    const ekc = (typeof e.kc === 'string' ? JSON.parse(e.kc) : e.kc ?? {}) as Kc;
    expect(ekc.acquisitionPrice).toBe(12000);
    expect(Number(e.purchase_price_cents)).toBe(1_200_000);
    // Rapport de l'équipement : inventaire exhaustif de ses champs.
    const { entries } = await rapport(c, m, 'EQUIPMENT', pac);
    const examines = new Set(entries.filter((x) => x.section === 'FIELD').map((x) => x.field_key));
    for (const d of registry.listFields(undefined, { targetType: 'EQUIPMENT' })) expect(examines.has(d.key), d.key).toBe(true);
  });

  // ── T3-COH-07 / 08 ───────────────────────────────────────────────────────

  it('T3-COH-07 / T3-COH-08 — tous les champs applicables évalués (vides compris), non applicables tracés, rien d’inventé, aucune carte', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await bien(c, { kc: { livingArea: 120, livingArea__origin: 'USER', notes: 'Mes notes', notes__origin: 'USER' } });
    await t3(c, m);
    const { entries, counters } = await rapport(c, m);
    const champs = new Map(entries.filter((e) => e.section === 'FIELD').map((e) => [e.field_key, e]));
    for (const d of registry.listFields('IMMOBILIER')) expect(champs.has(d.key), d.key).toBe(true);
    expect(champs.get('acquisitionPrice')).toMatchObject({ write_result: 'NOT_WRITTEN', reason_code: 'NO_EXPLOITABLE_INFO' });
    expect(champs.get('acquisitionPrice')!.links).toMatchObject({ inventory: 'NO_EVIDENCE_EMPTY' });
    expect(champs.get('livingArea')!.links).toMatchObject({ inventory: 'NO_EVIDENCE_FILLED' });
    expect(champs.get('saleDate')!.reason_code).toBe('INPUT_ONLY_FIELD');
    // Colonnes d'identité examinées (jamais modifiées par T3).
    expect(entries.some((e) => e.section === 'IDENTITY' && e.field_key === 'name')).toBe(true);
    expect(counters.examined).toBeGreaterThanOrEqual(registry.listFields('IMMOBILIER').length);
    expect(counters.unverifiable).toBeGreaterThan(0);
    expect(counters.notApplicable).toBeGreaterThan(0);
    // T3-COH-08 : aucune valeur inventée, aucune carte « À traiter ».
    const f = await fiche(m);
    expect(Object.keys(f.kc).filter((k) => !k.includes('__')).sort()).toEqual(['livingArea', 'notes']);
    expect(await cartes(m)).toEqual([]);

    // Vélo : immatriculation hors capacité → non applicable, tracé comme tel.
    const velo = await bien(c, { category: 'VEHICULE', subtype: 'Vélo', name: 'Vélo' });
    await t3(c, velo);
    const r = await rapport(c, velo);
    expect(r.entries.find((e) => e.field_key === 'registrationNumber')?.section).toBe('NOT_APPLICABLE');
  });

  it('T3-COH-07 bis — texte libre (notes, description) jamais réécrit par une preuve', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await bien(c, { kc: { description: 'Maison familiale', description__origin: 'DOCUMENT_EXTRACTION', description__authority: 30 } });
    const acte = await fichier(c, m, 'ACTE_AUTHENTIQUE');
    await preuve(c, m, acte, 'description', 'Maison individuelle de 5 pièces', 'Désignation : maison individuelle de 5 pièces', { authority: 100, documentType: 'ACTE_AUTHENTIQUE' });
    await t3(c, m);
    expect((await fiche(m)).kc.description).toBe('Maison familiale');
    const { entries } = await rapport(c, m);
    expect(entries.find((e) => e.section === 'FIELD' && e.field_key === 'description')?.links).toMatchObject({ reasonCode: 'FREE_TEXT_PROTECTED' });
  });

  // ── T3-COH-09 ────────────────────────────────────────────────────────────

  it('T3-COH-09 — stock historique réexaminé automatiquement (borné, reprenable) ; seconde exécution sans changement : aucune écriture ni événement', async () => {
    const c = await make.account({ plan: 'premium' });
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await bien(c, { name: `Maison ${i}` });
      const acte = await fichier(c, a, 'ACTE_AUTHENTIQUE');
      await candidatOperation(c, acte, { type: 'ACQUISITION', targets: [{ type: 'ASSET', entityId: a }], amountMinor: (200_000 + i) * 100, excerpt: `Prix ${200_000 + i} €` });
      ids.push(a);
    }
    // Passage T3 antérieur au lot 76J : rien de « touché » depuis.
    await sql`INSERT INTO account_reconciliation_runs (account_id, trigger_type, correlation_id, scope, status, started_at, finished_at)
      VALUES (${c.id}, 'scheduled', ${`l76j-${c.id}`}, 'incremental', 'completed', now(), now())`;
    await sql`UPDATE assets SET updated_at = now() - interval '1 day' WHERE id = ANY(${ids})`;
    // Lot 101-quinquies : une écriture asynchrone déclenchée par la création des pièces
    // (rattachements, files) peut « toucher » un bien APRÈS le recul ci-dessus sur un
    // serveur lent (CI) ; on attend que les biens restent non touchés (3 s au plus).
    for (let essai = 0; essai < 30; essai += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const touches = await sql`SELECT id FROM assets WHERE id = ANY(${ids}) AND updated_at > now() - interval '1 hour'`;
      if (touches.length === 0) break;
      await sql`UPDATE assets SET updated_at = now() - interval '1 day' WHERE id = ANY(${ids})`;
    }
    process.env.T3_INFORMATION_BACKFILL_MAX_ASSETS = '2';
    try {
      const passe = () => account.reconcileAccount(c.id, { type: 'scheduled' }, { scope: 'incremental' }, {
        reconcile: (i) => engine.reconcileAsset({ ...i, aiReview: false }),
      });
      const r1 = await passe();
      expect(r1.details.filter((d) => d.status !== 'SKIPPED').map((d) => d.objectId)).toEqual(ids.slice(0, 2));
      expect(r1.phases?.INFORMATION_BACKFILL).toMatchObject({ status: 'DEFERRED', counts: { selected: 2, remaining: 1 } });
      const r2 = await passe();
      // Reprise : le bien restant, puis plus rien (les deux premiers ont été écrits → touchés ; ils repassent sans rien changer).
      expect(r2.details.map((d) => d.objectId)).toContain(ids[2]);
      expect(r2.phases?.INFORMATION_BACKFILL).toMatchObject({ status: 'DONE', counts: { remaining: 0 } });
      for (const a of ids) expect((await fiche(a)).priceCents).toBe((200_000 + ids.indexOf(a)) * 100);
      const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM t3_information_checks WHERE account_id = ${c.id}`;
      expect(n).toBe(3);
      // Idempotence : bien par bien, une seconde exécution n'écrit rien de plus.
      for (const a of ids) {
        const avant = await traces(c, a);
        await t3(c, a);
        expect(await traces(c, a)).toEqual(avant);
      }
    } finally {
      delete process.env.T3_INFORMATION_BACKFILL_MAX_ASSETS;
    }
  });

  // ── T3-COH-10 ────────────────────────────────────────────────────────────

  it('T3-COH-10 — fiche et agenda issus de la même extraction erronée : une seule preuve, l’acte l’emporte ; prix du même acte non doublé', async () => {
    const c = await make.account({ plan: 'premium' });
    const m = await bien(c, { kc: { acquisitionDate: '2021-05-06', acquisitionDate__origin: 'RECONCILIATION', acquisitionDate__authority: 30 } });
    const avis = await fichier(c, m, 'AUTRE');
    await preuve(c, m, avis, 'acquisitionDate', '2021-05-06', 'Édité le 06/05/2021', { authority: 30, documentType: 'AUTRE' });
    await achatAgenda(c, m, '2021-05-06', { sourceFileId: avis });
    const acte = await fichier(c, m, 'ACTE_AUTHENTIQUE');
    await preuve(c, m, acte, 'acquisitionDate', '2005-02-17', 'Acte de vente du 17 février 2005', { authority: 100, documentType: 'ACTE_AUTHENTIQUE' });
    await preuve(c, m, acte, 'acquisitionPrice', 250000, 'Prix : 250 000 €', { authority: 1000, documentType: 'ACTE_AUTHENTIQUE' });
    await candidatOperation(c, acte, { type: 'ACQUISITION', targets: [{ type: 'ASSET', entityId: m }], amountMinor: 25_000_000, excerpt: 'Prix : 250 000 €' });
    await t3(c, m);
    const f = await fiche(m);
    expect(f.kc.acquisitionDate).toBe('2005-02-17');
    expect(f.purchaseDate).toBe('2005-02-17');
    const { entries } = await rapport(c, m);
    const agenda = entries.find((e) => e.section === 'CROSS_SOURCE' && e.field_key === 'acquisitionDate' && (e.links as { source?: string } | null)?.source === 'AGENDA');
    expect(agenda?.links).toMatchObject({ independent: false, sharedSourceFileIds: [avis] });
    // Prix : la preuve T1 de l'acte suffit ; le candidat Opération du MÊME acte n'ajoute aucune preuve.
    expect((await sql`SELECT 1 FROM field_evidence WHERE asset_id = ${m} AND field_key = 'acquisitionPrice'`)).toHaveLength(1);
    const prix = entries.find((e) => e.section === 'FIELD' && e.field_key === 'acquisitionPrice');
    expect(prix?.links).toMatchObject({ reasonCode: 'EMPTY_FIELD_SINGLE_CERTAIN' });
  });
});
