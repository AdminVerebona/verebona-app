"use client"

import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Plus, Home, GripVertical } from 'lucide-react';
import { RoomDrawer, RoomDrawerItem } from './RoomDrawer';

interface Substructure {
  id: number;
  name: string;
  orderIndex?: number;
}

interface AssetSubstructuresPanelProps {
  assetId: number;
  substructures: Substructure[];
  onRefresh: () => void;
}

export function AssetSubstructuresPanel({
  assetId,
  substructures,
  onRefresh,
}: AssetSubstructuresPanelProps) {
  const [drawerRoom, setDrawerRoom] = useState<RoomDrawerItem | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const handleAdd = useCallback(() => {
    setDrawerRoom(null);
    setIsDrawerOpen(true);
  }, []);

  const handleRowClick = useCallback((sub: Substructure) => {
    setDrawerRoom({ id: sub.id, name: sub.name, orderIndex: sub.orderIndex });
    setIsDrawerOpen(true);
  }, []);

  const sorted = [...substructures].sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-[color:var(--text-primary)]">Pièces</h2>
            <p className="text-sm text-[color:var(--text-muted)] mt-1">
              {sorted.length} pièce{sorted.length !== 1 ? 's' : ''}
            </p>
          </div>
          {sorted.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleAdd} className="btn-add px-4">
              <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
              Ajouter
            </Button>
          )}
        </div>

        {sorted.length === 0 ? (
          <Card className="border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] rounded-2xl shadow-sm">
            <CardContent className="flex items-center gap-4 py-4 px-5">
              <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                <Home className="w-4 h-4 text-blue-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-[color:var(--text-primary)]">Aucune pièce définie</p>
                <p className="text-xs text-[color:var(--text-muted)] mt-0.5">
                  Ex: Salon, Chambre 1, Cuisine, Salle de bain…
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleAdd} data-guide="add-room" className="btn-add px-4 flex-shrink-0">
                <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
                Ajouter une pièce
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-2 pt-4">
              {sorted.map((sub) => (
                <button
                  key={sub.id}
                  onClick={() => handleRowClick(sub)}
                  className="w-full flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors text-left"
                >
                  <GripVertical className="w-4 h-4 text-muted-foreground/40 flex-shrink-0" />
                  <div className="w-7 h-7 rounded bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Home className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <span className="font-medium flex-1">{sub.name}</span>
                </button>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <RoomDrawer
        open={isDrawerOpen}
        onOpenChange={setIsDrawerOpen}
        assetId={assetId}
        room={drawerRoom}
        onRefresh={onRefresh}
      />
    </>
  );
}
