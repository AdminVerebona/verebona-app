'use client';

/**
 * Lot 109B — protection des saisies non enregistrées de la fiche fournisseur.
 *
 * Tant que `dirty` est vrai :
 *  · fermer l'onglet ou recharger : avertissement du navigateur ;
 *  · clic sur un lien interne de l'application : confirmation avant de partir ;
 *  · retour du navigateur ou geste retour du téléphone : une entrée
 *    d'historique de GARDE (même adresse) est posée ; « retour » la retire et
 *    déclenche la confirmation — « Quitter » poursuit le retour, « Continuer »
 *    repose la garde. Le bouton « Retour » de la fiche passe par la même
 *    confirmation.
 * Une garde devenue inutile (modifications enregistrées ou annulées) est
 * « morte » : un appui retour qui y arriverait est enchaîné automatiquement,
 * comme pour les tiroirs (`sheet-history.ts`) — un seul appui suffit toujours.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { UNSAVED_GUARD_KEY } from '@/lib/suppliers/supplier-return';

export { UNSAVED_GUARD_KEY };

let deadGuard = false;
let skipInstalled = false;

function onCurrentGuardEntry(): boolean {
  const st = window.history.state as Record<string, unknown> | null;
  return !!st && st[UNSAVED_GUARD_KEY] === true;
}

function pushGuard(): void {
  const st = (window.history.state ?? {}) as Record<string, unknown>;
  window.history.pushState({ ...st, [UNSAVED_GUARD_KEY]: true }, '', window.location.href);
}

export function useUnsavedChangesGuard(dirty: boolean, navigate: (href: string) => void) {
  // Demande en cours : ref (une seule résolution, même si la fenêtre se ferme
  // ensuite d'elle-même) + état (affichage de la fenêtre).
  const pendingRef = useRef<null | { proceed: () => void; stay?: () => void }>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const setPending = useCallback((p: null | { proceed: () => void; stay?: () => void }) => {
    pendingRef.current = p;
    setConfirmOpen(p !== null);
  }, []);
  const navRef = useRef(navigate);
  navRef.current = navigate;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  /** Départ confirmé : les retours qui suivent ne redemandent rien. */
  const leavingRef = useRef(false);

  // Garde morte : l'appui retour qui y arrive est enchaîné (aucun effet visible sinon).
  useEffect(() => {
    if (skipInstalled || typeof window === 'undefined') return;
    skipInstalled = true;
    window.addEventListener('popstate', () => {
      if (deadGuard && !onCurrentGuardEntry()) { deadGuard = false; window.history.back(); }
    });
  }, []);

  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    deadGuard = false;
    leavingRef.current = false;
    pushGuard();
    let armed = true;
    const onPop = () => {
      if (!armed || leavingRef.current || onCurrentGuardEntry()) return;
      armed = false;
      setPending({
        proceed: () => { window.history.back(); },
        stay: () => { pushGuard(); armed = true; },
      });
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self')) return;
      let url: URL;
      try { url = new URL(a.href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      const href = `${url.pathname}${url.search}${url.hash}`;
      // La garde reste sous la page suivante : morte, elle sera enchaînée au retour.
      setPending({ proceed: () => { armed = false; deadGuard = true; navRef.current(href); } });
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('click', onClick, true);
      // Saisie enregistrée ou abandonnée sans quitter : la garde au-dessus devient morte.
      if (armed && onCurrentGuardEntry()) deadGuard = true;
    };
  }, [dirty, setPending]);

  /** Exécute `leave` après confirmation si une saisie est en cours. */
  const confirmLeave = useCallback((leave: () => void) => {
    if (!dirtyRef.current) { leave(); return; }
    setPending({ proceed: leave });
  }, [setPending]);

  const resolve = useCallback((leave: boolean) => {
    const p = pendingRef.current;
    setPending(null);
    if (!p) return;
    if (leave) { leavingRef.current = true; p.proceed(); } else p.stay?.();
  }, [setPending]);

  return { confirmOpen, confirmLeave, resolve };
}
