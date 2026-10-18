'use client';

import { useEffect } from 'react';

export default function MonCompteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[MonCompte Error]', error.message, error.stack);
  }, [error]);

  return (
    <div className="p-8 space-y-4">
      <h2 className="vb-app-section text-xl text-[color:var(--danger)]">Erreur sur Mon Compte</h2>
      <pre className="text-xs bg-[color:var(--danger-soft)] border border-[color:var(--danger-edge)] text-[color:var(--danger)] p-4 rounded-[12px] overflow-auto max-h-64">
        {error.message}
        {'\n\n'}
        {error.stack}
      </pre>
      <button
        onClick={reset}
        className="h-9 px-5 bg-[color:var(--accent)] hover:bg-[color:var(--accent-hover)] text-[color:var(--on-accent)] font-bold text-sm rounded-[12px] transition-colors"
      >
        Réessayer
      </button>
    </div>
  );
}
