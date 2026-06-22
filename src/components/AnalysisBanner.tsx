"use client";

import { useAnalysisBanner } from '@/contexts/AnalysisBannerContext';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/** Desktop — icône + texte court entre la recherche et la cloche */
export function AnalysisBanner() {
  const { analyzingCount, analyzingFileIds } = useAnalysisBanner();

  if (analyzingCount <= 0) return null;

  const label =
    analyzingCount === 1
      ? `Analyse en cours\u2026`
      : `${analyzingCount} analyses en cours\u2026`;

  // Premier fileId réel (> 0) pour le bouton Voir
  const firstFileId = analyzingFileIds.find(id => id > 0) ?? null;

  const handleOpenDrawer = () => {
    if (!firstFileId) return;
    window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: firstFileId } }));
  };

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0 animate-in fade-in duration-300">
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 px-2 py-1 text-[color:var(--text-muted)] text-xs whitespace-nowrap cursor-default select-none">
            <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[color:var(--accent)] opacity-60" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[color:var(--accent)] opacity-80" />
            </span>
            <span>{label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs text-center">
          Vous pouvez fermer l&apos;app, l&apos;analyse continue en arrière-plan.
        </TooltipContent>
      </Tooltip>

      {firstFileId && (
        <button
          onClick={handleOpenDrawer}
          className="text-xs text-[color:var(--accent)] font-medium hover:underline underline-offset-2 cursor-pointer whitespace-nowrap pr-1"
        >
          Voir →
        </button>
      )}
    </div>
  );
}

/** Mobile — fine barre sous le header fixe (top-16), disparaît quand analyse terminée */
export function MobileAnalysisBanner() {
  const { analyzingCount, analyzingFileIds } = useAnalysisBanner();

  if (analyzingCount <= 0) return null;

  const label =
    analyzingCount === 1
      ? `Analyse en cours\u2026`
      : `${analyzingCount} analyses en cours\u2026`;

  const firstFileId = analyzingFileIds.find(id => id > 0) ?? null;

  const handleOpenDrawer = () => {
    if (!firstFileId) return;
    window.dispatchEvent(new CustomEvent('open-document-drawer', { detail: { docId: firstFileId } }));
  };

  return (
    <div className="md:hidden fixed top-16 left-0 right-0 z-30 flex items-center justify-center gap-2 px-4 py-1.5 bg-[color:var(--bg-page)]/90 backdrop-blur-sm border-b border-[color:var(--border-subtle)] animate-in slide-in-from-top-1 fade-in duration-300">
      <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[color:var(--accent)] opacity-60" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[color:var(--accent)] opacity-80" />
      </span>
      <span className="text-[11px] text-[color:var(--text-muted)]">{label}</span>
      {firstFileId && (
        <button
          onClick={handleOpenDrawer}
          className="text-[11px] text-[color:var(--accent)] font-medium underline-offset-2 hover:underline cursor-pointer"
        >
          Voir
        </button>
      )}
    </div>
  );
}
