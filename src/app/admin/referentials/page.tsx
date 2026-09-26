"use client";

/**
 * Référentiels — CDC Back-Office V1 §9.
 *
 * Une page à sous-onglets (§9.1) : familles de biens, sous-catégories,
 * rubriques, types de documents, règles et mappings d'applicabilité.
 * Consultation et nombre d'utilisations courant (REFD-003) ; tri par libellé,
 * code, utilisations et statut lorsqu'il existe (REFD-002). Pas de recherche
 * (REFD-001), pas de seuil « rarement utilisé » (REFD-004), pas d'historique
 * (REFD-005), aucune modification (REFD-006) : les référentiels sont
 * versionnés dans le code.
 *
 * Remplace les anciennes pages « Types de biens » et « Types de documents »,
 * désormais redirigées ici. Onglet, tri et sens sont portés par l'URL (UX-004).
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { Library, Loader2, RefreshCw } from 'lucide-react';
import { SortHeader, nextSort } from '../subscriptions/_components/list-controls';

interface Row { code: string; label: string; active: boolean | null; usage: number | null; details: string | null }

interface Snapshot {
  version: string;
  assetFamilies: Row[];
  assetSubcategories: Row[];
  rubrics: Row[];
  documentTypes: Row[];
  applicability: Row[];
  mappings: Row[];
}

type Sort = 'label' | 'code' | 'usage' | 'active';

const TABS = [
  { key: 'families', label: 'Familles de biens', detail: null },
  { key: 'subcategories', label: 'Sous-catégories', detail: 'Famille' },
  { key: 'rubrics', label: 'Rubriques', detail: 'Applicabilité' },
  { key: 'document-types', label: 'Types de documents', detail: 'Rubrique' },
  { key: 'rules', label: 'Règles et mappings', detail: 'Portée' },
] as const;
type TabKey = typeof TABS[number]['key'];

function sortRows(rows: Row[], sort: Sort, dir: 'asc' | 'desc'): Row[] {
  const f = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (sort === 'usage') cmp = (a.usage ?? -1) - (b.usage ?? -1);
    else if (sort === 'active') cmp = Number(a.active ?? false) - Number(b.active ?? false);
    else cmp = a[sort].localeCompare(b[sort], 'fr');
    return cmp * f || a.label.localeCompare(b.label, 'fr');
  });
}

function RowsTable({ rows, detailLabel, sort, dir, onSort, withStatus }: {
  rows: Row[]; detailLabel: string | null; sort: Sort; dir: 'asc' | 'desc'; onSort: (k: Sort) => void; withStatus: boolean;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground py-6 text-center">Aucune valeur.</p>;
  return (
    <div className="rounded-xl border bg-card overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead><SortHeader label="Libellé" sortKey="label" current={sort} dir={dir} onSort={onSort} /></TableHead>
            <TableHead><SortHeader label="Code" sortKey="code" current={sort} dir={dir} onSort={onSort} /></TableHead>
            {detailLabel && <TableHead>{detailLabel}</TableHead>}
            {withStatus && <TableHead><SortHeader label="Statut" sortKey="active" current={sort} dir={dir} onSort={onSort} /></TableHead>}
            <TableHead className="text-right"><SortHeader label="Utilisations" sortKey="usage" current={sort} dir={dir} onSort={onSort} align="right" /></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortRows(rows, sort, dir).map((r, i) => (
            <TableRow key={`${r.code}-${i}`}>
              <TableCell className="text-sm">{r.label}</TableCell>
              <TableCell className="font-mono text-xs">{r.code}</TableCell>
              {detailLabel && <TableCell className="text-xs text-muted-foreground">{r.details ?? '—'}</TableCell>}
              {withStatus && (
                <TableCell className="text-sm">
                  {r.active === null ? '—' : r.active ? <span className="text-emerald-500">Actif</span> : <span className="text-muted-foreground">Inactif</span>}
                </TableCell>
              )}
              <TableCell className="text-right tabular-nums">{r.usage ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ReferentialsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const tab: TabKey = (TABS.find((t) => t.key === params.get('tab'))?.key) ?? 'families';
  const sort: Sort = (['label', 'code', 'usage', 'active'] as const).find((s) => s === params.get('sort')) ?? 'label';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';

  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setQuery = useCallback((next: Record<string, string>) => {
    const qs = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) qs.set(k, v);
    router.replace(`${pathname}?${qs}`);
  }, [params, pathname, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/referentials', { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setData(payload);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onSort = (key: Sort) => {
    const n = nextSort(sort, dir, key);
    setQuery({ sort: n.sort, dir: n.dir });
  };

  const current = TABS.find((t) => t.key === tab)!;
  const renderContent = () => {
    if (!data) return null;
    const props = { sort, dir: dir as 'asc' | 'desc', onSort, detailLabel: current.detail };
    switch (tab) {
      case 'families': return <RowsTable rows={data.assetFamilies} withStatus {...props} />;
      case 'subcategories': return <RowsTable rows={data.assetSubcategories} withStatus {...props} />;
      case 'rubrics': return <RowsTable rows={data.rubrics} withStatus={false} {...props} />;
      case 'document-types': return <RowsTable rows={data.documentTypes} withStatus={false} {...props} />;
      case 'rules':
        return (
          <div className="space-y-6">
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Applicabilité par famille de biens</h2>
              <RowsTable rows={data.applicability} withStatus={false} {...props} />
            </section>
            <section className="space-y-2">
              <h2 className="text-sm font-semibold">Mappings de taxonomie documentaire</h2>
              <RowsTable rows={data.mappings} withStatus {...props} detailLabel="Type de mapping" />
            </section>
          </div>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Library className="h-6 w-6" /> Référentiels</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Consultation et utilisations actuelles. Les référentiels sont versionnés dans le code{data ? ` (version ${data.version})` : ''} et ne sont pas modifiables ici.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Actualiser
        </Button>
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setQuery({ tab: t.key })}
            className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === t.key ? 'border-primary font-medium' : 'border-transparent text-muted-foreground'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <EcranEnErreur titre="Impossible de charger les référentiels" message={error} onRetry={() => load()} />
      ) : renderContent()}
    </div>
  );
}

export default function AdminReferentialsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>}>
      <ReferentialsScreen />
    </Suspense>
  );
}
