'use client';
/** En-tête du drawer (titre + fermeture + effacer l'historique) — CDC §7 / §24.5. */
import { VerebonaMascot } from './VerebonaMascot';

export function VerebonaHeader({ onClear }: { onClear?: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 font-medium">
        <VerebonaMascot pose="idle" size={22} /> Verebona
      </div>
      {onClear && (
        <button onClick={onClear} className="text-xs text-muted-foreground underline" aria-label="Effacer l'historique">
          Effacer
        </button>
      )}
    </div>
  );
}
