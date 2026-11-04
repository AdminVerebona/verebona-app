'use client';

/**
 * Lot 109B — chef d'orchestre du retour contextuel vers l'écran quitté pour
 * une fiche fournisseur (voir `src/lib/suppliers/supplier-return.ts`).
 *
 * Monté une fois dans la coquille (DashboardLayout), il :
 *  · enregistre l'instantané de l'écran au clic sur TOUT lien vers une fiche
 *    fournisseur (phase de capture : avant que le lien, l'Assistant ou un
 *    tiroir ne se ferment) ; un lien ordinaire que personne n'a pris en
 *    charge est suivi DANS l'application (jamais de rechargement complet,
 *    qui perdrait l'historique de l'onglet) ;
 *  · à l'arrivée sur la fiche, rattache l'instantané (jeton dans l'adresse)
 *    et ferme les tiroirs globaux restés ouverts par-dessus ;
 *  · au retour (navigateur, geste mobile, bouton de la fiche), rouvre les
 *    tiroirs dans leur ordre, l'Assistant, et rétablit le défilement.
 * Aucun rendu.
 */
import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { RESTORE_DRAWER_STACK_EVENT, CLOSE_ALL_DRAWERS_EVENT } from '@/lib/drawers';
import {
  ASSISTANT_CONTAINER_SELECTOR, RETURN_RESTORED_EVENT, bindSupplierArrival, captureSupplierOrigin, notePopState, registerSupplierNavigator,
  restoreAssistant, supplierIdFromHref, supplierIdFromPath, takePendingRestore, withReturnParam, type SupplierReturnContext,
} from '@/lib/suppliers/supplier-return';
import { supplierHref } from '@/lib/supplier-routes';

/** Délai maximal pour retrouver la position (contenu chargé progressivement). */
const SCROLL_RESTORE_MAX_MS = 4000;

function restoreScroll(top: number): void {
  if (top <= 0) return;
  const started = Date.now();
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  window.addEventListener('wheel', cancel, { once: true, passive: true });
  window.addEventListener('touchstart', cancel, { once: true, passive: true });
  const tick = () => {
    if (cancelled) return;
    const el = document.getElementById('main-scroll-container');
    if (el) {
      const max = el.scrollHeight - el.clientHeight;
      if (max >= top) { el.scrollTo({ top, behavior: 'auto' }); return; }
      if (Date.now() - started > SCROLL_RESTORE_MAX_MS) { el.scrollTo({ top: max, behavior: 'auto' }); return; }
    } else if (Date.now() - started > SCROLL_RESTORE_MAX_MS) return;
    window.setTimeout(tick, 80);
  };
  window.setTimeout(tick, 0);
}

function replay(ctx: SupplierReturnContext): void {
  if (ctx.drawers.length > 0) {
    window.dispatchEvent(new CustomEvent(RESTORE_DRAWER_STACK_EVENT, { detail: ctx.drawers }));
  }
  if (ctx.assistant?.open) restoreAssistant(ctx.assistant);
  restoreScroll(ctx.scrollTop);
  window.dispatchEvent(new CustomEvent(RETURN_RESTORED_EVENT, { detail: { pathname: ctx.pathname, view: ctx.view } }));
}

const isPlainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

function supplierAnchor(e: MouseEvent): { a: HTMLAnchorElement; id: number } | null {
  const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return null;
  const id = supplierIdFromHref(a.getAttribute('href'));
  return id ? { a, id } : null;
}

export function SupplierReturnManager() {
  const router = useRouter();
  const pathname = usePathname();
  const lastHref = useRef<string | null>(null);
  const captured = useRef(new WeakMap<Event, string>());

  useEffect(() => {
    registerSupplierNavigator({ push: (h) => router.push(h), replace: (h) => router.replace(h) });
    return () => registerSupplierNavigator(null);
  }, [router]);

  useEffect(() => {
    const onCapture = (e: MouseEvent) => {
      if (!isPlainClick(e)) return;
      const hit = supplierAnchor(e);
      if (!hit) return;
      // Lien vers la fiche déjà affichée (document ouvert depuis cette fiche) :
      // aucune navigation, les tiroirs se ferment et la fiche reste telle quelle.
      if (supplierIdFromPath(window.location.pathname) === hit.id) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent(CLOSE_ALL_DRAWERS_EVENT));
        return;
      }
      lastHref.current = window.location.href;
      const token = captureSupplierOrigin(hit.id, { fromAssistant: !!hit.a.closest(ASSISTANT_CONTAINER_SELECTOR) });
      if (token) captured.current.set(e, token);
    };
    // Après tous les gestionnaires : un lien ordinaire non pris en charge
    // (ni lien Next, ni ouverture propre à l'écran) est suivi dans l'application.
    const onBubble = (e: MouseEvent) => {
      const token = captured.current.get(e);
      if (!token || e.defaultPrevented || !isPlainClick(e)) return;
      const hit = supplierAnchor(e);
      if (!hit) return;
      e.preventDefault();
      router.push(withReturnParam(supplierHref(hit.id), token));
    };
    const onPop = () => { notePopState(lastHref.current, window.location); };
    window.addEventListener('click', onCapture, true);
    window.addEventListener('click', onBubble);
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('click', onCapture, true);
      window.removeEventListener('click', onBubble);
      window.removeEventListener('popstate', onPop);
    };
  }, [router]);

  useEffect(() => {
    const loc = window.location;
    const token = bindSupplierArrival(loc, (url) => {
      window.history.replaceState(window.history.state, '', url);
    });
    if (token) {
      // Les tiroirs globaux (pile, document) restés ouverts sous la fiche se ferment.
      window.dispatchEvent(new CustomEvent(CLOSE_ALL_DRAWERS_EVENT));
    }
    const ctx = takePendingRestore(loc.pathname);
    if (ctx) replay(ctx);
    lastHref.current = window.location.href;
  }, [pathname]);

  return null;
}
