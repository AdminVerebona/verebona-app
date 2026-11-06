/**
 * Lot 109B — fiche fournisseur unique, suppression du statut de vérification,
 * retour contextuel, pagination exacte, ouverture depuis un document.
 *
 *  L109B-RET-*   retour contextuel (jetons, chemins sûrs, libellés, instantanés, liaisons)
 *  L109B-VAL-*   validations des coordonnées, liens actionnables, IBAN masqué
 *  L109B-LIST-*  liste paginée (total exact, ILIKE neutralisé, bornes)
 *  L109B-UI-*    règles pures des écrans (conflits, fusion sans doublon, état du document, modifications)
 *  L109B-STAT-*  invariants statiques (tiroir supprimé, aucun statut, aucune création implicite)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/db', () => ({ pgClient: Object.assign(vi.fn(), { unsafe: vi.fn(async () => []) }), db: {}, ensureMigrations: vi.fn(async () => {}) }));

import type { AssistantReturnState, SupplierReturnContext } from '@/lib/suppliers/supplier-return';
const ret = await import('@/lib/suppliers/supplier-return');
const cfg = await import('@/lib/suppliers/supplier-fiche-config');
const val = await import('@/services/suppliers/supplier-validation');
const list = await import('@/services/suppliers/supplier-list.service');
const { conflictActions } = await import('@/components/suppliers/SupplierConflictsCard');
const { mergeById } = await import('@/components/suppliers/useSupplierSection');
const { documentSupplierState } = await import('@/components/assets/DocumentSupplierField');
const { supplierFormChanges } = await import('@/components/suppliers/SupplierCoordinatesCard');

const ROOT = process.cwd();
const lire = (p: string) => readFileSync(join(ROOT, p), 'utf8');

class MemStorage {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

describe('L109B-RET — retour contextuel', () => {
  it('RET-01 jetons, fiche désignée par un chemin ou un lien de même origine', () => {
    const t = ret.createReturnToken();
    expect(ret.isReturnToken(t)).toBe(true);
    expect(ret.isReturnToken('../x')).toBe(false);
    expect(ret.supplierIdFromPath('/fournisseurs/12')).toBe(12);
    expect(ret.supplierIdFromPath('/fournisseurs/12/')).toBe(12);
    expect(ret.supplierIdFromPath('/fournisseurs')).toBeNull();
    expect(ret.supplierIdFromPath('/fournisseurs/0')).toBeNull();
    expect(ret.supplierIdFromPath('/fournisseurs/12/agenda')).toBeNull();
    expect(ret.supplierIdFromHref('/fournisseurs/7?retour=abc', 'https://app.verebona.fr')).toBe(7);
    expect(ret.supplierIdFromHref('https://evil.example/fournisseurs/7', 'https://app.verebona.fr')).toBeNull();
  });

  it('RET-02 chemin de retour : interne seulement, `tiroir` retiré, jeton porté par la fiche', () => {
    expect(ret.isSafeInternalPath('/assets/3?tab=docs')).toBe(true);
    for (const p of ['//evil.com', 'https://evil.com', '/\\evil', '', 'javascript:alert(1)', '/a\u0000']) expect(ret.isSafeInternalPath(p), p).toBe(false);
    expect(ret.stripParams('/documents?q=edf&tiroir=document:4#x', ['tiroir'])).toBe('/documents?q=edf#x');
    const href = ret.withReturnParam('/fournisseurs/4', 'abcdefgh1234');
    expect(href).toBe('/fournisseurs/4?retour=abcdefgh1234');
    expect(ret.readReturnParam('?retour=abcdefgh1234')).toBe('abcdefgh1234');
    expect(ret.readReturnParam('?retour=https://evil')).toBeNull();
  });

  it('RET-03 libellé contextualisé : tiroir du dessus, Assistant, écran', () => {
    const L = (pathname: string, drawers: Array<{ kind: 'document' | 'equipement' | 'echeance' | 'piece'; id: number }> = [], assistant: AssistantReturnState | null = null) =>
      ret.returnLabel({ pathname, drawers, assistant });
    expect(L('/assets/3', [{ kind: 'equipement', id: 1 }])).toBe('Retour à l’équipement');
    expect(L('/assets/3', [{ kind: 'equipement', id: 1 }, { kind: 'document', id: 2 }])).toBe('Retour au document');
    expect(L('/agenda', [{ kind: 'echeance', id: 9 }])).toBe('Retour à l’événement');
    expect(L('/accueil', [], { open: true, threadShown: true, draft: '' })).toBe('Retour à l’Assistant');
    expect(L('/accueil', [], { open: true, threadShown: false, draft: 'edf' })).toBe('Retour à la recherche');
    expect(L('/fournisseurs')).toBe('Retour aux fournisseurs');
    expect(L('/fournisseurs/8')).toBe('Retour au fournisseur');
    expect(L('/assets/3')).toBe('Retour au bien');
    expect(L('/documents')).toBe('Retour aux documents');
    expect(L('/agenda')).toBe('Retour à l’Agenda');
    expect(L('/accueil/a-traiter')).toBe('Retour à « À traiter »');
    expect(ret.RETURN_FALLBACK_LABEL).toBe('Retour aux fournisseurs');
  });

  it('RET-04 tiroirs ouverts : ordre d’empilement, fermés et invalides ignorés', () => {
    const el = (v: string | null, state = 'open') => ({ getAttribute: (n: string) => (n === 'data-state' ? state : v) });
    expect(ret.openDrawersFrom([el('equipement:4'), el('document:9', 'closed'), el('x:1'), el('document:12')]))
      .toEqual([{ kind: 'equipement', id: 4 }, { kind: 'document', id: 12 }]);
    // Une fiche déjà présente revient au sommet (pas de doublon).
    expect(ret.openDrawersFrom([el('document:1'), el('equipement:2'), el('document:1')]))
      .toEqual([{ kind: 'equipement', id: 2 }, { kind: 'document', id: 1 }]);
  });

  it('RET-05 instantanés : stockage de session, validation, expiration, purge', () => {
    const st = new MemStorage();
    const now = Date.now();
    const ctx: SupplierReturnContext = {
      v: 1, token: 'abcdefgh1234', supplierId: 4, path: '/assets/3?tab=equipements', pathname: '/assets/3',
      drawers: [{ kind: 'equipement', id: 7 }], scrollTop: 420, label: 'Retour à l’équipement', view: null, assistant: null, savedAt: now,
    };
    expect(ret.saveReturnContext(ctx, st)).toBe(true);
    expect(ret.readReturnContext('abcdefgh1234', now, st)).toEqual(ctx);
    expect(ret.readReturnContext('abcdefgh1234', now + ret.RETURN_CONTEXT_TTL_MS + 1, st)).toBeNull();
    expect(ret.parseReturnContext({ ...ctx, path: 'https://evil.example/' }, now)).toBeNull();
    expect(ret.parseReturnContext({ ...ctx, drawers: [{ kind: 'bidon', id: 1 }, { kind: 'document', id: 3 }] }, now)?.drawers).toEqual([{ kind: 'document', id: 3 }]);
    for (let i = 0; i < ret.RETURN_CONTEXT_MAX + 5; i += 1) ret.saveReturnContext({ ...ctx, token: `tok${String(i).padStart(9, '0')}`, savedAt: now + i }, st);
    expect(st.length).toBe(ret.RETURN_CONTEXT_MAX);
    ret.purgeReturnContexts(st);
    expect(st.length).toBe(0);
  });

  describe('RET-06 navigation (fenêtre simulée)', () => {
    let storage: MemStorage;
    beforeEach(() => {
      storage = new MemStorage();
      ret.__resetSupplierReturnForTests();
      vi.stubGlobal('sessionStorage', storage);
      vi.stubGlobal('document', { querySelectorAll: () => [{ getAttribute: (n: string) => (n === 'data-state' ? 'open' : 'equipement:7') }], getElementById: () => ({ scrollTop: 310 }) });
      vi.stubGlobal('window', {
        location: { pathname: '/assets/3', search: '?tab=equipements', hash: '', origin: 'http://x', href: 'http://x/assets/3?tab=equipements' },
        sessionStorage: storage, history: { back: vi.fn(), go: vi.fn(), state: null, length: 3 }, addEventListener: () => {},
      });
    });
    afterEach(() => { vi.unstubAllGlobals(); ret.__resetSupplierReturnForTests(); });

    it('départ → arrivée liée → retour : instantané complet, bouton = retour arrière', () => {
      const push = vi.fn();
      ret.registerSupplierNavigator({ push, replace: vi.fn() });
      ret.navigateToSupplier(4);
      const href = push.mock.calls[0][0] as string;
      const token = ret.readReturnParam(href.split('?')[1]);
      expect(href).toMatch(/^\/fournisseurs\/4\?retour=/);
      const ctx = ret.readReturnContext(token)!;
      expect(ctx).toMatchObject({ path: '/assets/3?tab=equipements', drawers: [{ kind: 'equipement', id: 7 }], scrollTop: 310, label: 'Retour à l’équipement' });
      // Arrivée : rien à remplacer, jeton reconnu.
      const replace = vi.fn();
      expect(ret.bindSupplierArrival({ pathname: '/fournisseurs/4', search: `?retour=${token}` }, replace)).toBe(token);
      expect(replace).not.toHaveBeenCalled();
      expect(ret.canHistoryBack(token)).toBe(true);
      ret.goBackFromSupplier(`?retour=${token}`);
      expect((window.history.go as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(-1);
      // popstate vers l'écran de départ : restauration en attente pour CET écran seulement.
      expect(ret.notePopState(`http://x/fournisseurs/4?retour=${token}`, { pathname: '/documents' })).toBeNull();
      expect(ret.notePopState(`http://x/fournisseurs/4?retour=${token}`, { pathname: '/assets/3' })?.token).toBe(token);
      expect(ret.peekPendingRestore('/assets/3')?.drawers).toEqual([{ kind: 'equipement', id: 7 }]);
      expect(ret.takePendingRestore('/assets/3')?.token).toBe(token);
      expect(ret.peekPendingRestore('/assets/3')).toBeNull();
    });

    it('lien ordinaire (sans jeton) : jeton ajouté à l’arrivée ; autre fournisseur ou délai dépassé : rien', () => {
      const token = ret.captureSupplierOrigin(4)!;
      const replace = vi.fn();
      expect(ret.bindSupplierArrival({ pathname: '/fournisseurs/5', search: '' }, replace)).toBeNull();
      expect(ret.bindSupplierArrival({ pathname: '/fournisseurs/4', search: '?a=1' }, replace)).toBe(token);
      expect(replace).toHaveBeenCalledWith(`/fournisseurs/4?a=1&retour=${token}`);
      ret.captureSupplierOrigin(4);
      expect(ret.bindSupplierArrival({ pathname: '/fournisseurs/4', search: '' }, vi.fn(), Date.now() + ret.PENDING_CAPTURE_TTL_MS + 10)).toBeNull();
    });

    it('arrivée directe (lien partagé, autre onglet) : « Retour aux fournisseurs » ; onglet recopié : remplacement restauré', () => {
      const push = vi.fn(); const replace = vi.fn();
      ret.registerSupplierNavigator({ push, replace });
      expect(ret.supplierReturnState('?retour=zzzzzzzz1234').label).toBe('Retour aux fournisseurs');
      ret.goBackFromSupplier('?retour=zzzzzzzz1234');
      expect(push).toHaveBeenCalledWith('/fournisseurs');
      // Instantané présent mais fiche non ouverte dans cet onglet : remplacement + restauration.
      const token = ret.captureSupplierOrigin(4)!;
      ret.__resetSupplierReturnForTests();
      ret.registerSupplierNavigator({ push, replace });
      ret.goBackFromSupplier(`?retour=${token}`);
      expect(replace).toHaveBeenCalledWith('/assets/3?tab=equipements');
      expect(ret.peekPendingRestore('/assets/3')?.token).toBe(token);
    });

    it('garde de saisie morte au-dessus : le bouton la franchit (un seul appui)', () => {
      ret.registerSupplierNavigator({ push: vi.fn(), replace: vi.fn() });
      ret.navigateToSupplier(4);
      (window.history as { state: unknown }).state = { [ret.UNSAVED_GUARD_KEY]: true };
      const token = [...storage.m.values()].map((v) => JSON.parse(v).token)[0];
      ret.goBackFromSupplier(`?retour=${token}`);
      expect((window.history.go as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(-2);
    });

    it('Assistant : mémorisé seulement pour un départ DEPUIS l’Assistant', () => {
      const snap = { open: true, threadShown: true, draft: 'plombier' };
      ret.registerAssistantReturnPort({ snapshot: () => snap, restore: () => {} });
      const t1 = ret.captureSupplierOrigin(4)!;
      expect(ret.readReturnContext(t1)?.assistant).toBeNull();
      const t2 = ret.captureSupplierOrigin(4, { fromAssistant: true })!;
      expect(ret.readReturnContext(t2)?.assistant).toEqual(snap);
    });
  });
});

describe('L109B-VAL — coordonnées', () => {
  it('VAL-01 seuls les champs présents sont validés ; vide = effacé ; nom obligatoire', () => {
    expect(val.validateSupplierPatch({ email: '' })).toEqual({ ok: true, updates: { email: null } });
    expect(val.validateSupplierPatch({ name: '  A   B ' })).toEqual({ ok: true, updates: { name: 'A B' } });
    expect(val.validateSupplierPatch({ name: '' })).toMatchObject({ ok: false, field: 'name' });
    expect(val.validateSupplierPatch({ siren: '123 456 789' })).toEqual({ ok: true, updates: { siren: '123456789' } });
    expect(val.validateSupplierPatch({ siret: '1234' })).toMatchObject({ ok: false, field: 'siret' });
    expect(val.validateSupplierPatch({ email: 'pas-un-mail' })).toMatchObject({ ok: false, field: 'email' });
    expect(val.validateSupplierPatch({ iban: 'fr76 3000 6000 0112 3456 7890 189' })).toEqual({ ok: true, updates: { iban: 'FR7630006000011234567890189' } });
    expect(val.validateSupplierPatch({ iban: '1234' })).toMatchObject({ ok: false, field: 'iban' });
    expect(val.validateSupplierPatch({ contactStatus: 'verified', status: 'deleted' })).toEqual({ ok: true, updates: {} });
    expect(val.validateSupplierPatch({ name: 3 })).toMatchObject({ ok: false });
    expect(val.validateSupplierPatch(null)).toMatchObject({ ok: false });
  });

  it('VAL-02 liens actionnables sûrs ; IBAN masqué', () => {
    expect(val.websiteHref('dupont.fr')).toBe('https://dupont.fr/');
    expect(val.websiteHref('javascript:alert(1)')).toBeNull();
    expect(val.phoneHref('01 02 03 04 05')).toBe('tel:0102030405');
    expect(val.phoneHref('+33 (0)1 02')).toBe('tel:+33010' + '2');
    expect(cfg.maskIban('FR76 3000 6000 0112 3456 7890 189')).toBe('FR76 •••• •••• 0189');
    expect(cfg.maskIban('')).toBeNull();
    expect(cfg.maskIban(null)).toBeNull();
  });
});

describe('L109B-LIST — liste paginée', () => {
  it('LIST-01 paramètres bornés, motif ILIKE neutralisé', () => {
    const q = list.parseSupplierListQuery(new URLSearchParams({ search: ' edf ', status: 'bidon', sort: 'x', offset: '-3', limit: '9999' }));
    expect(q).toEqual({ search: 'edf', status: 'active', sort: 'name_asc', offset: 0, limit: 100 });
    expect(list.likePattern('100%_\\')).toBe('%100\\%\\_\\\\%');
    expect(cfg.suppliersListPath('', 'active', 'name_asc')).toBe('/fournisseurs');
    expect(cfg.suppliersListPath('edf', 'archived', 'recent')).toBe('/fournisseurs?q=edf&statut=archived&tri=recent');
  });

  it('LIST-02 total exact sur le MÊME périmètre que les lignes ; page suivante', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const run = async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('count(*)')) return [{ n: 120 }];
      return Array.from({ length: Number(params[params.length - 2]) }, (_, i) => ({ id: i + 1, name: `S${i}` }));
    };
    const page = await list.listSuppliers(10, { search: 'plomb', status: 'active', sort: 'name_asc', offset: 50, limit: 50 }, run);
    expect(page).toMatchObject({ total: 120, offset: 50, limit: 50, nextOffset: 100 });
    const [rows, count] = calls;
    const where = (s: string) => s.slice(s.indexOf('WHERE'), s.indexOf('ORDER') === -1 ? undefined : s.indexOf('ORDER')).replace(/\s+/g, ' ').trim();
    expect(where(rows.sql)).toBe(where(count.sql));
    expect(rows.params.slice(0, 2)).toEqual([10, 'active']);
    expect(count.params[0]).toBe(10);
    expect(rows.sql).not.toMatch(/iban|contact_status/);
  });
});

describe('L109B-UI — règles des écrans', () => {
  it('UI-01 conflit : IBAN ou champ non applicable → Garder / Ignorer seulement', () => {
    expect(conflictActions({ field: 'phone', masked: false, detectedValue: '06' })).toEqual(['keep_current', 'use_detected', 'ignored']);
    expect(conflictActions({ field: 'iban', masked: true, detectedValue: 'FR76 ••••' })).toEqual(['keep_current', 'ignored']);
    expect(conflictActions({ field: 'name', masked: false, detectedValue: 'X' })).toEqual(['keep_current', 'ignored']);
    expect(cfg.SUPPLIER_CONFLICT_APPLICABLE_FIELDS.addressLine1).toBe('address_line_1');
    expect(cfg.SUPPLIER_CONFLICT_APPLICABLE_FIELDS).not.toHaveProperty('iban');
  });

  it('UI-02 sections : fusion sans doublon ; état du fournisseur d’un document', () => {
    expect(mergeById([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }, { id: 3 }]).map((x) => x.id)).toEqual([1, 2, 3]);
    const l = (id: number) => ({ id, name: `S${id}`, status: 'active', role: null, isConfirmed: false, confidenceScore: null });
    expect(documentSupplierState(null)).toBe('loading');
    expect(documentSupplierState([])).toBe('none');
    expect(documentSupplierState([l(1)])).toBe('single');
    expect(documentSupplierState([l(1), l(2)])).toBe('multiple');
  });

  it('UI-03 modification : seuls les champs changés ; IBAN seulement ressaisi ou effacé', () => {
    const s = { id: 1, name: 'A', email: 'a@b.fr', phone: null, website: null, addressLine1: null, addressLine2: null, postalCode: null, city: null,
      country: null, siren: null, siret: null, vatNumber: null, hasIban: true, ibanMasked: 'FR76 •••• •••• 0189', ibanHolderName: null, source: 'manual', status: 'active' };
    const f = { name: 'A', email: 'a@b.fr', phone: '', website: '', addressLine1: '', addressLine2: '', postalCode: '', city: 'Lyon', country: '',
      siren: '', siret: '', vatNumber: '', ibanHolderName: '', iban: '', clearIban: false };
    expect(supplierFormChanges(s, f)).toEqual({ city: 'Lyon' });
    expect(supplierFormChanges(s, { ...f, city: '', iban: 'FR76X' })).toEqual({ iban: 'FR76X' });
    expect(supplierFormChanges(s, { ...f, city: '', clearIban: true })).toEqual({ iban: null });
  });
});

function fichiers(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'node_modules') fichiers(p, out); } else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

describe('L109B-STAT — invariants', () => {
  const sources = fichiers(join(ROOT, 'src')).filter((f) => !/__tests__|\.test\.|\.e2e\.|\/test\/e2e\//.test(f));

  it('STAT-01 tiroir fournisseur supprimé, aucun montage ni import', () => {
    expect(existsSync(join(ROOT, 'src/components/suppliers/SupplierDrawer.tsx'))).toBe(false);
    for (const f of sources) expect(readFileSync(f, 'utf8'), f).not.toMatch(/<SupplierDrawer\b|components\/suppliers\/SupplierDrawer/);
  });

  it('STAT-02 aucun statut global de vérification dans le code applicatif (hors migrations historiques)', () => {
    for (const f of sources) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/contactStatus|['"`]contact_status['"`]|contact_status,|contact_status\)/);
      expect(s, f).not.toMatch(/Partiellement vérifié|Coordonnées (non |partiellement )?vérifiées|Fournisseur (non )?vérifié|partially_verified/);
    }
    expect(lire('src/db/schema.ts')).not.toMatch(/text\('contact_status'\)/);
    const m = lire('src/db/migrations/1105_l109b_statut_fournisseur_retire.sql');
    expect(m).toMatch(/IF EXISTS/);
    expect(m).toMatch(/DROP DEFAULT/);
    expect(m).toMatch(/DROP NOT NULL/);
  });

  it('STAT-03 aucune création ni choix par nom au clic depuis un document ; équipement → fiche', () => {
    const dd = lire('src/components/assets/DocumentDrawer.tsx');
    expect(dd).not.toMatch(/api\/suppliers\?search=/);
    expect(dd).toMatch(/<DocumentSupplierField/);
    const field = lire('src/components/assets/DocumentSupplierField.tsx');
    expect(field).toMatch(/\/api\/documents\/\$\{documentId\}\/supplier/);
    // La création n'existe que dans l'action volontaire, après la vérification à blanc.
    expect(field.indexOf("dryRun: true")).toBeGreaterThan(-1);
    // Lot 113G : le corps de création peut porter la séparation décidée (« Créer quand même ») — préfixe comparé.
    expect(field.indexOf("'/api/suppliers', { name, source: 'manual'")).toBeGreaterThan(-1);
    expect(field.indexOf("dryRun: true")).toBeLessThan(field.indexOf("'/api/suppliers', { name, source: 'manual'"));
    const eq = lire('src/components/assets/EquipmentDrawer.tsx');
    expect(eq).toMatch(/kind="fournisseur"/);
    expect(eq).not.toMatch(/setSupplierDrawer/);
  });

  it('STAT-04 tiroirs repérables pour le retour ; gestionnaire monté dans la coquille', () => {
    for (const [f, kind] of [
      ['src/components/assets/DocumentDrawer.tsx', 'document'], ['src/components/assets/EquipmentDrawer.tsx', 'equipement'],
      ['src/components/assets/RoomDrawer.tsx', 'piece'], ['src/components/agenda/AgendaItemDrawer.tsx', 'echeance'],
    ] as const) expect(lire(f), f).toMatch(new RegExp(`data-return-drawer=\\{[^}]*\`${kind}:`));
    expect(lire('src/components/assets/EquipmentDrawer.tsx')).toContain('`equipement:${eq.id}`');
    expect(lire('src/components/DashboardLayout.tsx')).toMatch(/<SupplierReturnManager \/>/);
    expect(lire('src/components/drawers/GlobalDrawerHost.tsx')).toMatch(/RESTORE_DRAWER_STACK_EVENT/);
  });

  it('STAT-05 plus de plafonds silencieux (fiche 50, liste 100 / 20)', () => {
    expect(lire('src/services/suppliers/supplier-detail.service.ts')).not.toMatch(/LIMIT 50|SUPPLIER_DETAIL_LIMIT/);
    const route = lire('src/app/api/suppliers/route.ts');
    expect(route).not.toMatch(/\.limit\(100\)|\.limit\(20\)/);
    expect(lire('src/app/api/suppliers/[id]/route.ts')).not.toMatch(/\.limit\(50\)/);
  });

  it('STAT-06 point d’extension 109A nommé et branché sur la fiche', () => {
    expect(lire('src/services/suppliers/supplier-operation-documents.ts')).toMatch(/export async function listSupplierDocumentsViaOperation/);
    expect(lire('src/services/suppliers/supplier-detail.service.ts')).toMatch(/listSupplierDocumentsViaOperation\(accountId, supplierId, first\)/);
    // Jamais le mot « Opération » affiché.
    expect(lire('src/app/(dashboard)/fournisseurs/[id]/page.tsx')).not.toMatch(/>[^<]*Opération/);
  });
});
