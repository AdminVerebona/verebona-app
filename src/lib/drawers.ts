/**
 * Tiroirs généralisés — ouvrir une fiche sans quitter l'écran.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN SEUL MÉCANISME, QUATRE FICHES
 *
 * Document, échéance, équipement et pièce s'ouvrent en tiroir depuis n'importe
 * quel écran : notifications, « À traiter », recherche, sources de
 * l'assistant. Les biens restent des pages : ils ont des onglets et une
 * navigation propres qu'un tiroir écraserait.
 *
 * · `openDrawer({ kind, id })` depuis le code ;
 * · `?tiroir=<kind>:<id>` dans une URL (lien profond : e-mail, push, favori).
 *   Le paramètre est retiré de l'adresse une fois le tiroir ouvert, pour qu'un
 *   rechargement ne le rouvre pas.
 *
 * Le document garde son événement historique `open-document-drawer` : une
 * dizaine d'écrans l'émettent déjà et DashboardLayout l'écoute. Les trois
 * autres fiches passent par `open-entity-drawer`, écouté par GlobalDrawerHost.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { openHelpFromLink } from '@/lib/help-center/open';

export type DrawerKind = 'document' | 'echeance' | 'equipement' | 'piece';

export interface DrawerTarget {
  kind: DrawerKind;
  id: number;
  /** Document : ouvrir directement sur les résultats d'analyse. */
  showAnalysisResults?: boolean;
  /** Échéance : ouvrir en édition (date manquante, par exemple). */
  initialMode?: 'view' | 'edit';
}

export const OPEN_DOCUMENT_DRAWER = 'open-document-drawer';
export const OPEN_ENTITY_DRAWER = 'open-entity-drawer';
export const DRAWER_PARAM = 'tiroir';

/** Synonymes acceptés dans l'URL — le code, lui, n'utilise que les noms canoniques. */
const ALIASES: Record<string, DrawerKind> = {
  document: 'document', doc: 'document', fichier: 'document',
  echeance: 'echeance', agenda: 'echeance', evenement: 'echeance',
  equipement: 'equipement', equipment: 'equipement',
  piece: 'piece', room: 'piece', substructure: 'piece',
};

export function parseDrawerParam(value: string | null | undefined): DrawerTarget | null {
  if (!value) return null;
  const m = /^([a-z]+):(\d{1,10})$/i.exec(value.trim());
  if (!m) return null;
  const kind = ALIASES[m[1].toLowerCase()];
  const id = Number(m[2]);
  if (!kind || !Number.isSafeInteger(id) || id <= 0) return null;
  return { kind, id };
}

export function drawerParam(t: Pick<DrawerTarget, 'kind' | 'id'>): string {
  return `${t.kind}:${t.id}`;
}

/** Lien profond vers une fiche, sur la page donnée (l'accueil par défaut). */
export function drawerHref(t: Pick<DrawerTarget, 'kind' | 'id'>, path = '/accueil'): string {
  const [base, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set(DRAWER_PARAM, drawerParam(t));
  return `${base}?${params.toString()}`;
}

/**
 * Lot 75H — options d'ouverture.
 *
 * `stack` : la fiche s'EMPILE au-dessus des tiroirs déjà ouverts (carte
 * d'entité dans un tiroir) ; la fermer ramène au tiroir d'origine. Pour un
 * document, l'ouverture passe alors par GlobalDrawerHost (pile) et non par
 * le tiroir document unique de DashboardLayout : ce dernier peut être
 * lui-même SOUS le tiroir d'origine (document → équipement → document), et
 * la nouvelle fiche y resterait cachée.
 */
export interface OpenDrawerOptions {
  stack?: boolean;
  /**
   * Lot 76E — élément qui reprend le focus à la fermeture du tiroir document
   * (vignette d'une carte « À traiter »). Sans déclencheur Radix, le tiroir ne
   * le rendait à rien. Opt-in : sans cette option, rien ne change.
   */
  returnFocusTo?: HTMLElement | null;
}

/** Ouvre la fiche en tiroir, sur l'écran courant. */
export function openDrawer(t: DrawerTarget, opts: OpenDrawerOptions = {}): void {
  if (typeof window === 'undefined') return;
  if (t.kind === 'document' && opts.stack) {
    window.dispatchEvent(new CustomEvent<DrawerTarget>(OPEN_ENTITY_DRAWER, { detail: t }));
    return;
  }
  if (t.kind === 'document') {
    window.dispatchEvent(new CustomEvent(OPEN_DOCUMENT_DRAWER, {
      detail: {
        docId: t.id,
        showAnalysisResults: t.showAnalysisResults,
        ...(opts.returnFocusTo ? { returnFocusTo: opts.returnFocusTo } : {}),
      },
    }));
    return;
  }
  window.dispatchEvent(new CustomEvent<DrawerTarget>(OPEN_ENTITY_DRAWER, { detail: t }));
}

/**
 * Lot 76E — à la fermeture d'un tiroir (`onCloseAutoFocus` Radix) : rend le
 * focus à l'élément d'origine s'il est toujours affiché, et empêche alors le
 * comportement par défaut. Rend `true` si le focus a été rendu.
 */
export function restoreFocusOnClose(
  e: { preventDefault(): void },
  el: HTMLElement | null | undefined,
): boolean {
  if (!el || !el.isConnected) return false;
  e.preventDefault();
  el.focus();
  return true;
}

/** Fiche désignée par un lien profond, ou `null` si le lien n'en porte pas. */
export function drawerFromHref(href: string | null | undefined): DrawerTarget | null {
  if (!href) return null;
  const q = href.indexOf('?');
  if (q === -1) return null;
  const query = href.slice(q + 1).split('#')[0];
  return parseDrawerParam(new URLSearchParams(query).get(DRAWER_PARAM));
}

/**
 * Clic sur un lien interne : s'il désigne une fiche, elle s'ouvre en tiroir
 * sur l'écran courant, sans navigation. Rend `true` si le clic est traité.
 * (Un clic modifié — nouvel onglet — suit le lien, qui porte le même tiroir.)
 */
export function openDrawerFromLink(
  e: { preventDefault(): void; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; button?: number },
  href: string | null | undefined,
): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || (e.button ?? 0) !== 0) return false;
  // Lot 59 (point 3) : un lien vers le Centre d'aide s'ouvre dans un nouvel
  // onglet (site public), jamais dans l'application.
  if (openHelpFromLink(e, href)) return true;
  const t = drawerFromHref(href);
  if (!t) return false;
  e.preventDefault();
  openDrawer(t);
  return true;
}

// ══════════════════════════════════════════════════════════════════════════
// PILE DES TIROIRS (lot 75H)
//
// GlobalDrawerHost tient une PILE : une fiche ouverte depuis un tiroir
// s'affiche au-dessus, sa fermeture ramène à la précédente. Une fiche déjà
// présente dans la pile n'est pas rouverte une deuxième fois : on y revient
// (les tiroirs au-dessus se ferment), ce qui évite les boucles
// équipement → document → équipement → … La profondeur est bornée.
// ══════════════════════════════════════════════════════════════════════════

export const DRAWER_STACK_MAX = 6;

export function drawerKey(t: Pick<DrawerTarget, 'kind' | 'id'>): string {
  return `${t.kind}:${t.id}`;
}

/** Pile après ouverture de `entry` (clé `kind:id`). Pure, testée. */
export function pushDrawerEntry<T extends { key: string }>(stack: readonly T[], entry: T, max = DRAWER_STACK_MAX): T[] {
  const at = stack.findIndex((e) => e.key === entry.key);
  if (at !== -1) return [...stack.slice(0, at), entry];
  const next = [...stack, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Pile après fermeture de la fiche `key` (et de celles empilées au-dessus). */
export function closeDrawerEntry<T extends { key: string }>(stack: readonly T[], key: string): T[] {
  const at = stack.findIndex((e) => e.key === key);
  return at === -1 ? [...stack] : stack.slice(0, at);
}
