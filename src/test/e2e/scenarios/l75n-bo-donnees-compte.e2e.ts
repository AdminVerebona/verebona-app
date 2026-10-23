/**
 * Lot 75N — BO › Comptes › fiche d'un compte › « Données du compte » — base
 * PostgreSQL réelle, PAR LES VRAIES ROUTES (garde `requireAdmin` réelle : seule
 * la lecture du cookie de session est simulée).
 *
 *   · L75N-E01 droits : non-admin 403 sur liste, tiroir et export ;
 *   · L75N-E02 six catégories : listes paginées serveur, recherche, filtres,
 *     compteurs réels, archivés / supprimés consultables ;
 *   · L75N-E03 recette « Roborock » simulée : équipement (prix canonique HT
 *     1 165,83 € vs facture 1 399,00 €), miroir, preuves, faits T1, carte
 *     « À traiter », facture d'acquisition, Opération d'achat, échéance ;
 *     navigation Équipement → Facture → Opération → Échéance → retour ;
 *     valeurs techniques identiques à celles des lecteurs canoniques ;
 *   · L75N-E04 téléchargements JSON / CSV / TXT complets (nommage, en-têtes,
 *     journal), export sans troncature au-delà d'un lot interne (650
 *     preuves). Lot 81C (adapté) : le tiroir est une CONSULTATION PAGINÉE
 *     (première page + total réel), l'export est INTÉGRAL (plus de borne
 *     « incomplet » : une section en panne est FAILED, l'export PARTIAL) ;
 *   · L75N-E05 sécurité : entité d'un autre compte → 404 (tentative
 *     journalisée DENIED), masquage (clé de stockage, nom et texte du fichier,
 *     IBAN, donnée sensible du registre), aucune URL de fichier ;
 *   · L75N-E06 aucune écriture : empreintes des tables métier du compte
 *     identiques avant / après toutes les consultations et exports ; seule
 *     écriture : le journal d'administration.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

scenario('L75N', 'BO Données du compte : six catégories, tiroir, copie, exports, sécurité, recette Roborock', ({ sql, make }) => {
  const session = { userId: 0, role: 'USER', email: '' };
  afterAll(() => { vi.restoreAllMocks(); });

  async function seConnecter(role: 'ADMIN' | 'USER') {
    const u = await make.user({ role });
    session.userId = u.id; session.role = role; session.email = u.email;
    return u;
  }

  async function routes() {
    const { SessionService } = await import('@/lib/session-service');
    vi.spyOn(SessionService, 'getSession').mockImplementation(async () => ({ userId: session.userId, role: session.role, email: session.email }) as never);
    const { NextRequest } = await import('next/server');
    const list = await import('@/app/api/admin/accounts/[id]/data/[category]/route');
    const entity = await import('@/app/api/admin/accounts/[id]/entities/[type]/[entityId]/route');
    return {
      list: (accountId: number, category: string, qs = '') =>
        list.GET(new NextRequest(`http://app.test/api/admin/accounts/${accountId}/data/${category}${qs ? `?${qs}` : ''}`), { params: Promise.resolve({ id: String(accountId), category }) }),
      entity: (accountId: number, type: string, id: number, qs = '') =>
        entity.GET(new NextRequest(`http://app.test/api/admin/accounts/${accountId}/entities/${type}/${id}${qs ? `?${qs}` : ''}`), { params: Promise.resolve({ id: String(accountId), type, entityId: String(id) }) }),
    };
  }

  // ── Jeu « Roborock » ─────────────────────────────────────────────────────
  const ids: Record<string, number> = {};
  let A: AccountRow;
  let B: AccountRow;

  beforeAll(async () => {
    A = await make.account({ plan: 'premium', name: 'Compte Roborock E2E' });
    B = await make.account({ plan: 'premium', name: 'Autre compte E2E' });
    const maison = await make.asset(A, { category: 'IMMOBILIER', name: 'Maison principale', keyCharacteristics: { address1: '12 rue des Lilas', address1__origin: 'USER' } });
    ids.asset = maison.id;
    ids.assetArchived = (await make.asset(A, { category: 'VEHICULE', name: 'Ancienne voiture' })).id;
    await sql`UPDATE assets SET status = 'ARCHIVED' WHERE id = ${ids.assetArchived}`;
    ids.assetDeleted = (await make.asset(A, { category: 'OBJET', name: 'Bien supprimé' })).id;
    await sql`UPDATE assets SET deleted_at = now() WHERE id = ${ids.assetDeleted}`;

    ids.room = (await sql<{ id: number }[]>`INSERT INTO substructures (asset_id, name, room_type, area) VALUES (${maison.id}, 'Salon', 'LIVING', '32') RETURNING id`)[0].id;
    ids.equipment = (await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, substructure_id, name, type, category, purchase_price_cents, status, key_characteristics)
      VALUES (${maison.id}, ${ids.room}, 'Robot aspirateur Roborock S8 Pro Ultra', 'ROBOT_ASPIRATEUR', 'ELECTROMENAGER', 116583, 'EN_SERVICE',
              ${JSON.stringify({ acquisitionPrice: 1165.83, acquisitionPrice__origin: 'RECONCILIATION', acquisitionPrice__updatedAt: '2026-10-01T09:00:00.000Z' })}::jsonb)
      RETURNING id`)[0].id;
    ids.equipmentArchived = (await sql<{ id: number }[]>`
      INSERT INTO equipments (asset_id, name, archived_at) VALUES (${maison.id}, 'Ancien aspirateur', now()) RETURNING id`)[0].id;

    // Facture d'acquisition du 22/04/2024 (1 399,00 € TTC).
    const f = await make.assetFile(A, { assetId: maison.id, name: 'facture-roborock-dupont.pdf' });
    ids.file = f.id;
    await sql`UPDATE asset_files SET retained_title = 'Facture d’acquisition', document_type_code = 'FACTURE_ACHAT', document_date = '2024-04-22',
                     amount_cents = 139900, supplier = 'Boulanger', equipment_id = ${ids.equipment}, filename = 'facture-roborock-dupont.pdf',
                     original_filename = 'Facture Dupont IBAN.pdf', extracted_text = 'TEXTE INTÉGRAL CONFIDENTIEL — total TTC 1 399,00 €',
                     notes = 'Virement FR76 3000 6000 0112 3456 7890 189', analysis_state = 'ANALYZED'
               WHERE id = ${f.id}`;
    ids.extraction = (await sql<{ id: number }[]>`
      INSERT INTO document_extractions (account_id, file_id, amount_cents, currency, document_date, supplier_name, full_text, extracted_at)
      VALUES (${A.id}, ${f.id}, 139900, 'EUR', '2024-04-22', 'Boulanger', 'TEXTE INTÉGRAL CONFIDENTIEL', now()) RETURNING id`)[0].id;
    await sql`INSERT INTO document_source_units (account_id, file_id, extraction_id, source_unit_id, kind, ordinal, label, value_text, coverage_status, page)
              VALUES (${A.id}, ${f.id}, ${ids.extraction}, 'u-total', 'LABEL_VALUE', 1, 'Total TTC', '1 399,00 €', 'COVERED', 1),
                     (${A.id}, ${f.id}, ${ids.extraction}, 'u-ht', 'LABEL_VALUE', 2, 'Total HT', '1 165,83 €', 'COVERED', 1)`;
    ids.factHt = (await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_number, value_unit, raw_value, confidence,
                                  evidence_origin, excerpt, target_type, target_entity_id, status, source_unit_ids)
      VALUES (${A.id}, ${f.id}, ${ids.extraction}, 'acquisitionPrice', 'acquisitionPrice', 'Total HT', 1165.83, 'EUR', '1 165,83 € HT', 'certain',
              'TEXT_EXTRACTION', 'Total HT 1 165,83 €', 'EQUIPMENT', ${ids.equipment}, 'active', ARRAY['u-ht']) RETURNING id`)[0].id;
    ids.factTtc = (await sql<{ id: number }[]>`
      INSERT INTO document_facts (account_id, file_id, extraction_id, fact_key, canonical_key, label, value_number, value_unit, raw_value, confidence,
                                  evidence_origin, excerpt, status, source_unit_ids)
      VALUES (${A.id}, ${f.id}, ${ids.extraction}, 'totalAmount', 'totalAmount', 'Total TTC', 1399.00, 'EUR', '1 399,00 € TTC', 'certain',
              'TEXT_EXTRACTION', 'Total TTC 1 399,00 €', 'active', ARRAY['u-total']) RETURNING id`)[0].id;
    await sql`INSERT INTO document_unresolved_facts (account_id, file_id, extraction_id, reason, status, raw_key, raw_value)
              VALUES (${A.id}, ${f.id}, ${ids.extraction}, 'AMBIGUOUS_TAX_BASIS', 'UNRESOLVED', 'prix', '1 399,00')`;
    ids.evidence = (await sql<{ id: number }[]>`
      INSERT INTO field_evidence (account_id, asset_id, field_key, canonical_key, value_json, normalized_value, raw_value, canonical_unit, source_type, source_id,
                                  confidence, fingerprint, evidence_origin, evidence_excerpt, target_type, target_entity_id, status, lifecycle_status, extracted_at)
      VALUES (${A.id}, ${maison.id}, 'acquisitionPrice', 'acquisitionPrice', '1165.83'::jsonb, '1165.83', '1 165,83 € HT', 'EUR', 'document', ${f.id},
              'certain', ${`fp-${f.id}-ht`}, 'TEXT_EXTRACTION', 'Total HT 1 165,83 €', 'EQUIPMENT', ${ids.equipment}, 'active', 'ACTIVE', now())
      RETURNING id`)[0].id;
    // Volume : 650 preuves supplémentaires (> un lot interne de 500 lignes).
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, source_type, source_id, confidence, fingerprint, target_type, target_entity_id, status, lifecycle_status, extracted_at, evidence_excerpt)
              SELECT ${A.id}, ${maison.id}, 'maintenanceNote', to_jsonb('note ' || g), 'document', ${f.id}, 'probable', 'fp-vol-' || ${f.id} || '-' || g,
                     'EQUIPMENT', ${ids.equipment}, 'active', 'SUPERSEDED', now() - (g || ' seconds')::interval, 'extrait ' || g
                FROM generate_series(1, 650) g`;
    // Preuve d'un champ SENSIBLE du registre (adresse) sur le bien.
    await sql`INSERT INTO field_evidence (account_id, asset_id, field_key, value_json, raw_value, source_type, source_id, confidence, fingerprint, status, evidence_excerpt)
              VALUES (${A.id}, ${maison.id}, 'address1', '"12 rue des Lilas"'::jsonb, '12 rue des Lilas', 'document', ${f.id}, 'certain', ${`fp-adr-${f.id}`}, 'active', 'Adresse : 12 rue des Lilas')`;
    await sql`INSERT INTO canonical_field_writes (account_id, asset_id, canonical_key, old_value, new_value, origin, source_type, source_id, outcome, target_type, target_id)
              VALUES (${A.id}, ${maison.id}, 'acquisitionPrice', NULL, '1165.83'::jsonb, 'RECONCILIATION', 'document', ${String(f.id)}, 'written', 'EQUIPMENT', ${ids.equipment})`;
    ids.card = (await sql<{ id: number }[]>`
      INSERT INTO to_process_actions (account_id, target_type, target_id, field_key, action_kind, rule_code, question, proposals_json, trigger_context)
      VALUES (${A.id}, 'EQUIPMENT', ${ids.equipment}, 'acquisitionPrice', 'ARBITRATE', 'ENTITY-FIELD', 'Quel est le prix d’achat du robot ?',
              ${JSON.stringify([{ value: 1165.83, label: '1 165,83 € HT', confidence: 1, evidenceIds: [String(0)] }, { value: 1399, label: '1 399,00 €', confidence: 1, isCurrentValue: true }])}::jsonb,
              ${JSON.stringify({ current: 1399 })}::jsonb)
      RETURNING id`)[0].id;
    await sql`UPDATE to_process_actions SET proposals_json = jsonb_set(proposals_json, '{0,evidenceIds}', ${JSON.stringify([String(ids.evidence)])}::jsonb) WHERE id = ${ids.card}`;

    // Opération d'achat + composante + échéance d'achat.
    ids.op = (await sql<{ id: number }[]>`
      INSERT INTO business_operations (account_id, type_code, status, technical_label, provider, realized_date)
      VALUES (${A.id}, 'ACQUISITION', 'REALIZED', 'Achat Roborock S8 Pro Ultra', 'Boulanger', '2024-04-22') RETURNING id`)[0].id;
    const src = (await sql<{ id: number }[]>`
      INSERT INTO business_operation_sources (account_id, operation_id, source_kind, source_entity_key, source_role, locator, authority, confidence, active)
      VALUES (${A.id}, ${ids.op}, 'DOCUMENT', ${String(f.id)}, 'INVOICE', ${JSON.stringify({ filename: 'secret.pdf', page: 1 })}::jsonb, 'DOCUMENT', 'certain', true) RETURNING id`)[0].id;
    ids.component = (await sql<{ id: number }[]>`
      INSERT INTO business_operation_financial_components (account_id, operation_id, kind, amount_minor, currency, active, target_equipment_id, economic_date)
      VALUES (${A.id}, ${ids.op}, 'REALIZED_COST', 139900, 'EUR', true, ${ids.equipment}, '2024-04-22') RETURNING id`)[0].id;
    await sql`INSERT INTO business_operation_financial_component_sources (component_id, operation_source_id, is_primary) VALUES (${ids.component}, ${src}, true)`;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority, active) VALUES (${A.id}, ${ids.op}, ${maison.id}, 'PRIMARY', 'DOCUMENT', true)`;
    await sql`INSERT INTO business_operation_equipment_links (account_id, operation_id, equipment_id, asset_id, authority, active) VALUES (${A.id}, ${ids.op}, ${ids.equipment}, ${maison.id}, 'DOCUMENT', true)`;
    ids.agenda = (await sql<{ id: number }[]>`
      INSERT INTO agenda_items (account_id, title, start_date, business_operation_id, projection_origin, event_nature)
      VALUES (${A.id}, 'Achat du robot aspirateur', '2024-04-22', ${ids.op}, 'OPERATION', 'HISTORICAL') RETURNING id`)[0].id;
    await sql`INSERT INTO agenda_equipment_links (agenda_item_id, equipment_id) VALUES (${ids.agenda}, ${ids.equipment})`;
    await sql`INSERT INTO agenda_file_links (agenda_item_id, asset_file_id) VALUES (${ids.agenda}, ${f.id})`;
    ids.deadline = (await sql<{ id: number }[]>`
      INSERT INTO deadlines (account_id, user_id, asset_id, equipment_id, label, deadline_date) VALUES (${A.id}, ${A.ownerUserId}, ${maison.id}, ${ids.equipment}, 'Fin de garantie (historique)', '2026-04-22') RETURNING id`)[0].id;

    // Compte B : un équipement que A ne doit jamais voir.
    const autre = await make.asset(B, { category: 'IMMOBILIER', name: 'Maison B' });
    ids.equipmentB = (await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${autre.id}, 'Équipement B secret') RETURNING id`)[0].id;
    ids.fileB = (await make.assetFile(B, { assetId: autre.id })).id;
    // Les identifiants BIGINT reviennent en texte : normalisation numérique.
    for (const k of Object.keys(ids)) ids[k] = Number(ids[k]);
  });

  /** Empreinte des tables métier du compte (aucune écriture attendue). */
  async function empreinte(accountId: number): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const tables: Array<[string, string]> = [
      ['assets', `account_id = ${accountId}`],
      ['equipments', `asset_id IN (SELECT id FROM assets WHERE account_id = ${accountId})`],
      ['substructures', `asset_id IN (SELECT id FROM assets WHERE account_id = ${accountId})`],
      ['asset_files', `account_id = ${accountId}`], ['document_extractions', `account_id = ${accountId}`], ['document_facts', `account_id = ${accountId}`],
      ['document_unresolved_facts', `account_id = ${accountId}`], ['document_source_units', `account_id = ${accountId}`], ['field_evidence', `account_id = ${accountId}`],
      ['canonical_field_writes', `account_id = ${accountId}`], ['to_process_actions', `account_id = ${accountId}`], ['to_process_decisions', `account_id = ${accountId}`],
      ['business_operations', `account_id = ${accountId}`], ['business_operation_sources', `account_id = ${accountId}`],
      ['business_operation_financial_components', `account_id = ${accountId}`], ['agenda_items', `account_id = ${accountId}`], ['deadlines', `account_id = ${accountId}`],
      ['ai_job_queue', `account_id = ${accountId}`], ['reconciliation_runs', `account_id = ${accountId}`],
    ];
    for (const [t, w] of tables) {
      const [r] = await sql.unsafe(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x WHERE ${w}`);
      out[t] = `${r.n}:${r.h}`;
    }
    return out;
  }
  let avant: Record<string, string>;
  it('(empreinte initiale)', async () => { avant = await empreinte(A.id); });

  it('L75N-E01 droits : non-admin refusé (403) sur liste, tiroir et export', async () => {
    const r = await routes();
    await seConnecter('USER');
    expect((await r.list(A.id, 'equipements')).status).toBe(403);
    expect((await r.entity(A.id, 'equipment', ids.equipment)).status).toBe(403);
    expect((await r.entity(A.id, 'equipment', ids.equipment, 'format=json')).status).toBe(403);
  });

  it('L75N-E02 six catégories : pagination serveur, recherche, filtres, compteurs réels, archivés et supprimés', async () => {
    const r = await routes();
    await seConnecter('ADMIN');
    const biens = await (await r.list(A.id, 'biens', 'pageSize=2&sort=id&dir=asc')).json();
    expect(biens.total).toBe(3);
    expect(biens.items).toHaveLength(2);
    expect(biens.totalPages).toBe(2);
    expect(biens.counters).toEqual([
      { value: 'all', label: 'Tous', count: 3 }, { value: 'active', label: 'En portefeuille', count: 1 },
      { value: 'archived', label: 'Archivés / sortis', count: 1 }, { value: 'deleted', label: 'Supprimés', count: 1 },
    ]);
    const supprimes = await (await r.list(A.id, 'biens', 'state=deleted')).json();
    expect(supprimes.items.map((i: { id: number }) => i.id)).toEqual([ids.assetDeleted]);

    const eq = await (await r.list(A.id, 'equipements', 'q=roborock')).json();
    expect(eq.items).toHaveLength(1);
    expect(eq.items[0]).toMatchObject({ type: 'equipment', id: ids.equipment, name: 'Robot aspirateur Roborock S8 Pro Ultra', parent: { type: 'asset', id: ids.asset } });
    expect((await (await r.list(A.id, 'equipements', `q=${ids.equipment}`)).json()).items[0].id).toBe(ids.equipment);
    expect((await (await r.list(A.id, 'equipements', 'state=archived')).json()).items.map((i: { id: number }) => i.id)).toEqual([ids.equipmentArchived]);
    // Jokers neutralisés : « % » ne matche pas tout.
    expect((await (await r.list(A.id, 'equipements', 'q=%25')).json()).total).toBe(0);

    expect((await (await r.list(A.id, 'pieces')).json()).items[0]).toMatchObject({ type: 'room', id: ids.room });
    const docs = await (await r.list(A.id, 'documents', 'q=acquisition')).json();
    expect(docs.items[0]).toMatchObject({ type: 'document', id: ids.file, name: 'Facture d’acquisition' });
    expect(JSON.stringify(docs)).not.toContain('facture-roborock-dupont');
    const ech = await (await r.list(A.id, 'echeances')).json();
    expect(ech.items.map((i: { id: number }) => i.id)).toEqual([ids.agenda]);
    expect(ech.counters).toEqual([{ value: 'agenda', label: 'Agenda (actif)', count: 1 }, { value: 'deadlines', label: 'Historique deadlines', count: 1 }]);
    expect((await (await r.list(A.id, 'echeances', 'state=deadlines')).json()).items[0]).toMatchObject({ type: 'deadline', id: ids.deadline });
    const ops = await (await r.list(A.id, 'operations', 'q=roborock')).json();
    expect(ops.items[0]).toMatchObject({ type: 'operation', id: ids.op });
    expect(ops.counters.find((c: { value: string }) => c.value === 'active').count).toBe(1);
    // Paramètres hors liste blanche : défaut, jamais d'erreur SQL.
    expect((await r.list(A.id, 'biens', 'sort=password;drop&dir=x&state=zzz')).status).toBe(200);
    expect((await r.list(A.id, 'users')).status).toBe(400);
    expect((await r.list(999_999_999, 'biens')).status).toBe(404);
  });

  it('L75N-E03 recette Roborock : tiroir équipement, valeurs canoniques, miroir, preuves, carte « À traiter », navigation', async () => {
    const r = await routes();
    await seConnecter('ADMIN');
    const res = await r.entity(A.id, 'equipment', ids.equipment);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.entity).toMatchObject({ type: 'equipment', id: ids.equipment, table: 'equipments', name: 'Robot aspirateur Roborock S8 Pro Ultra', status: 'EN_SERVICE' });
    expect(d.complete).toBe(true);
    const sec = (id: string) => d.sections.find((s: { id: string }) => s.id === id);

    // Valeur canonique = lecteur canonique (mêmes octets).
    const { getCanonicalEntityState } = await import('@/services/canonical/entity-state');
    const canon = await getCanonicalEntityState({ type: 'EQUIPMENT', id: ids.equipment }, A.id);
    const prixCanon = sec('canonique').fields.find((f: { label: string }) => f.label.includes('(acquisitionPrice)'));
    expect(prixCanon).toMatchObject({ state: 'value', raw: canon!.fields.acquisitionPrice.value, display: '1 165,83 €', unit: 'EUR', origin: 'RECONCILIATION', originLabel: 'T3 (réconciliation)' });
    expect(prixCanon.raw).toBe(1165.83);
    // Miroir (colonne) comparé.
    const miroir = sec('miroirs').fields.find((f: { column: string }) => f.column === 'purchase_price_cents');
    expect(miroir).toMatchObject({ table: 'equipments', state: 'value', raw: 116583, display: '1 165,83 €' });
    expect(miroir.note).toMatch(/^identiques/);
    // Comparaison du prix : canonique, miroir, preuve, fait T1, carte « À traiter ».
    const prix = sec('prix-achat').fields;
    expect(prix.map((f: { table: string }) => f.table)).toEqual(['equipments', 'equipments', 'field_evidence', 'document_facts', 'to_process_actions']);
    expect(prix[2]).toMatchObject({ raw: 1165.83, origin: 'TEXT_EXTRACTION' });
    expect(prix[3]).toMatchObject({ raw: 1165.83, unit: 'EUR', originLabel: 'T1 (extraction documentaire)' });
    expect(prix[4].raw[0]).toMatchObject({ value: 1165.83, evidenceIds: [String(ids.evidence)] });
    expect(prix[4].note).toContain('OUVERTE');
    // Données BDD : colonnes, fiche JSON clé par clé.
    expect(sec('bdd-kc').fields.map((f: { path: string }) => f.path)).toEqual(['acquisitionPrice', 'acquisitionPrice__origin', 'acquisitionPrice__updatedAt']);
    expect(sec('bdd-equipments').fields.find((f: { column: string }) => f.column === 'estimated_value_cents')).toMatchObject({ state: 'null', raw: null });
    // Données de l'équipement ≠ données du bien parent.
    expect(sec('bdd-equipments').fields.find((f: { column: string }) => f.column === 'name').raw).toBe('Robot aspirateur Roborock S8 Pro Ultra');
    expect(JSON.stringify(sec('canonique'))).not.toContain('12 rue des Lilas');
    // Preuves : 651 lignes — lot 81C : consultation PAGINÉE (première page, total réel), navigation jusqu'à la dernière ligne.
    expect(sec('field-evidence').table).toMatchObject({ total: 651, complete: true });
    expect(sec('field-evidence').window).toMatchObject({ total: 651, offset: 0, size: 50 });
    expect(sec('field-evidence').table.rows).toHaveLength(50);
    const derniere = await (await r.entity(A.id, 'equipment', ids.equipment, 'section=field-evidence&offset=650')).json();
    expect(derniere.section.window).toMatchObject({ total: 651, offset: 650 });
    expect(derniere.section.table.rows).toHaveLength(1);
    expect(sec('to-process').table.rows[0].id).toBe(ids.card);
    expect(sec('canonical-writes').table.rows[0]).toMatchObject({ origin: 'RECONCILIATION', target_type: 'EQUIPMENT' });

    // Relations : Facture d'acquisition, Opération d'achat, Échéance, pièce, bien parent.
    const rel = d.sections.filter((s: { tab: string }) => s.tab === 'relations').flatMap((s: { relations: unknown[] }) => s.relations);
    const has = (type: string, id: number) => rel.some((x: { type: string; id: number }) => x.type === type && x.id === id);
    expect(has('asset', ids.asset) && has('room', ids.room) && has('document', ids.file) && has('operation', ids.op) && has('agenda', ids.agenda) && has('deadline', ids.deadline)).toBe(true);

    // Navigation : Équipement → Facture → Opération → Échéance (même route, même tiroir).
    const doc = await (await r.entity(A.id, 'document', ids.file)).json();
    expect(doc.entity).toMatchObject({ type: 'document', id: ids.file, name: 'Facture d’acquisition' });
    const dsec = (id: string) => doc.sections.find((s: { id: string }) => s.id === id);
    expect(dsec('identite').fields.find((f: { column: string }) => f.column === 'amount_cents')).toMatchObject({ raw: 139900, display: '1 399,00 €', unit: 'centimes EUR' });
    expect(dsec('identite').fields.find((f: { column: string }) => f.column === 'document_date')).toMatchObject({ raw: '2024-04-22', display: '22/04/2024' });
    expect(dsec('extractions').table.rows[0]).toMatchObject({ amount_cents: 139900, currency: 'EUR', full_text: { $etat: 'masque', motif: 'contenu intégral du document' } });
    expect(dsec('facts').table.rows.map((x: { id: number }) => Number(x.id)).sort()).toEqual([ids.factHt, ids.factTtc].sort());
    expect(dsec('source-units').table.rows).toHaveLength(2);
    expect(dsec('unresolved').table.rows).toHaveLength(1);
    const docRel = doc.sections.filter((s: { tab: string }) => s.tab === 'relations').flatMap((s: { relations: unknown[] }) => s.relations);
    expect(docRel.some((x: { type: string; id: number }) => x.type === 'operation' && x.id === ids.op)).toBe(true);
    expect(docRel.some((x: { type: string; id: number }) => x.type === 'equipment' && x.id === ids.equipment)).toBe(true);

    const op = await (await r.entity(A.id, 'operation', ids.op)).json();
    expect(op.operationDetail.operation.id).toBe(ids.op);
    const comp = op.sections.find((s: { id: string }) => s.id === 'components').table.rows[0];
    // Valeurs telles que rendues par OperationDiagnosticsService (BIGINT en texte : valeur brute exacte).
    expect(comp).toMatchObject({ kind: 'REALIZED_COST', currency: 'EUR' });
    expect(Number(comp.amount_minor)).toBe(139900);
    expect(Number(comp.target_equipment_id)).toBe(ids.equipment);
    const opRel = op.sections.find((s: { id: string }) => s.id === 'rel-operation').relations;
    expect(opRel.some((x: { type: string; id: number }) => x.type === 'agenda' && x.id === ids.agenda)).toBe(true);
    expect(opRel.some((x: { type: string; id: number }) => x.type === 'document' && x.id === ids.file)).toBe(true);
    expect(JSON.stringify(op)).not.toContain('secret.pdf');

    const ag = await (await r.entity(A.id, 'agenda', ids.agenda)).json();
    const agRel = ag.sections.find((s: { id: string }) => s.id === 'rel-cibles').relations;
    expect(agRel.map((x: { type: string }) => x.type).sort()).toEqual(['document', 'equipment', 'operation']);
    const piece = await (await r.entity(A.id, 'room', ids.room)).json();
    expect(piece.sections.find((s: { id: string }) => s.id === 'rel-equipements').relations[0].id).toBe(ids.equipment);
    const bien = await (await r.entity(A.id, 'asset', ids.asset)).json();
    expect(bien.sections.find((s: { id: string }) => s.id === 'tco')).toBeDefined();
    const hist = await r.entity(A.id, 'deadline', ids.deadline);
    expect(hist.status).toBe(200);
    // Toutes les sections des six types se lisent sans erreur (aucune section « non chargée »).
    for (const x of [d, doc, op, ag, piece, bien, await hist.json()]) {
      expect({ type: x.entity.type, warnings: x.warnings, errors: x.sections.filter((s: { error?: string }) => s.error).map((s: { id: string }) => s.id) })
        .toEqual({ type: x.entity.type, warnings: [], errors: [] });
    }
    // Bien supprimé logiquement : encore consultable.
    const sup = await (await r.entity(A.id, 'asset', ids.assetDeleted)).json();
    expect(sup.entity.statusLabel).toContain('supprimé logiquement');
  });

  it('L75N-E04 exports JSON / CSV / TXT : complets, nommés, horodatés, journalisés ; borne → incomplet signalé', async () => {
    const r = await routes();
    const admin = await seConnecter('ADMIN');
    const day = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date());

    const json = await r.entity(A.id, 'equipment', ids.equipment, 'format=json');
    expect(json.status).toBe(200);
    expect(json.headers.get('Content-Disposition')).toBe(`attachment; filename="verebona-compte-${A.id}-equipement-${ids.equipment}-${day}.json"`);
    expect(json.headers.get('Content-Type')).toContain('application/json');
    expect(json.headers.get('X-Verebona-Export-Id')).toMatch(/^[0-9a-f-]{36}$/);
    const exported = JSON.parse(await json.text());
    const tiroir = await (await r.entity(A.id, 'equipment', ids.equipment)).json();
    // Lot 81C : mêmes sections et mêmes champs que le tiroir ; les tables sont INTÉGRALES (le tiroir : une page).
    expect(exported.sections.map((s: { id: string }) => s.id)).toEqual(tiroir.sections.map((s: { id: string }) => s.id));
    expect(exported.sections.find((s: { id: string }) => s.id === 'prix-achat').fields).toEqual(tiroir.sections.find((s: { id: string }) => s.id === 'prix-achat').fields);
    expect(exported.sections.find((s: { id: string }) => s.id === 'field-evidence').table.rows).toHaveLength(651);
    expect(exported.sections.find((s: { id: string }) => s.id === 'field-evidence').table.rows.slice(0, 50)).toEqual(tiroir.sections.find((s: { id: string }) => s.id === 'field-evidence').table.rows);
    expect(exported).toMatchObject({ complete: true, exportStatus: 'COMPLETE', export: { status: 'COMPLETE', format: 'json' } });

    const csv = await r.entity(A.id, 'equipment', ids.equipment, 'format=csv');
    const csvBytes = new Uint8Array(await csv.arrayBuffer());
    expect([...csvBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);   // BOM UTF-8 (Excel)
    const csvText = new TextDecoder('utf-8').decode(csvBytes);
    expect(csv.headers.get('Content-Disposition')).toContain(`-equipement-${ids.equipment}-${day}.csv"`);
    expect(csvText).toContain('Prix d’achat — colonne miroir');
    expect(csvText.split('\r\n').filter((l) => l.includes(';field_evidence;')).length).toBeGreaterThan(651);
    const csvSection = await r.entity(A.id, 'equipment', ids.equipment, 'format=csv&section=field-evidence');
    const lignes = (await csvSection.text()).split('\r\n').filter(Boolean);
    expect(lignes).toHaveLength(652);
    expect(csvSection.headers.get('Content-Disposition')).toContain(`-${day}-field-evidence.csv"`);
    expect((await r.entity(A.id, 'equipment', ids.equipment, 'format=csv&section=inconnue')).status).toBe(400);

    const txt = await r.entity(A.id, 'equipment', ids.equipment, 'format=txt');
    const t = await txt.text();
    expect(t).toContain(`Équipement #${ids.equipment} — Robot aspirateur Roborock S8 Pro Ultra`);
    expect(t).toContain('brut=116583 | affiché=1 165,83 € | unité=centimes EUR');
    expect(t).toContain('######## Preuves et historique ########');
    expect((await r.entity(A.id, 'equipment', ids.equipment, 'format=xml')).status).toBe(400);

    const audit = await sql`SELECT action_type, target_type, target_id, result, details FROM admin_audit_log
                             WHERE admin_user_id = ${admin.id} ORDER BY id`;
    expect(audit.map((a) => a.action_type)).toEqual(['ACCOUNT_DATA_EXPORT', 'ACCOUNT_DATA_READ', 'ACCOUNT_DATA_EXPORT', 'ACCOUNT_DATA_EXPORT', 'ACCOUNT_DATA_EXPORT']);
    expect(audit[0]).toMatchObject({ target_type: 'ACCOUNT', target_id: A.id, result: 'SUCCESS' });
    expect(JSON.parse(audit[0].details as string)).toMatchObject({ entityType: 'equipment', entityId: ids.equipment, format: 'json', complete: true, fileName: `verebona-compte-${A.id}-equipement-${ids.equipment}-${day}.json` });

    // Lot 81C (adapté) : plus de borne de section — l'export TXT donne le statut en FIN de fichier.
    expect(t.trimEnd().split('\n').pop()).toMatch(/^Statut de l’export : COMPLETE — \d+ élément\(s\) exporté\(s\) sur \d+ attendu\(s\)/);
    const { buildEntityDossier } = await import('@/services/admin/account-data/dossier');
    // Section en erreur (simulée) : point de reprise, sections suivantes lues, avertissement explicite.
    const { readOnlyDossierExecutor } = await import('@/services/admin/account-data/dossier');
    let n = 0;
    const panne = readOnlyDossierExecutor((q) => async (text, params) => {
      if (/count\(\*\)::bigint AS n FROM \(SELECT \* FROM field_evidence WHERE/.test(text) && n++ === 0) return q('SELECT 1/0 AS x', []);
      return q(text, params);
    });
    const partiel = await buildEntityDossier(A.id, 'equipment', ids.equipment, { exec: panne });
    expect(partiel.complete).toBe(false);
    expect(partiel.sections.find((s) => s.id === 'field-evidence')!.error).toContain('22012');
    expect(partiel.sections.find((s) => s.id === 'to-process')!.table!.rows).toHaveLength(1);
    expect(partiel.warnings.join(' ')).toContain('non chargée');
  });

  it('L75N-E05 sécurité : intercomptes 404 journalisé, masquage, aucune URL de fichier original', async () => {
    const r = await routes();
    const admin = await seConnecter('ADMIN');
    for (const [type, id] of [['equipment', ids.equipmentB], ['document', ids.fileB], ['asset', ids.asset]] as const) {
      const acc = type === 'asset' ? B.id : A.id;   // bien de A demandé via B, équipement / document de B via A
      const res = await r.entity(acc, type, id);
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain('secret');
    }
    expect((await r.entity(A.id, 'equipment', ids.equipmentB, 'format=json')).status).toBe(404);
    const refus = await sql`SELECT result, details FROM admin_audit_log WHERE admin_user_id = ${admin.id} AND result = 'DENIED'`;
    expect(refus).toHaveLength(4);
    expect(JSON.parse(refus[0].details as string)).toMatchObject({ code: 'NOT_FOUND_IN_ACCOUNT', entityType: 'equipment', entityId: ids.equipmentB });
    expect((await r.entity(A.id, 'users', 1)).status).toBe(400);
    expect((await r.entity(A.id, 'equipment', 0)).status).toBe(400);

    const doc = await (await r.entity(A.id, 'document', ids.file, 'format=json')).text();
    const bien = await (await r.entity(A.id, 'asset', ids.asset, 'format=json')).text();
    for (const out of [doc, bien]) {
      expect(out).not.toContain('facture-roborock-dupont');
      expect(out).not.toContain('Facture Dupont IBAN');
      expect(out).not.toContain(`e2e/${A.id}/`);       // clé de stockage
      expect(out).not.toContain('TEXTE INTÉGRAL CONFIDENTIEL');
      expect(out).not.toContain('0112 3456 7890');      // IBAN
      expect(out).not.toMatch(/https?:\/\//);
    }
    const docJson = JSON.parse(doc);
    const bdd = docJson.sections.find((x: { id: string }) => x.id === 'bdd-asset-files').fields;
    const champ = (c: string) => bdd.find((f: { column: string }) => f.column === c);
    expect(champ('filename')).toMatchObject({ state: 'masked', note: 'nom du fichier original' });
    expect(champ('original_filename')).toMatchObject({ state: 'masked' });
    expect(champ('s3_key')).toMatchObject({ state: 'masked', note: 'clé de stockage' });
    expect(champ('extracted_text').note).toMatch(/^contenu intégral du document \(\d+ caractères\)$/);
    expect(champ('web_link_url')).toMatchObject({ state: 'null' });   // NULL en base : jamais confondu avec « masqué »
    expect('raw' in champ('filename')).toBe(false);
    expect(bien).not.toContain('12 rue des Lilas');      // donnée sensible du registre (address1)
    expect(bien).toContain('donnée sensible (registre)');
  });

  it('L75N-E06 aucune écriture : tables métier du compte identiques après consultations et exports', async () => {
    expect(await empreinte(A.id)).toEqual(avant);
  });
});
