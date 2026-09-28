'use client';
/**
 * Requête média suivie en direct — Direction D v2 §12bis : le réglage
 * « mouvement réduit » est suivi sans rechargement.
 */
import { useEffect, useState } from 'react';

export function useMediaQuery(query: string, initial = false): boolean {
  const [matches, setMatches] = useState(initial);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** `prefers-reduced-motion: reduce`, suivi en direct. */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** Écran ≥ 768 px (coquille desktop). */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)', true);
}
