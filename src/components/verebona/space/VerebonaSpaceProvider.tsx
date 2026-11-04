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
  buildTurns, recentSearches, spacePose,
  type MascotPoseName, type RecentSearchRow, type SpaceObject, type SpaceTurn,
} from '@/lib/verebona/space';
import {
  LIVE_DEBOUNCE_MS, LIVE_MIN_CHARS, createLiveSearchRunner, moveActive, navMatches, seeAllLinks, toLiveResults,
  type DocumentsCountState, type LiveResult, type LiveSeeAll,
} from '@/lib/verebona/live-search';
import { DOCUMENTS_SEE_ALL_EVENT, clearListSnapshot } from '@/components/documents/v2/list-restore';
import { openDrawer } from '@/lib/drawers';
import { openHelpFromLink } from '@/lib/help-center/open';
import { trackAssistantUsage } from '@/lib/verebona/usage-events';
import { useSharedSuggestions, type SharedSuggestionItem } from '@/lib/suggestions/shared-suggestions';
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
  /**
   * Lot 108J : suggestions PARTAGÉES — les mêmes trois questions, dans le même
   * ordre et la même version, que la zone de l'accueil (service unique).
   */
  suggestions: SharedSuggestionItem[];
  /** Lot 108J : pose une suggestion (vraie question, référence revalidée par le serveur) et la remplace partout. */
  askSuggestion: (s: SharedSuggestionItem) => void;
  /** Saisie du champ, partagée par le champ desktop et le champ mobile. */
  draft: string;
  setDraft: (text: string) => void;
  /** Suggestions pendant la frappe (biens, documents, échéances, pages). */
  live: LiveResult[];
  /**
   * Lot 97C : « Voir tous les documents / éléments d'agenda » (recherche
   * préremplie). Lot 105A : le lien des documents porte le total exact
   * (`count`) ou l'état « en cours » (`pending`), jamais un chiffre provisoire.
   */
  liveSeeAll: LiveSeeAll[];
  /** Ouvre un écran complet de « Voir tous » (espace fermé, saisie vidée). */
  openSeeAll: (l: LiveSeeAll) => void;
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

  // « Par exemple » (§6.5 état 1) — lot 108J : la sélection PARTAGÉE avec
  // l'accueil (GET /api/suggestions), lue à la première ouverture si elle
  // n'est pas déjà en mémoire ; identique sur toutes les pages (un changement
  // de route ne produit jamais une seconde liste incohérente).
  const shared = useSharedSuggestions({ active: isOpen });
  const suggestions = shared.items;

  // ── Saisie et suggestions pendant la frappe ──────────────────────────────
  const [draft, setDraftState] = useState('');
  const [live, setLive] = useState<LiveResult[]>([]);
  // Lot 105A : réponse brute de la recherche et décompte des documents, tous
  // deux rattachés à LEUR saisie — un état d'une autre saisie n'est jamais lu.
  const [liveRows, setLiveRows] = useState<{ q: string; rows: Parameters<typeof seeAllLinks>[1] } | null>(null);
  const [docCount, setDocCount] = useState<{ q: string; state: DocumentsCountState } | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [activeLive, setActiveLive] = useState(-1);
  const setDraft = useCallback((t: string) => {
    setDraftState(t.slice(0, 2000));
    setActiveLive(-1);
  }, []);
  const runnerRef = useRef<ReturnType<typeof createLiveSearchRunner> | null>(null);
  if (!runnerRef.current) {
    runnerRef.current = createLiveSearchRunner(
      async (url, signal) => {
        const res = await fetch(url, { credentials: 'include', signal });
        return res.ok ? res.json().catch(() => null) : null;
      },
      {
        onResults: (q, rows) => {
          setLive(toLiveResults(q, rows));
          setLiveRows({ q, rows });
          setLiveLoading(false);
        },
        onDocumentsCount: (q, state) => setDocCount({ q, state }),
      },
    );
  }
  useEffect(() => {
    const q = draft.trim();
    const runner = runnerRef.current!;
    runner.cancel();
    setLiveRows(null);
    setDocCount(null);
    if (q.length < LIVE_MIN_CHARS) { setLive([]); setLiveLoading(false); return; }
    setLive(navMatches(q));
    setLiveLoading(true);
    const t = setTimeout(() => runner.run(q), LIVE_DEBOUNCE_MS);
    // Nouvelle frappe ou démontage : délai annulé ET requêtes en vol abandonnées.
    return () => { clearTimeout(t); runner.cancel(); };
  }, [draft]);
  const liveSeeAll = useMemo<LiveSeeAll[]>(() => {
    const q = draft.trim();
    if (q.length < LIVE_MIN_CHARS) return [];
    const rows = liveRows?.q === q ? liveRows.rows : null;
    const count = docCount?.q === q ? docCount.state : ({ status: 'loading' } as const);
    // Ni suggestions ni décompte pour CETTE saisie : rien à proposer encore.
    if (!rows && count.status !== 'ready') return [];
    return seeAllLinks(q, rows, count);
  }, [draft, liveRows, docCount]);
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
    // Lot 59 (point 3) : le Centre d'aide s'ouvre dans un nouvel onglet.
    else if (!openHelpFromLink(null, r.href)) router.push(r.href);
  }, [close, router, setDraft]);

  const openSeeAll = useCallback((l: LiveSeeAll) => {
    setDraft('');
    close();
    if (l.id === 'voir-documents') {
      // Lot 105A : « Mes documents » s'ouvre avec la SEULE recherche — aucun
      // filtre d'une visite précédente (instantané de retour, écran déjà
      // monté) ne réduit en silence la liste sous le total annoncé.
      clearListSnapshot('mes-documents');
      window.dispatchEvent(new CustomEvent(DOCUMENTS_SEE_ALL_EVENT));
    }
    router.push(l.href);
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
    setIsOpen(true);
  }, [v, partirDeZero]);

  const runLocal = useCallback((id: string) => {
    localHandlers.current.get(id)?.();
  }, []);

  /** Retour à l'accueil du pop-up ; la prochaine question ouvre une nouvelle recherche. */
  const newRequest = useCallback(() => {
    setThreadShown(false);
    focusInput();
  }, [focusInput]);

  const resume = useCallback((id: number) => {
    void v.selectConversation(id);
    setThreadShown(true);
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

  const askSuggestion = useCallback((s: SharedSuggestionItem) => {
    const ctx = shared.pick(s);
    void envoyer(s.label, ctx);
  }, [shared, envoyer]);

  const api: VerebonaSpaceApi = {
    v, turns, isOpen, isDesktop, reducedMotion, pose, recent, removeRecent, showThread, suggestions, askSuggestion,
    draft, setDraft, live, liveSeeAll, openSeeAll, liveLoading, activeLive, moveLive, openLive,
    open, close, toggle, leaveForOverlay, ask: envoyer, askLocal, runLocal, guard, newRequest, resume, registerInput, focusInput,
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
