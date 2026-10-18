'use client';

/**
 * « Besoin d'aide ? » — CDC Centre d'aide V1 §2.1, §11, §13.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN POINT D'ENTRÉE, PAS UN SECOND CENTRE D'AIDE
 *
 * Cette modale lisait `src/lib/help-content/articles.ts`, une rédaction
 * propre à l'application : titres, résumés et slugs y divergeaient du site, et
 * plusieurs raccourcis menaient à une page inexistante (GAP-01, GAP-02).
 *
 * Elle ne garde plus que des IDs (`HELP_SHORTCUT_IDS`). Titre et adresse sont
 * lus dans le catalogue publié par le site de l'environnement ; un ID inconnu
 * ou non publié est masqué, jamais affiché avec un lien cassé. La recherche
 * interroge le Centre d'aide public, pas une copie locale.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Search, X, ExternalLink, PlayCircle, BookOpen, RotateCw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { loadHelpShortcutsState, type HelpShortcutsState } from '@/lib/help-center/catalog';
import { openHelpCenter } from '@/lib/help-center/open';

/**
 * Accès rapides — lot 62 (L62-AIDE) : TOUJOURS une section visible.
 *
 * · chargement : trois lignes d'attente (borné, `HELP_SHORTCUTS_DEADLINE_MS`) ;
 * · prêts : les exemples du Centre d'aide ;
 * · indisponibles : un message explicite et « Réessayer » — jamais une
 *   fenêtre silencieusement vide.
 *
 * Même composant sur ordinateur et sur mobile (application installée comprise).
 */
export function HelpShortcutsSection({ state, onOpen, onRetry }: {
  state: HelpShortcutsState;
  onOpen: (path: string) => void;
  onRetry: () => void;
}) {
  return (
    <div data-testid="help-shortcuts" data-state={state.status}>
      <p className="vb-app-label mb-2">Accès rapides</p>
      {state.status === 'loading' && (
        <div role="status" aria-live="polite" className="space-y-1">
          <span className="sr-only">Chargement des exemples du Centre d’aide…</span>
          {[0, 1, 2].map((i) => (
            <div key={i} aria-hidden="true" className="h-9 rounded-md bg-muted animate-pulse" />
          ))}
        </div>
      )}
      {state.status === 'ready' && (
        <ul className="space-y-1">
          {state.shortcuts.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onOpen(s.path)}
                className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              >
                <span>{s.title}</span>
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.status === 'unavailable' && (
        <div role="status" className="rounded-md border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
          <p>Les exemples du Centre d’aide ne sont pas disponibles pour le moment. Recherchez ci-dessus ou ouvrez le Centre d’aide.</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            Réessayer
          </button>
        </div>
      )}
    </div>
  );
}

interface HelpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpModal({ open, onOpenChange }: HelpModalProps) {
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  const [shortcuts, setShortcuts] = useState<HelpShortcutsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) { setQuery(''); return; }
    let cancelled = false;
    // Lot 35 (L35-1) : lus par la route de l'application (loadHelpShortcuts(pathname)),
    // dans l'ordre de la page — mêmes exemples sur ordinateur et sur mobile
    // (même composant). Lot 62 (L62-AIDE) : chargement borné, repli explicite.
    // Exemples déjà affichés : gardés pendant la relecture (pas de clignotement).
    setShortcuts((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    loadHelpShortcutsState(pathname).then((s) => { if (!cancelled) setShortcuts(s); });
    return () => { cancelled = true; };
  }, [open, pathname, attempt]);

  /**
   * Lot 59 (point 3) : nouvel onglet isolé (site public), sur ordinateur ET
   * sur mobile — plus de Centre d'aide intégré à l'application.
   */
  function openHelp(path: string) {
    openHelpCenter(path);
    onOpenChange(false);
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q) openHelp(`/aide?q=${encodeURIComponent(q)}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg w-full">
        <DialogHeader>
          <DialogTitle>Besoin d’aide ?</DialogTitle>
          <DialogDescription className="sr-only">
            Recherchez dans le Centre d’aide ou ouvrez un accès rapide.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSearchSubmit} className="relative" role="search">
          <label htmlFor="help-modal-search" className="sr-only">Rechercher dans le Centre d’aide</label>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            id="help-modal-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher dans le Centre d’aide…"
            maxLength={200}
            className="w-full rounded-md border border-input bg-background pl-9 pr-9 py-2 text-sm"
            autoFocus
          />
          {query && (
            <button
              type="button"
              aria-label="Effacer la recherche"
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </form>

        {/* Accès rapides — chargement, exemples ou repli explicite (L62-AIDE). */}
        <HelpShortcutsSection state={shortcuts} onOpen={openHelp} onRetry={() => setAttempt((n) => n + 1)} />

        <div className="border-t pt-3 space-y-2">
          <button
            type="button"
            onClick={() => openHelp('/aide')}
            className="flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-primary hover:bg-muted transition-colors"
          >
            <BookOpen className="h-4 w-4" aria-hidden="true" />
            Ouvrir le Centre d’aide
          </button>
          <button
            type="button"
            onClick={() => {
              window.dispatchEvent(new CustomEvent('onboarding:relaunch'));
              onOpenChange(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors text-left text-[color:var(--text-primary)]"
          >
            <PlayCircle className="h-4 w-4 text-[color:var(--accent)] flex-shrink-0" aria-hidden="true" />
            <span>Revoir le guide de bienvenue</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
