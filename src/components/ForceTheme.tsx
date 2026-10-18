"use client"

import { useLayoutEffect } from 'react';
import { applyThemeToDocument, type AppTheme } from '@/lib/theme';

/**
 * Force a specific theme on public/unauthenticated pages.
 * The user's saved preference is left untouched in localStorage —
 * only the active DOM attribute is overridden while the page is mounted.
 * useLayoutEffect runs before the browser paints, preventing any flash.
 * Lot 66 : la couleur de barre d'état (`theme-color`) suit le thème forcé.
 */
export function ForceTheme({ theme }: { theme: AppTheme }) {
  useLayoutEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  return null;
}
