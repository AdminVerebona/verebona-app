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

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { LayoutGrid, List, Loader2 } from 'lucide-react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { apiClient } from '@/lib/api-client';
import {
  TO_PROCESS_NO_FILTER_RESULT,
  toProcessHeadline,
} from '@/lib/referential/v2/microcopy';
import type { OrderMode } from '@/services/to-process/priority';
import { ActionCard, ActionRow, type ActionProposalView, type ActionView } from './ActionCard';

type Presentation = 'CARDS' | 'LIST';

const PRESENTATION_KEY = 'a-traiter:presentation';

interface PageResponse {
  actions: ActionView[];
  total: number;
  shown: number;
}

export function ToProcessQueue() {
  const router = useRouter();
  const { setBreadcrumbs } = useBreadcrumb();
  // §8.2 / ATP-02 : la vue par défaut est « Par priorité » à chaque visite.
  const [orderMode, setOrderMode] = useState<OrderMode>('BY_PRIORITY');
  const [presentation, setPresentation] = useState<Presentation>('CARDS');
  const [page, setPage] = useState<PageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  // ATP-03 : la présentation est une préférence durable. Lue après le premier
  // rendu pour ne pas dépendre du stockage pendant l'hydratation.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(PRESENTATION_KEY);
      if (stored === 'LIST' || stored === 'CARDS') setPresentation(stored);
    } catch {
      /* stockage indisponible : la valeur par défaut convient. */
    }
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

  /**
   * Application d'une proposition.
   *
   * La carte disparaît immédiatement (§16.3, « mise à jour optimiste possible
   * après arbitrage, avec rollback sur erreur ») : attendre la réponse ferait
   * hésiter sur un geste qui se veut immédiat.
   */
  const choose = async (action: ActionView, proposal: ActionProposalView) => {
    setBusyId(action.publicId);
    const snapshot = page;
    setPage((current) =>
      current
        ? {
            ...current,
            actions: current.actions.filter((a) => a.publicId !== action.publicId),
            total: Math.max(0, current.total - 1),
            shown: Math.max(0, current.shown - 1),
          }
        : current,
    );

    try {
      const res = await apiClient.post<{ ok: boolean; previousValue: unknown }>(
        `/api/v2/to-process/${action.publicId}/resolve`,
        { mode: 'arbitrate', value: proposal.value },
      );

      toast.success('Valeur mise à jour', {
        action: {
          label: 'Annuler',
          onClick: () => void undo(action, res.previousValue),
        },
      });
    } catch {
      setPage(snapshot);
      toast.error('La valeur n’a pas pu être appliquée.');
    } finally {
      setBusyId(null);
    }
  };

  const undo = async (action: ActionView, previousValue: unknown) => {
    try {
      await apiClient.post(`/api/v2/to-process/${action.publicId}/resolve`, {
        mode: 'undo',
        previousValue,
      });
      await load(orderMode);
      toast.success('Modification annulée.');
    } catch {
      toast.error('L’annulation n’a pas abouti.');
    }
  };

  /** « Autre » et « Compléter » ouvrent l'objet sur le champ concerné (§8.5, §8.6). */
  const openTarget = (action: ActionView) => {
    const field = action.fieldKey ?? action.relationKey ?? '';
    if (action.targetType === 'DOCUMENT' && action.target.publicId) {
      router.push(`/documents/${action.target.publicId}?field=${field}`);
      return;
    }
    if (action.targetType === 'ASSET' && action.target.publicId) {
      router.push(`/assets/${action.target.publicId}?field=${field}`);
      return;
    }
    toast.info('Ouvrez cet élément depuis sa page pour compléter l’information.');
  };

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
                onChoose={choose}
                onOpenTarget={openTarget}
                busy={busyId === action.publicId}
              />
            ) : (
              <ActionRow
                key={action.publicId}
                action={action}
                onChoose={choose}
                onOpenTarget={openTarget}
                busy={busyId === action.publicId}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
