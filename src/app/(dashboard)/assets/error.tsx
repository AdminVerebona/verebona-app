'use client';

import { useEffect } from 'react';

export default function AssetsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[Assets Error]', error.message);
  }, [error]);

  return (
    <div className="p-8 space-y-4">
      <h2 className="text-xl font-bold text-destructive">Une erreur est survenue</h2>
      <p className="text-muted-foreground">{error.message}</p>
      <button
        onClick={reset}
        className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm"
      >
        Réessayer
      </button>
    </div>
  );
}