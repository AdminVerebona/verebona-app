'use client';
/**
 * Boutons d'action contrôlés — CDC §22, §19.8, §27.9, §27.11.
 *
 * Le href vient TOUJOURS du serveur (§27.1). Les actions d'interface sans
 * navigation (SHOW_SOURCES, SHOW_EXPLANATION, RETRY_REQUEST) étaient rendues
 * en `<button>` SANS gestionnaire : « Voir les sources », « Pourquoi ? » et
 * « Réessayer » ne faisaient rien. Elles sont désormais remontées au message
 * via `onAction`, qui sait les exécuter.
 */
import type { VerebonaAction } from '@/lib/verebona/useVerebona';
import { openDrawerFromLink } from '@/lib/drawers';

export interface VerebonaActionsProps {
  actions: VerebonaAction[];
  /** Exécute une action d'interface (sans href). Absent : bouton désactivé. */
  onAction?: (action: VerebonaAction) => void;
}

export function VerebonaActions({ actions, onAction }: VerebonaActionsProps) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {actions.map((a) => (
        a.href ? (
          <a key={a.actionId} href={a.href} data-analytics={a.analyticsCode}
             onClick={(e) => openDrawerFromLink(e, a.href)}
             className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            {a.label}
          </a>
        ) : (
          <button key={a.actionId} type="button" data-analytics={a.analyticsCode}
                  disabled={!onAction}
                  onClick={() => onAction?.(a)}
                  className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
            {a.label}
          </button>
        )
      ))}
    </div>
  );
}
