'use client';
/**
 * Suggestions partagées sous la bulle de l'accueil — lot 108J.
 *
 * Trois QUESTIONS (jamais un raccourci d'ajout déguisé), les mêmes que
 * l'état initial de « Demander à Verebona ». Un clic pose la question à
 * l'Assistant ; la suggestion est remplacée par une autre déjà disponible.
 * Aucun bouton « Autre suggestion ».
 *
 * Responsive (charte Sérénité, jetons uniquement) :
 *   · mobile : une colonne pleine largeur, trois boutons EMPILÉS, zones
 *     tactiles d'au moins 44 px, retour à la ligne naturel, aucun texte
 *     rogné, aucun défilement horizontal ni carrousel ;
 *   · ordinateur : pastilles compactes qui passent à la ligne dans la
 *     largeur de la colonne (aucune largeur fixe).
 */
import type { SharedSuggestionItem } from '@/lib/suggestions/shared-suggestions';

export function SharedSuggestionList({ items, loading, onAsk, className = '' }: {
  items: SharedSuggestionItem[];
  loading?: boolean;
  onAsk: (s: SharedSuggestionItem) => void;
  className?: string;
}) {
  if (items.length === 0) {
    // Lecture en cours : place réservée (aucun saut de mise en page), jamais un vide silencieux.
    return loading ? (
      <div className={`flex min-w-0 flex-col gap-2 ${className}`} role="status" aria-label="Chargement des suggestions" data-home-suggestions-loading>
        {[0, 1, 2].map((i) => <div key={i} className="h-11 w-full animate-pulse rounded-2xl bg-[color:var(--border-subtle)] md:h-9 md:w-7/12 md:rounded-full" />)}
      </div>
    ) : null;
  }
  return (
    <ul
      className={`m-0 flex min-w-0 list-none flex-col gap-2 p-0 md:flex-row md:flex-wrap ${className}`}
      aria-label="Questions suggérées"
      data-home-suggestions
    >
      {items.map((s) => (
        <li key={s.id} className="flex min-w-0 md:max-w-full" data-suggestion-id={s.id} data-suggestion-objective={s.objective}>
          <button
            type="button"
            onClick={() => onAsk(s)}
            className="flex min-h-[44px] w-full min-w-0 items-center gap-2 rounded-2xl border border-[color:var(--border)] bg-[color:var(--bg-card)] px-3.5 py-2 text-left text-[14px] leading-[1.45] text-[color:var(--text-primary)] transition-colors duration-[180ms] hover:border-[color:var(--accent)] hover:text-[color:var(--accent)] md:min-h-[36px] md:w-auto md:rounded-full md:py-1.5 md:text-[13.5px]"
          >
            <span className="font-semibold text-[color:var(--accent)]" aria-hidden>›</span>
            <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{s.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
