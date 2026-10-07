'use client';

/**
 * File unique « À traiter » — CDC V2.0 §7.1, §8.1 à §8.3, §17.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NI ONGLETS, NI SECTIONS — ET C'EST LA DÉCISION LA PLUS VISIBLE
 *
 * §8.3 : « Ni la vue Par priorité ni la vue Par action n'utilisent d'onglets
 * ou de sections. Il s'agit toujours d'une liste continue dont l'ordre change
 * selon le mode choisi. » (critère ATP-01)
 *
 * La tentation est forte d'ajouter des en-têtes « À faire d'abord », « À faire
 * ensuite » : cela paraît plus lisible. Cela réintroduit exactement ce que la
 * V1 faisait — des compartiments dans lesquels l'utilisateur descend, et dont
 * les derniers ne sont jamais atteints. L'ordre suffit à porter la hiérarchie.
 *
 * ── DEUX BASCULES, DEUX MÉMOIRES DIFFÉRENTES ──────────────────────────────
 *
 * §8.2 : Cartes / Liste est mémorisé, Par priorité / Par action ne l'est pas
 * (critères ATP-02, ATP-03). La distinction n'est pas un oubli du CDC : la
 * densité est une préférence durable, l'ordre est une façon de chercher,
 * propre au moment. Rouvrir la page sur « Par action » ferait perdre le repère
 * de ce qui compte le plus.
 *
 * ── L'ANNULATION EST CE QUI REND LE CLIC ANODIN ───────────────────────────
 *
 * §8.5 : appliquer sans écran de confirmation n'est tenable que parce que
 * « Valeur mise à jour — Annuler » suit. La valeur précédente est donc gardée
 * le temps du toast, et renvoyée telle quelle au serveur.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { LayoutGrid, List, Loader2 } from 'lucide-react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { apiClient } from '@/lib/api-client';
import {
  TO_PROCESS_NO_FILTER_RESULT,
  toProcessHeadline,
} from '@/lib/referential/v2/microcopy';
import { TO_PROCESS_COUNT_EVENT } from '@/hooks/useToProcessCount';
import type { OrderMode } from '@/services/to-process/priority';
import { ActionCard, ActionRow, todoCardDomId, type ActionView } from './ActionCard';
import { useToProcessResolution } from './useToProcessResolution';

type Presentation = 'CARDS' | 'LIST';

const PRESENTATION_KEY = 'a-traiter:presentation';

/** Paramètre d'URL d'une carte ciblée par la mascotte (OPEN_TODO_CARD, lot 32). */
export const TODO_FOCUS_PARAM = 'todo';

interface PageResponse {
  actions: ActionView[];
  total: number;
  shown: number;
}

/** Carte ciblée par l'URL (`?todo=<publicId>`), lue côté client seulement. */
function focusFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = new URLSearchParams(window.location.search).get(TODO_FOCUS_PARAM);
    return v && /^[0-9a-zA-Z-]{8,64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function ToProcessQueue() {
  const { setBreadcrumbs } = useBreadcrumb();
  // §8.2 / ATP-02 : la vue par défaut est « Par priorité » à chaque visite.
  const [orderMode, setOrderMode] = useState<OrderMode>('BY_PRIORITY');
  const [presentation, setPresentation] = useState<Presentation>('CARDS');
  const [page, setPage] = useState<PageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // Carte ciblée par son ID (mascotte) : positionnée et mise en évidence.
  const [focusId, setFocusId] = useState<string | null>(null);
  const focusPending = useRef<string | null>(null);
  const snapshot = useRef<PageResponse | null>(null);

  // ATP-03 : la présentation est une préférence durable. Lue après le premier
  // rendu pour ne pas dépendre du stockage pendant l'hydratation.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(PRESENTATION_KEY);
      if (stored === 'LIST' || stored === 'CARDS') setPresentation(stored);
    } catch {
      /* stockage indisponible : la valeur par défaut convient. */
    }
    focusPending.current = focusFromUrl();
  }, []);

  const choosePresentation = (value: Presentation) => {
    setPresentation(value);
    try {
      localStorage.setItem(PRESENTATION_KEY, value);
    } catch {
      /* ignore */
    }
  };

  const load = useCallback(async (mode: OrderMode) => {
    setLoading(true);
    try {
      const data = await apiClient.get<PageResponse>(
        `/api/v2/to-process?order=${mode === 'BY_ACTION' ? 'action' : 'priority'}`,
      );
      setPage(data);
      // L32-6 : la pastille du menu (desktop + barre mobile) prend le nombre
      // que la page vient de lire — même calcul, même instant.
      window.dispatchEvent(new CustomEvent(TO_PROCESS_COUNT_EVENT, { detail: data.total }));
    } catch {
      toast.error('Les actions n’ont pas pu être chargées.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: 'À traiter' }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    void load(orderMode);
  }, [orderMode, load]);

  // Une fiche complétée dans un tiroir retire l'action de la file.
  useEffect(() => {
    const reload = () => { void load(orderMode); };
    const events = ['refresh-a-traiter', 'agenda-mutated', 'document-analysis-complete'];
    events.forEach((e) => window.addEventListener(e, reload));
    return () => events.forEach((e) => window.removeEventListener(e, reload));
  }, [orderMode, load]);

  // OPEN_TODO_CARD (lot 32) : la carte désignée par son ID est amenée à
  // l'écran, mise en évidence, et le focus posé sur son action — jamais
  // « le haut de la page ».
  useEffect(() => {
    const id = focusPending.current;
    if (!id || !page) return;
    focusPending.current = null;
    const present = page.actions.some((a) => a.publicId === id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(TODO_FOCUS_PARAM);
      window.history.replaceState(window.history.state, '', url.toString());
    } catch { /* URL non modifiable : sans effet */ }
    if (!present) {
      toast.info('Cette action est déjà traitée.');
      return;
    }
    setFocusId(id);
    requestAnimationFrame(() => {
      const el = document.getElementById(todoCardDomId(id));
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.querySelector<HTMLElement>('input, button:not([disabled])')?.focus({ preventScroll: true });
    });
  }, [page]);

  // La mise en évidence s'efface d'elle-même (le focus clavier reste).
  useEffect(() => {
    if (!focusId) return;
    const t = setTimeout(() => setFocusId(null), 6_000);
    return () => clearTimeout(t);
  }, [focusId]);

  /**
   * Application d'une proposition — parcours COMMUN avec la mascotte
   * (`useToProcessResolution`).
   *
   * La carte disparaît immédiatement (§16.3, « mise à jour optimiste possible
   * après arbitrage, avec rollback sur erreur ») : attendre la réponse ferait
   * hésiter sur un geste qui se veut immédiat.
   */
  const { busyId, choose, openTarget } = useToProcessResolution({
    onRemove: (action) => {
      setPage((current) => {
        snapshot.current = current;
        return current
          ? {
              ...current,
              actions: current.actions.filter((a) => a.publicId !== action.publicId),
              total: Math.max(0, current.total - 1),
              shown: Math.max(0, current.shown - 1),
            }
          : current;
      });
    },
    onRollback: () => setPage(snapshot.current),
  });

  const count = page?.shown ?? 0;

  return (
    <div className="space-y-6 w-full max-w-full overflow-x-hidden">
      {/* En-tête au format des autres pages : titre, décompte, commandes à
          droite (cf. « Mon agenda », « Mes biens »). */}
      <div className="flex items-center justify-between mb-6">
        <div className="min-w-0">
          <h1 className="text-xl md:text-3xl font-bold whitespace-nowrap">À traiter</h1>
          <p className="text-muted-foreground mt-1">
            {loading && !page
              ? '\u00a0'
              : count === 0
                ? 'Rien à traiter pour le moment'
                : `${count} ${count > 1 ? 'actions' : 'action'}`}
          </p>
        </div>
      </div>

      {/* §17.1 : un message global en haut d'écran, aucun dans les cartes. */}
      {count > 0 && (
        <p className="text-sm text-muted-foreground -mt-2">
          {toProcessHeadline(count, orderMode)}
        </p>
      )}

      {/* Bascules : même composant visuel que les vues de l'agenda. */}
      {count > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-md border overflow-hidden" role="group" aria-label="Organisation">
            <button
              className={`px-3 py-1.5 text-sm ${orderMode === 'BY_PRIORITY' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              aria-pressed={orderMode === 'BY_PRIORITY'}
              onClick={() => setOrderMode('BY_PRIORITY')}
            >
              Par priorité
            </button>
            <button
              className={`px-3 py-1.5 text-sm ${orderMode === 'BY_ACTION' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              aria-pressed={orderMode === 'BY_ACTION'}
              onClick={() => setOrderMode('BY_ACTION')}
            >
              Par action
            </button>
          </div>

          <div className="flex rounded-md border overflow-hidden" role="group" aria-label="Présentation">
            <button
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${presentation === 'CARDS' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              aria-pressed={presentation === 'CARDS'}
              onClick={() => choosePresentation('CARDS')}
            >
              <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> Cartes
            </button>
            <button
              className={`px-3 py-1.5 text-sm flex items-center gap-1.5 ${presentation === 'LIST' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
              aria-pressed={presentation === 'LIST'}
              onClick={() => choosePresentation('LIST')}
            >
              <List className="h-3.5 w-3.5" aria-hidden /> Liste
            </button>
          </div>
        </div>
      )}

      {loading && !page ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Chargement des actions…
        </div>
      ) : count === 0 ? (
        // L'en-tête porte déjà « Rien à traiter pour le moment » (§17.2) : le
        // répéter ici affichait deux fois la même phrase sur un écran vide.
        // Seul le cas « filtres sans résultat » mérite un message propre (§8.8).
        page && page.total > 0 ? (
          <p className="py-8 text-sm text-muted-foreground">{TO_PROCESS_NO_FILTER_RESULT}</p>
        ) : null
      ) : (
        // Liste continue, sans section ni onglet (§8.3, ATP-01).
        <div className={presentation === 'CARDS' ? 'space-y-3' : 'rounded-lg border px-4'}>
          {page!.actions.map((action) =>
            presentation === 'CARDS' ? (
              <ActionCard
                key={action.publicId}
                action={action}
                onChoose={(a, p) => { void choose(a, p); }}
                onOpenTarget={openTarget}
                busy={busyId === action.publicId}
                focused={focusId === action.publicId}
              />
            ) : (
              <ActionRow
                key={action.publicId}
                action={action}
                onChoose={(a, p) => { void choose(a, p); }}
                onOpenTarget={openTarget}
                busy={busyId === action.publicId}
                focused={focusId === action.publicId}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
