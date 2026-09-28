"use client";

/**
 * Liste des comptes — CDC Back-Office V1 §5.1.
 *
 * Colonnes §5.1 : nom, offre, statut, utilisateurs, biens, documents,
 * stockage, création, dernière connexion. Recherche SERVEUR (ACC-L02) sur le
 * nom du compte et l'identité / l'e-mail de tout utilisateur rattaché.
 * En tête : total et synthèse par statut (ACC-L01). Filtres offre et statut
 * (ACC-L03), tri (ACC-L04), pagination classique (ACC-L05). UX-004 : état
 * porté par l'URL (retour arrière conservé). ERR-001 : écran d'erreur.
 */
import { Suspense, useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Search, Building2, RefreshCw } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { AdminPagination, SortHeader, nextSort } from '../subscriptions/_components/list-controls';
import { formatBytes, formatDate, formatDateTime } from '@/lib/admin/format';

type AccountStatus = 'active' | 'suspended' | 'deletion_pending';

interface Account {
  id: number;
  name: string;
  ownerEmail: string | null;
  planType: string;
  status: AccountStatus;
  memberCount: number;
  assetCount: number;
  documentCount: number;
  storageBytes: number;
  createdAt: string;
  lastLoginAt: string | null;
}

type Sort = 'name' | 'plan' | 'status' | 'storage' | 'documents' | 'assets' | 'members' | 'created' | 'lastLogin';

interface Summary {
  total: number;
  active: number;
  suspended: number;
  deletionPending: number;
}

function PlanBadge({ plan }: { plan: string }) {
  const variants: Record<string, { cls: string; label: string }> = {
    STANDARD:    { cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',    label: 'Standard' },
    PREMIUM:     { cls: 'bg-blue-500/15 text-blue-400 border-blue-500/30',    label: 'Premium' },
    PREMIUM_DUO: { cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', label: 'Premium Duo' },
  };
  const v = variants[plan] ?? variants.STANDARD;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${v.cls}`}>
      {v.label}
    </span>
  );
}

const STATUS_LABEL: Record<AccountStatus, { label: string; cls: string }> = {
  active: { label: 'Actif', cls: 'text-emerald-400' },
  suspended: { label: 'Suspendu', cls: 'text-red-400' },
  deletion_pending: { label: 'Suppression en cours', cls: 'text-amber-400' },
};

function AccountsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  const plan = params.get('plan') ?? '';
  const status = params.get('status') ?? '';
  const sort = (params.get('sort') as Sort) || 'created';
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pageInfo, setPageInfo] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch] = useState(q);

  const setQuery = useCallback((next: Record<string, string>) => {
    const qs = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) qs.set(k, v);
      else qs.delete(k);
    }
    router.replace(`${pathname}?${qs}`);
  }, [params, pathname, router]);

  const fetchAccounts = useCallback(async () => {
    try {
      setLoading(true);
      setFetchError(null);
      const qs = new URLSearchParams({ sort, dir, page: String(page) });
      if (q) qs.set('q', q);
      if (plan) qs.set('plan', plan);
      if (status) qs.set('status', status);
      const res = await fetch(`/api/admin/accounts?${qs}`, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) {
        router.push('/login?returnUrl=/admin/accounts');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Erreur ${res.status}`);
      setAccounts(data.accounts || []);
      setSummary(data.summary ?? null);
      setPageInfo({ page: data.page, totalPages: data.totalPages, total: data.total });
    } catch (error) {
      // ERR-001 : aucune donnée partielle présentée comme complète.
      setAccounts([]);
      setSummary(null);
      setPageInfo(null);
      setFetchError(error instanceof Error ? error.message : 'Erreur réseau — impossible de charger les comptes.');
    } finally {
      setLoading(false);
    }
  }, [q, plan, status, sort, dir, page, router]);

  useEffect(() => { void fetchAccounts(); }, [fetchAccounts]);

  // Recherche serveur, reportée dans l'URL 300 ms après la dernière frappe.
  useEffect(() => {
    if (search.trim() === q) return;
    const handle = setTimeout(() => setQuery({ q: search.trim(), page: '1' }), 300);
    return () => clearTimeout(handle);
  }, [search, q, setQuery]);

  const onSort = (key: Sort) => {
    const n = nextSort(sort, dir, key);
    setQuery({ sort: n.sort, dir: n.dir, page: '1' });
  };
  const hasCriteria = !!(q || plan || status);
  const selectCls = 'rounded-md border bg-background px-3 py-2 text-sm';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Building2 className="h-6 w-6" />
            Comptes
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Chaque compte porte ses utilisateurs, biens et abonnement
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchAccounts()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </Button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border bg-card p-4 text-center">
            <p className="text-2xl font-bold">{summary.total}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Comptes totaux</p>
          </div>
          <div className="rounded-xl border bg-card p-4 text-center">
            <p className="text-2xl font-bold text-emerald-400">{summary.active}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Actifs</p>
          </div>
          <div className="rounded-xl border bg-card p-4 text-center">
            <p className="text-2xl font-bold text-red-400">{summary.suspended}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Suspendus</p>
          </div>
          <div className="rounded-xl border bg-card p-4 text-center">
            <p className="text-2xl font-bold text-amber-400">{summary.deletionPending}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Suppression en cours</p>
          </div>
        </div>
      )}

      <div className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Rechercher par nom de compte, nom, prénom ou e-mail d'un utilisateur…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <select aria-label="Filtrer par offre" className={selectCls} value={plan} onChange={(e) => setQuery({ plan: e.target.value, page: '1' })}>
          <option value="">Toutes les offres</option>
          <option value="STANDARD">Standard</option>
          <option value="PREMIUM">Premium</option>
          <option value="PREMIUM_DUO">Premium Duo</option>
        </select>
        <select aria-label="Filtrer par statut" className={selectCls} value={status} onChange={(e) => setQuery({ status: e.target.value, page: '1' })}>
          <option value="">Tous les statuts</option>
          <option value="active">Actif</option>
          <option value="suspended">Suspendu</option>
          <option value="deletion_pending">Suppression en cours</option>
        </select>
      </div>

      {fetchError ? (
        <EcranEnErreur titre="Chargement des comptes impossible" message={fetchError} onRetry={fetchAccounts} />
      ) : loading && accounts.length === 0 ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Building2 className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p>{hasCriteria ? 'Aucun compte ne correspond à ces critères.' : 'Aucun compte.'}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className={`rounded-xl border bg-card overflow-x-auto ${loading ? 'opacity-60' : ''}`}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead><SortHeader label="Nom" sortKey="name" current={sort} dir={dir} onSort={onSort} /></TableHead>
                  <TableHead><SortHeader label="Offre" sortKey="plan" current={sort} dir={dir} onSort={onSort} /></TableHead>
                  <TableHead><SortHeader label="Statut" sortKey="status" current={sort} dir={dir} onSort={onSort} /></TableHead>
                  <TableHead className="text-right"><SortHeader label="Utilisateurs" sortKey="members" current={sort} dir={dir} onSort={onSort} align="right" /></TableHead>
                  <TableHead className="text-right"><SortHeader label="Biens" sortKey="assets" current={sort} dir={dir} onSort={onSort} align="right" /></TableHead>
                  <TableHead className="text-right"><SortHeader label="Documents" sortKey="documents" current={sort} dir={dir} onSort={onSort} align="right" /></TableHead>
                  <TableHead className="text-right"><SortHeader label="Stockage" sortKey="storage" current={sort} dir={dir} onSort={onSort} align="right" /></TableHead>
                  <TableHead><SortHeader label="Création" sortKey="created" current={sort} dir={dir} onSort={onSort} /></TableHead>
                  <TableHead><SortHeader label="Dernière connexion" sortKey="lastLogin" current={sort} dir={dir} onSort={onSort} /></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map(account => (
                  <TableRow
                    key={account.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/admin/accounts/${account.id}`)}
                  >
                    <TableCell>
                      <div className="font-medium text-sm">{account.name}</div>
                      {account.ownerEmail && (
                        <div className="text-xs text-muted-foreground truncate max-w-[16rem]">{account.ownerEmail}</div>
                      )}
                    </TableCell>
                    <TableCell><PlanBadge plan={account.planType} /></TableCell>
                    <TableCell>
                      <span className={`text-xs font-medium ${STATUS_LABEL[account.status].cls}`}>
                        {STATUS_LABEL[account.status].label}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{account.memberCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{account.assetCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{account.documentCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(account.storageBytes)}</TableCell>
                    <TableCell className="text-xs">{formatDate(account.createdAt)}</TableCell>
                    <TableCell className="text-xs">{formatDateTime(account.lastLoginAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {pageInfo && (
            <AdminPagination
              page={pageInfo.page}
              totalPages={pageInfo.totalPages}
              total={pageInfo.total}
              disabled={loading}
              onPage={(p) => setQuery({ page: String(p) })}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function AdminAccountsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>}>
      <AccountsScreen />
    </Suspense>
  );
}
