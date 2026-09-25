"use client";

/**
 * Liste des comptes — CDC Back-Office V1 §5.1.
 *
 * Colonnes §5.1 : nom, offre, statut, utilisateurs, biens, documents,
 * stockage, création, dernière connexion. Recherche SERVEUR (ACC-L02) sur le
 * nom du compte et l'identité / l'e-mail de tout utilisateur rattaché.
 * En tête : total et synthèse par statut (ACC-L01).
 */
import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Search, Building2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
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

export default function AdminAccountsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');

  const fetchAccounts = useCallback(async (q: string) => {
    try {
      setLoading(true);
      setFetchError(null);
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      const res = await fetch(`/api/admin/accounts${params}`, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) {
        router.push('/login?returnUrl=/admin/accounts');
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setFetchError(err.message || `Erreur ${res.status}`);
        return;
      }
      const data = await res.json();
      setAccounts(data.accounts || []);
      setSummary(data.summary ?? null);
      setAppliedSearch(q);
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
      setFetchError('Erreur réseau — impossible de charger les comptes.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  // Recherche serveur, déclenchée 300 ms après la dernière frappe.
  useEffect(() => {
    const handle = setTimeout(() => { void fetchAccounts(search.trim()); }, 300);
    return () => clearTimeout(handle);
  }, [search, fetchAccounts]);

  return (
    <div className="space-y-6">
      {/* Header */}
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
        <Button variant="outline" size="sm" onClick={() => fetchAccounts(search.trim())} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </Button>
      </div>

      {/* Synthèse par statut (ACC-L01) */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-xl border bg-card p-4 text-center">
            <p className="text-2xl font-bold">{summary.total}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{appliedSearch ? 'Comptes trouvés' : 'Comptes totaux'}</p>
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

      {/* Recherche (ACC-L02) */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Rechercher par nom de compte, nom, prénom ou e-mail d'un utilisateur…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Liste */}
      {loading && accounts.length === 0 ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : fetchError ? (
        <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-6 text-center text-red-400">
          <p className="font-medium mb-2">Erreur de chargement</p>
          <p className="text-sm">{fetchError}</p>
          <button onClick={() => fetchAccounts(search.trim())} className="mt-3 text-sm underline">Réessayer</button>
        </div>
      ) : accounts.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Building2 className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p>{appliedSearch ? 'Aucun compte ne correspond à cette recherche.' : 'Aucun compte.'}</p>
        </div>
      ) : (
        <div className="rounded-xl border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nom</TableHead>
                <TableHead>Offre</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Utilisateurs</TableHead>
                <TableHead className="text-right">Biens</TableHead>
                <TableHead className="text-right">Documents</TableHead>
                <TableHead className="text-right">Stockage</TableHead>
                <TableHead>Création</TableHead>
                <TableHead>Dernière connexion</TableHead>
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
      )}
    </div>
  );
}
