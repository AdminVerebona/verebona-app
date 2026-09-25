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
import { usePathname, useRouter } from 'next/navigation';
import { Search, X, ExternalLink, PlayCircle, BookOpen } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { fetchHelpCatalog, resolveShortcuts, type ResolvedShortcut } from '@/lib/help-center/catalog';
import { helpPageUrl, integratedHelpHref, prefersIntegratedHelp } from '@/lib/help-center/open';

interface HelpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpModal({ open, onOpenChange }: HelpModalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState('');
  const [shortcuts, setShortcuts] = useState<ResolvedShortcut[] | null>(null);

  useEffect(() => {
    if (!open) { setQuery(''); return; }
    let cancelled = false;
    fetchHelpCatalog().then((c) => { if (!cancelled) setShortcuts(resolveShortcuts(c)); });
    return () => { cancelled = true; };
  }, [open]);

  /** Mobile : Centre d'aide intégré ; ordinateur : nouvel onglet isolé. */
  function openHelp(path: string) {
    if (prefersIntegratedHelp()) {
      router.push(integratedHelpHref(path, pathname ?? undefined));
    } else {
      window.open(helpPageUrl(path, false), '_blank', 'noopener,noreferrer');
    }
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
            className="w-full rounded-md border border-input bg-background pl-9 pr-9 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
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

        {/* Accès rapides — masqués tant que le catalogue n'a pas répondu, ou s'il est indisponible. */}
        {shortcuts && shortcuts.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Accès rapides</p>
            <ul className="space-y-1">
              {shortcuts.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => openHelp(s.path)}
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                  >
                    <span>{s.title}</span>
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

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
            <PlayCircle className="h-4 w-4 text-blue-500 flex-shrink-0" aria-hidden="true" />
            <span>Revoir le guide de bienvenue</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
