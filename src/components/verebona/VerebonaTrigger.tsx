"use client"

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

interface VerebonaTriggerProps {
  onClick?: () => void;
  /** Masquer quand le drawer est ouvert. */
  hidden?: boolean;
}

/**
 * Entrée de l'assistant — CDC §7.1, refonte « Accueil Assistant » :
 * mascotte 3D (pose dialogue) + pilule « Demander à Verebona ».
 * S'estompe pendant le scroll du conteneur principal, disparaît drawer ouvert.
 */
export function VerebonaTrigger({ onClick, hidden }: VerebonaTriggerProps) {
  const [dimmed, setDimmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = document.getElementById('main-scroll-container') ?? window;
    const onScroll = () => {
      setDimmed(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setDimmed(false), 450);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (hidden) return null;

  return (
    <button
      type="button"
      onClick={onClick ?? (() => window.dispatchEvent(new CustomEvent('verebona:open', { detail: {} })))}
      aria-label="Demander à Verebona"
      className={`fixed bottom-5 right-6 z-40 flex items-center gap-2.5 transition-all duration-300 hover:-translate-y-0.5 ${dimmed ? 'opacity-25' : 'opacity-100'}`}
    >
      <span className="px-3.5 py-2 rounded-full bg-[color:var(--bg-card)] border border-[color:var(--border-subtle)] shadow-relief-lg text-[12.5px] font-semibold text-[color:var(--text-primary)]">
        Demander à Verebona
      </span>
      <Image
        src="/mascot/dialogue-bubble.webp"
        alt=""
        width={64}
        height={64}
        className="select-none animate-[vb-float_6s_ease-in-out_infinite] [filter:drop-shadow(0_14px_24px_rgba(4,10,26,.6))]"
      />
    </button>
  );
}
