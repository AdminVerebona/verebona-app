"use client";

/**
 * Supervision — CDC BO §4.5.
 *
 *  - SUP-001 / SUP-002 : compteur global et compteur par domaine, zéros
 *    compris, sans navigation intermédiaire (SUP-006).
 *  - SUP-003 : aucun message « Aucun problème détecté » — les zéros suffisent.
 *  - SUP-005 : liste des anomalies ouvertes directement visible, triable par
 *    date, domaine, compte et utilisateur ; ni recherche ni filtre.
 *  - SUP-H01 / SUP-H02 : historique des anomalies résolues, pagination
 *    classique et tri uniquement.
 *  - Aucune criticité, aucun bouton de création (SUP-012).
 *
 * Le tri et la page vivent dans l'URL : ils sont conservés au retour de
 * l'écran de traitement (UX-004).
 */
import Link from 'next/link';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/admin/format';
import type { AnomalyListItem, DomainCounter } from '@/services/admin/anomaly.service';
import { SectionTitle, ViewState } from './shared';
import { useDashboardData } from './useDashboardData';

type Status = 'open' | 'resolved';
type SortKey = 'date' | 'detected' | 'domain' | 'account' | 'user';

interface ListResponse {
  items: AnomalyListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListParams { sort: SortKey; dir: 'asc' | 'desc'; page: number }

function Counters() {
  const { data, loading, error, reload } = useDashboardData<{ totalOpen: number; domains: DomainCounter[] }>(
    '/api/admin/dashboard?view=supervision',
  );
  if (!data) return <ViewState loading={loading} error={error} onRetry={reload} title="Compteurs de supervision indisponibles" />;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
      <div className="rounded-xl border bg-card p-4 text-center">
        <p className="text-2xl font-bold tabular-nums">{data.totalOpen}</p>
        <p className="text-xs text-muted-foreground mt-0.5">Anomalies ouvertes</p>
      </div>
      {data.domains.map((d) => (
        <div key={d.domain} className="rounded-xl border bg-card p-4 text-center">
          <p className={`text-2xl font-bold tabular-nums ${d.open > 0 ? '' : 'text-muted-foreground'}`}>{d.open}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{d.label}</p>
        </div>
      ))}
    </div>
  );
}

function SortHeader({ label, k, params, onChange }: { label: string; k: SortKey; params: ListParams; onChange: (p: ListParams) => void }) {
  const active = params.sort === k;
  const Icon = params.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className="px-3 py-2 font-medium" aria-sort={active ? (params.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={`inline-flex items-center gap-1 hover:text-foreground ${active ? 'text-foreground' : ''}`}
        onClick={() => onChange({ sort: k, dir: active && params.dir === 'desc' ? 'asc' : active ? 'desc' : (k === 'date' || k === 'detected' ? 'desc' : 'asc'), page: 1 })}
      >
        {label}
        {active && <Icon className="h-3 w-3" aria-hidden />}
      </button>
    </th>
  );
}

function AnomalyTable({ status, params, onChange }: { status: Status; params: ListParams; onChange: (p: ListParams) => void }) {
  const url = `/api/admin/anomalies?status=${status}&sort=${params.sort}&dir=${params.dir}&page=${params.page}`;
  const { data, loading, error, reload } = useDashboardData<ListResponse>(url);
  if (!data) {
    return <ViewState loading={loading} error={error} onRetry={reload} title={status === 'open' ? 'Anomalies ouvertes indisponibles' : 'Historique indisponible'} />;
  }
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const resolved = status === 'resolved';

  return (
    <div className="space-y-2">
      <div className="rounded-xl border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b">
              <SortHeader label={resolved ? 'Résolue le' : 'Dernière occurrence'} k="date" params={params} onChange={onChange} />
              {resolved && <SortHeader label="Détectée le" k="detected" params={params} onChange={onChange} />}
              <SortHeader label="Domaine" k="domain" params={params} onChange={onChange} />
              <th className="px-3 py-2 font-medium">Anomalie</th>
              <SortHeader label="Compte" k="account" params={params} onChange={onChange} />
              <SortHeader label="Utilisateur" k="user" params={params} onChange={onChange} />
              {resolved
                ? <><th className="px-3 py-2 font-medium">Cause</th><th className="px-3 py-2 font-medium">Action corrective</th><th className="px-3 py-2 font-medium">Résolution</th></>
                : <th className="px-3 py-2 font-medium text-right">Occurrences</th>}
            </tr>
          </thead>
          <tbody>
            {data.items.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                {resolved ? 'Aucune anomalie résolue.' : '0 anomalie ouverte.'}
              </td></tr>
            )}
            {data.items.map((a) => (
              <tr key={a.id} className="border-b last:border-b-0 hover:bg-muted/40">
                <td className="px-3 py-2 whitespace-nowrap">
                  <Link href={`/admin/supervision/${a.id}`} className="hover:underline">
                    {formatDateTime(resolved ? a.resolvedAt : a.lastSeenAt)}
                  </Link>
                </td>
                {resolved && <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(a.firstSeenAt)}</td>}
                <td className="px-3 py-2 whitespace-nowrap">{a.domainLabel}</td>
                <td className="px-3 py-2 min-w-[14rem]">
                  <Link href={`/admin/supervision/${a.id}`} className="font-medium hover:underline">{a.title}</Link>
                  {a.previousAnomalyId && <span className="ml-2 text-xs text-muted-foreground">récurrence</span>}
                </td>
                <td className="px-3 py-2">
                  {a.accountId ? <Link href={`/admin/accounts/${a.accountId}`} className="hover:underline">{a.accountName ?? `#${a.accountId}`}</Link> : '—'}
                </td>
                <td className="px-3 py-2">
                  {a.userId ? <Link href={`/admin/users/${a.userId}`} className="hover:underline">{a.userEmail ?? `#${a.userId}`}</Link> : '—'}
                </td>
                {resolved ? (
                  <>
                    <td className="px-3 py-2 max-w-[16rem] truncate" title={a.cause ?? a.autoResolutionCause ?? ''}>{a.cause ?? a.autoResolutionCause ?? '—'}</td>
                    <td className="px-3 py-2 max-w-[16rem] truncate" title={a.correctiveAction ?? ''}>{a.correctiveAction ?? '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{a.resolutionSource === 'auto' ? 'Automatique' : 'Manuelle'}</td>
                  </>
                ) : (
                  <td className="px-3 py-2 text-right tabular-nums">{a.occurrenceCount}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="text-muted-foreground">Page {data.page} / {pages} · {data.total} anomalie(s)</span>
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Page précédente"
            disabled={data.page <= 1} onClick={() => onChange({ ...params, page: data.page - 1 })}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Page suivante"
            disabled={data.page >= pages} onClick={() => onChange({ ...params, page: data.page + 1 })}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

export function SupervisionTab({
  open, history, onOpenChange, onHistoryChange,
}: {
  open: ListParams;
  history: ListParams;
  onOpenChange: (p: ListParams) => void;
  onHistoryChange: (p: ListParams) => void;
}) {
  return (
    <div className="space-y-4">
      <Counters />
      <SectionTitle>Anomalies ouvertes</SectionTitle>
      <AnomalyTable status="open" params={open} onChange={onOpenChange} />
      <SectionTitle>Historique des anomalies résolues</SectionTitle>
      <AnomalyTable status="resolved" params={history} onChange={onHistoryChange} />
    </div>
  );
}
