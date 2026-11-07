/**
 * Lot 113Y (#721) — fiche fournisseur : UNE seule rubrique « Documents »,
 * sur PostgreSQL 16 réel, par les MÊMES routes que l'écran (web, PWA et
 * application mobile : même page, même API).
 *
 *  L113Y-E01  cas de référence : 2 attestations liées directement + le compromis de l'événement
 *             « Achat — Maison » → « Documents (3) », contexte « Via Achat — Maison » ; plus aucune
 *             section séparée ; « Événements associés » et « Biens » inchangés ;
 *  L113Y-E02  document commun (direct ET via un ou plusieurs événements) : une seule fois, total exact,
 *             lien direct prioritaire (aucun contexte) ; aucun lien perdu ;
 *  L113Y-E03  plusieurs fournisseurs sur l'événement : la pièce d'un AUTRE fournisseur n'est jamais
 *             exposée par la seule participation ; un émetteur d'une pièce (DOCUMENT_ISSUER) ne voit que
 *             ses propres documents ; événement invalidé, lien retiré, document supprimé ou non déposé :
 *             exclus ;
 *  L113Y-E04  aucun document : total 0, carte « Équipements » vide (total 0 → masquée par l'écran) ;
 *  L113Y-E05  autre compte, compte Duo lié, jonction corrompue vers un document d'un autre compte : rien ;
 *  L113Y-E06  plus de 50 documents (directs, via, communs) : pages jusqu'au bout, total exact, aucun
 *             doublon, tri date décroissante (sans date en dernier) ;
 *  L113Y-E07  lecture seule : empreintes des relations, preuves et décisions identiques.
 */
import { beforeAll, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';
import type { AccountRow } from '../factories';

const session = vi.hoisted(() => ({ userId: 0, currentAccountId: 0 as number | null }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: async () => ({ userId: session.userId, currentAccountId: session.currentAccountId }),
    handleSessionError: (e: unknown) => { throw e; },
  },
}));
vi.mock('@/services/verebona-assistant/events/business-events', async (o) => ({
  ...(await o<object>()), emitBusinessEvent: async () => {}, emitBusinessEvents: async () => {},
}));

type Doc = { id: number; title: string; documentDate: string | null; provenance: string; viaContext: string | null; isConfirmed: boolean };
type Page = { items: Doc[]; total: number; nextOffset: number | null };
const req = (url: string) => new NextRequest(`http://localhost${url}`);

scenario('L113Y-FOURNISSEUR-DOCUMENTS', 'Fiche fournisseur : une seule rubrique « Documents » (lot 113Y)', ({ sql, make }) => {
  const connecter = (a: AccountRow) => { session.userId = a.ownerUserId; session.currentAccountId = a.id; };
  const fournisseur = async (a: AccountRow, name: string) => Number((await sql<{ id: number }[]>`
    INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, status)
    VALUES (${a.id}, ${a.ownerUserId}, ${name}, ${name.toLowerCase()}, 'active') RETURNING id`)[0].id);
  const document = async (a: AccountRow, assetId: number | null, titre: string, date: string | null) => {
    const id = (await make.assetFile(a, { assetId })).id;
    await sql`UPDATE asset_files SET retained_title = ${titre}, document_date = ${date} WHERE id = ${id}`;
    return id;
  };
  const relier = (fileId: number, supplierId: number, confirmed = true) =>
    sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed, confidence_score) VALUES (${fileId}, ${supplierId}, ${confirmed}, ${confirmed ? '1' : '0.6'})`;
  const evenement = async (a: AccountRow, label: string, o: { invalide?: boolean; titre?: string } = {}) => {
    const id = Number((await sql.unsafe(
      `INSERT INTO business_operations (account_id, type_code, status, technical_label${o.invalide ? ', invalidated_at, invalidation_reason' : ''})
       VALUES ($1, 'ACQUISITION', 'REALIZED', $2${o.invalide ? ", now(), 'E2E_L113Y'" : ''}) RETURNING id`, [a.id, label]))[0].id);
    if (o.titre) {
      const item = (await make.agendaItem(a, { title: o.titre })).id;
      // Rattachement puis rôle (le déclencheur de synchronisation rend « RELATED » un déplacement hors service).
      await sql`UPDATE agenda_items SET business_operation_id = ${id} WHERE id = ${item}`;
      await sql`UPDATE agenda_items SET operation_role = 'PRINCIPAL', operation_role_origin = 'USER' WHERE id = ${item}`;
    }
    return id;
  };
  const partie = (a: AccountRow, op: number, s: number, role: string, status = 'ACTIVE') =>
    sql`INSERT INTO business_operation_suppliers (account_id, operation_id, supplier_id, role, origin, status) VALUES (${a.id}, ${op}, ${s}, ${role}, 'T3', ${status})`;
  const membre = (a: AccountRow, op: number, f: number) =>
    sql`INSERT INTO business_operation_documents (account_id, operation_id, file_id, origins) VALUES (${a.id}, ${op}, ${f}, ARRAY['SOURCE'])`;

  const overview = async (id: number) => {
    const { GET } = await import('@/app/api/suppliers/[id]/overview/route');
    const r = await GET(req(`/api/suppliers/${id}/overview`), { params: Promise.resolve({ id: String(id) }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> & { documents: Page; equipments: Page; assets: Page; agendaItems: Array<{ id: number }> } };
  };
  const section = async (id: number, offset: number, limit?: number) => {
    const { GET } = await import('@/app/api/suppliers/[id]/sections/[section]/route');
    const q = new URLSearchParams({ offset: String(offset), ...(limit ? { limit: String(limit) } : {}) });
    const r = await GET(req(`/api/suppliers/${id}/sections/documents?${q}`), { params: Promise.resolve({ id: String(id), section: 'documents' }) });
    return { status: r.status, body: (await r.json()) as Page };
  };
  /** « Afficher plus » jusqu'au bout. */
  const tous = async (id: number) => {
    const first = (await overview(id)).body.documents;
    const items = [...first.items];
    let next = first.nextOffset;
    while (next != null) {
      const p = (await section(id, next)).body;
      items.push(...p.items);
      next = p.nextOffset;
    }
    return { total: first.total, items };
  };

  let A: AccountRow;
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    A = await make.account({ plan: 'premium' });
    const maison = await make.asset(A, { category: 'IMMOBILIER', name: 'Maison' });
    ids.maison = maison.id;
    ids.notaire = await fournisseur(A, 'Étude Notariale Durand');
    ids.agence = await fournisseur(A, 'Agence du Centre');
    ids.banque = await fournisseur(A, 'Banque Exemple');
    ids.vide = await fournisseur(A, 'Fournisseur sans document');
    // Cas de référence (ticket #721).
    ids.attPropriete = await document(A, maison.id, 'Attestation de propriété', '2026-03-02');
    ids.attVente = await document(A, maison.id, 'Attestation de vente', '2026-03-01');
    ids.compromis = await document(A, maison.id, 'Compromis de vente', '2025-12-15');
    await relier(ids.attPropriete, ids.notaire);
    await relier(ids.attVente, ids.notaire, false);
    ids.achat = await evenement(A, 'Achat maison', { titre: 'Achat — Maison' });
    await partie(A, ids.achat, ids.notaire, 'PROVIDER');
    await membre(A, ids.achat, ids.compromis);
    // Événement associé (relation persistante) : conservé.
    ids.rdv = (await make.agendaItem(A, { title: 'Signature acte', assetIds: [maison.id] })).id;
    await sql`INSERT INTO agenda_item_suppliers (account_id, agenda_item_id, supplier_id, provenance) VALUES (${A.id}, ${ids.rdv}, ${ids.notaire}, 'USER')`;
  });

  it('L113Y-E01 — cas de référence : « Documents (3) », contexte « Via Achat — Maison », plus de section séparée', async () => {
    connecter(A);
    const ov = await overview(ids.notaire);
    expect(ov.status).toBe(200);
    expect(ov.body).not.toHaveProperty('documentsViaOperation');
    expect(ov.body.documents.total).toBe(3);
    expect(ov.body.documents.items.map((d) => d.id)).toEqual([ids.attPropriete, ids.attVente, ids.compromis]);
    const compromis = ov.body.documents.items.find((d) => d.id === ids.compromis)!;
    expect(compromis).toMatchObject({ provenance: 'VIA_EVENT', viaContext: 'Via Achat — Maison', isConfirmed: false, title: 'Compromis de vente', documentDate: '2025-12-15' });
    // Lien direct incertain : reste incertain (aucune promotion par la fusion), sans contexte.
    expect(ov.body.documents.items.find((d) => d.id === ids.attVente)).toMatchObject({ provenance: 'DIRECT', viaContext: null, isConfirmed: false });
    // Biens et événements associés inchangés.
    expect(ov.body.assets.items.map((a) => a.id)).toEqual([ids.maison]);
    expect(ov.body.agendaItems.map((i) => i.id)).toEqual([ids.rdv]);
    // Jamais le mot « Opération » dans la réponse affichable.
    expect(JSON.stringify(ov.body.documents)).not.toMatch(/Opération/);
  });

  it('L113Y-E02 — document commun aux deux chemins (et à deux événements) : une seule fois, direct prioritaire', async () => {
    connecter(A);
    ids.commun = await document(A, ids.maison, 'Acte authentique', '2026-02-20');
    await relier(ids.commun, ids.notaire);
    await membre(A, ids.achat, ids.commun);
    const second = await evenement(A, 'Frais de notaire', { titre: 'Frais — Maison' });
    await partie(A, second, ids.notaire, 'PROVIDER');
    await membre(A, second, ids.commun);
    await membre(A, second, ids.compromis);
    const { total, items } = await tous(ids.notaire);
    expect(total).toBe(4);
    expect(items.map((d) => d.id)).toEqual([ids.attPropriete, ids.attVente, ids.commun, ids.compromis]);
    expect(items.find((d) => d.id === ids.commun)).toMatchObject({ provenance: 'DIRECT', viaContext: null, isConfirmed: true });
    // Compromis : deux événements, une seule ligne, contexte des deux (texte trié, aucun doublon).
    expect(items.find((d) => d.id === ids.compromis)?.viaContext).toBe('Via Achat — Maison et 1 autre événement');
    // Aucun lien perdu : les jonctions sont intactes.
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_operation_documents WHERE file_id = ${ids.commun} AND active`;
    expect(n).toBe(2);
  });

  it('L113Y-E03 — plusieurs fournisseurs : pièce d’un autre fournisseur jamais exposée ; exclusions', async () => {
    connecter(A);
    // Pièce de l'agence, membre de l'événement : agence = émettrice d'une pièce (DOCUMENT_ISSUER).
    ids.mandat = await document(A, ids.maison, 'Mandat de vente', '2025-11-02');
    await relier(ids.mandat, ids.agence);
    await membre(A, ids.achat, ids.mandat);
    await partie(A, ids.achat, ids.agence, 'DOCUMENT_ISSUER');
    // Avis de prélèvement de la banque, membre de l'événement ; banque partie comme marque (BRAND).
    ids.avis = await document(A, ids.maison, 'Avis de prélèvement', '2026-03-05');
    await relier(ids.avis, ids.banque);
    await membre(A, ids.achat, ids.avis);
    await partie(A, ids.achat, ids.banque, 'BRAND');
    // Événement invalidé, lien retiré, document supprimé, document non déposé.
    const invalide = await evenement(A, 'Ancien achat', { invalide: true, titre: 'Achat annulé' });
    await partie(A, invalide, ids.notaire, 'PROVIDER');
    ids.horsInvalide = await document(A, ids.maison, 'Pièce d’un événement invalidé', '2025-01-01');
    await membre(A, invalide, ids.horsInvalide);
    const retire = await evenement(A, 'Travaux', { titre: 'Travaux — Maison' });
    await partie(A, retire, ids.notaire, 'PROVIDER', 'REMOVED');
    ids.horsRetire = await document(A, ids.maison, 'Devis travaux', '2025-02-01');
    await membre(A, retire, ids.horsRetire);
    ids.supprime = await document(A, ids.maison, 'Brouillon supprimé', '2025-03-01');
    await membre(A, ids.achat, ids.supprime);
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${ids.supprime}`;
    ids.enCours = await document(A, ids.maison, 'Dépôt en cours', '2025-04-01');
    await membre(A, ids.achat, ids.enCours);
    await sql`UPDATE asset_files SET upload_status = 'PENDING' WHERE id = ${ids.enCours}`;

    const notaire = await tous(ids.notaire);
    expect(notaire.total).toBe(4);
    for (const x of [ids.mandat, ids.avis, ids.horsInvalide, ids.horsRetire, ids.supprime, ids.enCours]) expect(notaire.items.map((d) => d.id)).not.toContain(x);
    // Agence : ses propres pièces seulement (le compromis du notaire n'est pas « à » elle).
    const agence = await tous(ids.agence);
    expect(agence.items.map((d) => [d.id, d.provenance])).toEqual([[ids.mandat, 'DIRECT']]);
    expect(agence.total).toBe(1);
    const banque = await tous(ids.banque);
    expect(banque.items.map((d) => d.id)).toEqual([ids.avis]);
    // Intervenant posé par l'utilisateur : voit les pièces neutres de l'événement, jamais celles d'un autre fournisseur.
    const expert = await fournisseur(A, 'Expert diagnostiqueur');
    await partie(A, ids.achat, expert, 'INTERVENER');
    const ex = await tous(expert);
    expect(ex.items.map((d) => d.id)).toEqual([ids.compromis]);
    expect(ex.items[0]).toMatchObject({ provenance: 'VIA_EVENT', viaContext: 'Via Achat — Maison' });
  });

  it('L113Y-E04 — aucun document : total 0 ; aucun équipement : total 0 (carte masquée par l’écran)', async () => {
    connecter(A);
    const ov = await overview(ids.vide);
    expect(ov.status).toBe(200);
    expect(ov.body.documents).toMatchObject({ total: 0, items: [], nextOffset: null });
    expect(ov.body.equipments).toMatchObject({ total: 0, items: [] });
    // Dès qu'un équipement est rattaché, la section le compte (carte réaffichée).
    const eq = Number((await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name) VALUES (${ids.maison}, 'Chaudière') RETURNING id`)[0].id);
    await sql`INSERT INTO equipment_suppliers (equipment_id, supplier_id, relationship_type, source_type, is_primary) VALUES (${eq}, ${ids.vide}, 'INSTALLER', 'manual', true)`;
    expect((await overview(ids.vide)).body.equipments.total).toBe(1);
  });

  it('L113Y-E05 — autre compte, compte Duo lié, jonction corrompue : rien d’un autre compte', async () => {
    const B = await make.account({ plan: 'premium' });
    const docB = await document(B, null, 'Document du compte B', '2026-01-01');
    // Jonction corrompue (garde intercomptes contournée, comme une donnée historique) : fournisseur de A → document de B.
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed) VALUES (${docB}, ${ids.notaire}, true)`;
    });
    connecter(A);
    expect((await tous(ids.notaire)).items.map((d) => d.id)).not.toContain(docB);
    expect((await tous(ids.notaire)).total).toBe(4);
    connecter(B);
    expect((await overview(ids.notaire)).status).toBe(404);
    expect((await section(ids.notaire, 0)).status).toBe(404);
    // Duo : deux espaces liés — chaque espace ne lit que ses fournisseurs.
    const titulaire = await make.user();
    const membreDuo = await make.user();
    const D1 = await make.account({ owner: titulaire, plan: 'premium_duo' });
    const D2 = await make.account({ owner: membreDuo, plan: 'premium_duo' });
    const [duo] = await sql<{ id: number }[]>`INSERT INTO duo_accounts (billing_owner_user_id) VALUES (${titulaire.id}) RETURNING id`;
    await sql`UPDATE accounts SET duo_account_id = ${duo.id} WHERE id IN (${D1.id}, ${D2.id})`;
    const s1 = await fournisseur(D1, 'Couvreur du titulaire');
    const d1 = await document(D1, null, 'Facture toiture', '2026-01-10');
    await relier(d1, s1);
    connecter(D2);
    expect((await overview(s1)).status).toBe(404);
    connecter(D1);
    expect((await overview(s1)).body.documents.items.map((d) => d.id)).toEqual([d1]);
  });

  it('L113Y-E06 — plus de 50 documents : pagination complète, total exact, aucun doublon, tri stable', async () => {
    const C = await make.account({ plan: 'premium' });
    connecter(C);
    const bien = await make.asset(C, { category: 'IMMOBILIER', name: 'Immeuble' });
    const s = await fournisseur(C, 'Syndic Volume');
    const op = await evenement(C, 'Copropriété', { titre: 'Copropriété — Immeuble' });
    await partie(C, op, s, 'PROVIDER');
    const attendus: number[] = [];
    for (let i = 0; i < 25; i++) { const f = await document(C, bien.id, `Appel de fonds ${i}`, `2025-${String((i % 12) + 1).padStart(2, '0')}-10`); await relier(f, s); attendus.push(f); }
    for (let i = 0; i < 30; i++) { const f = await document(C, bien.id, `Procès-verbal ${i}`, i % 5 === 0 ? null : `2024-${String((i % 12) + 1).padStart(2, '0')}-20`); await membre(C, op, f); attendus.push(f); }
    for (let i = 0; i < 6; i++) { const f = await document(C, bien.id, `Relevé commun ${i}`, `2026-01-0${i + 1}`); await relier(f, s); await membre(C, op, f); attendus.push(f); }
    const { total, items } = await tous(s);
    expect(total).toBe(61);
    expect(items).toHaveLength(61);
    expect(new Set(items.map((d) => d.id)).size).toBe(61);
    expect([...items.map((d) => d.id)].sort((a, b) => a - b)).toEqual([...attendus].sort((a, b) => a - b));
    // Tri : date du document décroissante, sans date en dernier (jamais de date inventée).
    const dates = items.map((d) => d.documentDate);
    const sansDate = dates.findIndex((d) => d == null);
    expect(dates.slice(sansDate).every((d) => d == null)).toBe(true);
    const avec = dates.slice(0, sansDate) as string[];
    expect([...avec].sort().reverse()).toEqual(avec);
    expect(items.filter((d) => d.provenance === 'VIA_EVENT')).toHaveLength(30);
    // Page demandée bornée (100) : deux appels suffisent, toujours le même total.
    const p1 = (await section(s, 0, 100000)).body;
    expect(p1.items).toHaveLength(61);
    expect(p1).toMatchObject({ total: 61, nextOffset: null });
  });

  it('L113Y-E07 — lecture seule : relations, preuves, décisions et cartes inchangées', async () => {
    const tables = ['document_suppliers', 'business_operation_suppliers', 'business_operation_supplier_history', 'business_operation_documents',
      'agenda_item_suppliers', 'supplier_review_items', 'to_process_actions', 'asset_files', 'suppliers'];
    const empreinte = async () => {
      const out: Record<string, string> = {};
      for (const t of tables) out[t] = String((await sql.unsafe(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`))[0].h);
      return out;
    };
    const avant = await empreinte();
    connecter(A);
    await tous(ids.notaire);
    await tous(ids.agence);
    await overview(ids.vide);
    expect(await empreinte()).toEqual(avant);
  });
});
