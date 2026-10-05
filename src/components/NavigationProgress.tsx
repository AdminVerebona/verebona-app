'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Indicateur de navigation — UN seul, monté par ClientShell (APP-PERF-39).
 *
 * Les étapes de progression posaient quatre minuteurs dans une seule
 * référence : seul le dernier était annulé au changement de page suivant ou
 * au démontage, et les autres écrivaient ensuite un état obsolète (barre
 * relancée, jamais refermée lors d'une navigation rapide). Tous sont
 * désormais suivis et annulés ensemble.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    const timers = timersRef.current;
    const later = (fn: () => void, ms: number) => { timers.push(setTimeout(fn, ms)); };
    const clear = () => { timers.forEach(clearTimeout); timers.length = 0; };

    clear();
    setVisible(true);
    setWidth(20);

    later(() => setWidth(60), 80);
    later(() => setWidth(80), 300);
    later(() => {
      setWidth(100);
      later(() => {
        setVisible(false);
        setWidth(0);
      }, 250);
    }, 500);

    return clear;
  }, [pathname]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '2px',
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          height: '100%',
          background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
          width: `${width}%`,
          transition: width === 100 ? 'width 150ms ease' : 'width 300ms ease',
          boxShadow: '0 0 8px rgba(59,130,246,0.6)',
        }}
      />
    </div>
  );
}
