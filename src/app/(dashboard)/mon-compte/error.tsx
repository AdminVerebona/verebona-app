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
      <h2 className="text-xl font-bold text-red-500">Erreur sur Mon Compte</h2>
      <pre className="text-xs bg-black/50 text-red-300 p-4 rounded overflow-auto max-h-64">
        {error.message}
        {'\n\n'}
        {error.stack}
      </pre>
      <button
        onClick={reset}
        className="px-4 py-2 bg-blue-600 text-white rounded"
      >
        Réessayer
      </button>
    </div>
  );
}
