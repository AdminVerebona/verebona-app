/**
 * Lot 109B — fiche fournisseur unique, suppression du statut de vérification,
 * pagination exhaustive, ouverture depuis un document sans création implicite,
 * sur PostgreSQL 16 réel, par les MÊMES routes que les écrans.
 *
 *  L109B-E2E-AC07a  fiche : > 50 documents / biens / équipements, total exact, pages jusqu'au bout, zéro doublon, compte isolé
 *  L109B-E2E-AC07b  liste : > 100 fournisseurs, recherche > 20 résultats, pagination, tri, statut, motif ILIKE neutralisé
 *  L109B-E2E-AC08   document → fournisseur rattaché par IDENTIFIANT : unique, plusieurs, aucun — jamais de création
 *  L109B-E2E-AC04   modification (validations), IBAN jamais en clair hors consultation protégée, lecture seule, archivage / réactivation
 *  L109B-E2E-AC04b  conflits : « Utiliser » corrige l'adresse (colonne réelle), IBAN jamais appliqué d'un clic
 *  L109B-E2E-AC05   aucune colonne / valeur de statut : création manuelle, Agenda, analyse, transfert ; migration 1105 (temps 1) idempotente
 *  L109B-E2E-AC06   preuve de relation conservée : un rattachement incertain reste non confirmé
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { scenario } from '../scenario';

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

type Json = Record<string, unknown>;
const req = (url: string, method = 'GET', body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

scenario('L109B-FOURNISSEURS-FICHE-UNIQUE', 'Fournisseurs : fiche unique, sans statut de vérification, listes exhaustives (lot 109B)', ({ sql, make }) => {
  const connecter = (a: { id: number; ownerUserId: number }) => { session.userId = a.ownerUserId; session.currentAccountId = a.id; };
  const fournisseur = async (accountId: number, userId: number, name: string, over: { status?: string; iban?: string | null; createdAt?: string } = {}) => {
    const { normalizeName } = await import('@/services/suppliers/supplier-service');
    const [s] = await sql<{ id: number }[]>`
      INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, status, iban, created_at)
      VALUES (${accountId}, ${userId}, ${name}, ${normalizeName(name)}, ${over.status ?? 'active'}, ${over.iban ?? null}, ${over.createdAt ?? new Date().toISOString()}) RETURNING id`;
    return s.id;
  };
  const overview = async (id: number) => {
    const { GET } = await import('@/app/api/suppliers/[id]/overview/route');
    const r = await GET(req(`/api/suppliers/${id}/overview`), ctx(id));
    return { status: r.status, body: (await r.json()) as Json };
  };
  const section = async (id: number, s: string, offset: number, limit?: number) => {
    const { GET } = await import('@/app/api/suppliers/[id]/sections/[section]/route');
    const q = new URLSearchParams({ offset: String(offset), ...(limit ? { limit: String(limit) } : {}) });
    const r = await GET(req(`/api/suppliers/${id}/sections/${s}?${q}`), { params: Promise.resolve({ id: String(id), section: s }) });
    return { status: r.status, body: (await r.json()) as { items: Array<{ id: number }>; total: number; nextOffset: number | null } };
  };
  /** Toutes les pages d'une section, comme « Afficher plus » jusqu'au bout. */
  const toutes = async (id: number, s: string, first: { items: Array<{ id: number }>; nextOffset: number | null }) => {
    const ids = first.items.map((x) => x.id);
    let next = first.nextOffset;
    while (next != null) {
      const p = await section(id, s, next);
      ids.push(...p.body.items.map((x) => x.id));
      next = p.body.nextOffset;
    }
    return ids;
  };
  const liste = async (params: Record<string, string>) => {
    const { GET } = await import('@/app/api/suppliers/route');
    const r = await GET(req(`/api/suppliers?${new URLSearchParams(params)}`));
    return (await r.json()) as { suppliers: Array<{ id: number; name: string }>; total: number; nextOffset: number | null };
  };
  const listeComplete = async (params: Record<string, string>) => {
    const ids: number[] = [];
    let page = await liste(params);
    ids.push(...page.suppliers.map((s) => s.id));
    while (page.nextOffset != null) {
      page = await liste({ ...params, offset: String(page.nextOffset) });
      ids.push(...page.suppliers.map((s) => s.id));
    }
    return { ids, total: page.total };
  };
  const fournisseursDuDocument = async (docId: number) => {
    const { GET } = await import('@/app/api/documents/[id]/supplier/route');
    const r = await GET(req(`/api/documents/${docId}/supplier`), ctx(docId));
    return { status: r.status, body: (await r.json()) as { suppliers?: Array<{ id: number; isConfirmed: boolean; confidenceScore: number | null }> } };
  };
  const nbFournisseurs = async (accountId: number) =>
    Number((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM suppliers WHERE account_id = ${accountId}`)[0].n);

  it('L109B-E2E-AC07a — fiche : plus de 50 objets par section, total exact, toutes les pages, zéro doublon', async () => {
    const a = await make.account({ plan: 'premium' });
    const b = await make.account();
    connecter(a);
    const s = await fournisseur(a.id, a.ownerUserId, 'Homiris Sécurité');
    const biens = [];
    for (let i = 0; i < 53; i += 1) biens.push(await make.asset(a, { name: `Bien ${String(i).padStart(2, '0')}` }));
    for (const bien of biens) await sql`INSERT INTO asset_suppliers (asset_id, supplier_id) VALUES (${bien.id}, ${s})`;
    for (let i = 0; i < 61; i += 1) {
      const f = await make.assetFile(a, { assetId: biens[i % biens.length].id });
      await sql`UPDATE asset_files SET document_date = ${`2024-01-${String((i % 28) + 1).padStart(2, '0')}`} WHERE id = ${f.id}`;
      await sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed) VALUES (${f.id}, ${s}, ${i % 2 === 0})`;
    }
    for (let i = 0; i < 55; i += 1) {
      const [e] = await sql<{ id: number }[]>`INSERT INTO equipments (asset_id, name, type) VALUES (${biens[i % 3].id}, ${`Détecteur ${i}`}, 'ALARM') RETURNING id`;
      await sql`INSERT INTO equipment_suppliers (equipment_id, supplier_id, is_primary) VALUES (${e.id}, ${s}, ${i === 0})`;
    }
    // Jonction vers un document d'un autre compte : refusée par la base (garde 0332),
    // et de toute façon jamais comptée par la fiche (documents re-filtrés sur le compte).
    const fb = await make.assetFile(b);
    await expect(sql`INSERT INTO document_suppliers (document_id, supplier_id) VALUES (${fb.id}, ${s})`).rejects.toThrow(/CROSS_ACCOUNT_LINK/);
    // Document supprimé : absent.
    const fd = await make.assetFile(a);
    await sql`INSERT INTO document_suppliers (document_id, supplier_id) VALUES (${fd.id}, ${s})`;
    await sql`UPDATE asset_files SET deleted_at = now() WHERE id = ${fd.id}`;

    const ov = await overview(s);
    expect(ov.status).toBe(200);
    const docs = ov.body.documents as { items: Array<{ id: number }>; total: number; nextOffset: number | null };
    const assets = ov.body.assets as typeof docs;
    const eqs = ov.body.equipments as typeof docs;
    expect([docs.total, assets.total, eqs.total]).toEqual([61, 53, 55]);
    expect(docs.items.length).toBeLessThan(61);
    for (const [name, first, total] of [['documents', docs, 61], ['assets', assets, 53], ['equipments', eqs, 55]] as const) {
      const ids = await toutes(s, name, first);
      expect(ids, name).toHaveLength(total);
      expect(new Set(ids).size, `${name} sans doublon`).toBe(total);
    }
    expect((await toutes(s, 'documents', docs))).not.toContain(fb.id);
    expect((await toutes(s, 'documents', docs))).not.toContain(fd.id);
    // Page demandée bornée ; section inconnue refusée ; autre compte : 404.
    expect((await section(s, 'documents', 0, 100000)).body.items).toHaveLength(61);
    const { GET } = await import('@/app/api/suppliers/[id]/sections/[section]/route');
    expect((await GET(req(`/api/suppliers/${s}/sections/x`), { params: Promise.resolve({ id: String(s), section: 'x' }) })).status).toBe(400);
    connecter(b);
    expect((await section(s, 'documents', 0)).status).toBe(404);
    expect((await overview(s)).status).toBe(404);
    // Lot 113Y (#721) : plus de section séparée « Documents des événements de référence » — aucun événement
    // de référence → la rubrique unique « Documents » ne compte que les documents directs, rien d'inventé.
    connecter(a);
    const ov2 = await overview(s);
    expect(ov2.body).not.toHaveProperty('documentsViaOperation');
    expect((ov2.body.documents as { total: number }).total).toBe(61);
  });

  it('L109B-E2E-AC07b — liste : plus de 100 fournisseurs, recherche au-delà de 20, pagination, tri, statut', async () => {
    const a = await make.account();
    const b = await make.account();
    for (let i = 0; i < 112; i += 1) await fournisseur(a.id, a.ownerUserId, `Artisan ${String(i).padStart(3, '0')}`);
    for (let i = 0; i < 27; i += 1) await fournisseur(a.id, a.ownerUserId, `Plomberie ${String(i).padStart(2, '0')}`);
    const archive = await fournisseur(a.id, a.ownerUserId, 'Plomberie Archivée', { status: 'archived' });
    await fournisseur(a.id, a.ownerUserId, 'Taux 100% Garanti');
    await fournisseur(b.id, b.ownerUserId, 'Plomberie Autre Compte');
    connecter(a);
    const tout = await listeComplete({});
    expect(tout.total).toBe(140);
    expect(tout.ids).toHaveLength(140);
    expect(new Set(tout.ids).size).toBe(140);
    const premiere = await liste({});
    expect(premiere.suppliers.length).toBeLessThan(140);
    expect(premiere.nextOffset).not.toBeNull();
    const recherche = await listeComplete({ search: 'plomb' });
    expect(recherche.total).toBe(27);
    expect(new Set(recherche.ids).size).toBe(27);
    expect(recherche.ids).not.toContain(archive);
    // Tri : A → Z et Z → A cohérents d'une page à l'autre.
    const az = (await liste({ search: 'plomb', limit: '100' })).suppliers.map((s) => s.name);
    const za = (await liste({ search: 'plomb', sort: 'name_desc', limit: '100' })).suppliers.map((s) => s.name);
    expect(za).toEqual([...az].reverse());
    // Archivés : liste distincte.
    expect((await liste({ status: 'archived' })).suppliers.map((s) => s.id)).toEqual([archive]);
    // `%` saisi : caractère ordinaire, pas « tout ».
    expect((await liste({ search: '%' })).suppliers.map((s) => s.name)).toEqual(['Taux 100% Garanti']);
    // Jamais d'IBAN ni de statut dans une liste.
    expect(JSON.stringify(premiere)).not.toMatch(/iban|contactStatus/i);
  });

  it('L109B-E2E-AC08 — document : fournisseur rattaché par identifiant, jamais choisi par nom ni créé', async () => {
    const a = await make.account();
    connecter(a);
    const vrai = await fournisseur(a.id, a.ownerUserId, 'EDF Commerce');
    await fournisseur(a.id, a.ownerUserId, 'EDF'); // homonyme : jamais choisi
    const avant = await nbFournisseurs(a.id);
    const f1 = await make.assetFile(a);
    await sql`UPDATE asset_files SET supplier = 'EDF' WHERE id = ${f1.id}`;
    await sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed, confidence_score) VALUES (${f1.id}, ${vrai}, false, 0.7)`;
    const r1 = await fournisseursDuDocument(f1.id);
    expect(r1.status).toBe(200);
    expect(r1.body.suppliers?.map((s) => [s.id, s.isConfirmed, s.confidenceScore])).toEqual([[vrai, false, 0.7]]);
    // Aucun rattachement : liste vide, AUCUNE fiche créée (même avec un nom relevé inconnu).
    const f2 = await make.assetFile(a);
    await sql`UPDATE asset_files SET supplier = 'Fournisseur Jamais Vu' WHERE id = ${f2.id}`;
    expect((await fournisseursDuDocument(f2.id)).body.suppliers).toEqual([]);
    expect(await nbFournisseurs(a.id)).toBe(avant);
    // Plusieurs rattachements : tous rendus, le confirmé d'abord (aucun choix arbitraire).
    const autre = await fournisseur(a.id, a.ownerUserId, 'Installateur Solaire');
    await sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed) VALUES (${f2.id}, ${autre}, true), (${f2.id}, ${vrai}, false)`;
    expect((await fournisseursDuDocument(f2.id)).body.suppliers?.map((s) => s.id)).toEqual([autre, vrai]);
    // Fournisseur supprimé : absent ; document d'un autre compte : 404.
    await sql`UPDATE suppliers SET status = 'deleted' WHERE id = ${autre}`;
    expect((await fournisseursDuDocument(f2.id)).body.suppliers?.map((s) => s.id)).toEqual([vrai]);
    const b = await make.account();
    const fb = await make.assetFile(b);
    expect((await fournisseursDuDocument(fb.id)).status).toBe(404);
    // Le tiroir document ne cherche plus par nom et ne crée plus rien au clic.
    const drawer = readFileSync(join(process.cwd(), 'src/components/assets/DocumentDrawer.tsx'), 'utf8');
    expect(drawer).not.toMatch(/api\/suppliers\?search=/);
    expect(drawer).not.toMatch(/apiClient\.post[^;]*'\/api\/suppliers'/);
  });

  it('L109B-E2E-AC04 — modification, IBAN protégé, lecture seule, archivage et réactivation', async () => {
    const a = await make.account();
    connecter(a);
    const s = await fournisseur(a.id, a.ownerUserId, 'Menuiserie Dupont');
    const f = await make.assetFile(a);
    await sql`INSERT INTO document_suppliers (document_id, supplier_id, is_confirmed) VALUES (${f.id}, ${s}, true)`;
    const { PATCH, GET } = await import('@/app/api/suppliers/[id]/route');
    const patch = async (body: Json) => { const r = await PATCH(req(`/api/suppliers/${s}`, 'PATCH', body), ctx(s)); return { status: r.status, body: (await r.json()) as Json }; };
    expect((await patch({ siret: '123' })).status).toBe(400);
    expect((await patch({ name: '  ' })).status).toBe(400);
    expect((await patch({ iban: 'pas un iban' })).status).toBe(400);
    const ok = await patch({ name: 'Menuiserie Dupont & Fils', siret: '123 456 789 00012', email: 'contact@dupont.fr', iban: 'FR76 3000 6000 0112 3456 7890 189', website: 'dupont.fr' });
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain('FR7630006000011234567890189');
    const [row] = await sql<{ name: string; siret: string; iban: string; normalized_name: string }[]>`SELECT name, siret, iban, normalized_name FROM suppliers WHERE id = ${s}`;
    expect(row).toMatchObject({ name: 'Menuiserie Dupont & Fils', siret: '12345678900012', iban: 'FR7630006000011234567890189' });
    // Fiche (et ancien GET du tiroir) : IBAN masqué seulement, aucun statut.
    for (const body of [(await overview(s)).body, (await (await GET(req(`/api/suppliers/${s}`), ctx(s))).json()) as Json]) {
      const sup = body.supplier as Json;
      expect(sup.ibanMasked).toBe('FR76 •••• •••• 0189');
      expect(JSON.stringify(body)).not.toContain('FR7630006000011234567890189');
      expect(JSON.stringify(body)).not.toMatch(/contactStatus|contact_status/);
    }
    // Consultation protégée : compte de la session seulement, jamais mise en cache.
    const iban = await import('@/app/api/suppliers/[id]/iban/route');
    const r = await iban.GET(req(`/api/suppliers/${s}/iban`), ctx(s));
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(((await r.json()) as Json).iban).toBe('FR7630006000011234567890189');
    const b = await make.account();
    connecter(b);
    expect((await iban.GET(req(`/api/suppliers/${s}/iban`), ctx(s))).status).toBe(404);
    expect((await patch({ name: 'Piratage' })).status).toBe(404);
    // Archivage : relations conservées, fiche consultable, hors liste active ; réactivation.
    connecter(a);
    const arch = await import('@/app/api/suppliers/[id]/archive/route');
    expect((await arch.POST(req(`/api/suppliers/${s}/archive`, 'POST', {}), ctx(s))).status).toBe(200);
    const archivee = await overview(s);
    expect((archivee.body.supplier as Json).status).toBe('archived');
    expect((archivee.body.documents as { total: number }).total).toBe(1);
    expect((await liste({})).suppliers.map((x) => x.id)).not.toContain(s);
    expect((await arch.POST(req(`/api/suppliers/${s}/archive`, 'POST', { restore: true }), ctx(s))).status).toBe(200);
    expect(((await overview(s)).body.supplier as Json).status).toBe('active');
    // Compte en lecture seule : modification et archivage refusés, consultation possible.
    const ro = await make.account({ plan: null });
    connecter(ro);
    const sro = await fournisseur(ro.id, ro.ownerUserId, 'Fournisseur Lecture Seule');
    expect((await PATCH(req(`/api/suppliers/${sro}`, 'PATCH', { name: 'X' }), ctx(sro))).status).toBe(403);
    expect((await arch.POST(req(`/api/suppliers/${sro}/archive`, 'POST', {}), ctx(sro))).status).toBe(403);
    expect((await overview(sro)).status).toBe(200);
  });

  it('L109B-E2E-AC04b — conflits : « Utiliser » sur l’adresse, IBAN jamais appliqué d’un clic', async () => {
    const a = await make.account();
    connecter(a);
    const s = await fournisseur(a.id, a.ownerUserId, 'Couverture Martin', { iban: 'FR7630006000011234567890189' });
    await sql`UPDATE suppliers SET address_line_1 = '1 rue A' WHERE id = ${s}`;
    const f = await make.assetFile(a);
    const [adr] = await sql<{ id: number }[]>`
      INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id, document_id, conflicting_field, current_value, detected_value)
      VALUES (${a.id}, 'contact_conflict', 'open', ${s}, ${f.id}, 'addressLine1', '1 rue A', '2 avenue B') RETURNING id`;
    const [ib] = await sql<{ id: number }[]>`
      INSERT INTO supplier_review_items (account_id, item_type, status, supplier_id, document_id, conflicting_field, current_value, detected_value)
      VALUES (${a.id}, 'contact_conflict', 'open', ${s}, ${f.id}, 'iban', 'FR7630006000011234567890189', 'FR7612345000019876543210987') RETURNING id`;
    const conflits = (await overview(s)).body.conflicts as Array<{ id: number; masked: boolean; detectedValue: string; source: { documentId: number } | null }>;
    expect(conflits.map((c) => [c.id, c.masked, c.source?.documentId])).toEqual(expect.arrayContaining([[adr.id, false, f.id], [ib.id, true, f.id]]));
    expect(JSON.stringify(conflits)).not.toContain('FR7612345000019876543210987');
    const { POST } = await import('@/app/api/to-process/suppliers/[id]/resolve/route');
    expect((await POST(req(`/api/to-process/suppliers/${adr.id}/resolve`, 'POST', { resolution: 'use_detected' }), ctx(adr.id))).status).toBe(200);
    expect((await sql<{ a: string }[]>`SELECT address_line_1 AS a FROM suppliers WHERE id = ${s}`)[0].a).toBe('2 avenue B');
    expect((await POST(req(`/api/to-process/suppliers/${ib.id}/resolve`, 'POST', { resolution: 'use_detected' }), ctx(ib.id))).status).toBe(400);
    expect((await sql<{ iban: string }[]>`SELECT iban FROM suppliers WHERE id = ${s}`)[0].iban).toBe('FR7630006000011234567890189');
    expect((await POST(req(`/api/to-process/suppliers/${ib.id}/resolve`, 'POST', { resolution: 'keep_current' }), ctx(ib.id))).status).toBe(200);
    expect((await overview(s)).body.conflicts).toEqual([]);
  });

  it('L109B-E2E-AC05/06 — aucune valeur de statut, création et transfert ; preuve de relation conservée', async () => {
    const a = await make.account();
    const b = await make.account();
    connecter(a);
    const colonnes = await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'suppliers' AND column_name = 'contact_status'`;
    expect(colonnes).toHaveLength(0);
    // Création manuelle.
    const { POST } = await import('@/app/api/suppliers/route');
    const r = await POST(req('/api/suppliers', 'POST', { name: 'Électricité Moreau' }));
    expect(r.status).toBe(201);
    const created = ((await r.json()) as { supplier: Json }).supplier;
    expect(JSON.stringify(created)).not.toMatch(/contactStatus|iban/);
    // Création par l'analyse : incertaine → rattachement NON confirmé (preuve locale conservée).
    const { feedSupplierFromAnalysis } = await import('@/services/suppliers/supplier-from-analysis');
    const f = await make.assetFile(a);
    const out = await feedSupplierFromAnalysis({ accountId: a.id, userId: a.ownerUserId, documentId: f.id, supplier: { name: 'Électricité Moreau SARL', confidence: 'probable' } });
    expect(['linked', 'created', 'created_uncertain']).toContain(out.status);
    const lien = await sql<{ is_confirmed: boolean }[]>`SELECT is_confirmed FROM document_suppliers WHERE document_id = ${f.id}`;
    expect(lien).toHaveLength(1);
    const sid = (out as { supplierId: number }).supplierId;
    const docs = (await overview(sid)).body.documents as { items: Array<{ id: number; isConfirmed: boolean }> };
    expect(docs.items.find((d) => d.id === f.id)?.isConfirmed).toBe(lien[0].is_confirmed);
    // Création depuis le tiroir Agenda (référentiel, dédoublonnage) : sans statut.
    const { resolveSupplierForUser } = await import('@/services/agenda/agenda-suppliers');
    const { db: base } = await import('@/db');
    const viaAgenda = await base.transaction((tx) => resolveSupplierForUser(tx, { accountId: a.id, userId: a.ownerUserId, name: 'Paysagiste Lenoir' }));
    expect(viaAgenda.outcome).toBe('created');
    // Transfert d'un bien vers un autre compte : fiche copiée sans statut.
    const bien = await make.asset(a);
    await sql`INSERT INTO asset_suppliers (asset_id, supplier_id) VALUES (${bien.id}, ${created.id as number})`;
    const { db } = await import('@/db');
    const { transferAssetDataInTx } = await import('@/services/assets/asset-account-transfer.service');
    await db.transaction(async (tx) => {
      await tx.execute((await import('drizzle-orm')).sql`UPDATE assets SET account_id = ${b.id} WHERE id = ${bien.id}`);
      await transferAssetDataInTx(tx, { assetId: bien.id, fromAccountId: a.id, toAccountId: b.id });
    });
    const copie = await sql<{ account_id: number; name: string; source: string }[]>`
      SELECT s.account_id, s.name, s.source FROM asset_suppliers x JOIN suppliers s ON s.id = x.supplier_id WHERE x.asset_id = ${bien.id}`;
    expect(copie).toEqual([{ account_id: b.id, name: 'Électricité Moreau', source: 'manual' }]);
  });

  it('L109B-E2E-1105 — migration 1105 (temps 1) : colonne héritée neutralisée, idempotente', async () => {
    // Base d'un environnement encore pourvu de la colonne (schéma d'avant 109B).
    await sql.unsafe(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_status text NOT NULL DEFAULT 'unverified'`);
    const a = await make.account();
    const ancien = await fournisseur(a.id, a.ownerUserId, 'Fiche Ancienne');
    expect((await sql<{ c: string }[]>`SELECT contact_status AS c FROM suppliers WHERE id = ${ancien}`)[0].c).toBe('unverified');
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/1105_l109b_statut_fournisseur_retire.sql'), 'utf8');
    for (let i = 0; i < 2; i += 1) await sql.begin(async (tx) => { await tx.unsafe(migration); });
    const [col] = await sql<{ is_nullable: string; column_default: string | null }[]>`
      SELECT is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'suppliers' AND column_name = 'contact_status'`;
    expect(col).toEqual({ is_nullable: 'YES', column_default: null });
    // Intégration lot 109 : valeur existante conservée (aucune donnée effacée), jamais lue par le code.
    expect((await sql<{ c: string | null }[]>`SELECT contact_status AS c FROM suppliers WHERE id = ${ancien}`)[0].c).toBe('unverified');
    // Nouvelle création : aucun statut par défaut ; ancienne version (valeur explicite) toujours acceptée.
    const neuf = await fournisseur(a.id, a.ownerUserId, 'Fiche Nouvelle');
    expect((await sql<{ c: string | null }[]>`SELECT contact_status AS c FROM suppliers WHERE id = ${neuf}`)[0].c).toBeNull();
    await sql`INSERT INTO suppliers (account_id, created_by_user_id, name, normalized_name, contact_status) VALUES (${a.id}, ${a.ownerUserId}, 'V', 'v', 'unverified')`;
    // Temps 2 (déploiement suivant) : retrait physique, rejouable.
    await sql.unsafe(`ALTER TABLE suppliers DROP COLUMN IF EXISTS contact_status`);
    for (let i = 0; i < 2; i += 1) await sql.begin(async (tx) => { await tx.unsafe(migration); });
    expect(await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'suppliers' AND column_name = 'contact_status'`).toHaveLength(0);
  });
});
