"use client"

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Calendar, CheckCircle2, AlertCircle, Plus, Eye, EyeOff } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import dynamic from 'next/dynamic';

const CreateAgendaItemDrawer = dynamic(
  () => import('@/components/agenda/CreateAgendaItemDrawer').then(m => ({ default: m.CreateAgendaItemDrawer })),
  { ssr: false }
);

interface FollowupItem {
  itemType: 'agenda';
  id: string;
  publicId: string;
  title: string;
  effectiveDate: string | null;
  effectiveStatus: string;
  isDone: boolean;
  isOverdue: boolean;
  description: string | null;
  originType: string;
  requiresQualification: boolean;
}

interface Props {
  assetId: number;
}

const formatDate = (d: string | null) => {
  if (!d) return 'Sans date';
  try {
    return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return d; }
};

const today = () => new Date().toISOString().split('T')[0];

export function AssetFollowupTab({ assetId }: Props) {
  const [items, setItems] = useState<FollowupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [includeDone, setIncludeDone] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.get<{ items: FollowupItem[]; total: number }>(
        `/api/assets/${assetId}/followup?includeDone=${includeDone}&limit=100`
      );
      setItems(data.items ?? []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [assetId, includeDone, refreshTrigger]);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = useCallback(() => {
    apiClient.clearCache();
    setRefreshTrigger(v => v + 1);
  }, []);

  const td = today();

  const upcoming = useMemo(() =>
    items.filter(i => !i.isDone && i.effectiveDate && i.effectiveDate >= td)
      .sort((a, b) => (a.effectiveDate ?? '').localeCompare(b.effectiveDate ?? '')),
    [items, td]
  );

  const past = useMemo(() =>
    items.filter(i => i.isDone || !i.effectiveDate || i.effectiveDate < td)
      .sort((a, b) => (b.effectiveDate ?? '').localeCompare(a.effectiveDate ?? '')),
    [items, td]
  );

  const noDate = useMemo(() => items.filter(i => !i.effectiveDate && !i.isDone), [items]);

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full" />)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header controls */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIncludeDone(v => !v)}
          className="text-muted-foreground"
        >
          {includeDone ? <EyeOff className="w-4 h-4 mr-1" /> : <Eye className="w-4 h-4 mr-1" />}
          {includeDone ? 'Masquer terminés' : 'Afficher terminés'}
        </Button>

        <div className="hidden sm:flex items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => setShowCreate(true)}>
            <Plus className="w-3 h-3 mr-1" />
            Agenda
          </Button>
        </div>
      </div>

      {/* Lists */}
      {items.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <ActivityIcon className="w-10 h-10 mx-auto mb-2 opacity-30" />
          <p>Aucune activité agenda</p>
          <div className="flex justify-center gap-2 mt-3 sm:flex hidden">
            <Button size="sm" onClick={() => setShowCreate(true)}>Ajouter un élément agenda</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {noDate.length > 0 && (
            <Section title="Sans date" items={noDate} />
          )}
          {upcoming.length > 0 && (
            <Section title="À venir" items={upcoming} />
          )}
          {past.length > 0 && (
            <Section title="Passé" items={past} muted />
          )}
        </div>
      )}

      {showCreate && (
        <CreateAgendaItemDrawer
          open={showCreate}
          onClose={() => setShowCreate(false)}
          onMutated={() => { setShowCreate(false); handleRefresh(); }}
          prefilledAssetId={assetId}
        />
      )}
    </div>
  );
}

function ActivityIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}

function Section({ title, items, muted }: { title: string; items: FollowupItem[]; muted?: boolean }) {
  return (
    <div>
      <p className={`text-xs font-semibold uppercase tracking-wider mb-2 ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>
        {title}
      </p>
      <div className="space-y-1.5">
        {items.map(item => (
          <ItemRow key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

function ItemRow({ item }: { item: FollowupItem }) {
  const stateIcon = item.isOverdue
    ? <AlertCircle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />
    : item.isDone
    ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
    : null;

  return (
    <div className={`flex items-center gap-2 text-sm rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors ${item.isDone ? 'opacity-50' : ''}`}>
      <Calendar className="w-4 h-4 flex-shrink-0 text-blue-500" />
      <span className={`flex-1 truncate ${item.isDone ? 'line-through' : ''}`}>{item.title}</span>
      {item.isOverdue && (
        <Badge variant="destructive" className="text-xs">En retard</Badge>
      )}
      {stateIcon}
      <span className="text-xs text-muted-foreground flex-shrink-0">
        {formatDate(item.effectiveDate)}
      </span>
    </div>
  );
}
