"use client"

import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import type {
  ObjectType, ToProcessFamily, Priority, ToProcessStatus, ToProcessFilters,
} from '@/types/to-process';
import {
  FAMILY_LABELS, PRIORITY_LABELS, OBJECT_TYPE_LABELS,
} from '@/types/to-process';

interface Asset {
  id: number;
  name: string;
}

interface FilterState {
  families: ToProcessFamily[];
  objectTypes: ObjectType[];
  assetIds: number[];
  priorities: Priority[];
  status: ToProcessStatus | 'all';
}

interface Props {
  open: boolean;
  onClose: () => void;
  filters: FilterState;
  onApply: (filters: FilterState) => void;
  activeCount: number;
}

const FAMILY_OPTIONS: ToProcessFamily[] = ['arbitrate', 'attach', 'confirm', 'complete'];
const OBJECT_TYPE_OPTIONS: ObjectType[] = ['document', 'agenda', 'equipment', 'supplier'];
const PRIORITY_OPTIONS: Priority[] = ['high', 'medium', 'low'];

export function ToProcessFiltersDrawer({ open, onClose, filters, onApply, activeCount }: Props) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [local, setLocal] = useState<FilterState>(filters);

  useEffect(() => {
    setLocal(filters);
  }, [filters, open]);

  useEffect(() => {
    if (!open) return;
    apiClient.get<{ data: Asset[] }>('/api/assets?limit=100')
      .then(d => setAssets(d.data ?? []))
      .catch(() => {});
  }, [open]);

  const toggleFamily = (f: ToProcessFamily) => {
    setLocal(prev => ({
      ...prev,
      families: prev.families.includes(f)
        ? prev.families.filter(x => x !== f)
        : [...prev.families, f],
    }));
  };

  const toggleObjectType = (t: ObjectType) => {
    setLocal(prev => ({
      ...prev,
      objectTypes: prev.objectTypes.includes(t)
        ? prev.objectTypes.filter(x => x !== t)
        : [...prev.objectTypes, t],
    }));
  };

  const togglePriority = (p: Priority) => {
    setLocal(prev => ({
      ...prev,
      priorities: prev.priorities.includes(p)
        ? prev.priorities.filter(x => x !== p)
        : [...prev.priorities, p],
    }));
  };

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
    const reset: FilterState = {
      families: [],
      objectTypes: [],
      assetIds: [],
      priorities: [],
      status: 'all',
    };
    setLocal(reset);
    onApply(reset);
    onClose();
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent className="w-full sm:max-w-[380px] overflow-y-auto">
        <div className="px-6">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              Filtrer
              {activeCount > 0 && (
                <Badge variant="secondary" className="text-xs px-1.5 py-0">
                  {activeCount}
                </Badge>
              )}
            </SheetTitle>
          </SheetHeader>

          <div className="mt-6 space-y-6">
            {/* Famille d'action */}
            <div>
              <p className="text-sm font-medium mb-3">Famille d'action</p>
              <div className="space-y-2">
                {FAMILY_OPTIONS.map(f => (
                  <label key={f} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={local.families.includes(f)}
                      onCheckedChange={() => toggleFamily(f)}
                    />
                    <span className="text-sm">{FAMILY_LABELS[f]}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Type d'objet */}
            <div>
              <p className="text-sm font-medium mb-3">Type d'objet</p>
              <div className="space-y-2">
                {OBJECT_TYPE_OPTIONS.map(t => (
                  <label key={t} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={local.objectTypes.includes(t)}
                      onCheckedChange={() => toggleObjectType(t)}
                    />
                    <span className="text-sm">{OBJECT_TYPE_LABELS[t]}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Priorité */}
            <div>
              <p className="text-sm font-medium mb-3">Priorité</p>
              <div className="space-y-2">
                {PRIORITY_OPTIONS.map(p => (
                  <label key={p} className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={local.priorities.includes(p)}
                      onCheckedChange={() => togglePriority(p)}
                    />
                    <span className="text-sm">{PRIORITY_LABELS[p]}</span>
                  </label>
                ))}
              </div>
            </div>

            {/* Biens */}
            {assets.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-3">Bien concerné</p>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {assets.map(asset => (
                    <label key={asset.id} className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={local.assetIds.includes(asset.id)}
                        onCheckedChange={() => toggleAsset(asset.id)}
                      />
                      <span className="text-sm truncate">{asset.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Statut */}
            <div>
              <p className="text-sm font-medium mb-3">Statut</p>
              <div className="flex gap-2">
                {(['all', 'active', 'snoozed'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                      local.status === s
                        ? 'bg-[#3b82f6] text-white border-[#3b82f6]'
                        : 'border-[color:var(--border-subtle)] text-[color:var(--text-muted)] hover:border-[#3b82f6]/50'
                    }`}
                    onClick={() => setLocal(prev => ({ ...prev, status: s }))}
                  >
                    {s === 'all' ? 'Tout' : s === 'active' ? 'À traiter' : 'Mis de côté'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-8 flex gap-2 border-t border-[color:var(--border-subtle)] pt-4">
            <Button className="flex-1" onClick={handleApply}>Appliquer</Button>
            <Button variant="outline" onClick={handleReset}>Réinitialiser</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}