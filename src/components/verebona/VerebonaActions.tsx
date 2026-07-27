'use client';
/** Boutons d'action contrôlés — CDC §22. Le href vient TOUJOURS du serveur (§27.1). */
import type { VerebonaAction } from '@/lib/verebona/useVerebona';

export function VerebonaActions({ actions }: { actions: VerebonaAction[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {actions.map((a) => (
        a.href ? (
          <a key={a.actionId} href={a.href} data-analytics={a.analyticsCode}
             className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            {a.label}
          </a>
        ) : (
          <button key={a.actionId} data-analytics={a.analyticsCode}
                  className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted">
            {a.label}
          </button>
        )
      ))}
    </div>
  );
}
