/**
 * Lot 113E (#700) — BO › Compte › « Données du compte » › septième onglet
 * « Fournisseurs (N) » — base PostgreSQL réelle, PAR LES VRAIES ROUTES (garde
 * `requireAdmin` réelle : seule la lecture du cookie de session est simulée).
 *
 *   · L113E-E01 droits : non-admin 403 (liste, tiroir, export) ;
 *   · L113E-E02 compteur = BDD (actifs + archivés, supprimés hors total),
 *     pagination serveur EXHAUSTIVE (133 fournisseurs listés, pages de 50 : aucun
 *     doublon, aucun manquant, ordre stable), tris, filtres archivés /
 *     supprimés, compte vide « Fournisseurs (0) » ;
 *   · L113E-E03 recherche : nom, nom normalisé, SIRET saisi avec espaces,
 *     identifiant, identifiant public ; jamais un fournisseur d'un autre compte ;
 *   · L113E-E04 tiroir : données réellement enregistrées, IBAN et titulaire
 *     masqués (fiche, observations, revue de conflit bancaire, export JSON),
 *     relations PERSISTÉES séparées DIRECT / VIA Opération (documents, biens,
 *     équipements, échéances), Opérations tous états ; une Opération invalidée
 *     ou un lien retiré ne produit aucune relation « via » ; un document au nom
 *     identique mais non lié n'apparaît jamais ;
 *   · L113E-E05 isolation : autre compte et compte Duo lié → 404 (DENIED
 *     journalisé), listes disjointes ;
 *   · L113E-E06 non-régression : les six onglets d'origine répondent ;
 *   · L113E-E07 lecture seule : empreintes des tables métier (référentiel
 *     fournisseurs, relations, revues, « À traiter », files IA) identiques ;
 *     seule écriture : le journal d'administration (ACCOUNT_DATA_READ / EXPORT).
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

scenario('L113E', 'BO Données du compte : onglet Fournisseurs (lecture seule, pagination, relations, isolation)', ({ sql, make }) => {
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

  const IBAN = 'FR7630006000011234567890189';
  const ids: Record<string, number> = {};
  let A: AccountRow;
  let B: AccountRow;
  let VIDE: AccountRow;
  let D2: AccountRow;
  let publicId = '';

  async function fournisseur(acc: AccountRow, userId: number, nom: string, extra: Record<string, unknown> = {}): Promise<number> {
    const cols = { account_id: acc.id, created_by_user_id: userId, name: nom, normalized_name: nom.toLowerCase(), ...extra };
    const [r] = await sql<{ id: number }[]>`INSERT INTO suppliers ${sql(cols)} RETURNING id`;
    return Number(r.id);
  }

  beforeAll(async () => {
    A = await make.account({ plan: 'premium', name: 'Compte fournisseurs E2E' });
    B = await make.account({ plan: 'premium', name: 'Autre compte E2E' });
    VIDE = await make.account({ plan: 'premium', name: 'Compte sans fournisseur' });
    // Duo : deux espaces liés par duo_accounts — chacun garde ses fournisseurs.
    const titulaire = await make.user();
    const membre = await make.user();
    const D1 = await make.account({ owner: titulaire, plan: 'premium_duo', name: 'Duo titulaire' });
    D2 = await make.account({ owner: membre, plan: 'premium_duo', name: 'Duo membre' });
    const [duo] = await sql<{ id: number }[]>`INSERT INTO duo_accounts (billing_owner_user_id) VALUES (${titulaire.id}) RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duo.id} WHERE id IN (${D1.id}, ${D2.id})`;
    ids.duo1 = await fournisseur(D1, titulaire.id, 'Électricien du titulaire');
    ids.duo2 = await fournisseur(D2, membre.id, 'Couvreur du membre Duo', { scope: 'shared' });

    const owner = A.ownerUserId;
    // Volume : 130 fournisseurs actifs (+ Plomberie Martin = 131 actifs, > 2 pages de 50), 2 archivés, 1 supprimé : total 133.
    await sql`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, created_at)
              SELECT ${A.id}, ${owner}, 'Volume ' || lpad(g::text, 3, '0'), 'volume ' || lpad(g::text, 3, '0'), now() - (g || ' minutes')::interval
                FROM generate_series(1, 130) g`;
    ids.archived1 = await fournisseur(A, owner, 'Ancien chauffagiste', { status: 'archived' });
    ids.archived2 = await fournisseur(A, owner, 'Ancien jardinier', { status: 'archived' });
    ids.deleted = await fournisseur(A, owner, 'Fournisseur supprimé', { status: 'deleted' });
    ids.s = await fournisseur(A, owner, 'Plomberie Martin', {
      email: 'contact@plomberie-martin.fr', phone: '01 02 03 04 05', website: 'https://plomberie-martin.fr', address_line_1: '3 rue du Port', postal_code: '75011',
      city: 'Paris', siren: '123456789', siret: '12345678900011', vat_number: 'FR12123456789', iban: IBAN, iban_holder_name: 'SARL Plomberie Martin', source: 'document',
      normalized_name: 'plomberie martin', field_provenance: JSON.stringify({ email: { documentId: 1, origin: 'T1_ANALYSIS' }, iban: { documentId: 1, value: IBAN } }),
      user_field_decisions: JSON.stringify({ phone: { action: 'SET', at: '2026-10-01T10:00:00.000Z', userId: owner } }),
    });
    publicId = String((await sql<{ p: string }[]>`SELECT public_id::text AS p FROM suppliers WHERE id = ${ids.s}`)[0].p);
    // Autre compte : même nom, même SIRET — jamais visible depuis A.
    ids.b = await fournisseur(B, B.ownerUserId, 'Plomberie Martin', { siret: '12345678900011', iban: 'FR7611112222333344445555666' });

    // Relations PERSISTÉES du fournisseur S.
    const maison = await make.asset(A, { category: 'IMMOBILIER', name: 'Maison principale' });
    const garage = await make.asset(A, { category: 'IMMOBILIER', name: 'Garage' });
    const studio = await make.asset(A, { category: 'IMMOBILIER', name: 'Studio' });
    ids.maison = maison.id; ids.garage = garage.id; ids.studio = studio.id;
    ids.chaudiere = Number((await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${maison.id}, 'Chaudière') RETURNING id`)[0].id);
    ids.ballon = Number((await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${garage.id}, 'Ballon d’eau chaude') RETURNING id`)[0].id);
    ids.factureDirecte = (await make.assetFile(A, { assetId: maison.id })).id;
    await sql`UPDATE asset_files SET retained_title = 'Facture plomberie directe' WHERE id = ${ids.factureDirecte}`;
    ids.devisOp = (await make.assetFile(A, { assetId: garage.id })).id;
    await sql`UPDATE asset_files SET retained_title = 'Devis de l’intervention' WHERE id = ${ids.devisOp}`;
    // Document au texte « Plomberie Martin » SANS lien persisté : jamais une relation.
    ids.homonyme = (await make.assetFile(A, { assetId: maison.id })).id;
    await sql`UPDATE asset_files SET retained_title = 'Courrier Plomberie Martin', supplier = 'Plomberie Martin' WHERE id = ${ids.homonyme}`;
    ids.docInvalide = (await make.assetFile(A, { assetId: maison.id })).id;

    await sql`INSERT INTO document_suppliers (document_id, supplier_id, role, is_confirmed) VALUES (${ids.factureDirecte}, ${ids.s}, 'ISSUER', true)`;
    await sql`INSERT INTO equipment_suppliers (equipment_id, supplier_id, relationship_type, source_type, is_primary) VALUES (${ids.chaudiere}, ${ids.s}, 'INSTALLER', 'manual', true)`;
    await sql`INSERT INTO asset_suppliers (asset_id, supplier_id, source_type) VALUES (${studio.id}, ${ids.s}, 'manual')`;

    const op = async (label: string, extra = '') => Number((await sql.unsafe(
      `INSERT INTO business_operations (account_id, type_code, status, technical_label${extra ? ', invalidated_at, invalidation_reason' : ''})
       VALUES ($1, 'INTERVENTION', 'REALIZED', $2${extra ? ", now(), 'E2E_INVALIDATED'" : ''}) RETURNING id`, [A.id, label]))[0].id);
    ids.op = await op('Intervention plomberie');
    ids.opInvalide = await op('Intervention annulée', 'invalide');
    ids.opRetire = await op('Intervention sans le fournisseur');
    await sql`INSERT INTO business_operation_suppliers (account_id, operation_id, supplier_id, role, origin, status)
              VALUES (${A.id}, ${ids.op}, ${ids.s}, 'PROVIDER', 'T3', 'ACTIVE'),
                     (${A.id}, ${ids.opInvalide}, ${ids.s}, 'PROVIDER', 'T3', 'ACTIVE'),
                     (${A.id}, ${ids.opRetire}, ${ids.s}, 'INTERVENER', 'T3', 'REMOVED')`;
    for (const o of [ids.op, ids.opInvalide, ids.opRetire]) {
      const f = o === ids.op ? ids.devisOp : ids.docInvalide;
      await sql`INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins) VALUES (${A.id}, ${o}, ${f}, ARRAY['SOURCE']) ON CONFLICT DO NOTHING`;
    }
    await sql`INSERT INTO business_operation_equipment_links (account_id, operation_id, equipment_id, asset_id, authority, active) VALUES (${A.id}, ${ids.op}, ${ids.ballon}, ${garage.id}, 'DOCUMENT', true)`;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority, active) VALUES (${A.id}, ${ids.op}, ${garage.id}, 'PRIMARY', 'DOCUMENT', true)`;
    await sql`INSERT INTO business_operation_asset_links (account_id, operation_id, asset_id, link_role, authority, active) VALUES (${A.id}, ${ids.opInvalide}, ${maison.id}, 'PRIMARY', 'DOCUMENT', true)`;

    ids.rdvDirect = (await make.agendaItem(A, { title: 'Entretien chaudière', assetIds: [maison.id] })).id;
    await sql`INSERT INTO agenda_item_suppliers (account_id, agenda_item_id, supplier_id, provenance) VALUES (${A.id}, ${ids.rdvDirect}, ${ids.s}, 'USER')`;
    ids.rdvOp = (await make.agendaItem(A, { title: 'Intervention garage', assetIds: [garage.id] })).id;
    await sql`UPDATE agenda_items SET business_operation_id = ${ids.op} WHERE id = ${ids.rdvOp}`;

    // Preuves : observation avec IBAN relevé, revue de conflit bancaire, revue de conflit e-mail.
    await sql`INSERT INTO supplier_contact_observations (supplier_id, document_id, observed_name, observed_iban, observed_iban_holder_name, observed_email, origin, evidence)
              VALUES (${ids.s}, ${ids.factureDirecte}, 'Plomberie Martin', ${IBAN.toLowerCase()}, 'SARL Plomberie Martin', 'contact@plomberie-martin.fr', 'T1_ANALYSIS',
                      ${JSON.stringify({ iban: { excerpt: `IBAN ${IBAN}` }, email: { excerpt: 'contact@plomberie-martin.fr' } })}::jsonb)`;
    await sql`INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id, document_id, conflicting_field, current_value, detected_value)
              VALUES (${A.id}, 'contact_conflict', 'open', ${ids.s}, ${ids.factureDirecte}, 'iban', ${IBAN}, ${'fr7611112222333344445555666'}),
                     (${A.id}, 'contact_conflict', 'open', ${ids.s}, ${ids.factureDirecte}, 'email', 'contact@plomberie-martin.fr', 'devis@plomberie-martin.fr')`;
    for (const k of Object.keys(ids)) ids[k] = Number(ids[k]);
  });

  /** Empreinte des tables métier (aucune écriture attendue). */
  async function empreinte(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const tables = ['suppliers', 'document_suppliers', 'equipment_suppliers', 'asset_suppliers', 'supplier_contact_observations', 'supplier_review_items',
      'business_operation_suppliers', 'business_operation_supplier_history', 'agenda_item_suppliers', 'agenda_item_supplier_history', 'agenda_item_supplier_suppressions',
      'business_operations', 'business_operation_documents', 'asset_files', 'assets', 'equipments', 'agenda_items', 'to_process_actions', 'to_process_decisions',
      'ai_job_queue', 'field_evidence', 'canonical_field_writes'];
    for (const t of tables) {
      const [r] = await sql.unsafe(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x`);
      out[t] = `${r.n}:${r.h}`;
    }
    return out;
  }
  let avant: Record<string, string>;
  let auditAvant = 0;
  it('(empreinte initiale)', async () => {
    avant = await empreinte();
    auditAvant = Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_audit_log`)[0].n);
  });

  it('L113E-E01 droits : non-admin refusé (403) sur la liste, le tiroir et l’export', async () => {
    const r = await routes();
    await seConnecter('USER');
    expect((await r.list(A.id, 'fournisseurs')).status).toBe(403);
    expect((await r.entity(A.id, 'supplier', ids.s)).status).toBe(403);
    expect((await r.entity(A.id, 'supplier', ids.s, 'format=json')).status).toBe(403);
  });

  it('L113E-E02 compteur = BDD, pagination exhaustive sans doublon, filtres archivés / supprimés, compte vide', async () => {
    const r = await routes();
    await seConnecter('ADMIN');
    const [{ n: attendu }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM suppliers WHERE account_id = ${A.id} AND status <> 'deleted'`;
    expect(attendu).toBe(133);
    const p1 = await (await r.list(A.id, 'fournisseurs', 'pageSize=50&sort=name&dir=asc')).json();
    expect(p1.counters).toEqual([
      { value: 'all', label: 'Tous (actifs et archivés)', count: 133 }, { value: 'active', label: 'Actifs', count: 131 },
      { value: 'archived', label: 'Archivés', count: 2 }, { value: 'deleted', label: 'Supprimés (hors total)', count: 1 },
    ]);
    expect(p1.total).toBe(133);
    expect(p1.totalPages).toBe(3);
    const vus: number[] = [];
    const noms: string[] = [];
    for (let page = 1; page <= p1.totalPages; page++) {
      const body = await (await r.list(A.id, 'fournisseurs', `pageSize=50&sort=name&dir=asc&page=${page}`)).json();
      vus.push(...body.items.map((i: { id: number }) => i.id));
      noms.push(...body.items.map((i: { name: string }) => i.name));
    }
    expect(vus).toHaveLength(133);
    expect(new Set(vus).size).toBe(133);
    const enBase = (await sql<{ id: number }[]>`SELECT id FROM suppliers WHERE account_id = ${A.id} AND status <> 'deleted' ORDER BY lower(name), id`).map((x) => Number(x.id));
    expect(vus).toEqual(enBase);
    expect(noms).not.toContain('Fournisseur supprimé');
    const parId = await (await r.list(A.id, 'fournisseurs', 'pageSize=100&sort=id&dir=desc')).json();
    expect(parId.items[0].id).toBe(Math.max(...enBase));

    const archives = await (await r.list(A.id, 'fournisseurs', 'state=archived&sort=name&dir=asc')).json();
    expect(archives.items.map((i: { id: number; state: string }) => [i.id, i.state])).toEqual([[ids.archived1, 'archived'], [ids.archived2, 'archived']]);
    const supprimes = await (await r.list(A.id, 'fournisseurs', 'state=deleted')).json();
    expect(supprimes.items.map((i: { id: number }) => i.id)).toEqual([ids.deleted]);

    const vide = await (await r.list(VIDE.id, 'fournisseurs')).json();
    expect(vide.total).toBe(0);
    expect(vide.items).toEqual([]);
    expect(vide.counters[0]).toEqual({ value: 'all', label: 'Tous (actifs et archivés)', count: 0 });

    const ligne = (await (await r.list(A.id, 'fournisseurs', `q=${ids.s}`)).json()).items[0];
    expect(ligne).toMatchObject({ type: 'supplier', id: ids.s, name: 'Plomberie Martin', kind: 'SIRET 12345678900011 · TVA FR12123456789', state: 'active' });
    expect(ligne.details).toEqual(expect.arrayContaining([
      { label: 'E-mail', value: 'contact@plomberie-martin.fr' }, { label: 'Ville', value: '75011 Paris' },
      { label: 'Liens', value: '1 document(s) direct(s) · 2 Opération(s) active(s)' },
    ]));
    expect(JSON.stringify(p1) + JSON.stringify(ligne)).not.toMatch(/iban|30006000011234567890189|SARL Plomberie Martin/i);
  });

  it('L113E-E03 recherche : nom, SIRET avec espaces, identifiant, identifiant public — jamais un autre compte', async () => {
    const r = await routes();
    await seConnecter('ADMIN');
    const ids_ = async (q: string) => (await (await r.list(A.id, 'fournisseurs', `q=${encodeURIComponent(q)}`)).json()).items.map((i: { id: number }) => i.id);
    expect(await ids_('plomberie')).toEqual([ids.s]);
    expect(await ids_('123 456 789 00011')).toEqual([ids.s]);
    expect(await ids_(String(ids.s))).toEqual([ids.s]);
    expect(await ids_(publicId)).toEqual([ids.s]);
    expect(await ids_('Volume 012')).toHaveLength(1);
    expect(await ids_('Volume 12')).toHaveLength(10);
    expect(await ids_(String(ids.b))).toEqual([]);
    const vol = await (await r.list(A.id, 'fournisseurs', 'q=Volume&pageSize=100')).json();
    expect(vol.total).toBe(130);
    expect(vol.totalPages).toBe(2);
  });

  it('L113E-E04 tiroir : données enregistrées, banque masquée, relations DIRECT / VIA Opération séparées', async () => {
    const r = await routes();
    await seConnecter('ADMIN');
    const res = await r.entity(A.id, 'supplier', ids.s);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.entity).toMatchObject({ type: 'supplier', id: ids.s, table: 'suppliers', name: 'Plomberie Martin', status: 'active' });
    expect(d.complete).toBe(true);
    const texte = JSON.stringify(d);
    expect(texte).not.toMatch(/30006000011234567890189|11112222333344445555666|SARL Plomberie Martin/i);
    const sec = (id: string) => d.sections.find((s: { id: string }) => s.id === id);
    const champ = (id: string, col: string) => sec(id).fields.find((f: { column: string }) => f.column === col);
    expect(champ('identite', 'siret').raw).toBe('12345678900011');
    expect(champ('identite', 'email').raw).toBe('contact@plomberie-martin.fr');
    expect(champ('identite', 'iban').state).toBe('masked');
    expect(champ('identite', 'iban_holder_name').state).toBe('masked');
    const prov = sec('provenance').fields;
    expect(prov.find((f: { path?: string; column: string }) => f.column === 'field_provenance' && f.path === 'iban').state).toBe('masked');
    expect(prov.find((f: { path?: string; column: string }) => f.column === 'user_field_decisions' && f.path === 'phone').state).toBe('value');

    const rel = (id: string) => (sec(id).relations as Array<{ type: string; id: number; nature: string; via: string }>);
    expect(rel('rel-documents-direct').map((x) => x.id)).toEqual([ids.factureDirecte]);
    expect(rel('rel-documents-via').map((x) => x.id)).toEqual([ids.devisOp]);
    expect(rel('rel-documents-via')[0].nature).toContain(`via Opération #${ids.op}`);
    const tousDocs = [...rel('rel-documents-direct'), ...rel('rel-documents-via')].map((x) => x.id);
    expect(tousDocs).not.toContain(ids.homonyme);
    expect(tousDocs).not.toContain(ids.docInvalide);
    expect(rel('rel-equipements-direct').map((x) => x.id)).toEqual([ids.chaudiere]);
    expect(rel('rel-equipements-via').map((x) => x.id)).toEqual([ids.ballon]);
    expect(rel('rel-biens-direct').map((x) => [x.id, x.via]).sort()).toEqual([
      [ids.maison, 'document_suppliers → asset_files.asset_id'], [ids.maison, 'equipment_suppliers → equipments.asset_id'], [ids.studio, 'asset_suppliers'],
    ].sort());
    expect(rel('rel-biens-via').map((x) => x.id)).toEqual([ids.garage]);
    expect(rel('rel-echeances-direct').map((x) => x.id)).toEqual([ids.rdvDirect]);
    expect(rel('rel-echeances-via').map((x) => x.id)).toEqual([ids.rdvOp]);
    const ops = rel('rel-operations');
    expect(ops.map((x) => x.id).sort((a, b) => a - b)).toEqual([ids.op, ids.opInvalide, ids.opRetire].sort((a, b) => a - b));
    expect(ops.find((x) => x.id === ids.opRetire)!.nature).toContain('REMOVED');
    expect(JSON.stringify(ops.find((x) => x.id === ids.opInvalide))).toContain('invalidée');

    const obs = sec('observations').table;
    expect(obs.total).toBe(1);
    expect(obs.rows[0].observed_iban).toMatchObject({ $etat: 'masque' });
    expect(obs.rows[0].observed_iban_holder_name).toMatchObject({ $etat: 'masque' });
    const revues = sec('reviews').table.rows as Array<Record<string, unknown>>;
    expect(revues).toHaveLength(2);
    expect(revues.find((x) => x.conflicting_field === 'iban')!.current_value).toMatchObject({ $etat: 'masque' });
    expect(revues.find((x) => x.conflicting_field === 'iban')!.detected_value).toMatchObject({ $etat: 'masque' });
    expect(revues.find((x) => x.conflicting_field === 'email')!.detected_value).toBe('devis@plomberie-martin.fr');

    // Section paginée (navigation serveur) et export intégral JSON : mêmes protections.
    const page = await (await r.entity(A.id, 'supplier', ids.s, 'section=rel-operations&offset=0&size=1')).json();
    expect(page.section.window).toMatchObject({ total: 3, offset: 0, size: 1 });
    const exp = await r.entity(A.id, 'supplier', ids.s, 'format=json');
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-disposition')).toMatch(/verebona-compte-\d+-fournisseur-\d+-/);
    const fichier = await exp.text();
    expect(fichier).not.toMatch(/30006000011234567890189|11112222333344445555666|SARL Plomberie Martin/i);
    expect(JSON.parse(fichier)).toMatchObject({ complete: true, exportStatus: 'COMPLETE', export: { status: 'COMPLETE', format: 'json' } });
  });

  it('L113E-E05 isolation : autre compte et espace Duo lié → 404 (DENIED journalisé), listes disjointes', async () => {
    const r = await routes();
    await seConnecter('ADMIN');
    expect((await r.entity(A.id, 'supplier', ids.b)).status).toBe(404);
    expect((await r.entity(B.id, 'supplier', ids.s)).status).toBe(404);
    expect((await r.entity(A.id, 'supplier', ids.duo2)).status).toBe(404);
    const [refus] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_audit_log WHERE action_type = 'ACCOUNT_DATA_READ' AND result = 'DENIED' AND target_id = ${A.id}`;
    expect(refus.n).toBeGreaterThanOrEqual(2);
    const listeB = await (await r.list(B.id, 'fournisseurs')).json();
    expect(listeB.items.map((i: { id: number }) => i.id)).toEqual([ids.b]);
    const d2 = await (await r.list(D2.id, 'fournisseurs')).json();
    expect(d2.items.map((i: { id: number }) => i.id)).toEqual([ids.duo2]);
    expect(d2.total).toBe(1);
  });

  it('L113E-E06 non-régression : les six onglets d’origine répondent', async () => {
    const r = await routes();
    await seConnecter('ADMIN');
    for (const c of ['biens', 'equipements', 'pieces', 'documents', 'echeances', 'operations']) {
      const res = await r.list(A.id, c);
      expect(res.status, c).toBe(200);
      expect((await res.json()).category).toBe(c);
    }
    expect((await (await r.list(A.id, 'biens')).json()).total).toBe(3);
  });

  it('L113E-E07 lecture seule : tables métier identiques ; seule écriture : le journal d’administration', async () => {
    expect(await empreinte()).toEqual(avant);
    const nouvelles = await sql<{ action_type: string }[]>`SELECT action_type FROM admin_audit_log ORDER BY id OFFSET ${auditAvant}`;
    expect(nouvelles.length).toBeGreaterThan(0);
    expect([...new Set(nouvelles.map((a) => a.action_type))].sort()).toEqual(['ACCOUNT_DATA_EXPORT', 'ACCOUNT_DATA_READ']);
  });
});
