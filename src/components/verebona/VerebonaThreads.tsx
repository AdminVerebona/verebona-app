'use client';
/**
 * Sélecteur de fils de conversation — plusieurs conversations indépendantes.
 *
 * Chaque fil garde sa propre mémoire ; « Nouvelle conversation » démarre sans
 * rien reprendre des autres. Les fils sont ceux de l'utilisateur connecté
 * uniquement (privés en Duo).
 */
import type { VerebonaThread } from '@/lib/verebona/useVerebona';

export interface VerebonaThreadsProps {
  threads: VerebonaThread[];
  currentId: number | null;
  disabled?: boolean;
  onSelect: (id: number) => void;
  onNew: () => void;
  onClear: () => void;
}

const dateCourte = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) : '';

export function libelleFil(t: VerebonaThread): string {
  const titre = t.title?.trim() || 'Nouvelle conversation';
  const date = dateCourte(t.lastMessageAt ?? t.createdAt);
  return date ? `${titre} · ${date}` : titre;
}

export function VerebonaThreads({ threads, currentId, disabled, onSelect, onNew, onClear }: VerebonaThreadsProps) {
  const courantConnu = currentId != null && threads.some((t) => t.id === currentId);
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2">
      <label className="sr-only" htmlFor="verebona-thread">Conversation</label>
      <select
        id="verebona-thread"
        className="min-w-0 flex-1 truncate rounded-md border bg-transparent px-2 py-1 text-xs"
        value={courantConnu ? String(currentId) : ''}
        disabled={disabled || threads.length === 0}
        onChange={(e) => { if (e.target.value) onSelect(Number(e.target.value)); }}
      >
        {!courantConnu && <option value="">Nouvelle conversation</option>}
        {threads.map((t) => (
          <option key={t.id} value={t.id}>{libelleFil(t)}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={onNew}
        disabled={disabled}
        className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-muted"
      >
        + Nouvelle
      </button>
      {currentId != null && (
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          className="shrink-0 text-xs text-muted-foreground underline"
          aria-label="Effacer cette conversation"
        >
          Effacer
        </button>
      )}
    </div>
  );
}
