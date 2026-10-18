"use client"

import { useState, useEffect, useCallback } from 'react';
import { Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  readSavedTheme,
  resolveTheme,
  systemPrefersDark,
  type AppTheme,
} from '@/lib/theme';

/**
 * Thème courant et bascule (menu du compte, desktop et mobile).
 *
 * Lot 66 : sans choix enregistré, le thème suit la préférence du système, y
 * compris quand elle change pendant la visite ; un choix fait dans le menu
 * est enregistré et l'emporte ensuite. Valeurs `blue` (sombre) / `beige`
 * (clair) inchangées (src/lib/theme.ts).
 */
export function useThemeToggle() {
  const [theme, setTheme] = useState<AppTheme>('beige');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const initial = resolveTheme(readSavedTheme(), systemPrefersDark());
    setTheme(initial);
    applyThemeToDocument(initial);

    // Préférence du système suivie tant qu'aucun choix n'est enregistré.
    const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : null;
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => {
      if (readSavedTheme()) return;
      const next: AppTheme = e.matches ? 'blue' : 'beige';
      setTheme(next);
      applyThemeToDocument(next);
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: AppTheme = prev === 'blue' ? 'beige' : 'blue';
      applyThemeToDocument(next);
      try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* stockage indisponible */ }
      return next;
    });
  }, []);

  return { theme, toggleTheme, mounted };
}

export function ThemeToggle({ iconOnly = false }: { iconOnly?: boolean }) {
  const { theme, toggleTheme, mounted } = useThemeToggle();

  if (!mounted) return null;

  return (
    <Button
      variant="ghost"
      onClick={toggleTheme}
      className={iconOnly ? 'w-10 h-10 p-0 rounded-full' : 'rounded-full justify-start w-full px-3 py-2'}
      title={theme === 'blue' ? 'Passer au thème clair' : 'Passer au thème sombre'}
    >
      {iconOnly ? (
        theme === 'blue' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />
      ) : (
        <span className="text-sm font-medium">
          Thème : {theme === 'blue' ? 'Sombre' : 'Clair'}
        </span>
      )}
    </Button>
  );
}
