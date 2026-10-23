/**
 * Lot 81F — bouton « retour » (Android, geste retour du navigateur, WebView
 * Capacitor) et tiroirs.
 *
 * Sans ce module, « retour » quittait la PAGE en laissant le tiroir ouvert
 * par-dessus (ou fermait l'application quand l'historique était vide). Sur
 * un appareil tactile, chaque tiroir ouvert pose une entrée d'historique
 * (même URL, état Next.js recopié) ; « retour » la retire, et le tiroir se
 * ferme EXACTEMENT comme avec Échap : la garde du tiroir (`onEscapeKeyDown`,
 * ex. analyse en cours du tiroir document) s'applique, et seule la couche
 * du dessus se ferme.
 *
 * Fermeture par le X, Échap ou le code : on ne rappelle JAMAIS
 * `history.back()` (il annulerait une navigation lancée au même moment,
 * ex. lien dans le tiroir). L'entrée devient « morte » ; si l'utilisateur
 * revient en arrière depuis elle, l'appui qui n'aurait rien changé à
 * l'écran (même page) est enchaîné automatiquement : un seul appui suffit
 * toujours pour quitter la page.
 *
 * Desktop (pointeur fin, hors Capacitor) : aucun effet, historique intact.
 */
import * as React from 'react';

/** Jetons des tiroirs ouverts au-dessus de cette entrée (état d'historique). */
export const SHEET_STACK_KEY = '__vbSheets';
/** Sur l'entrée SOUS un tiroir : jeton du tiroir posé au-dessus. */
export const SHEET_BELOW_KEY = '__vbSheetBelow';

export interface SheetHistoryWindow {
  history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string, url?: string | null): void;
    replaceState(data: unknown, unused: string, url?: string | null): void;
    back(): void;
  };
  location: { href: string; protocol?: string };
  matchMedia?: (q: string) => { matches: boolean };
  Capacitor?: { isNativePlatform?: () => boolean };
}

type HistoryState = Record<string, unknown>;

function record(state: unknown): HistoryState {
  return state && typeof state === 'object' ? { ...(state as HistoryState) } : {};
}

export function sheetStack(state: unknown): string[] {
  const s = record(state)[SHEET_STACK_KEY];
  return Array.isArray(s) ? s.filter((t): t is string => typeof t === 'string') : [];
}

/** Appareil où « retour » existe et doit fermer le tiroir : tactile ou application native. */
export function sheetHistoryEnabled(w: SheetHistoryWindow): boolean {
  try {
    if (w.Capacitor?.isNativePlatform?.() === true) return true;
  } catch { /* pont natif indisponible */ }
  const p = w.location?.protocol;
  if (p === 'capacitor:' || p === 'ionic:') return true;
  try {
    return w.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

/** Jetons des tiroirs fermés autrement que par « retour » (entrée morte). */
const deadTokens = new Set<string>();

/** Pose l'entrée d'historique du tiroir `token` au-dessus de l'entrée courante. */
export function pushSheetEntry(w: SheetHistoryWindow, token: string): void {
  const cur = record(w.history.state);
  w.history.replaceState({ ...cur, [SHEET_BELOW_KEY]: token }, '', w.location.href);
  const { [SHEET_BELOW_KEY]: _below, ...rest } = cur;
  void _below;
  w.history.pushState({ ...rest, [SHEET_STACK_KEY]: [...sheetStack(cur), token] }, '', w.location.href);
}

/** Tiroir fermé sans « retour » : son entrée devient morte (jamais de `history.back()` ici). */
export function releaseSheetEntry(w: SheetHistoryWindow, token: string): void {
  deadTokens.add(token);
  const cur = record(w.history.state);
  const stack = sheetStack(cur);
  if (stack[stack.length - 1] === token) {
    w.history.replaceState({ ...cur, [SHEET_STACK_KEY]: stack.slice(0, -1) }, '', w.location.href);
  }
}

/**
 * À chaque `popstate` : arrivée sur l'entrée située sous un tiroir déjà
 * fermé (entrée morte au-dessus, même écran) → l'appui n'a rien changé à
 * l'écran : on poursuit le retour. Renvoie `true` si un retour a été enchaîné.
 */
export function skipDeadSheetEntry(w: SheetHistoryWindow): boolean {
  const below = record(w.history.state)[SHEET_BELOW_KEY];
  if (typeof below !== 'string' || !deadTokens.has(below)) return false;
  deadTokens.delete(below);
  w.history.back();
  return true;
}

/** Le tiroir `token` a-t-il été retiré de l'historique (retour) ? */
export function sheetEntryPopped(w: SheetHistoryWindow, token: string): boolean {
  return !sheetStack(w.history.state).includes(token);
}

export function __resetSheetHistoryForTests(): void {
  deadTokens.clear();
}

let seq = 0;
let skipInstalled = false;

/** Ferme la couche du dessus comme Échap (DismissableLayer de Radix, gardes comprises). */
function requestEscape(doc: Document): void {
  doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
}

/** Branche le bouton retour sur un tiroir ouvert (`open`). */
export function useSheetHistory(open: boolean): void {
  const openRef = React.useRef(open);
  openRef.current = open;
  const [repush, setRepush] = React.useState(0);

  React.useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const w = window as unknown as SheetHistoryWindow & Window;
    if (!sheetHistoryEnabled(w)) return;
    if (!skipInstalled) {
      skipInstalled = true;
      window.addEventListener('popstate', () => { skipDeadSheetEntry(w); });
    }
    seq += 1;
    const token = `s${Date.now().toString(36)}${seq}`;
    let live = true;
    pushSheetEntry(w, token);
    const onPop = () => {
      if (!live || !sheetEntryPopped(w, token)) return;
      live = false;
      requestEscape(document);
      // Fermeture refusée par le tiroir (garde) : on repose l'entrée.
      window.setTimeout(() => { if (openRef.current) setRepush((n) => n + 1); }, 30);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (live) releaseSheetEntry(w, token);
    };
  }, [open, repush]);
}
