"use client"

import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Hook exporté pour utiliser le toggle de thème ailleurs (ex: dans un DropdownMenuItem)
export function useThemeToggle() {
  const [theme, setTheme] = useState<'blue' | 'beige'>('blue');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const savedTheme = localStorage.getItem('verebona-theme') as 'blue' | 'beige' | null;
    const initial = savedTheme || 'blue';
    setTheme(initial);
    applyTheme(initial);
  }, []);

  const applyTheme = (newTheme: 'blue' | 'beige') => {
    document.body.classList.remove('theme-blue', 'theme-beige');
    document.body.classList.add(`theme-${newTheme}`);
    document.documentElement.setAttribute('data-theme', newTheme);
  };

  const toggleTheme = () => {
    const newTheme = theme === 'blue' ? 'beige' : 'blue';
    setTheme(newTheme);
    applyTheme(newTheme);
    localStorage.setItem('verebona-theme', newTheme);
  };

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