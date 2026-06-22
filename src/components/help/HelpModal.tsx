'use client';

import { useState, useMemo, useEffect } from 'react';
import Fuse from 'fuse.js';
import { Search, X, ExternalLink, Sparkles, PlayCircle } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { HELP_ARTICLES, HELP_QUICK_LINKS, type HelpArticle } from '@/lib/help-content/articles';

// ── Synonymes de normalisation pour améliorer la recherche ───────────────────
const SYNONYM_MAP: Record<string, string> = {
  'assurance': 'police contrat',
  'locataire': 'bien',
  'proprio': 'propriétaire',
  'factu': 'facture',
  'docs': 'documents',
  'fichier': 'document',
  'maison': 'bien immobilier',
  'appart': 'appartement bien',
  'voiture': 'bien véhicule',
  'chaudière': 'équipement',
  'vmc': 'équipement',
  'clim': 'équipement climatisation',
};

function normalizeQuery(q: string): string {
  let result = q.toLowerCase();
  for (const [key, val] of Object.entries(SYNONYM_MAP)) {
    result = result.replace(new RegExp(key, 'gi'), val);
  }
  return result;
}

const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;

function isNew(article: HelpArticle) {
  return (
    article.tags.states.includes('new') &&
    Date.now() - new Date(article.publishedAt).getTime() < SIXTY_DAYS
  );
}

const publishedArticles = HELP_ARTICLES.filter((a) => a.isPublished);

const fuse = new Fuse(publishedArticles, {
  keys: ['title', 'summary', 'tags.themes'],
  threshold: 0.3,
  includeScore: true,
});

interface HelpModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpModal({ open, onOpenChange }: HelpModalProps) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const suggestions = useMemo(() => {
    if (!query.trim()) return [];
    const normalized = normalizeQuery(query);
    return fuse.search(normalized).slice(0, 5);
  }, [query]);

  const newArticles = useMemo(
    () => publishedArticles.filter(isNew).slice(0, 3),
    []
  );

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (query.trim()) {
      window.open(`/aide?q=${encodeURIComponent(query.trim())}`, '_blank');
      onOpenChange(false);
    }
  }

  function openArticle(slug: string) {
    window.open(`/aide/${slug}`, '_blank');
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg w-full">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>Besoin d'aide ?</span>
          </DialogTitle>
        </DialogHeader>

        {/* Search */}
        <form onSubmit={handleSearchSubmit} className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher dans le centre d'aide…"
            className="w-full rounded-md border border-input bg-background pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            autoFocus
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </form>

        {/* Suggestions */}
        {suggestions.length > 0 ? (
          <div className="space-y-1">
            {suggestions.map(({ item }) => (
              <button
                key={item.slug}
                onClick={() => openArticle(item.slug)}
                className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
              >
                <span>{item.title}</span>
                <ExternalLink className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              </button>
            ))}
            <button
              onClick={() => { window.open(`/aide?q=${encodeURIComponent(query.trim())}`, '_blank'); onOpenChange(false); }}
              className="w-full text-center text-xs text-primary hover:underline pt-1"
            >
              Voir tous les résultats →
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Quick links */}
            <div>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Liens rapides</p>
              <div className="space-y-1">
                {HELP_QUICK_LINKS.map((link) => (
                  <button
                    key={link.slug}
                    onClick={() => openArticle(link.slug)}
                    className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                  >
                    <span>{link.title}</span>
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  </button>
                ))}
              </div>
            </div>

            {/* Nouveautés */}
            {newArticles.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1">
                  <Sparkles className="h-3 w-3" />
                  Nouveautés
                </p>
                <div className="space-y-1">
                  {newArticles.map((article) => (
                    <button
                      key={article.slug}
                      onClick={() => openArticle(article.slug)}
                      className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors text-left"
                    >
                      <span>{article.title}</span>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="border-t pt-3 space-y-2">
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('onboarding:relaunch'));
              onOpenChange(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted transition-colors text-left text-[color:var(--text-primary)]"
          >
            <PlayCircle className="h-4 w-4 text-blue-500 flex-shrink-0" />
            <span>Revoir le guide de bienvenue</span>
          </button>
          <button
            onClick={() => { window.open('/aide', '_blank'); onOpenChange(false); }}
            className="w-full text-center text-sm text-primary hover:underline pt-1"
          >
            Voir tous les articles →
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
