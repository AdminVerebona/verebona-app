/**
 * Fiche fournisseur — droits du compte (mêmes règles que les biens) et
 * accès depuis l'assistant (cartes, OPEN_SUPPLIER, OPEN_SUPPLIERS).
 *
 * Isolation : un fournisseur d'un autre compte est introuvable (404) ; chaque
 * requête de la fiche est bornée au compte de la SESSION, jamais à celui du
 * fournisseur ; les objets liés sont re-filtrés sur ce compte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/db', () => ({
  pgClient: Object.assign(vi.fn(), { unsafe: vi.fn(async () => []) }),
  db: {},
  ensureMigrations: vi.fn(async () => {}),
}));

const session = vi.hoisted(() => ({ current: { userId: 1, currentAccountId: 10 } as { userId: number; currentAccountId: number | null } }));
vi.mock('@/lib/session-service', () => ({
  SessionService: {
    getSession: vi.fn(async () => session.current),
    handleSessionError: () => new Response(null, { status: 401 }),
  },
}));

// La route est testée avec un service simulé (plus bas) ; le service lui-même
// est testé dans sa version réelle.
const svc = vi.hoisted(() => ({ getSupplierDetail: vi.fn() }));
vi.mock('@/services/suppliers/supplier-detail.service', async (orig) => ({
  ...(await orig<typeof import('../supplier-detail.service')>()),
  getSupplierDetail: (...a: unknown[]) => svc.getSupplierDetail(...a),
}));
const { getSupplierDetail } = await vi.importActual<typeof import('../supplier-detail.service')>('../supplier-detail.service');
const { resolveActions } = await import('@/services/verebona-assistant/core/action-resolver.service');
const { findNavigationTarget } = await import('@/services/verebona-assistant/core/navigation-targets');
const { hrefSource } = await import('@/services/verebona-assistant/core/entity-ref');
const { construireActionIntents } = await import('@/services/verebona-assistant/core/ports');
const { routeForIntent } = await import('@/services/verebona-assistant/core/intent-router.service');

// ── Base simulée : deux comptes, un fournisseur chacun ─────────────────────
// Chaque ligne porte son compte ; le faux exécutant ne rend que les lignes du
// compte passé en paramètre $2 — ce qui vérifie que le service transmet le
// compte de la session à CHAQUE requête.
const SUPPLIERS = [
  { id: 4, accountId: 10, name: 'Plomberie Martin', email: 'contact@martin.fr', phone: null, website: null, addressLine1: null, addressLine2: null,
    postalCode: '69003', city: 'Lyon', country: null, siren: null, siret: null, vatNumber: null, hasIban: true,
    source: 'document_extraction', contactStatus: 'unverified', status: 'active' },
  { id: 9, accountId: 20, name: 'Garage d’un autre compte', email: 'x@y.fr', phone: null, website: null, addressLine1: null, addressLine2: null,
    postalCode: null, city: null, country: null, siren: null, siret: null, vatNumber: null, hasIban: false,
    source: 'manual', contactStatus: 'verified', status: 'active' },
];
const LIES: Record<string, Array<Record<string, unknown>>> = {
  documents: [
    { accountId: 10, supplierId: 4, id: 100, title: 'Facture chaudière', documentType: 'FACTURE', documentDate: '2025-03-12', role: 'issuer', isConfirmed: true, assetId: 1, assetName: 'Maison', available: true },
    { accountId: 20, supplierId: 4, id: 999, title: 'Document d’un autre compte', documentType: null, documentDate: null, role: null, isConfirmed: false, assetId: null, assetName: null, available: true },
  ],
  assets: [
    { accountId: 10, supplierId: 4, id: 1, name: 'Maison', category: 'IMMOBILIER', city: 'Lyon', available: true },
    { accountId: 10, supplierId: 4, id: 2, name: 'Chalet (archivé)', category: 'IMMOBILIER', city: null, available: false },
  ],
  equipments: [{ accountId: 10, supplierId: 4, id: 7, name: 'Chaudière', type: 'CHAUDIERE', relationshipType: 'installer', isPrimary: true, assetId: 1, assetName: 'Maison', available: true }],
  agenda: [{ accountId: 10, supplierId: 4, id: 55, title: 'Entretien chaudière', startDate: '2026-10-01', manualStatus: null }],
};

const requetes: Array<{ sql: string; params: unknown[] }> = [];
const run = async (sql: string, params: unknown[]) => {
  requetes.push({ sql, params });
  const [supplierId, accountId] = params as [number, number];
  const q = sql.replace(/\s+/g, ' ');
  const pour = (rows: Array<Record<string, unknown>>) =>
    rows.filter((r) => r.accountId === accountId && r.supplierId === supplierId).map(({ accountId: _a, supplierId: _s, ...r }) => r);
  if (q.includes('FROM suppliers')) return SUPPLIERS.filter((s) => s.id === supplierId && s.accountId === accountId).map(({ accountId: _a, ...s }) => s);
  if (q.startsWith('SELECT a.id, a.name')) return pour(LIES.assets);
  if (q.startsWith('SELECT f.id')) return pour(LIES.documents);
  if (q.includes('FROM equipment_suppliers es JOIN equipments')) return pour(LIES.equipments);
  if (q.includes('FROM agenda_items i')) return pour(LIES.agenda);
  if (q.includes('FROM supplier_review_items')) return accountId === 10 && supplierId === 4 ? [{ n: 2 }] : [{ n: 0 }];
  throw new Error(`requête inattendue : ${q.slice(0, 60)}`);
};

beforeEach(() => { requetes.length = 0; session.current = { userId: 1, currentAccountId: 10 }; });

describe('service de la fiche : isolation entre comptes', () => {
  it('fournisseur du compte : fiche complète, objets liés du compte seulement, sans IBAN', async () => {
    const d = await getSupplierDetail(10, 4, run);
    expect(d?.supplier.name).toBe('Plomberie Martin');
    expect(d?.documents.map((x) => x.id)).toEqual([100]);
    expect(d?.assets.map((x) => [x.id, x.available])).toEqual([[1, true], [2, false]]);
    expect(d?.equipments.map((x) => x.id)).toEqual([7]);
    expect(d?.agendaItems.map((x) => x.id)).toEqual([55]);
    expect(d?.openReviewCount).toBe(2);
    expect(d?.supplier.hasIban).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/"iban"/);
  });

  it('fournisseur d’un autre compte : null, et AUCUNE requête sur ses objets liés', async () => {
    expect(await getSupplierDetail(10, 9, run)).toBeNull();
    expect(requetes).toHaveLength(1);
  });

  it('identifiants invalides : null sans requête', async () => {
    for (const [a, s] of [[10, 0], [10, -1], [10, 1.5], [0, 4], [Number.NaN, 4]] as const) {
      expect(await getSupplierDetail(a, s, run)).toBeNull();
    }
    expect(requetes).toHaveLength(0);
  });

  it('chaque requête porte le compte de la session, et chaque table d’objets est bornée à ce compte', async () => {
    await getSupplierDetail(10, 4, run);
    expect(requetes.length).toBeGreaterThan(1);
    for (const r of requetes) {
      expect(r.params).toEqual([4, 10]);
      const q = r.sql.replace(/\s+/g, ' ');
      // Toute table portant un compte est filtrée sur $2 (compte de la session).
      for (const [table, alias] of [['asset_files', 'f'], ['assets', 'a'], ['agenda_items', 'i']] as const) {
        if (new RegExp(`\\b${table} ${alias}\\b`).test(q)) expect(q).toContain(`${alias}.account_id = $2`);
      }
      if (/FROM suppliers\b/.test(q) || /FROM supplier_review_items\b/.test(q)) expect(q).toMatch(/account_id = \$2/);
      // Documents et biens supprimés, équipements archivés : jamais rendus.
      if (/\basset_files f\b/.test(q)) expect(q).toContain('f.deleted_at IS NULL');
      if (/\bassets a\b/.test(q)) expect(q).toContain('a.deleted_at IS NULL');
      if (/\bequipments e\b/.test(q)) expect(q).toContain('e.archived_at IS NULL');
    }
  });
});

describe('GET /api/suppliers/[id]/overview', () => {
  const appel = async (id: string) => {
    const { GET } = await import('@/app/api/suppliers/[id]/overview/route');
    return GET(new NextRequest(`http://x/api/suppliers/${id}/overview`), { params: Promise.resolve({ id }) });
  };

  it('interroge le service avec le compte de la SESSION', async () => {
    svc.getSupplierDetail.mockResolvedValueOnce({ supplier: { id: 4, name: 'Plomberie Martin' } });
    const res = await appel('4');
    expect(res.status).toBe(200);
    expect(svc.getSupplierDetail).toHaveBeenLastCalledWith(10, 4);
  });

  it('fournisseur d’un autre compte (service → null) : 404, rien de révélé', async () => {
    svc.getSupplierDetail.mockResolvedValueOnce(null);
    const res = await appel('9');
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toMatch(/Garage/);
  });

  it('identifiant non numérique : 400 sans interroger le service', async () => {
    svc.getSupplierDetail.mockClear();
    for (const id of ['abc', '4abc', '1e3', '-4']) expect((await appel(id)).status).toBe(400);
    expect(svc.getSupplierDetail).not.toHaveBeenCalled();
  });

  it('sans compte actif : 401', async () => {
    session.current = { userId: 1, currentAccountId: null };
    expect((await appel('4')).status).toBe(401);
  });
});

describe('assistant : cartes et actions vers la fiche fournisseur', () => {
  const access = (fournisseursDuCompte: number[]) => ({
    assetInAccount: async () => false, documentInAccount: async () => false, agendaItemInAccount: async () => false,
    helpEntryPublished: async () => false,
    supplierInAccount: async (a: number, id: number) => a === 10 && fournisseursDuCompte.includes(id),
  });

  it('carte et source « Fournisseur » : lien vers /fournisseurs/[id]', () => {
    expect(hrefSource('supplier_4')).toBe('/fournisseurs/4');
  });

  it('OPEN_SUPPLIER : fournisseur du compte → fiche ; d’un autre compte → action écartée', async () => {
    const route = routeForIntent('ACCOUNT_SEARCH_SUPPLIER', 'STANDARD', 'test');
    const input = { accountId: 10, userId: 1, planType: 'STANDARD', message: 'Retrouve mon plombier', clientRequestId: 'x', locale: 'fr-FR' };
    const sources = [
      { id: 'supplier_4', type: 'supplier', title: 'Plomberie Martin', content: '', relevanceScore: 0.9 },
      { id: 'supplier_9', type: 'supplier', title: 'Garage', content: '', relevanceScore: 0.8 },
    ] as never;
    const actions = await resolveActions({
      accountId: 10, intent: 'ACCOUNT_SEARCH_SUPPLIER',
      actionIntents: construireActionIntents(route, input as never, sources), access: access([4]),
    });
    expect(actions.filter((a) => a.type === 'OPEN_SUPPLIER').map((a) => a.href)).toEqual(['/fournisseurs/4']);
    expect(actions.some((a) => a.href === '/fournisseurs/9')).toBe(false);
    // Repli sans cible : la liste des fournisseurs.
    expect(actions.find((a) => a.type === 'OPEN_SUPPLIERS')?.href).toBe('/fournisseurs');
  });

  it('vérificateur sans contrôle fournisseur : aucune fiche ouverte (refus par défaut)', async () => {
    const { supplierInAccount: _s, ...sansFournisseur } = access([4]);
    const actions = await resolveActions({
      accountId: 10, intent: 'ACCOUNT_SEARCH_SUPPLIER',
      actionIntents: [{ type: 'OPEN_SUPPLIER', targetId: 'supplier_4' }], access: sansFournisseur,
    });
    expect(actions).toEqual([]);
  });

  it('cible d’une autre famille refusée (un document ne vaut pas un fournisseur)', async () => {
    const actions = await resolveActions({
      accountId: 10, intent: 'ACCOUNT_SEARCH_SUPPLIER',
      actionIntents: [{ type: 'OPEN_SUPPLIER', targetId: 'doc_4' }], access: access([4]),
    });
    expect(actions).toEqual([]);
  });

  it('navigation : « Ouvre mes fournisseurs » → OPEN_SUPPLIERS', () => {
    expect(findNavigationTarget('Ouvre mes fournisseurs')?.action).toBe('OPEN_SUPPLIERS');
    expect(findNavigationTarget('Affiche la liste des prestataires')?.action).toBe('OPEN_SUPPLIERS');
    // Les autres destinations ne changent pas.
    expect(findNavigationTarget('Ouvre mes documents')?.action).toBe('OPEN_DOCUMENTS_PAGE');
  });
});
