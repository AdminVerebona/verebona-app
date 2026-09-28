'use client';

/**
 * Garde de navigation client — CDC BO IA VER-007, WF-26.
 *
 * `beforeunload` ne couvre que la fermeture, le rechargement et les liens
 * externes. Une navigation client (menu `AdminSidebar`, `next/link`) ne le
 * déclenche pas : la saisie était perdue en silence. Ce crochet intercepte,
 * EN PHASE DE CAPTURE sur le document — donc avant le gestionnaire de clic de
 * `next/link`, que React branche sur la racine — tout clic sur un lien interne
 * de même origine, et le remet à l'écran : Enregistrer / Quitter sans
 * enregistrer / Annuler (WF-26 étape 2).
 *
 * Limite assumée : le bouton « Précédent » du navigateur n'est pas
 * intercepté (le faire suppose de manipuler l'historique) ; il reste couvert
 * par `beforeunload` lorsqu'il quitte l'application.
 */
import { useEffect } from 'react';

/** Pur : ce clic est-il une navigation interne à intercepter ? */
export function internalHref(
  e: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>,
  anchor: { href: string; target: string; hasAttribute(n: string): boolean } | null,
  location: { origin: string; href: string },
): string | null {
  if (!anchor || e.defaultPrevented || e.button !== 0) return null;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null; // nouvel onglet : rien n'est perdu
  if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return null;
  let url: URL;
  try { url = new URL(anchor.href, location.href); } catch { return null; }
  if (url.origin !== location.origin) return null; // lien externe : `beforeunload` s'en charge
  const here = new URL(location.href);
  if (url.pathname === here.pathname && url.search === here.search) return null; // ancre de la même page
  return url.pathname + url.search + url.hash;
}

export function useUnsavedNavigationGuard(
  dirty: boolean,
  ask: (proceed: () => void) => void,
  navigate: (href: string) => void,
): void {
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      const href = internalHref(e, anchor, window.location);
      if (!href) return;
      e.preventDefault();
      e.stopPropagation();
      ask(() => navigate(href));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [dirty, ask, navigate]);
}
