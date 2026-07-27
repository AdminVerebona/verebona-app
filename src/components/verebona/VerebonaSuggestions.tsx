'use client';
/** Suggestions initiales — CDC §8 (catalogue, jamais généré par IA). */
export function VerebonaSuggestions({
  suggestions, onPick,
}: { suggestions: Array<{ id: string; label: string }>; onPick: (label: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">Comment puis-je vous aider ?</p>
      <div className="flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <button key={s.id} onClick={() => onPick(s.label)}
                  className="rounded-full border px-3 py-1.5 text-xs hover:bg-muted">
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
