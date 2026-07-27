'use client';
/** Avis utile / pas utile — CDC §27.10. */
import { useState } from 'react';

export function VerebonaFeedback({
  messageId, onFeedback,
}: { messageId: string; onFeedback: (id: string, v: 'helpful' | 'not_helpful', reason?: string) => void }) {
  const [done, setDone] = useState<null | 'helpful' | 'not_helpful'>(null);
  if (done) return <div className="mt-1 text-[10px] text-muted-foreground">Merci pour votre retour.</div>;
  return (
    <div className="mt-1 flex gap-2 text-xs text-muted-foreground">
      <button aria-label="Réponse utile" onClick={() => { onFeedback(messageId, 'helpful'); setDone('helpful'); }}>👍</button>
      <button aria-label="Réponse pas utile" onClick={() => { onFeedback(messageId, 'not_helpful'); setDone('not_helpful'); }}>👎</button>
    </div>
  );
}
