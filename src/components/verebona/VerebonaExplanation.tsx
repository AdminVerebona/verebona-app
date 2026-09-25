'use client';
/**
 * « Pourquoi cette réponse ? » — CDC §19.8, §27.9.
 *
 * Appelle `GET /api/verebona/messages/{id}/explanation` (claims, nature,
 * sources enregistrées — aucun nouvel appel modèle) et affiche une
 * justification synthétique : les faits utilisés et leurs sources, jamais
 * un raisonnement interne.
 */
import { useEffect, useState } from 'react';
import {
  EXPLANATION_EMPTY, formatExplanation, type ExplanationItem,
} from '@/lib/verebona/assistant-ui';

export function VerebonaExplanation({ messageId }: { messageId: string }) {
  const [items, setItems] = useState<ExplanationItem[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let annule = false;
    void (async () => {
      const res = await fetch(`/api/verebona/messages/${encodeURIComponent(messageId)}/explanation`).catch(() => null);
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      if (annule) return;
      if (!data) { setError(true); return; }
      setItems(formatExplanation(data.explanation));
    })();
    return () => { annule = true; };
  }, [messageId]);

  if (error) {
    return <p className="mt-2 text-xs text-muted-foreground" role="status">L’explication n’est pas disponible pour le moment.</p>;
  }
  if (!items) {
    return <p className="mt-2 text-xs text-muted-foreground" role="status">Chargement de l’explication…</p>;
  }
  return (
    <div className="mt-2 rounded border p-2 text-xs" aria-label="Pourquoi cette réponse">
      <p className="mb-1 font-medium">Pourquoi cette réponse ?</p>
      {items.length === 0 ? (
        <p className="text-muted-foreground">{EXPLANATION_EMPTY}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it, i) => (
            <li key={i}>
              <span>{it.text}</span>
              {it.derivation && <span className="ml-1 text-muted-foreground">({it.derivation})</span>}
              {it.sources.length > 0 && (
                <span className="block text-muted-foreground">Source : {it.sources.join(', ')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
