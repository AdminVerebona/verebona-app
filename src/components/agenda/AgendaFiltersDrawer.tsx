"use client"

import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';

interface Asset {
  id: number;
  name: string;
}

interface AgendaFilters {
  assetIds: number[];
  period: 'all' | 'past' | 'today' | 'upcoming';
  includeCancelled: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  filters: AgendaFilters;
  onApply: (filters: AgendaFilters) => void;
}

const PERIOD_OPTIONS: { value: AgendaFilters['period']; label: string }[] = [
  { value: 'all', label: 'Tout' },
  { value: 'upcoming', label: 'À venir' },
  { value: 'today', label: "Aujourd'hui" },
  { value: 'past', label: 'Passés' },
];

export function AgendaFiltersDrawer({ open, onClose, filters, onApply }: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [local, setLocal] = useState<AgendaFilters>(filters);

  useEffect(() => {
    setLocal(filters);
  }, [filters, open]);

  useEffect(() => {
    if (!open) return;
    apiClient.get<{ data: Asset[] }>('/api/assets?limit=100')
      .then(d => setAssets(d.data ?? []))
      .catch(() => {});
  }, [open]);

  const toggleAsset = (id: number) => {
    setLocal(prev => ({
      ...prev,
      assetIds: prev.assetIds.includes(id)
        ? prev.assetIds.filter(a => a !== id)
        : [...prev.assetIds, id],
    }));
  };

  const handleApply = () => {
    onApply(local);
    onClose();
  };

  const handleReset = () => {
    const reset: AgendaFilters = { assetIds: [], period: 'all', includeCancelled: false };
    setLocal(reset);
    onApply(reset);
    onClose();
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-[380px] overflow-y-auto">
        <div className="px-6">
        <SheetHeader>
          <SheetTitle>Filtres</SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Période */}
          <div>
            <p className="text-sm font-medium mb-3">Période</p>
            <div className="space-y-2">
              {PERIOD_OPTIONS.map(opt => (
                <label key={opt.value} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="period"
                    value={opt.value}
                    checked={local.period === opt.value}
                    onChange={() => setLocal(prev => ({ ...prev, period: opt.value }))}
                    className="accent-primary"
                  />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Biens */}
          {assets.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-3">Biens</p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {assets.map(asset => (
                  <label key={asset.id} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={local.assetIds.includes(asset.id)}
                      onCheckedChange={() => toggleAsset(asset.id)}
                    />
                    <span className="text-sm">{asset.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Options */}
          <div>
            <p className="text-sm font-medium mb-3">Options</p>
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={local.includeCancelled}
                onCheckedChange={v => setLocal(prev => ({ ...prev, includeCancelled: !!v }))}
              />
              <span className="text-sm">Afficher les annulés</span>
            </label>
          </div>
        </div>

        <div className="mt-8 flex gap-2 border-t pt-4">
          <Button className="flex-1" onClick={handleApply}>Appliquer</Button>
          <Button variant="outline" onClick={handleReset}>Réinitialiser</Button>
        </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
