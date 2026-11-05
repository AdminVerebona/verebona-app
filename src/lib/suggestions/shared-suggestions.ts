'use client';
/**
 * Suggestions PARTAGÉES côté navigateur — lot 108J.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE LISTE POUR LES DEUX SURFACES
 *
 * L'accueil (zone sous la bulle) et l'état initial de « Demander à
 * Verebona » (ordinateur et mobile) lisent le MÊME magasin : une seule
 * lecture de GET /api/suggestions, une seule version, le même ordre. Un clic
 * sur une suggestion la remplace AUSSITÔT, dans les deux surfaces, par la
 * suivante de la réserve déjà validée par le serveur — aucun appel IA,
 * aucune relecture, aucun scintillement. Le serveur enregistre la
 * consultation quand la question part (rotation seulement).
 *
 *   · liée à l'époque de session : changement de compte, de membre Duo ou
 *     déconnexion → magasin vidé (jamais les suggestions d'un autre compte) ;
 *   · relue après un événement qui change les faits pertinents (document
 *     ajouté, analysé, supprimé, échéance modifiée…), temporisée ; la liste
 *     affichée reste en place pendant la relecture ;
 *   · lecture impossible et rien en mémoire : repli éditorial SÛR (questions
 *     de prise en main, aucune donnée personnelle) — jamais d'écran vide.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { getSessionEpoch } from '@/lib/session/session-lifecycle';
import { GUIDE_STOCK, SAFE_FALLBACK_GUIDE_IDS } from '@/services/suggestions/shared/stock';

export interface SharedSuggestionItem {
  id: string;
  label: string;
  objective: 'EXPLOIT' | 'ANTICIPATE' | 'GUIDE';
  source: 'ACCOUNT_DATA' | 'HELP_CENTER' | 'RESOURCES';
  assetId?: number;
}

export interface SharedSuggestionsState {
  status: 'idle' | 'loading' | 'ready' | 'fallback';
  version: string | null;
  items: SharedSuggestionItem[];
  reserve: SharedSuggestionItem[];
}

/** Relecture si la liste a plus de… */
export const SHARED_SUGGESTIONS_MAX_AGE_MS = 10 * 60_000;
/** Temporisation des relectures après une rafale d'événements. */
export const SHARED_SUGGESTIONS_DEBOUNCE_MS = 2_000;

/** Événements du front qui changent des faits pertinents (mêmes que la mascotte). */
export const SHARED_SUGGESTIONS_REFRESH_EVENTS = [
  'document-added', 'document-deleted', 'document-analysis-complete', 'agenda-mutated', 'verebona:data-mutated', 'asset-details-updated',
] as const;

/** Repli éditorial sûr (aucune donnée personnelle), identique aux questions de prise en main du serveur. */
export function fallbackSuggestions(): SharedSuggestionItem[] {
  return SAFE_FALLBACK_GUIDE_IDS
    .map((id) => GUIDE_STOCK.find((e) => e.id === id))
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map((e) => ({ id: e.id, label: e.label, objective: 'GUIDE' as const, source: e.corpus === 'HELP' ? 'HELP_CENTER' as const : 'RESOURCES' as const }));
}

/**
 * Remplacement après un clic (pur, testé) : la suggestion cliquée laisse sa
 * place, au même rang, à la première suggestion de la réserve qui n'est pas
 * déjà affichée ; sans réserve, elle reste (jamais de zone qui se vide).
 */
export function replaceConsumed(s: Pick<SharedSuggestionsState, 'items' | 'reserve'>, id: string): Pick<SharedSuggestionsState, 'items' | 'reserve'> {
  const i = s.items.findIndex((x) => x.id === id);
  if (i < 0) return s;
  const affiches = new Set(s.items.map((x) => x.id));
  const j = s.reserve.findIndex((x) => !affiches.has(x.id));
  if (j < 0) return s;
  const items = [...s.items];
  const [suivante] = s.reserve.slice(j, j + 1);
  items[i] = suivante;
  // La cliquée part en fin de réserve : elle pourra revenir plus tard.
  const reserve = [...s.reserve.slice(0, j), ...s.reserve.slice(j + 1), s.items[i]];
  return { items, reserve };
}

// ── Magasin (une instance par onglet) ──────────────────────────────────────

let state: SharedSuggestionsState = { status: 'idle', version: null, items: [], reserve: [] };
let meta: { at: number; epoch: number } = { at: 0, epoch: -1 };
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
/**
 * Lot 110C : surfaces qui AFFICHENT les suggestions en ce moment (rangée de
 * l'accueil large, « Demander à Verebona » ouvert). Sans aucune surface
 * active (accueil mobile, espace fermé), un événement de données ne relit
 * pas : la liste est seulement marquée périmée et relue à la prochaine
 * activation.
 */
let activeSurfaces = 0;

function emit(next: SharedSuggestionsState) {
  state = next;
  listeners.forEach((l) => l());
}

async function fetchSelection(): Promise<void> {
  const epoch = getSessionEpoch();
  try {
    const res = await fetch('/api/suggestions', { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json() as { version?: string; items?: SharedSuggestionItem[]; reserve?: SharedSuggestionItem[] };
    if (epoch !== getSessionEpoch()) return; // réponse d'une autre session : ignorée
    if (!Array.isArray(data.items)) throw new Error('réponse illisible');
    const items = data.items;
    meta = { at: Date.now(), epoch };
    // Même version : la liste affichée (et ses remplacements) reste en place.
    if (data.version && data.version === state.version && state.status === 'ready') return;
    // Lot 111L : la sélection CANONIQUE est servie telle quelle, même courte
    // (moins de trois questions de qualité : jamais de remplissage côté
    // navigateur). Le repli sûr ne sert qu'en cas d'échec de lecture.
    emit({ status: 'ready', version: data.version ?? null, items, reserve: Array.isArray(data.reserve) ? data.reserve : [] });
  } catch {
    if (epoch !== getSessionEpoch()) return;
    meta = { at: Date.now(), epoch };
    // Une liste déjà affichée reste ; sinon, le repli sûr (jamais d'écran vide).
    if (state.items.length === 0) emit({ status: 'fallback', version: null, items: fallbackSuggestions(), reserve: [] });
  }
}

/** Lecture si nécessaire (absente, trop ancienne, autre session) ; une seule à la fois. */
export function ensureSharedSuggestions(force = false): Promise<void> {
  const epoch = getSessionEpoch();
  if (meta.epoch !== epoch) {
    // Autre compte / membre : rien de l'ancienne session n'est montré.
    state = { status: 'loading', version: null, items: [], reserve: [] };
    listeners.forEach((l) => l());
  }
  const frais = meta.epoch === epoch && Date.now() - meta.at < SHARED_SUGGESTIONS_MAX_AGE_MS && state.items.length > 0;
  if (frais && !force) return Promise.resolve();
  if (state.status === 'idle') emit({ ...state, status: 'loading' });
  return (inflight ??= fetchSelection().finally(() => { inflight = null; }));
}

/** Relecture temporisée (événements de données). */
export function scheduleSharedSuggestionsRefresh(ms = SHARED_SUGGESTIONS_DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (activeSurfaces > 0) void ensureSharedSuggestions(true);
    else meta = { ...meta, at: 0 }; // périmée : relue à la prochaine ouverture d'une surface
  }, ms);
}

/** État courant du magasin (tests et diagnostic ; les surfaces passent par `useSharedSuggestions`). */
export function sharedSuggestionsSnapshot(): SharedSuggestionsState {
  return state;
}

/** Nombre de surfaces actives (tests et diagnostic). */
export function activeSharedSuggestionSurfaces(): number {
  return activeSurfaces;
}

/** Clic : remplacement immédiat dans les deux surfaces (aucun appel). */
export function consumeSharedSuggestion(id: string): void {
  const r = replaceConsumed(state, id);
  if (r.items !== state.items) emit({ ...state, ...r });
}

/** Réservé aux tests et aux transitions de session. */
export function resetSharedSuggestions(): void {
  state = { status: 'idle', version: null, items: [], reserve: [] };
  meta = { at: 0, epoch: -1 };
  inflight = null;
  // `activeSurfaces` reste : il suit les surfaces montées, pas la session.
  if (timer) clearTimeout(timer);
  timer = null;
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  window.addEventListener('verebona:session-changed', resetSharedSuggestions);
  window.addEventListener('storage', (e) => { if (e.key === 'user' || e.key === null) resetSharedSuggestions(); });
  for (const ev of SHARED_SUGGESTIONS_REFRESH_EVENTS) window.addEventListener(ev, () => scheduleSharedSuggestionsRefresh());
}

const SERVER_STATE: SharedSuggestionsState = { status: 'idle', version: null, items: [], reserve: [] };

// ── Télémétrie « affiché / cliqué » (supervision de l'absence de rendu) ────

function newVisitId(): string {
  try { return crypto.randomUUID(); } catch { return `v-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
}

function sendEvents(visitId: string, events: Array<{ id: string; objective: string; eventType: 'displayed' | 'clicked' }>) {
  if (!events.length) return;
  void fetch('/api/home/mascot/events', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ events: events.map((e) => ({ visitId, occurrenceKey: `SUG:${e.id}`, sourceCode: `SUG-${e.objective}`, placement: 'secondary', eventType: e.eventType, actionId: `SUG:${e.id}:ask` })) }),
  }).catch(() => {});
}

/**
 * Suggestions partagées pour une surface. `active` : la surface est visible
 * (l'espace « Demander à Verebona » ouvert, la rangée de l'accueil large —
 * lot 110C : jamais l'accueil mobile) — la lecture part alors si nécessaire ;
 * inactive, la surface ne lit RIEN. `track` : télémétrie « affiché » (accueil).
 */
export function useSharedSuggestions(opts: { active?: boolean; track?: boolean } = {}) {
  const active = opts.active !== false;
  const snap = useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
    () => SERVER_STATE,
  );
  useEffect(() => {
    if (!active) return;
    activeSurfaces += 1;
    void ensureSharedSuggestions();
    return () => { activeSurfaces -= 1; };
  }, [active]);
  const visit = useRef<{ id: string; vus: Set<string> } | null>(null);
  useEffect(() => {
    if (!opts.track || !active || snap.items.length === 0) return;
    visit.current ??= { id: newVisitId(), vus: new Set() };
    const v = visit.current;
    const nouveaux = snap.items.filter((x) => !v.vus.has(x.id));
    nouveaux.forEach((x) => v.vus.add(x.id));
    sendEvents(v.id, nouveaux.map((x) => ({ id: x.id, objective: x.objective, eventType: 'displayed' })));
  }, [snap.items, opts.track, active]);

  /**
   * Clic : la suggestion est remplacée dans les deux surfaces ; rend le
   * contexte à transmettre avec la question (revalidé par le serveur).
   */
  const pick = useCallback((s: SharedSuggestionItem): Record<string, string> => {
    if (opts.track && visit.current) sendEvents(visit.current.id, [{ id: s.id, objective: s.objective, eventType: 'clicked' }]);
    consumeSharedSuggestion(s.id);
    return { suggestionId: s.id, ...(state.version ? { suggestionVersion: state.version } : {}) };
  }, [opts.track]);

  return { status: snap.status, version: snap.version, items: snap.items, pick };
}
