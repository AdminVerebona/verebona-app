"use client"

import { useState, useCallback, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Equipment, Substructure } from '@/types/domain';
import { Plus, Settings, MapPin } from 'lucide-react';
import { EquipmentDrawer, EquipmentDrawerItem, EquipmentDrawerSubstructure } from './EquipmentDrawer';
import { Badge } from '@/components/ui/badge';

interface AssetEquipmentsPanelProps {
  assetId: number;
  assetName?: string;
  equipments: Equipment[];
  substructures: Substructure[];
  onRefresh: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  EN_SERVICE: 'En service',
  EN_PANNE: 'En panne',
  EN_REPARATION: 'En réparation',
  INACTIF: 'Inactif',
};

const STATUS_VARIANTS: Record<string, 'active' | 'inactive' | 'pending' | 'secondary'> = {
  EN_SERVICE: 'active',
  EN_PANNE: 'inactive',
  EN_REPARATION: 'pending',
  INACTIF: 'secondary',
};

export function AssetEquipmentsPanel({
  assetId,
  assetName,
  equipments,
  substructures,
  onRefresh,
}: AssetEquipmentsPanelProps) {
  const [selectedEq, setSelectedEq] = useState<EquipmentDrawerItem | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const handleAdd = useCallback(() => {
    setSelectedEq(null);
    setIsDrawerOpen(true);
  }, []);

  const handleRowClick = useCallback((eq: Equipment) => {
    setSelectedEq({
      id: eq.id,
      assetId: eq.assetId,
      name: eq.name,
      type: eq.type,
      status: eq.status,
      substructureId: eq.substructureId,
    });
    setIsDrawerOpen(true);
  }, []);

  // Group by substructure
  const groups = useMemo(() => {
    const roomMap = new Map<number | null, { name: string; items: Equipment[] }>();
    const sortedSubs = [...substructures].sort((a, b) => ((a as any).orderIndex ?? 0) - ((b as any).orderIndex ?? 0));
    for (const sub of sortedSubs) {
      roomMap.set(sub.id, { name: sub.name, items: [] });
    }
    roomMap.set(null, { name: 'Sans pièce', items: [] });

    for (const eq of equipments) {
      const key = eq.substructureId ?? null;
      if (!roomMap.has(key)) roomMap.set(key, { name: 'Sans pièce', items: [] });
      roomMap.get(key)!.items.push(eq);
    }

    const result: Array<{ key: number | null; name: string; items: Equipment[] }> = [];
    for (const [key, val] of roomMap.entries()) {
      val.items.sort((a, b) => a.name.localeCompare(b.name));
      if (val.items.length > 0 || key !== null) {
        result.push({ key, name: val.name, items: val.items });
      }
    }
    result.sort((a, b) => {
      if (a.key === null) return 1;
      if (b.key === null) return -1;
      return 0;
    });
    return result.filter(g => g.items.length > 0);
  }, [equipments, substructures]);

  const drawerSubstructures: EquipmentDrawerSubstructure[] = substructures.map(s => ({ id: s.id, name: s.name }));

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold text-[color:var(--text-primary)]">Équipements</h2>
            <p className="text-sm text-[color:var(--text-muted)] mt-1">
              {equipments.length} équipement{equipments.length !== 1 ? 's' : ''}
            </p>
          </div>
          {equipments.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleAdd} className="btn-add px-4">
              <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
              Ajouter
            </Button>
          )}
        </div>

        {equipments.length === 0 ? (
          <Card className="border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] rounded-2xl shadow-sm">
            <CardContent className="flex items-center gap-4 py-4 px-5">
              <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                <Settings className="w-4 h-4 text-blue-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-[color:var(--text-primary)]">Aucun équipement répertorié</p>
                <p className="text-xs text-[color:var(--text-muted)] mt-0.5">
                  Ex: Chaudière, Moteur, Pompe à chaleur, Alarme…
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={handleAdd} data-guide="add-equipment" className="btn-add px-4 flex-shrink-0">
                <Plus className="btn-add-plus-icon w-4 h-4 mr-2" />
                Ajouter un équipement
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="space-y-6 pt-4">
              {groups.map(group => (
                <div key={group.key ?? 'none'}>
                  <div className="flex items-center gap-1.5 mb-2 text-xs font-medium text-muted-foreground">
                    <MapPin className="w-3.5 h-3.5" />
                    {group.name}
                    <span className="ml-1 text-muted-foreground/60">({group.items.length})</span>
                  </div>
                  <div className="space-y-1">
                    {group.items.map(eq => (
                      <button
                        key={eq.id}
                        onClick={() => handleRowClick(eq)}
                        className="w-full flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors text-left"
                      >
                        <div className="w-7 h-7 rounded bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <Settings className="w-3.5 h-3.5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="font-medium truncate block">{eq.name}</span>
                          {eq.type && <span className="text-xs text-muted-foreground">{eq.type}</span>}
                        </div>
                        <Badge
                          variant={STATUS_VARIANTS[eq.status] ?? 'secondary'}
                          className="text-[10px] px-2 py-0.5 flex-shrink-0"
                        >
                          {STATUS_LABELS[eq.status] ?? eq.status}
                        </Badge>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <EquipmentDrawer
        open={isDrawerOpen}
        onOpenChange={setIsDrawerOpen}
        assetId={assetId}
        assetName={assetName}
        equipment={selectedEq}
        substructures={drawerSubstructures}
        onRefresh={onRefresh}
      />
    </>
  );
}
