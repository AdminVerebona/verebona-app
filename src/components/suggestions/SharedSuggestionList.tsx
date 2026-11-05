'use client';
/**
 * Suggestions partagées de l'accueil — lot 108J, présentation lot 110C.
 *
 * Trois QUESTIONS (jamais un raccourci d'ajout déguisé), les mêmes que
 * l'état initial de « Demander à Verebona ». Un clic pose la question à
 * l'Assistant ; la suggestion est remplacée par une autre déjà disponible.
 * Aucun bouton « Autre suggestion ».
 *
 * Lot 110C : l'accueil ne les montre plus que sur ordinateur / format large
 * (règle : `src/lib/suggestions/home-placement.ts`) — UNE rangée horizontale
 * compacte d'au plus trois cartes de même largeur, secondaire (bord discret,
 * texte secondaire), texte qui passe à la ligne DANS chaque carte, aucun
 * empilement, aucun défilement horizontal ni carrousel. Cibles d'au moins
 * 44 px (écrans tactiles larges), anneau de focus de la charte (globals.css).
 * Sur mobile la zone est absente ; « Demander à Verebona » garde les siennes.
 */
import type { SharedSuggestionItem } from '@/lib/suggestions/shared-suggestions';
import { MAX_HOME_SUGGESTIONS } from '@/services/home/mascot/types';

/** Rangée : trois colonnes égales, jamais plus (au-delà : non affichées). */
const ROW = 'm-0 grid min-w-0 list-none grid-cols-3 items-stretch gap-2 p-0';

export function SharedSuggestionList({ items, loading, onAsk, className = '' }: {
  items: SharedSuggestionItem[];
  loading?: boolean;
  onAsk: (s: SharedSuggestionItem) => void;
  className?: string;
}) {
  const shown = items.slice(0, MAX_HOME_SUGGESTIONS);
  if (shown.length === 0) {
    // Lecture en cours : une rangée réservée (aucun saut), jamais un vide silencieux.
    return loading ? (
      <div className={`${ROW} ${className}`} role="status" aria-label="Chargement des suggestions" data-home-suggestions-loading>
        {Array.from({ length: MAX_HOME_SUGGESTIONS }, (_, i) => <div key={i} className="h-[52px] min-w-0 animate-pulse rounded-xl bg-[color:var(--border-subtle)]" />)}
      </div>
    ) : null;
  }
  return (
    <ul className={`${ROW} ${className}`} aria-label="Questions suggérées" data-home-suggestions data-layout="row">
      {shown.map((s) => (
        <li key={s.id} className="flex min-w-0" data-suggestion-id={s.id} data-suggestion-objective={s.objective}>
          <button
            type="button"
            onClick={() => onAsk(s)}
            className="flex min-h-[44px] w-full min-w-0 items-start gap-2 rounded-xl border border-[color:var(--border-subtle)] bg-transparent px-3 py-2 text-left text-[13px] leading-[1.4] text-[color:var(--text-secondary)] transition-colors duration-[180ms] hover:border-[color:var(--accent)] hover:bg-[color:var(--bg-card)] hover:text-[color:var(--text-primary)]"
          >
            <span className="font-semibold text-[color:var(--accent)]" aria-hidden>›</span>
            <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{s.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
