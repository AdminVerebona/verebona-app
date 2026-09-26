'use client';

/**
 * RGPD — suivi opérationnel des demandes (CDC Back-Office V1 §12).
 *
 *  - vue par défaut : demandes OUVERTES (GDP-001) ; historique séparé des
 *    demandes traitées (GDP-018) ;
 *  - en tête : demandes ouvertes et demandes traitées sur la période
 *    choisie — pas de compteur « reçues » (GDP-002) ;
 *  - échéance et jours restants, sans seuil visuel de type J-7 (GDP-003) ;
 *    un dépassement ne crée aucune anomalie de supervision (GDP-004) ;
 *  - tri (GDP-005, GDP-019) et pagination classique (GDP-006) ; paramètres
 *    conservés dans l'URL (UX-004).
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Loader2, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatDateTime } from '@/lib/admin/format';
import { ORIGIN_LABELS, RIGHT_LABELS, STATUS_LABELS, daysRemaining, parisDateOf } from '@/services/gdpr/rules';
import { GdprRequestDialog } from './_components/GdprRequestDialog';
import { accountLabel, formatIsoDate, subjectLabel, type GdprRequestItem } from './_components/types';

type View = 'open' | 'history';

interface ListResponse {
  items: GdprRequestItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counters: { open: number; processedInPeriod: number; from: string; to: string };
  view: View;
  sort: string;
  dir: 'asc' | 'desc';
}

const COLUMNS: Record<View, Array<{ key: string; label: string; sortable?: boolean; className?: string }>> = {
  open: [
    { key: 'due', label: 'Échéance', sortable: true },
    { key: 'remaining', label: 'Jours restants', className: 'text-right' },
    { key: 'right', label: 'Type de droit', sortable: true },
    { key: 'user', label: 'Utilisateur', sortable: true },
    { key: 'account', label: 'Compte', sortable: true },
    { key: 'received', label: 'Réception', sortable: true },
    { key: 'status', label: 'Statut', sortable: true },
    { key: 'origin', label: 'Origine', sortable: true },
  ],
  history: [
    { key: 'processed', label: 'Traitée le', sortable: true },
    { key: 'right', label: 'Type de droit', sortable: true },
    { key: 'user', label: 'Utilisateur', sortable: true },
    { key: 'account', label: 'Compte', sortable: true },
    { key: 'received', label: 'Réception', sortable: true },
    { key: 'due', label: 'Échéance' },
    { key: 'origin', label: 'Origine' },
    { key: 'result', label: 'Résultat' },
  ],
};

function periodPreset(days: number): { from: string; to: string } {
  const now = new Date();
  return { from: parisDateOf(new Date(now.getTime() - (days - 1) * 86_400_000)), to: parisDateOf(now) };
}

function RemainingDays({ dueDate }: { dueDate: string }) {
  const d = daysRemaining(dueDate);
  // GDP-003 : information brute, sans code couleur de seuil.
  if (d > 0) return <>{d} j</>;
  if (d === 0) return <>Aujourd’hui</>;
  return <>Dépassée de {-d} j</>;
}

function GdprPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const view: View = params.get('view') === 'history' ? 'history' : 'open';
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });

  const qs = params.toString();

  const setParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k); else next.set(k, v);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [qs, pathname, router]);

  const fetchList = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/admin/gdpr?${qs}`, { credentials: 'include', cache: 'no-store' });
      if (res.status === 401 || res.status === 403) {
        router.push('/login?returnUrl=/admin/gdpr');
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // ERR-001 : aucune donnée partielle affichée comme complète.
        setData(null);
        setFetchError(body.message || `Erreur ${res.status}`);
        return;
      }
      setData(body);
    } catch {
      setData(null);
      setFetchError('Erreur réseau — impossible de charger les demandes.');
    } finally {
      setLoading(false);
    }
  }, [qs, router]);

  useEffect(() => { void fetchList(); }, [fetchList]);

  const sortBy = (key: string) => {
    if (!data) return;
    const dir = data.sort === key ? (data.dir === 'asc' ? 'desc' : 'asc') : key === 'due' ? 'asc' : 'desc';
    setParams({ sort: key, dir, page: null });
  };

  const period = data?.counters ?? { ...periodPreset(30), open: 0, processedInPeriod: 0 };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="h-6 w-6" />
            RGPD
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Suivi des demandes relatives aux droits des personnes — système et saisies par le support
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => fetchList()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Actualiser
          </Button>
          <Button size="sm" onClick={() => setDialog({ open: true, id: null })}>
            <Plus className="h-4 w-4 mr-1.5" />
            Nouvelle demande
          </Button>
        </div>
      </div>

      {/* Compteurs (GDP-002) */}
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_2fr]">
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold">{data ? data.counters.open : '—'}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Demandes ouvertes</p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold">{data ? data.counters.processedInPeriod : '—'}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Traitées sur la période</p>
        </div>
        <div className="rounded-xl border bg-card p-4 space-y-2">
          <p className="text-xs text-muted-foreground">Période</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" className="w-auto" value={period.from} max={period.to}
              onChange={(e) => e.target.value && setParams({ from: e.target.value })} />
            <span className="text-xs text-muted-foreground">au</span>
            <Input type="date" className="w-auto" value={period.to} min={period.from}
              onChange={(e) => e.target.value && setParams({ to: e.target.value })} />
          </div>
          <div className="flex flex-wrap gap-1">
            {[[30, '30 jours'], [90, '90 jours'], [365, '12 mois']].map(([d, label]) => (
              <button key={d} type="button" className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                onClick={() => setParams(periodPreset(d as number))}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Vues (GDP-001, GDP-018) */}
      <div className="flex gap-1 border-b">
        {(['open', 'history'] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setParams({ view: v === 'open' ? null : v, sort: null, dir: null, page: null })}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${view === v ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}
          >
            {v === 'open' ? 'Demandes ouvertes' : 'Historique'}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : fetchError ? (
        <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-6 text-center text-red-400">
          <p className="font-medium mb-2">Erreur de chargement</p>
          <p className="text-sm">{fetchError}</p>
          <button onClick={() => fetchList()} className="mt-3 text-sm underline">Réessayer</button>
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <ShieldCheck className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p>
            {data && data.total > 0
              ? 'Aucune demande sur cette page.'
              : view === 'open' ? 'Aucune demande ouverte.' : 'Aucune demande traitée.'}
          </p>
        </div>
      ) : (
        <>
          <div className="rounded-xl border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {COLUMNS[view].map((c) => (
                    <TableHead key={c.key} className={c.className}>
                      {c.sortable ? (
                        <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => sortBy(c.key)}>
                          {c.label}
                          {data.sort === c.key && (data.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                        </button>
                      ) : c.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => setDialog({ open: true, id: r.id })}>
                    {view === 'open' ? (
                      <>
                        <TableCell className="text-sm tabular-nums">{formatIsoDate(r.dueDate)}</TableCell>
                        <TableCell className="text-sm text-right tabular-nums"><RemainingDays dueDate={r.dueDate} /></TableCell>
                        <TableCell className="text-sm">{RIGHT_LABELS[r.rightType]}</TableCell>
                        <TableCell className="text-sm max-w-[16rem] truncate">{subjectLabel(r)}</TableCell>
                        <TableCell className="text-sm max-w-[12rem] truncate">{accountLabel(r)}</TableCell>
                        <TableCell className="text-xs">{formatDateTime(r.receivedAt)}</TableCell>
                        <TableCell className="text-sm">
                          {STATUS_LABELS[r.status]}
                          {r.lastError && <span className="block text-xs text-red-400">Erreur de traitement</span>}
                        </TableCell>
                        <TableCell className="text-xs">{ORIGIN_LABELS[r.origin]}</TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell className="text-xs">{formatDateTime(r.processedAt)}</TableCell>
                        <TableCell className="text-sm">{RIGHT_LABELS[r.rightType]}</TableCell>
                        <TableCell className="text-sm max-w-[16rem] truncate">{subjectLabel(r)}</TableCell>
                        <TableCell className="text-sm max-w-[12rem] truncate">{accountLabel(r)}</TableCell>
                        <TableCell className="text-xs">{formatDateTime(r.receivedAt)}</TableCell>
                        <TableCell className="text-sm tabular-nums">{formatIsoDate(r.dueDate)}</TableCell>
                        <TableCell className="text-xs">{ORIGIN_LABELS[r.origin]}</TableCell>
                        <TableCell className="text-xs max-w-[18rem] truncate" title={r.result ?? ''}>{r.result ?? '—'}</TableCell>
                      </>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Pagination classique (GDP-006) */}
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{data.total} demande{data.total > 1 ? 's' : ''}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={data.page <= 1}
                onClick={() => setParams({ page: String(data.page - 1) })}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span>Page {data.page} / {data.totalPages}</span>
              <Button variant="outline" size="sm" disabled={data.page >= data.totalPages}
                onClick={() => setParams({ page: String(data.page + 1) })}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}

      <GdprRequestDialog
        open={dialog.open}
        requestId={dialog.id}
        onClose={() => setDialog({ open: false, id: null })}
        onChanged={() => fetchList()}
      />
    </div>
  );
}

export default function AdminGdprPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>}>
      <GdprPageContent />
    </Suspense>
  );
}
