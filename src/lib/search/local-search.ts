/**
 * Recherche locale des écrans Documents et Agenda — lot 97C (ticket P1
 * « Ajouter une recherche locale réactive sur les quatre écrans »,
 * arbitrages PO du 26/10/2026 : Q1-B pages générales ET onglets des biens,
 * Q2-A filtrage automatique après un court délai, Q3-B Agenda : toutes
 * périodes par défaut, résultats en liste).
 *
 * Module PUR (aucun accès base, aucune dépendance React) : partagé par le
 * champ commun (`components/search/LocalSearchField.tsx`), les quatre écrans
 * et les routes `GET /api/v2/documents` et `GET /api/agenda`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE NE FAIT PAS
 *
 * Il ne cherche rien : la correspondance est celle de la barre de recherche
 * (`lib/search/match-engine.ts`, via `matchingIdsForList` du service de
 * recherche globale), appliquée côté serveur AVANT pagination et compteurs.
 * Aucun appel IA (T1, T2, T3, T4, T6) n'est déclenché par la saisie.
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Délai sans nouvelle frappe avant l'envoi de la recherche (Q2-A). */
export const LOCAL_SEARCH_DEBOUNCE_MS = 300;
/** Longueur conservée (même borne que `parseSearchQuery`). */
export const LOCAL_SEARCH_MAX_LENGTH = 200;
/** Paramètre d'URL de la recherche locale (pages générales et onglets `tab`). */
export const LOCAL_SEARCH_PARAM = 'q';

export type LocalSearchKind = 'document' | 'agenda';

/** Libellés validés par le ticket (§3.1). */
export const LOCAL_SEARCH_LABELS: Readonly<Record<LocalSearchKind, string>> = {
  document: 'Rechercher dans les documents…',
  agenda: 'Rechercher dans l’agenda…',
};

/** Saisie normalisée : espaces superflus retirés, longueur bornée. */
export function normalizeLocalQuery(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, LOCAL_SEARCH_MAX_LENGTH);
}

/** Recherche lue dans une URL (`?q=`) ; chaîne vide si absente. */
export function readLocalQuery(params: Pick<URLSearchParams, 'get'> | null | undefined): string {
  return normalizeLocalQuery(params?.get(LOCAL_SEARCH_PARAM) ?? '');
}

const nom = (kind: LocalSearchKind, n: number) =>
  kind === 'document' ? `document${n > 1 ? 's' : ''}` : `élément${n > 1 ? 's' : ''}`;

/** Nombre RÉEL de résultats (compteur serveur), annoncé sous le champ. */
export function localSearchStatus(kind: LocalSearchKind, count: number): string {
  if (count === 0) return kind === 'document' ? 'Aucun document trouvé' : 'Aucun élément trouvé';
  return `${count} ${nom(kind, count)} ${count > 1 ? 'trouvés' : 'trouvé'}`;
}

/** Message spécifique « aucun résultat » (§3.1), distinct de la liste vide. */
export function localSearchNoResult(kind: LocalSearchKind, q: string, filtered: boolean): string {
  const quoi = kind === 'document' ? 'Aucun document' : 'Aucun élément';
  return filtered
    ? `${quoi} ne correspond à « ${q} » avec ces filtres.`
    : `${quoi} ne correspond à « ${q} ».`;
}

/**
 * Nouvelle chaîne de requête après une recherche validée — les AUTRES
 * paramètres (filtres, vue, onglet `tab`) sont conservés.
 *
 *   · `q` vide → paramètre retiré ;
 *   · `dropResults` (Mes documents) : une nouvelle recherche n'est jamais
 *     limitée en silence par un ancien filtre d'identifiants `?resultats=`
 *     de l'assistant ;
 *   · `switchToList` (Agenda, Q3-B) : une recherche (nouvelle ou modifiée)
 *     passe en vue Liste, où toutes les périodes sont affichées.
 */
export function searchWithLocalQuery(
  search: string,
  q: string,
  opts: { dropResults?: boolean; switchToList?: boolean } = {},
): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const avant = readLocalQuery(params);
  const valeur = normalizeLocalQuery(q);
  if (valeur) params.set(LOCAL_SEARCH_PARAM, valeur);
  else params.delete(LOCAL_SEARCH_PARAM);
  if (valeur && opts.dropResults) params.delete('resultats');
  if (valeur && opts.switchToList && valeur !== avant) params.set('view', 'list');
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Changement d'onglet d'une fiche de bien : la recherche d'un onglet n'est
 * jamais appliquée automatiquement à un autre (§7.2) — `q` est retiré.
 */
export function searchForTab(search: string, tab: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const avant = params.get('tab');
  params.set('tab', tab);
  if (avant !== tab) params.delete(LOCAL_SEARCH_PARAM);
  return `?${params.toString()}`;
}

/**
 * Lien « Voir tous » de la recherche générale : l'écran complet, recherche
 * PRÉREMPLIE (le critère, jamais les quelques identifiants des suggestions).
 */
export function localSearchHref(kind: LocalSearchKind, q: string): string {
  const valeur = normalizeLocalQuery(q);
  const params = new URLSearchParams();
  if (valeur) params.set(LOCAL_SEARCH_PARAM, valeur);
  if (kind === 'agenda' && valeur) params.set('view', 'list');
  const s = params.toString();
  return `${kind === 'document' ? '/documents' : '/agenda'}${s ? `?${s}` : ''}`;
}

// ── Saisie différée (testable sans navigateur) ───────────────────────────

type Timer = ReturnType<typeof setTimeout>;

export interface LocalSearchInput {
  /** Frappe : la recherche part après `LOCAL_SEARCH_DEBOUNCE_MS` sans nouvelle frappe. */
  type: (raw: string) => void;
  /** Entrée : exécution immédiate (le délai en cours est annulé). */
  submit: (raw: string) => void;
  /** Effacement : recherche vide immédiatement. */
  clear: () => void;
  /**
   * Recherche active changée de l'extérieur (URL, retour arrière) : devient
   * la référence, sans annuler une frappe en attente.
   */
  sync: (q: string) => void;
  /** Démontage : aucun envoi tardif. */
  dispose: () => void;
}

/**
 * Contrôleur de saisie du champ commun. `commit` n'est appelé qu'avec une
 * valeur NORMALISÉE et DIFFÉRENTE de la dernière transmise : deux frappes
 * qui reviennent au même texte ne relancent aucune requête.
 */
export function createLocalSearchInput(
  commit: (q: string) => void,
  opts: { initial?: string; delayMs?: number; setTimer?: (fn: () => void, ms: number) => Timer; clearTimer?: (t: Timer) => void } = {},
): LocalSearchInput {
  const delay = opts.delayMs ?? LOCAL_SEARCH_DEBOUNCE_MS;
  const setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimer ?? ((t) => clearTimeout(t));
  let last = normalizeLocalQuery(opts.initial ?? '');
  let timer: Timer | null = null;
  const stop = () => { if (timer !== null) { clearT(timer); timer = null; } };
  const send = (raw: string) => {
    stop();
    const q = normalizeLocalQuery(raw);
    if (q === last) return;
    last = q;
    commit(q);
  };
  return {
    type: (raw) => { stop(); timer = setT(() => { timer = null; send(raw); }, delay); },
    submit: (raw) => send(raw),
    clear: () => send(''),
    sync: (q) => { last = normalizeLocalQuery(q); },
    dispose: stop,
  };
}

/**
 * Garde « dernière saisie seulement » : chaque recherche reçoit un numéro ;
 * une réponse dont le numéro n'est plus le dernier est ignorée (réponses
 * arrivées dans le désordre, §3.1).
 */
export function createLatestGuard() {
  let seq = 0;
  return {
    next: () => ++seq,
    isLatest: (n: number) => n === seq,
  };
}
