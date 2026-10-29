'use client';

/**
 * Champ de recherche locale — UN composant pour les quatre écrans (lot 97C) :
 * « Mes documents », Documents d'un bien, « Mon agenda », Agenda d'un bien.
 *
 * Le champ ne cherche rien lui-même : il transmet une saisie normalisée à
 * l'écran (`onCommit`), qui l'ajoute à SA requête serveur (filtres, tri,
 * pagination et compteurs inchangés). Les écrans restent propriétaires de
 * leurs filtres et de leur présentation.
 *
 * Comportement (§3.1 du ticket) :
 *   · envoi après 300 ms sans nouvelle frappe ; Entrée : immédiat ;
 *   · bouton d'effacement dès qu'une saisie existe (les filtres restent) ;
 *     Échap efface aussi ;
 *   · indicateur discret pendant la recherche ;
 *   · nombre RÉEL de résultats (compteur serveur), annoncé aux technologies
 *     d'assistance (`aria-live`) ;
 *   · réponses dans le désordre : ignorées par l'écran (clé de requête ou
 *     numéro d'appel), le champ n'affiche que l'état de la dernière saisie.
 *
 * Charte Sérénité : jetons CSS existants ; 16 px sur téléphone (pas de zoom
 * automatique iOS), cible tactile de 44 px pour l'effacement.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, Search, X } from 'lucide-react';
import {
  LOCAL_SEARCH_LABELS,
  LOCAL_SEARCH_MAX_LENGTH,
  createLocalSearchInput,
  localSearchStatus,
  normalizeLocalQuery,
  type LocalSearchInput,
  type LocalSearchKind,
} from '@/lib/search/local-search';

export function LocalSearchField({
  kind,
  value,
  onCommit,
  busy = false,
  resultCount = null,
  className = '',
}: {
  kind: LocalSearchKind;
  /** Recherche ACTIVE (validée) — URL, retour sur l'écran. */
  value: string;
  onCommit: (q: string) => void;
  /** Une requête de la recherche active est en cours. */
  busy?: boolean;
  /** Résultats de la recherche active (serveur) ; `null` tant qu'inconnu. */
  resultCount?: number | null;
  className?: string;
}) {
  const id = useId();
  const statusId = `${id}-etat`;
  const [draft, setDraft] = useState(value);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  const inputRef = useRef<LocalSearchInput | null>(null);
  const champ = useRef<HTMLInputElement | null>(null);

  // Une seule instance de contrôleur par montage. Dernière valeur connue : validée par ce champ, ou reçue de l'écran.
  const derniere = useRef(value);
  if (inputRef.current === null) {
    inputRef.current = createLocalSearchInput((q) => { derniere.current = q; commitRef.current(q); }, { initial: value });
  }
  useEffect(() => () => inputRef.current?.dispose(), []);

  // Recherche changée de l'EXTÉRIEUR (URL ouverte, retour arrière, effacement
  // par l'écran) : le champ s'aligne. Une valeur que ce champ vient de valider
  // ne touche jamais au texte en cours de frappe.
  useEffect(() => {
    if (value === derniere.current) return;
    derniere.current = value;
    inputRef.current?.sync(value);
    // Saisie en cours qui mène déjà à cette valeur : le texte tapé est gardé tel quel.
    setDraft((d) => (normalizeLocalQuery(d) === value ? d : value));
  }, [value]);

  const actif = value !== '';
  const libelle = LOCAL_SEARCH_LABELS[kind];
  const etat = actif && resultCount !== null && !busy ? localSearchStatus(kind, resultCount) : '';

  return (
    <div className={`w-full ${className}`}>
      <form
        role="search"
        aria-label={kind === 'document' ? 'Recherche dans les documents' : 'Recherche dans l’agenda'}
        onSubmit={(e) => { e.preventDefault(); inputRef.current?.submit(draft); }}
        className="relative flex w-full items-center"
      >
        <Search className="pointer-events-none absolute left-3 h-4 w-4 text-[color:var(--text-muted)]" aria-hidden />
        <input
          ref={champ}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={LOCAL_SEARCH_MAX_LENGTH}
          value={draft}
          placeholder={libelle}
          aria-label={libelle}
          aria-describedby={statusId}
          aria-busy={busy || undefined}
          onChange={(e) => { setDraft(e.target.value); inputRef.current?.type(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && draft !== '') {
              e.preventDefault();
              setDraft('');
              inputRef.current?.clear();
            }
          }}
          className="h-10 w-full min-w-0 rounded-[12px] border border-input bg-[color:var(--field-bg)] pl-9 pr-20 text-base text-[color:var(--text-primary)] outline-none transition-[border-color] duration-[180ms] placeholder:text-[color:var(--text-muted)] focus-visible:border-[color:var(--accent)] md:text-sm [&::-webkit-search-cancel-button]:hidden"
          data-testid={`recherche-locale-${kind}`}
        />
        <span className="absolute right-1 flex items-center gap-0.5">
          {busy && actif && (
            <Loader2 className="h-4 w-4 animate-spin text-[color:var(--text-muted)]" aria-hidden />
          )}
          {draft !== '' && (
            <button
              type="button"
              onClick={() => { setDraft(''); inputRef.current?.clear(); champ.current?.focus(); }}
              aria-label="Effacer la recherche"
              title="Effacer la recherche"
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text-primary)] md:h-8 md:w-8"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </span>
      </form>
      <p id={statusId} role="status" aria-live="polite" className="m-0 min-h-[18px] px-1 pt-1 text-xs text-[color:var(--text-muted)]">
        {busy && actif ? 'Recherche en cours…' : etat}
      </p>
    </div>
  );
}
