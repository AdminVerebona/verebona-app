'use client';
/** Champ de saisie — CDC §7.5 (≤ 2 000 caractères) / §7.8 (annulation). */
import { useState } from 'react';

export interface VerebonaComposerProps {
  isLoading: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function VerebonaComposer({ isLoading, onSend, onCancel }: VerebonaComposerProps) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim() || isLoading) return;
    onSend(text);
    setText('');
  };
  return (
    <div className="border-t p-3">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 2000))}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          rows={2}
          maxLength={2000}
          placeholder="Posez votre question à Verebona…"
          aria-label="Message pour Verebona"
          className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
        />
        {isLoading ? (
          <button onClick={onCancel} className="rounded-lg border px-3 py-2 text-sm" aria-label="Annuler">Stop</button>
        ) : (
          <button onClick={submit} disabled={!text.trim()} className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" aria-label="Envoyer">Envoyer</button>
        )}
      </div>
      <div className="mt-1 text-right text-[10px] text-muted-foreground">{text.length}/2000</div>
    </div>
  );
}
