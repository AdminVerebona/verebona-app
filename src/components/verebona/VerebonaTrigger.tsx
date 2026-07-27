'use client';
/** Bouton flottant d'ouverture — CDC §7.1. Utilisable hors du DrawerTrigger si besoin. */
import { VerebonaMascot } from './VerebonaMascot';

export function VerebonaTrigger({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Ouvrir l'assistant Verebona"
      className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:scale-105"
    >
      <VerebonaMascot pose="idle" size={32} />
    </button>
  );
}
