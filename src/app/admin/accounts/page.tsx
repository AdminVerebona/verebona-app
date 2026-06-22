"use client";

import { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Search, Building2, Users, Package, CreditCard, ChevronRight, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api-client';

interface Account {
  id: number;
  name: string;
  ownerId: number;
  ownerEmail: string;
  ownerName: string;
  planType: string;
  subscriptionStatus: string;
  stripeCustomerId: string | null;
  premiumUntil: number | null;
  duoAccountId: number | null;
  duoStatus: string | null;
  memberCount: number;
  assetCount: number;
  createdAt: string;
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

export default function AdminAccountsPage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => { fetchAccounts(); }, []);

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      setFetchError(null);
      const token = typeof window !== 'undefined' ? localStorage.getItem('bearer_token') : null;
      const res = await fetch('/api/admin/accounts', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
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
    } catch (error) {
      console.error('Failed to fetch accounts:', error);
      setFetchError('Erreur réseau — impossible de charger les comptes.');
    } finally {
      setLoading(false);
    }
  };

  const filtered = accounts.filter(a => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      a.name.toLowerCase().includes(q) ||
      a.ownerEmail.toLowerCase().includes(q) ||
      a.ownerName.toLowerCase().includes(q)
    );
  });

  const totalStandard = accounts.filter(a => a.planType === 'STANDARD').length;
  const totalPremium = accounts.filter(a => a.planType === 'PREMIUM').length;
  const totalDuo = accounts.filter(a => a.planType === 'PREMIUM_DUO').length;
  const totalStripe = accounts.filter(a => !!a.stripeCustomerId).length;

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
            {accounts.length} compte{accounts.length !== 1 ? 's' : ''} — chaque compte porte ses utilisateurs, biens et abonnement
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAccounts} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold">{accounts.length}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Comptes totaux</p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-zinc-400">{totalStandard}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Standard</p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-blue-400">{totalPremium}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Premium</p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-emerald-400">{totalDuo}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Premium Duo</p>
        </div>
        <div className="rounded-xl border bg-card p-4 text-center">
          <p className="text-2xl font-bold text-slate-400">{totalStripe}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Clients Stripe</p>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Rechercher par nom, email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : fetchError ? (
        <div className="rounded-xl border border-red-500/30 bg-red-950/20 p-6 text-center text-red-400">
          <p className="font-medium mb-2">Erreur de chargement</p>
          <p className="text-sm">{fetchError}</p>
          <button onClick={fetchAccounts} className="mt-3 text-sm underline">Réessayer</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Building2 className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p>{search ? 'Aucun compte trouvé pour cette recherche.' : 'Aucun compte.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(account => (
            <button
              key={account.id}
              onClick={() => router.push(`/admin/accounts/${account.id}`)}
              className="w-full text-left flex items-center gap-4 px-4 py-3 rounded-xl border bg-card hover:bg-accent/40 transition-colors"
            >
              {/* Left: identity */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm truncate">{account.name}</span>
                  <PlanBadge plan={account.planType} />
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{account.ownerEmail}</p>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Users className="h-3.5 w-3.5" />
                  <span>{account.memberCount}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Package className="h-3.5 w-3.5" />
                  <span>{account.assetCount}</span>
                </div>
                {account.stripeCustomerId && (
                  <div className="flex items-center gap-1 text-blue-500">
                    <CreditCard className="h-3.5 w-3.5" />
                    <span>Stripe</span>
                  </div>
                )}
              </div>

              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
