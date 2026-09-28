"use client"

/**
 * Utilisateurs — CDC Back-Office V1 §6.1.
 *
 * USR-L01 : compteurs total / actifs / désactivés. Colonnes : identité,
 * e-mail, compte, offre, statut. USR-L02 : recherche unique (nom, prénom,
 * e-mail, nom du compte). USR-L03 / USR-L04 : aucun filtre ni colonne statut
 * administrateur, rôle, dernière connexion, date de création. USR-L05 :
 * pagination classique et tri. UX-004 : état porté par l'URL. UX-005 : deux
 * états vides distincts. ERR-001 : écran d'erreur avec « Réessayer ».
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Loader2, Search, Users } from 'lucide-react';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { AdminPagination, SortHeader, nextSort } from '../subscriptions/_components/list-controls';

type Sort = 'name' | 'email' | 'account' | 'plan' | 'status';

interface UserRow {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  accountId: number | null;
  accountName: string | null;
  planType: string | null;
  status: 'active' | 'disabled';
}

interface Payload {
  summary: { total: number; active: number; disabled: number };
  items: UserRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const PLAN_LABELS: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  PREMIUM_DUO: 'Premium Duo',
  DUO: 'Premium Duo',
};

function SummaryTile({ label, value }: { label: string; value: number | undefined }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold">{value ?? '—'}</p>
      </CardContent>
    </Card>
  );
}

function UsersScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  const sort = (params.get('sort') as Sort) || 'name';
  const dir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const [search, setSearch] = useState(q);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setQuery = useCallback((next: Record<string, string>) => {
    const qs = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) qs.set(k, v);
      else qs.delete(k);
    }
    router.replace(`${pathname}?${qs}`);
  }, [params, pathname, router]);

  // Recherche différée : l'URL n'est mise à jour qu'après la saisie.
  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => setQuery({ q: search.trim(), page: '1' }), 300);
    return () => clearTimeout(t);
  }, [search, q, setQuery]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ sort, dir, page: String(page) });
      if (q) qs.set('q', q);
      const res = await fetch(`/api/admin/users?${qs}`, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setData(payload as Payload);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [q, sort, dir, page]);

  useEffect(() => { void load(); }, [load]);

  const onSort = (key: Sort) => {
    const n = nextSort(sort, dir, key);
    setQuery({ sort: n.sort, dir: n.dir, page: '1' });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">Utilisateurs</h1>
        <p className="text-muted-foreground mt-1">Administration et support au niveau utilisateur</p>
      </div>

      {error ? (
        <EcranEnErreur titre="Chargement des utilisateurs impossible" message={error} onRetry={load} />
      ) : (
        <>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
            <SummaryTile label="Utilisateurs" value={data?.summary.total} />
            <SummaryTile label="Actifs" value={data?.summary.active} />
            <SummaryTile label="Désactivés" value={data?.summary.disabled} />
          </div>

          <div className="relative max-w-md">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Rechercher par nom, prénom, e-mail ou compte…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <Card>
            <CardContent className="pt-6 space-y-4">
              {loading && !data ? (
                <div className="space-y-2">
                  {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-10" />)}
                </div>
              ) : data && data.items.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground space-y-2">
                  <Users className="h-10 w-10 mx-auto opacity-50" />
                  <p>{q ? 'Aucun utilisateur ne correspond à votre recherche.' : 'Aucun utilisateur.'}</p>
                </div>
              ) : data ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-muted-foreground border-b">
                      <tr>
                        <th className="py-2 pr-3"><SortHeader label="Identité" sortKey="name" current={sort} dir={dir} onSort={onSort} /></th>
                        <th className="py-2 pr-3"><SortHeader label="E-mail" sortKey="email" current={sort} dir={dir} onSort={onSort} /></th>
                        <th className="py-2 pr-3"><SortHeader label="Compte" sortKey="account" current={sort} dir={dir} onSort={onSort} /></th>
                        <th className="py-2 pr-3"><SortHeader label="Offre" sortKey="plan" current={sort} dir={dir} onSort={onSort} /></th>
                        <th className="py-2"><SortHeader label="Statut" sortKey="status" current={sort} dir={dir} onSort={onSort} /></th>
                      </tr>
                    </thead>
                    <tbody className={loading ? 'opacity-60' : ''}>
                      {data.items.map((u) => (
                        <tr key={u.id} className="border-b last:border-0 hover:bg-accent/50">
                          <td className="py-2 pr-3">
                            <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">
                              {`${u.firstName} ${u.lastName}`.trim() || '—'}
                            </Link>
                          </td>
                          <td className="py-2 pr-3 text-muted-foreground">{u.email}</td>
                          <td className="py-2 pr-3">
                            {u.accountId ? (
                              <Link href={`/admin/accounts/${u.accountId}`} className="hover:underline">{u.accountName ?? `Compte #${u.accountId}`}</Link>
                            ) : '—'}
                          </td>
                          <td className="py-2 pr-3">{u.planType ? (PLAN_LABELS[u.planType] ?? u.planType) : '—'}</td>
                          <td className="py-2">
                            <Badge variant={u.status === 'active' ? 'active' : 'inactive'}>
                              {u.status === 'active' ? 'Actif' : 'Désactivé'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {data && (
                <AdminPagination
                  page={data.page}
                  totalPages={data.totalPages}
                  total={data.total}
                  disabled={loading}
                  onPage={(p) => setQuery({ page: String(p) })}
                />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

export default function AdminUsersPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-muted-foreground" /></div>}>
      <UsersScreen />
    </Suspense>
  );
}
