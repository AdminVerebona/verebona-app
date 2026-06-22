"use client"

import { useLayoutEffect } from 'react';

/**
 * Force a specific theme on public/unauthenticated pages.
 * The user's saved preference is left untouched in localStorage —
 * only the active DOM attribute is overridden while the page is mounted.
 * useLayoutEffect runs before the browser paints, preventing any flash.
 */
export function ForceTheme({ theme }: { theme: 'blue' | 'beige' }) {
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.classList.remove('theme-blue', 'theme-beige');
    document.body.classList.add(`theme-${theme}`);
  }, [theme]);

  return null;
}
