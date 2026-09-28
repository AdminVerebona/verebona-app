/**
 * Préférences d'affichage des documents — mémorisées par contexte.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI EST MÉMORISÉ, ET CE QUI NE L'EST PAS
 *
 * Regroupement, liste / vignettes et tri sont des MANIÈRES de regarder : on
 * les retrouve d'une visite à l'autre, séparément pour « Mes documents » et
 * pour l'onglet Documents d'un bien (les deux périmètres ne se consultent pas
 * de la même façon).
 *
 * Les FILTRES ne le sont jamais : un utilisateur qui revient sur ses
 * documents doit les voir tous, pas hériter d'un filtre posé la semaine
 * précédente et oublié depuis.
 *
 * Le stockage peut être absent (rendu serveur), bloqué (navigation privée,
 * quota) ou contenir n'importe quoi (ancienne version, saisie manuelle) :
 * chaque lecture est validée champ par champ et chaque accès protégé.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { DocumentsContext, SortDir, SortKey, ViewMode } from './documents-view';

export interface ViewPrefs {
  grouped: boolean;
  view: ViewMode;
  sort: SortKey;
  dir: SortDir;
}

/** Valeurs de la maquette : regroupé, en liste, date d'ajout décroissante. */
export const DEFAULT_PREFS: Readonly<ViewPrefs> = {
  grouped: true,
  view: 'list',
  sort: 'added',
  dir: 'desc',
};

const PREFIX = 'verebona.documents.affichage.v1.';
export const prefsStorageKey = (context: DocumentsContext) => PREFIX + context;

/** Clés de l'ancien choix liste / vignettes, reprises une fois pour ne pas le perdre. */
export const LEGACY_VIEW_KEYS: Record<DocumentsContext, string> = {
  'mes-documents': 'documentsViewMode',
  'fiche-bien': 'assetDocumentsViewMode',
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const SORTS: readonly SortKey[] = ['added', 'docDate', 'title', 'bien', 'rubric'];

/** Valide une valeur lue ; tout champ invalide reprend sa valeur par défaut. */
export function parsePrefs(raw: unknown): ViewPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    grouped: typeof o.grouped === 'boolean' ? o.grouped : DEFAULT_PREFS.grouped,
    view: o.view === 'list' || o.view === 'grid' ? o.view : DEFAULT_PREFS.view,
    sort: SORTS.includes(o.sort as SortKey) ? (o.sort as SortKey) : DEFAULT_PREFS.sort,
    dir: o.dir === 'asc' || o.dir === 'desc' ? o.dir : DEFAULT_PREFS.dir,
  };
}

function storageOrNull(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null; // accès refusé (navigation privée, iframe sandbox)
  }
}

export function loadPrefs(context: DocumentsContext, storage?: StorageLike | null): ViewPrefs {
  const s = storageOrNull(storage);
  if (!s) return { ...DEFAULT_PREFS };
  try {
    const brut = s.getItem(prefsStorageKey(context));
    if (brut) return parsePrefs(JSON.parse(brut));
    const ancien = s.getItem(LEGACY_VIEW_KEYS[context]);
    return { ...DEFAULT_PREFS, view: ancien === 'grid' || ancien === 'list' ? ancien : DEFAULT_PREFS.view };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(context: DocumentsContext, prefs: ViewPrefs, storage?: StorageLike | null): void {
  const s = storageOrNull(storage);
  if (!s) return;
  try {
    s.setItem(prefsStorageKey(context), JSON.stringify(parsePrefs(prefs)));
  } catch {
    /* quota dépassé ou stockage bloqué : la préférence vaut pour la visite */
  }
}
