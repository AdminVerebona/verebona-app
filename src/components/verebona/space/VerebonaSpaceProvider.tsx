'use client';
/**
 * Champ Verebona + espace de réponse unique — Direction D v2 §5 à §8.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL CHAMP, UN SEUL ESPACE, SUR TOUTES LES PAGES
 *
 * Remplace la loupe de recherche indépendante et le tiroir latéral de
 * l'assistant. Monté une fois dans la coquille authentifiée : le champ du
 * header (desktop), la pilule de la barre haute (mobile), les tuiles et les
 * suggestions de l'accueil, le centre d'aide, le tiroir document… passent
 * tous par la même fonction `ask`, avec le contexte de la page courante.
 *
 * Le routage réel de l'assistant est conservé (`useVerebona` →
 * `/api/verebona/messages`) : l'utilisateur ne choisit jamais le moteur.
 *
 * Continuité : un fil = un échange suivi ; « Nouvelle demande » archive le
 * fil (il reste dans « Demandes précédentes ») et repart vide ; « Reprendre »
 * rouvre un fil archivé avec tout son contexte.
 *
 * POP-UP DU CHAMP (2 oct. 2026) : chaque ouverture affiche les suggestions
 * puis les 3 dernières recherches (une ligne, corbeille) — jamais le dernier
 * échange. Une question posée depuis cet écran démarre une nouvelle
 * recherche ; un clic sur une recherche récente rouvre son échange.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useVerebona } from '@/lib/verebona/useVerebona';
import { useWriteGuard } from '@/contexts/WriteGuardContext';
import { buildPageContext } from '@/lib/verebona/page-context';
import {
  buildTurns, previousRequests, recentSearches, spacePose,
  type MascotPoseName, type PreviousRequestRow, type RecentSearchRow, type SpaceObject, type SpaceTurn,
} from '@/lib/verebona/space';
import {
  LIVE_DEBOUNCE_MS, LIVE_MIN_CHARS, moveActive, navMatches, toLiveResults, type LiveResult,
} from '@/lib/verebona/live-search';
import { openDrawer } from '@/lib/drawers';
import { trackAssistantUsage } from '@/lib/verebona/usage-events';
import { suggestionsForRoute } from '@/services/verebona-assistant/registries/capability-registry';
import { useIsDesktop, useReducedMotion } from '@/hooks/useMediaQuery';

/** Réponse construite par l'interface (sujet de la mascotte, parcours d'ajout). */
export interface LocalExchange {
  question: string;
  content: string;
  kind?: import('@/lib/verebona/space').AnswerKind;
  tone?: 'neutral' | 'success';
  summary?: string;
  objects?: Array<Omit<SpaceObject, 'actionId'> & { onOpen?: () => void }>;
  actions?: Array<{ label: string; primary?: boolean; run: () => void }>;
}

export interface VerebonaSpaceApi {
  v: ReturnType<typeof useVerebona>;
  turns: SpaceTurn[];
  isOpen: boolean;
  isDesktop: boolean;
  reducedMotion: boolean;
  pose: MascotPoseName;
  /** Recherches récentes du pop-up (3 au plus, fil courant compris). */
  recent: RecentSearchRow[];
  /** Supprime une recherche récente, sans confirmation ; la suivante remonte. */
  removeRecent: (id: number) => void;
  /**
   * L'échange en cours est-il affiché ? Faux à chaque ouverture (pop-up :
   * suggestions + recherches récentes), vrai après une question ou une reprise.
   */
  showThread: boolean;
  /** Toutes les demandes (vue « Toutes les demandes »), sans le fil courant. */
  allPrevious: PreviousRequestRow[];
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  suggestions: Array<{ id: string; label: string }>;
  /** Saisie du champ, partagée par le champ desktop et le champ mobile. */
  draft: string;
  setDraft: (text: string) => void;
  /** Suggestions pendant la frappe (biens, documents, échéances, pages). */
  live: LiveResult[];
  liveLoading: boolean;
  /** Suggestion choisie au clavier (-1 : aucune, « Entrée » demande à Verebona). */
  activeLive: number;
  moveLive: (delta: 1 | -1) => void;
  openLive: (r: LiveResult) => void;
  /** Ouvre l'espace (sans garde : ouvrir n'écrit rien) ; le champ reçoit le focus. */
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** Ferme l'espace plein écran (mobile) avant d'ouvrir un tiroir ou une fenêtre. */
  leaveForOverlay: () => void;
  /** Envoie une demande au moteur réel, avec le contexte de la page. */
  ask: (question: string, context?: Record<string, string>) => false | Promise<boolean>;
  /** Ajoute un échange construit par l'interface, et ouvre l'espace. */
  askLocal: (exchange: LocalExchange) => void;
  runLocal: (id: string) => void;
  /** Exécute une écriture (confirmation, clarification…) après la garde. */
  guard: (fn: () => void) => void;
  /** « Nouvelle demande » : archive le fil courant (§8). */
  newRequest: () => void;
  /** « Reprendre » une demande précédente (§8). */
  resume: (id: number) => void;
  /** Référence du champ actif (desktop ou mobile), pour le focus. */
  registerInput: (el: HTMLInputElement | null) => void;
  focusInput: () => void;
}

const Ctx = createContext<VerebonaSpaceApi | null>(null);

export function useVerebonaSpace(): VerebonaSpaceApi | null {
  return useContext(Ctx);
}

interface ProviderProps {
  children: ReactNode;
  /** « Signaler un problème » quand la réponse n'a pas d'identifiant serveur. */
  onOpenHelp?: () => void;
}

/** Une fenêtre modale (Radix) est-elle ouverte par-dessus ? */
function modalOuverte(): boolean {
  return typeof document !== 'undefined'
    && !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
}

export function VerebonaSpaceProvider({ children, onOpenHelp }: ProviderProps) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const pageContext = useMemo(() => buildPageContext(pathname), [pathname]);
  const { garder, signalerRefus } = useWriteGuard();
  const [isOpen, setIsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const reducedMotion = useReducedMotion();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const localHandlers = useRef(new Map<string, () => void>());
  const seq = useRef(0);
  const isDesktopRef = useRef(isDesktop);
  isDesktopRef.current = isDesktop;

  const v = useVerebona(pageContext, {
    // Refus serveur malgré la garde : l'espace se ferme pour laisser la
    // fenêtre de fin d'essai lisible.
    onWriteBlocked: (info) => {
      setIsOpen(false);
      signalerRefus(info);
    },
  });

  const turns = useMemo(() => buildTurns(v.messages, v.isLoading), [v.messages, v.isLoading]);
  const pose = spacePose(turns);
  const allPrevious = useMemo(() => previousRequests(v.threads, v.conversationId, new Date(), Number.POSITIVE_INFINITY), [v.threads, v.conversationId]);

  // ── Pop-up : accueil (suggestions + recherches récentes) ou échange ──────
  const [threadShown, setThreadShown] = useState(false);
  const showThread = threadShown && turns.length > 0;
  const [hiddenThreads, setHiddenThreads] = useState<ReadonlySet<number>>(() => new Set());
  const recent = useMemo(() => recentSearches(v.threads, hiddenThreads), [v.threads, hiddenThreads]);
  const removeRecent = useCallback((id: number) => {
    setHiddenThreads((h) => new Set(h).add(id));
    void v.deleteThread(id);
  }, [v]);
  /** Depuis l'accueil du pop-up, une question ouvre une NOUVELLE recherche. */
  const threadShownRef = useRef(threadShown);
  threadShownRef.current = threadShown;
  const turnsCountRef = useRef(turns.length);
  turnsCountRef.current = turns.length;
  const partirDeZero = useCallback(async () => {
    if (!threadShownRef.current && turnsCountRef.current > 0) await v.newConversation();
  }, [v]);

  // « Par exemple » (§6.5 état 1) : catalogue de la page, complété par l'état
  // du compte côté serveur dès la première ouverture sur cette page.
  const [suggestionsCompte, setSuggestionsCompte] = useState<{ route: string; items: Array<{ id: string; label: string }> } | null>(null);
  useEffect(() => {
    if (!isOpen || suggestionsCompte?.route === pageContext.route) return;
    let annule = false;
    void (async () => {
      const res = await fetch(`/api/verebona/suggestions?route=${encodeURIComponent(pageContext.route)}`).catch(() => null);
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      if (!annule && Array.isArray(data?.suggestions) && data.suggestions.length > 0) {
        setSuggestionsCompte({ route: pageContext.route, items: data.suggestions });
      }
    })();
    return () => { annule = true; };
  }, [isOpen, pageContext.route, suggestionsCompte?.route]);
  const suggestions = useMemo(() => {
    const items = suggestionsCompte?.route === pageContext.route
      ? suggestionsCompte.items
      : suggestionsForRoute(pageContext.route).map((s) => ({ id: s.id, label: s.label }));
    return items.slice(0, 3);
  }, [suggestionsCompte, pageContext.route]);

  // ── Saisie et suggestions pendant la frappe ──────────────────────────────
  const [draft, setDraftState] = useState('');
  const [live, setLive] = useState<LiveResult[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [activeLive, setActiveLive] = useState(-1);
  const liveSeq = useRef(0);
  const setDraft = useCallback((t: string) => {
    setDraftState(t.slice(0, 2000));
    setActiveLive(-1);
  }, []);
  useEffect(() => {
    const q = draft.trim();
    const mine = ++liveSeq.current;
    if (q.length < LIVE_MIN_CHARS) { setLive([]); setLiveLoading(false); return; }
    setLive(navMatches(q));
    setLiveLoading(true);
    const t = setTimeout(async () => {
      // Mode `instant` : recherche SQL seule, jamais d'appel modèle à la frappe.
      const res = await fetch(`/api/search?instant=1&q=${encodeURIComponent(q)}`, { credentials: 'include' }).catch(() => null);
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      if (mine !== liveSeq.current) return;
      setLive(toLiveResults(q, data?.results));
      setLiveLoading(false);
    }, LIVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [draft]);
  const moveLive = useCallback((delta: 1 | -1) => {
    setActiveLive((i) => moveActive(i, delta, live.length));
  }, [live.length]);

  const focusInput = useCallback(() => {
    // Après le rendu de l'espace : le champ mobile n'existe qu'une fois ouvert.
    setTimeout(() => inputRef.current?.focus(), 40);
  }, []);

  const registerInput = useCallback((el: HTMLInputElement | null) => {
    if (el) inputRef.current = el;
  }, []);

  /** Garde d'écriture : à l'ENVOI seulement, jamais à l'ouverture. */
  const autorise = useCallback((): boolean => {
    let ok = false;
    garder(() => { ok = true; });
    return ok;
  }, [garder]);

  // ══════════════════════════════════════════════════════════════════════
  // OUVRIR N'EST PAS ÉCRIRE
  //
  // L'ouverture était gardée, et le champ s'ouvrait au focus : pour un
  // compte en fin d'essai, la fenêtre de refus rendait le focus au champ en
  // se fermant… qui rouvrait l'espace, donc la fenêtre — une boucle sans
  // issue. Ouvrir se fait au clic, au raccourci ou à la frappe, sans garde ;
  // seul l'envoi d'une demande (ou d'une décision) passe par la garde.
  // ══════════════════════════════════════════════════════════════════════
  const open = useCallback(() => {
    setIsOpen(true);
    focusInput();
    // Chaque ouverture : accueil du pop-up (suggestions + recherches récentes).
    setThreadShown(false);
    // §32.3 (D-J7) : ouverture de Verebona (anonyme).
    trackAssistantUsage({ type: 'ASSISTANT_OPEN' });
  }, [focusInput]);

  const close = useCallback(() => {
    // Fermer ne perd rien (§6.2) : l'échange continue, le champ propose
    // « Reprendre · n échanges ».
    setIsOpen(false);
    setHistoryOpen(false);
    // Une question posée espace fermé (tuiles, mascotte…) ouvre une nouvelle recherche.
    setThreadShown(false);
  }, []);

  const toggle = useCallback(() => {
    if (isOpen) close(); else open();
  }, [isOpen, open, close]);

  /** Mobile : l'espace plein écran masquerait le tiroir ou la fenêtre ouverts. */
  const leaveForOverlay = useCallback(() => {
    if (!isDesktopRef.current) close();
  }, [close]);

  // ══════════════════════════════════════════════════════════════════════
  // TOUTE QUESTION PASSE PAR LA GARDE
  //
  // Champ, suggestions, tuiles de l'accueil, centre d'aide, choix proposés :
  // une seule fonction d'envoi. Elle rend `false` quand la question est
  // refusée : le champ garde alors son texte.
  // ══════════════════════════════════════════════════════════════════════
  const envoyer = useCallback((texte: string, context?: Record<string, string>): false | Promise<boolean> => {
    if (!autorise()) {
      // La fenêtre de refus s'affiche : l'espace plein écran (mobile) la masquerait.
      leaveForOverlay();
      return false;
    }
    setIsOpen(true);
    setHistoryOpen(false);
    return (async () => {
      await partirDeZero();
      setThreadShown(true);
      return v.send(texte, context);
    })();
  }, [autorise, v, leaveForOverlay, partirDeZero]);

  const guard = useCallback((fn: () => void) => {
    if (autorise()) fn();
    else leaveForOverlay();
  }, [autorise, leaveForOverlay]);

  const openLive = useCallback((r: LiveResult) => {
    setDraft('');
    close();
    if (r.drawer) openDrawer(r.drawer);
    else router.push(r.href);
  }, [close, router, setDraft]);

  /** Échange construit par l'interface : aucune écriture, donc aucune garde. */
  const askLocal = useCallback((ex: LocalExchange) => {
    const id = (suffixe: string) => `local-${++seq.current}-${suffixe}`;
    const actions = (ex.actions ?? []).map((a, i) => {
      const actionId = id(`a${i}`);
      localHandlers.current.set(actionId, a.run);
      return { id: actionId, label: a.label, primary: a.primary };
    });
    const objects = (ex.objects ?? []).map((o, i) => {
      const { onOpen, ...rest } = o;
      if (!onOpen) return rest;
      const actionId = id(`o${i}`);
      localHandlers.current.set(actionId, onOpen);
      return { ...rest, actionId };
    });
    void (async () => {
      await partirDeZero();
      v.appendLocal(ex.question, {
        content: ex.content, kind: ex.kind, tone: ex.tone, summary: ex.summary, objects, actions,
      });
      setThreadShown(true);
    })();
    setHistoryOpen(false);
    setIsOpen(true);
  }, [v, partirDeZero]);

  const runLocal = useCallback((id: string) => {
    localHandlers.current.get(id)?.();
  }, []);

  /** Retour à l'accueil du pop-up ; la prochaine question ouvre une nouvelle recherche. */
  const newRequest = useCallback(() => {
    setThreadShown(false);
    setHistoryOpen(false);
    focusInput();
  }, [focusInput]);

  const resume = useCallback((id: number) => {
    void v.selectConversation(id);
    setThreadShown(true);
    setHistoryOpen(false);
    focusInput();
  }, [v, focusInput]);

  // Ouverture programmée (tiroir document, centre d'aide, liens profonds…),
  // avec question optionnelle et contexte structuré (CDC Mascotte SEC-005).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ question?: string; context?: { intent?: string; assetId?: number; documentId?: number } }>).detail;
      if (!detail?.question) { open(); return; }
      const ctx: Record<string, string> = {};
      if (detail.context?.intent) ctx.intent = detail.context.intent;
      if (detail.context?.assetId) ctx.assetId = String(detail.context.assetId);
      if (detail.context?.documentId) ctx.documentId = String(detail.context.documentId);
      void envoyer(detail.question, Object.keys(ctx).length ? ctx : undefined);
    };
    window.addEventListener('verebona:open', handler);
    return () => window.removeEventListener('verebona:open', handler);
  }, [envoyer, open]);

  // ⌘K / Ctrl+K : ouvre (ou ferme) l'espace depuis n'importe où ; Échap ferme.
  // Jamais sous une fenêtre modale ouverte : elle garde la main.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        if (modalOuverte()) return;
        e.preventDefault();
        if (isOpen) close(); else open();
        return;
      }
      if (e.key === 'Escape' && isOpen) {
        if (modalOuverte()) return;
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, open, close]);

  // Changement de page : l'espace se referme (le fil est conservé).
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname;
      close();
    }
  }, [pathname, close]);

  // « Signaler un problème » sans identifiant serveur : le centre d'aide.
  useEffect(() => {
    const handler = () => { leaveForOverlay(); onOpenHelp?.(); };
    window.addEventListener('verebona:report', handler);
    return () => window.removeEventListener('verebona:report', handler);
  }, [onOpenHelp, leaveForOverlay]);

  const api: VerebonaSpaceApi = {
    v, turns, isOpen, isDesktop, reducedMotion, pose, recent, removeRecent, showThread, allPrevious, historyOpen, setHistoryOpen, suggestions,
    draft, setDraft, live, liveLoading, activeLive, moveLive, openLive,
    open, close, toggle, leaveForOverlay, ask: envoyer, askLocal, runLocal, guard, newRequest, resume, registerInput, focusInput,
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
