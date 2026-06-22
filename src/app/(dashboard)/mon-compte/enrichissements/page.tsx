'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { apiClient } from '@/lib/api-client';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bot, ExternalLink, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import Link from 'next/link';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface AiHistoryItem {
  id: number;
  fieldKey: string;
  fieldLabel: string;
  oldValue: string | null;
  newValue: string;
  createdAt: string;
  assetId: number;
  assetName: string;
  assetFileId: number | null;
  docTitle: string | null;
}

interface AssetOption {
  id: number;
  name: string;
}

function formatValue(val: string | null): string {
  if (!val || val === 'null') return '—';
  if (val === 'true') return 'Oui';
  if (val === 'false') return 'Non';
  return val;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const PAGE_SIZE = 30;

export default function EnrichissementsPage() {
  const { setBreadcrumbs } = useBreadcrumb();

  const [items, setItems] = useState<AiHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [offset, setOffset] = useState(0);

  // Filters
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [filterAsset, setFilterAsset] = useState<string>('all');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [filtersVisible, setFiltersVisible] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: 'Mon compte', href: '/mon-compte' },
      { label: 'Historique des enrichissements' },
    ]);
  }, [setBreadcrumbs]);

  // Load asset list for filter dropdown
  useEffect(() => {
    apiClient.get<{ data: AssetOption[] }>('/api/assets?limit=200').then(res => {
      setAssets(res.data ?? []);
    }).catch(() => {});
  }, []);

  const buildQuery = useCallback((off: number) => {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(off));
    if (filterAsset && filterAsset !== 'all') params.set('assetId', filterAsset);
    if (filterDateFrom) params.set('dateFrom', filterDateFrom);
    if (filterDateTo) params.set('dateTo', filterDateTo);
    return `/api/ai-history?${params.toString()}`;
  }, [filterAsset, filterDateFrom, filterDateTo]);

  const fetchItems = useCallback(async (off: number, append = false) => {
    try {
      const data = await apiClient.get<{ items: AiHistoryItem[]; total: number }>(buildQuery(off));
      if (append) setItems(prev => [...prev, ...(data.items ?? [])]);
      else setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setOffset(off + (data.items?.length ?? 0));
    } catch { /* silencieux */ }
  }, [buildQuery]);

  // Reset & reload when filters change
  useEffect(() => {
    setLoading(true);
    setOffset(0);
    fetchItems(0).finally(() => setLoading(false));
  }, [filterAsset, filterDateFrom, filterDateTo]);

  const hasMore = items.length < total;

  const hasActiveFilters = (filterAsset && filterAsset !== 'all') || filterDateFrom || filterDateTo;

  const resetFilters = () => {
    setFilterAsset('all');
    setFilterDateFrom('');
    setFilterDateTo('');
  };

  return (
    <div className="space-y-6 w-full max-w-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-[#3b82f6]" />
            <h1 className="text-2xl font-bold">Historique des enrichissements</h1>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Champs complétés ou modifiés automatiquement par Verebona lors de l'analyse de vos documents.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={() => setFiltersVisible(v => !v)}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
          Filtres
          {hasActiveFilters && (
            <span className="ml-1 w-1.5 h-1.5 rounded-full bg-blue-400 inline-block" />
          )}
        </Button>
      </div>

      {/* Filters panel */}
      {filtersVisible && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Filtrer l'historique</span>
            {hasActiveFilters && (
              <button
                onClick={resetFilters}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                Réinitialiser
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Filter by asset */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Bien</label>
              <Select value={filterAsset} onValueChange={setFilterAsset}>
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue placeholder="Tous les biens" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les biens</SelectItem>
                  {assets.map(a => (
                    <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/* Date from */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">À partir du</label>
              <Input
                type="date"
                className="h-9 text-sm"
                value={filterDateFrom}
                onChange={e => setFilterDateFrom(e.target.value)}
              />
            </div>
            {/* Date to */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground font-medium">Jusqu'au</label>
              <Input
                type="date"
                className="h-9 text-sm"
                value={filterDateTo}
                onChange={e => setFilterDateTo(e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Stats bar */}
      {!loading && (
        <p className="text-xs text-muted-foreground">
          {total === 0
            ? 'Aucune modification enregistrée'
            : `${total} modification${total > 1 ? 's' : ''} au total`}
          {hasActiveFilters && ' · filtres actifs'}
        </p>
      )}

      {/* Table */}
      <div className="rounded-xl border border-border overflow-hidden">
        {/* Header row */}
        <div className="hidden sm:grid grid-cols-[1fr_1fr_1fr_auto] gap-4 px-4 py-2.5 bg-muted/40 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wide">
          <span>Champ</span>
          <span>Bien</span>
          <span>Nouvelle valeur</span>
          <span className="text-right">Date</span>
        </div>

        {loading ? (
          <div className="divide-y divide-border">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-4 px-4 py-3 items-center">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-16 ml-auto" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <Bot className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              {hasActiveFilters
                ? 'Aucune modification ne correspond à ces filtres.'
                : 'Aucune modification automatique enregistrée pour le moment.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {items.map(item => (
              <div
                key={item.id}
                className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-1 sm:gap-4 px-4 py-3 items-start sm:items-center hover:bg-muted/20 transition-colors"
              >
                {/* Champ */}
                <div>
                  <span className="text-sm font-medium">{item.fieldLabel}</span>
                  {item.docTitle && (
                    <p className="text-xs text-muted-foreground mt-0.5 italic truncate">
                      depuis "{item.docTitle}"
                    </p>
                  )}
                </div>

                {/* Bien */}
                <div>
                  <Link
                    href={`/assets/${item.assetId}`}
                    className="text-sm text-[color:var(--text-muted)] hover:text-foreground underline underline-offset-2 inline-flex items-center gap-0.5"
                  >
                    {item.assetName}
                    <ExternalLink className="w-3 h-3 flex-shrink-0" />
                  </Link>
                </div>

                {/* Valeur */}
                <div className="text-sm">
                  {item.oldValue ? (
                    <span className="text-muted-foreground">
                      <span className="line-through opacity-50">{formatValue(item.oldValue)}</span>
                      {' → '}
                      <span className="text-foreground/80">{formatValue(item.newValue)}</span>
                    </span>
                  ) : (
                    <span className="text-foreground/80">{formatValue(item.newValue)}</span>
                  )}
                </div>

                {/* Date */}
                <div className="text-xs text-muted-foreground sm:text-right whitespace-nowrap">
                  {formatDate(item.createdAt)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Load more */}
        {hasMore && !loading && (
          <div className="border-t border-border px-4 py-3">
            <Button
              variant="ghost" size="sm"
              className="text-muted-foreground gap-1.5 w-full justify-center hover:text-foreground"
              onClick={async () => {
                setLoadingMore(true);
                await fetchItems(offset, true);
                setLoadingMore(false);
              }}
              disabled={loadingMore}
            >
              <ChevronDown className={`w-3.5 h-3.5 ${loadingMore ? 'animate-bounce' : ''}`} />
              Charger plus ({total - items.length} restant{total - items.length > 1 ? 's' : ''})
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
