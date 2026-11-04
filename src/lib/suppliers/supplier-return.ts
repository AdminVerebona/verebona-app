/**
 * Lot 109B — retour contextuel depuis la fiche fournisseur.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE BESOIN
 *
 * La fiche `/fournisseurs/[id]` est l'unique interface fournisseur. On y
 * arrive depuis un document, un équipement, un événement d'Agenda, un bien,
 * la liste, la recherche générale, l'Assistant ou une carte « À traiter ».
 * « Retour » doit rendre l'écran QUITTÉ : route, tiroir(s) ouvert(s),
 * onglet / recherche / filtres / tri (portés par l'adresse de l'écran),
 * position de défilement, Assistant ouvert — de la même façon par le bouton
 * de la fiche, le retour du navigateur et le geste retour du téléphone, y
 * compris après plusieurs allers-retours.
 *
 * LE MÉCANISME (fiable, sans URL de retour externe)
 *
 *  1. Au départ (clic sur un lien vers une fiche, ou `navigateToSupplier`),
 *     un INSTANTANÉ de l'écran est enregistré dans le stockage de SESSION de
 *     l'onglet sous un jeton opaque aléatoire : chemin interne, tiroirs
 *     ouverts (attribut `data-return-drawer` des tiroirs, ordre d'empilement),
 *     défilement de `#main-scroll-container`, état propre à l'écran
 *     (`registerReturnViewState`), état de l'Assistant.
 *  2. La fiche porte ce jeton dans son adresse (`?retour=<jeton>`) : un
 *     rechargement le retrouve. Le jeton n'est PAS une adresse : il ne
 *     désigne qu'un instantané de cet onglet. Un lien partagé, un favori ou
 *     un autre navigateur n'y trouvent rien → « Retour aux fournisseurs ».
 *  3. « Retour » de la fiche = `history.back()` quand l'entrée précédente
 *     est l'écran de départ (arrivée dans l'application) : bouton,
 *     navigateur et geste mobile font EXACTEMENT la même chose. Sinon
 *     (nouvel onglet avec instantané recopié) : remplacement par l'écran de
 *     départ, restauré.
 *  4. À l'arrivée sur l'écran de départ par un retour (événement `popstate`
 *     venant de la fiche, ou bouton), l'instantané est rejoué : tiroirs
 *     rouverts dans le même ordre (`router.back()` seul ne le peut pas : ils
 *     ont été démontés), défilement, Assistant.
 *
 * Isolation : instantanés effacés au changement de session ou de compte
 * (`verebona:session-changed`) ; chemin validé (interne, même origine) ;
 * l'instantané ne contient aucune donnée métier, seulement des identifiants
 * que les écrans relisent avec les droits du compte (un tiroir d'un objet
 * devenu inaccessible ne s'ouvre pas).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DRAWER_PARAM, parseDrawerParam, type DrawerKind } from '@/lib/drawers';
import { SUPPLIERS_ROUTE, supplierHref } from '@/lib/supplier-routes';

export const RETURN_PARAM = 'retour';
/** Entrée d'historique de garde des saisies non enregistrées (fiche). */
export const UNSAVED_GUARD_KEY = '__vbUnsavedGuard';
const STORE_PREFIX = 'verebona.fournisseur.retour.v1.';
/** Durée de vie d'un instantané (onglet) : une journée de travail. */
export const RETURN_CONTEXT_TTL_MS = 12 * 60 * 60 * 1000;
/** Instantanés conservés au plus (les plus anciens sont effacés). */
export const RETURN_CONTEXT_MAX = 40;
/** Délai entre le clic et l'arrivée sur la fiche pour rattacher l'instantané. */
export const PENDING_CAPTURE_TTL_MS = 15_000;
/** Tiroirs rouverts au plus (même borne que la pile des tiroirs). */
const MAX_DRAWERS = 6;

export interface ReturnDrawer { kind: DrawerKind; id: number }

export interface AssistantReturnState {
  open: boolean;
  threadShown: boolean;
  draft: string;
}

export interface SupplierReturnContext {
  v: 1;
  token: string;
  supplierId: number;
  /** Chemin interne de l'écran quitté (avec sa recherche, sans `?tiroir=`). */
  path: string;
  pathname: string;
  drawers: ReturnDrawer[];
  scrollTop: number;
  label: string;
  /** État propre à l'écran (sections chargées, etc.), opaque. */
  view: Record<string, unknown> | null;
  assistant: AssistantReturnState | null;
  savedAt: number;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & Partial<Pick<Storage, 'length' | 'key'>>;

// ─── Fonctions pures (testées) ───────────────────────────────────────────────

const TOKEN_RE = /^[a-z0-9]{8,24}$/;

export function isReturnToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

export function createReturnToken(rand: () => number = Math.random): string {
  let t = '';
  while (t.length < 12) t += Math.floor(rand() * 36).toString(36);
  return t.slice(0, 12);
}

/** Identifiant de la fiche désignée par un chemin `/fournisseurs/<id>`, sinon null. */
export function supplierIdFromPath(pathname: string | null | undefined): number | null {
  const m = /^\/fournisseurs\/(\d{1,10})\/?$/.exec(pathname ?? '');
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Fiche désignée par un lien (relatif ou de même origine), sinon null. */
export function supplierIdFromHref(href: string | null | undefined, origin?: string): number | null {
  if (!href) return null;
  try {
    const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    const u = new URL(href, base);
    if (u.origin !== new URL(base).origin) return null;
    return supplierIdFromPath(u.pathname);
  } catch {
    return null;
  }
}

/** Chemin interne sûr : commence par un seul « / », sans schéma ni hôte. */
export function isSafeInternalPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 2000) return false;
  if (!p.startsWith('/') || p.startsWith('//') || p.startsWith('/\\')) return false;
  return !/[\u0000-\u001f]/.test(p);
}

/** Retire des paramètres d'un chemin interne (le tiroir est rouvert par l'instantané). */
export function stripParams(path: string, names: readonly string[]): string {
  const [beforeHash, hash = ''] = path.split('#');
  const [base, query = ''] = beforeHash.split('?');
  const params = new URLSearchParams(query);
  for (const n of names) params.delete(n);
  const q = params.toString();
  return `${base}${q ? `?${q}` : ''}${hash ? `#${hash}` : ''}`;
}

/** Adresse de la fiche portant le jeton de retour. */
export function withReturnParam(href: string, token: string): string {
  const [base, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  params.set(RETURN_PARAM, token);
  return `${base}?${params.toString()}`;
}

export function readReturnParam(search: string | null | undefined): string | null {
  const t = new URLSearchParams(search ?? '').get(RETURN_PARAM);
  return isReturnToken(t) ? t : null;
}

const DRAWER_LABELS: Record<DrawerKind, string> = {
  document: 'Retour au document',
  equipement: 'Retour à l’équipement',
  echeance: 'Retour à l’événement',
  piece: 'Retour à la pièce',
};

/** Libellé du bouton « Retour » selon l'écran quitté. */
export function returnLabel(o: { pathname: string; drawers: readonly ReturnDrawer[]; assistant?: AssistantReturnState | null }): string {
  const top = o.drawers[o.drawers.length - 1];
  if (top) return DRAWER_LABELS[top.kind];
  if (o.assistant?.open) return o.assistant.threadShown ? 'Retour à l’Assistant' : 'Retour à la recherche';
  const p = o.pathname.replace(/\/+$/, '') || '/';
  if (p === SUPPLIERS_ROUTE) return 'Retour aux fournisseurs';
  if (supplierIdFromPath(p)) return 'Retour au fournisseur';
  if (/^\/assets\/[^/]+$/.test(p)) return 'Retour au bien';
  if (p === '/assets') return 'Retour aux biens';
  if (/^\/documents\/[^/]+$/.test(p)) return 'Retour au document';
  if (p === '/documents') return 'Retour aux documents';
  if (p.startsWith('/agenda')) return 'Retour à l’Agenda';
  if (p.endsWith('/a-traiter')) return 'Retour à « À traiter »';
  if (p === '/accueil' || p === '/dashboard') return 'Retour à l’accueil';
  return 'Retour';
}

/** Libellé de repli : arrivée directe (lien, favori, rechargement sans instantané). */
export const RETURN_FALLBACK_LABEL = 'Retour aux fournisseurs';

/** Valide un instantané lu ; `null` s'il est absent, expiré ou malformé. */
export function parseReturnContext(raw: unknown, now: number): SupplierReturnContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || !isReturnToken(o.token) || typeof o.savedAt !== 'number') return null;
  if (now - o.savedAt > RETURN_CONTEXT_TTL_MS || o.savedAt > now + 60_000) return null;
  const supplierId = Number(o.supplierId);
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) return null;
  if (!isSafeInternalPath(o.path) || !isSafeInternalPath(o.pathname)) return null;
  const drawers: ReturnDrawer[] = [];
  if (Array.isArray(o.drawers)) {
    for (const d of o.drawers.slice(0, MAX_DRAWERS)) {
      const t = d && typeof d === 'object' ? parseDrawerParam(`${(d as ReturnDrawer).kind}:${(d as ReturnDrawer).id}`) : null;
      if (t) drawers.push({ kind: t.kind, id: t.id });
    }
  }
  const a = o.assistant as Record<string, unknown> | null | undefined;
  const assistant = a && typeof a === 'object' && typeof a.open === 'boolean'
    ? { open: a.open, threadShown: a.threadShown === true, draft: typeof a.draft === 'string' ? a.draft.slice(0, 500) : '' }
    : null;
  return {
    v: 1, token: o.token, supplierId, path: o.path, pathname: o.pathname, drawers,
    scrollTop: typeof o.scrollTop === 'number' && Number.isFinite(o.scrollTop) && o.scrollTop > 0 ? Math.round(o.scrollTop) : 0,
    label: typeof o.label === 'string' && o.label.length <= 80 ? o.label : returnLabel({ pathname: o.pathname, drawers, assistant }),
    view: o.view && typeof o.view === 'object' && !Array.isArray(o.view) ? (o.view as Record<string, unknown>) : null,
    assistant,
    savedAt: o.savedAt,
  };
}

/** Tiroirs ouverts, dans l'ordre d'empilement (éléments portant `data-return-drawer`). */
export function openDrawersFrom(elements: ArrayLike<{ getAttribute(n: string): string | null }>): ReturnDrawer[] {
  const out: ReturnDrawer[] = [];
  for (const el of Array.from(elements)) {
    if (el.getAttribute('data-state') && el.getAttribute('data-state') !== 'open') continue;
    const t = parseDrawerParam(el.getAttribute('data-return-drawer'));
    if (!t) continue;
    const at = out.findIndex((d) => d.kind === t.kind && d.id === t.id);
    if (at !== -1) out.splice(at, 1);
    out.push({ kind: t.kind, id: t.id });
  }
  return out.slice(-MAX_DRAWERS);
}

// ─── Stockage de session ─────────────────────────────────────────────────────

function storageOrNull(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function saveReturnContext(ctx: SupplierReturnContext, storage?: StorageLike | null): boolean {
  const s = storageOrNull(storage);
  if (!s) return false;
  try {
    s.setItem(STORE_PREFIX + ctx.token, JSON.stringify(ctx));
    pruneReturnContexts(s);
    return true;
  } catch {
    return false;
  }
}

export function readReturnContext(token: string | null | undefined, now = Date.now(), storage?: StorageLike | null): SupplierReturnContext | null {
  if (!isReturnToken(token)) return null;
  const s = storageOrNull(storage);
  if (!s) return null;
  try {
    const raw = s.getItem(STORE_PREFIX + token);
    const ctx = raw ? parseReturnContext(JSON.parse(raw), now) : null;
    return ctx && ctx.token === token ? ctx : null;
  } catch {
    return null;
  }
}

function keysOf(s: StorageLike): string[] {
  const out: string[] = [];
  if (typeof s.length !== 'number' || typeof s.key !== 'function') return out;
  for (let i = 0; i < s.length; i += 1) {
    const k = s.key(i);
    if (k && k.startsWith(STORE_PREFIX)) out.push(k);
  }
  return out;
}

function pruneReturnContexts(s: StorageLike, now = Date.now()): void {
  const entries = keysOf(s).map((k) => {
    try {
      const v = JSON.parse(s.getItem(k) ?? 'null') as { savedAt?: number } | null;
      return { k, at: typeof v?.savedAt === 'number' ? v.savedAt : 0 };
    } catch {
      return { k, at: 0 };
    }
  });
  const expired = entries.filter((e) => now - e.at > RETURN_CONTEXT_TTL_MS);
  const live = entries.filter((e) => now - e.at <= RETURN_CONTEXT_TTL_MS).sort((a, b) => b.at - a.at);
  for (const e of [...expired, ...live.slice(RETURN_CONTEXT_MAX)]) s.removeItem(e.k);
}

/** Efface tous les instantanés (changement de session ou de compte). */
export function purgeReturnContexts(storage?: StorageLike | null): void {
  const s = storageOrNull(storage);
  if (!s) return;
  try {
    for (const k of keysOf(s)) s.removeItem(k);
  } catch { /* stockage indisponible */ }
  pending = null;
  pendingRestore = null;
  arrived.clear();
}

// ─── État de l'onglet (navigateur) ───────────────────────────────────────────

interface Nav { push(href: string): void; replace(href: string): void }
let nav: Nav | null = null;
let pending: { ctx: SupplierReturnContext; at: number } | null = null;
let pendingRestore: SupplierReturnContext | null = null;
/** Jetons dont la fiche a été ouverte DANS cet onglet (l'entrée précédente est l'écran de départ). */
const arrived = new Set<string>();
const viewProviders = new Map<string, () => Record<string, unknown> | null>();
let assistantPort: { snapshot(): AssistantReturnState | null; restore(s: AssistantReturnState): void } | null = null;

export const RETURN_RESTORED_EVENT = 'verebona:supplier-return-restored';
/** Conteneur de l'Assistant (ordinateur et téléphone) — `VerebonaField`. */
export const ASSISTANT_CONTAINER_SELECTOR = '#verebona-espace';

/** Monté par `SupplierReturnManager` (routeur Next de la coquille). */
export function registerSupplierNavigator(n: Nav | null): void { nav = n; }

/** Écran : état à rejouer au retour (ex. sections chargées), lu au départ. */
export function registerReturnViewState(pathname: string, getter: () => Record<string, unknown> | null): () => void {
  viewProviders.set(pathname, getter);
  return () => { if (viewProviders.get(pathname) === getter) viewProviders.delete(pathname); };
}

/** Assistant : instantané (ouvert, fil affiché, saisie) et restauration. */
export function registerAssistantReturnPort(p: typeof assistantPort): () => void {
  assistantPort = p;
  return () => { if (assistantPort === p) assistantPort = null; };
}

export function restoreAssistant(s: AssistantReturnState): void {
  assistantPort?.restore(s);
}

function scrollContainer(): HTMLElement | null {
  return typeof document !== 'undefined' ? document.getElementById('main-scroll-container') : null;
}

/** Enregistre l'instantané de l'écran courant avant d'ouvrir la fiche `supplierId`. */
/**
 * `fromAssistant` : le départ a lieu DANS l'Assistant (carte, lien d'une
 * réponse) — son état est alors mémorisé et rétabli au retour. Un lien de la
 * page, Assistant ouvert ou non, ne le mémorise pas.
 */
export function captureSupplierOrigin(
  supplierId: number,
  opts: { assistant?: AssistantReturnState | null; fromAssistant?: boolean } = {},
): string | null {
  if (typeof window === 'undefined' || !Number.isSafeInteger(supplierId) || supplierId <= 0) return null;
  const { pathname, search, hash } = window.location;
  const path = stripParams(`${pathname}${search}${hash}`, [DRAWER_PARAM]);
  if (!isSafeInternalPath(path)) return null;
  const drawers = openDrawersFrom(document.querySelectorAll('[data-return-drawer]'));
  let assistant: AssistantReturnState | null = opts.assistant ?? null;
  if (!assistant && opts.fromAssistant) {
    try { assistant = assistantPort?.snapshot() ?? null; } catch { assistant = null; }
  }
  if (assistant && !assistant.open) assistant = null;
  let view: Record<string, unknown> | null = null;
  try { view = viewProviders.get(pathname)?.() ?? null; } catch { view = null; }
  const ctx: SupplierReturnContext = {
    v: 1, token: createReturnToken(), supplierId, path, pathname, drawers,
    scrollTop: Math.round(scrollContainer()?.scrollTop ?? 0),
    label: returnLabel({ pathname, drawers, assistant }),
    view, assistant, savedAt: Date.now(),
  };
  saveReturnContext(ctx);
  pending = { ctx, at: Date.now() };
  return ctx.token;
}

/** Ouvre la fiche (navigation dans l'application) en mémorisant le point de départ. */
export function navigateToSupplier(supplierId: number, opts: { assistant?: AssistantReturnState | null; fromAssistant?: boolean } = {}): void {
  const token = captureSupplierOrigin(supplierId, opts);
  const href = token ? withReturnParam(supplierHref(supplierId), token) : supplierHref(supplierId);
  if (token) arrived.add(token);
  if (nav) nav.push(href);
  else if (typeof window !== 'undefined') window.location.assign(href);
}

/**
 * Arrivée sur une page : rattache l'instantané en attente à la fiche ouverte
 * (jeton ajouté à l'adresse si le lien d'origine ne le portait pas). Rend le
 * jeton de la fiche, ou null. `replace` remplace l'adresse sans navigation.
 */
export function bindSupplierArrival(
  loc: { pathname: string; search: string; hash?: string },
  replace: (url: string) => void,
  now = Date.now(),
): string | null {
  const id = supplierIdFromPath(loc.pathname);
  if (!id) return null;
  const inUrl = readReturnParam(loc.search);
  const p = pending;
  if (p && now - p.at <= PENDING_CAPTURE_TTL_MS && p.ctx.supplierId === id) {
    pending = null;
    arrived.add(p.ctx.token);
    if (inUrl !== p.ctx.token) {
      const params = new URLSearchParams(loc.search);
      params.set(RETURN_PARAM, p.ctx.token);
      replace(`${loc.pathname}?${params.toString()}${loc.hash ?? ''}`);
    }
    return p.ctx.token;
  }
  return inUrl;
}

/** `popstate` : quitte-t-on une fiche vers son écran de départ ? */
export function notePopState(prevHref: string | null, loc: { pathname: string }): SupplierReturnContext | null {
  if (!prevHref) return null;
  let prev: URL;
  try { prev = new URL(prevHref, 'http://x'); } catch { return null; }
  if (!supplierIdFromPath(prev.pathname)) return null;
  const ctx = readReturnContext(readReturnParam(prev.search));
  if (!ctx || ctx.pathname !== loc.pathname) return null;
  pendingRestore = ctx;
  return ctx;
}

/** Restauration en attente pour cet écran (lue par l'écran au montage). */
export function peekPendingRestore(pathname: string): SupplierReturnContext | null {
  return pendingRestore && pendingRestore.pathname === pathname ? pendingRestore : null;
}

export function takePendingRestore(pathname: string): SupplierReturnContext | null {
  const r = peekPendingRestore(pathname);
  if (r) pendingRestore = null;
  return r;
}

function isReloadNavigation(): boolean {
  try {
    const e = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return e?.type === 'reload';
  } catch {
    return false;
  }
}

/** Le bouton « Retour » peut-il simplement revenir en arrière dans l'historique ? */
export function canHistoryBack(token: string | null): boolean {
  if (!token || typeof window === 'undefined') return false;
  if (arrived.has(token)) return true;
  // Fiche rechargée : l'historique de l'onglet est intact.
  return isReloadNavigation() && window.history.length > 1;
}

/** Contexte de retour de la fiche ouverte (jeton de l'adresse). */
export function supplierReturnState(search: string): { token: string | null; ctx: SupplierReturnContext | null; label: string } {
  const token = readReturnParam(search);
  const ctx = readReturnContext(token);
  return { token, ctx, label: ctx?.label ?? RETURN_FALLBACK_LABEL };
}

/** « Retour » de la fiche (même effet que le retour du navigateur quand c'est possible). */
export function goBackFromSupplier(search: string): void {
  const { token, ctx } = supplierReturnState(search);
  if (ctx && canHistoryBack(token)) {
    // Garde de saisie morte au-dessus (voir useUnsavedChangesGuard) : franchie aussi.
    const st = window.history.state as Record<string, unknown> | null;
    window.history.go(st && st[UNSAVED_GUARD_KEY] === true ? -2 : -1);
    return;
  }
  if (ctx) {
    pendingRestore = ctx;
    if (nav) nav.replace(ctx.path); else window.location.assign(ctx.path);
    return;
  }
  if (nav) nav.push(SUPPLIERS_ROUTE); else window.location.assign(SUPPLIERS_ROUTE);
}

export function __resetSupplierReturnForTests(): void {
  pending = null;
  pendingRestore = null;
  arrived.clear();
  viewProviders.clear();
  assistantPort = null;
  nav = null;
}

if (typeof window !== 'undefined') {
  window.addEventListener('verebona:session-changed', () => purgeReturnContexts());
}
