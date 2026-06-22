"use client"

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Search, ChevronLeft, ChevronRight, Package, Building2, AlertTriangle, RefreshCw } from 'lucide-react';

const STATUS_OPTIONS = [
  { value: 'all',          label: 'Tous les statuts' },
  { value: 'EN_SERVICE',   label: 'En service' },
  { value: 'EN_PANNE',     label: 'En panne' },
  { value: 'EN_REPARATION',label: 'En réparation' },
  { value: 'INACTIF',      label: 'Inactif' },
  { value: 'VENDU',        label: 'Vendu' },
  { value: 'DETRUIT',      label: 'Détruit' },
  { value: 'ARCHIVED',     label: 'Archivé' },
  { value: 'TRANSMIS',     label: 'Transmis' },
];

const STATUS_STYLES: Record<string, string> = {
  EN_SERVICE:    'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
  EN_PANNE:      'bg-red-500/15 text-red-400 border-red-500/30',
  EN_REPARATION: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  INACTIF:       'bg-slate-500/15 text-slate-400 border-slate-500/30',
  VENDU:         'bg-slate-500/15 text-slate-400 border-slate-500/30',
  DETRUIT:       'bg-red-500/15 text-red-400 border-red-500/30',
  ARCHIVED:      'bg-slate-500/15 text-slate-400 border-slate-500/30',
  TRANSMIS:      'bg-violet-500/15 text-violet-400 border-violet-500/30',
};
import { apiClient } from '@/lib/api-client';

interface Asset {
  id: number;
  userId: number;
  category: string;
  categoryLabel: string;
  subtype: string | null;
  name: string;
  purchaseDate: string | null;
  purchasePrice: string | null;
  status: string;
  accountName: string | null;
  createdAt: string;
  owner: {
    email: string;
    firstName: string;
    lastName: string;
  };
}

interface AssetType {
  id: number;
  code: string;
  label: string;
  isEnabled: boolean;
}

export default function AdminAssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [assetTypes, setAssetTypes] = useState<AssetType[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Filters
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [accountSearch, setAccountSearch] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  useEffect(() => {
    loadAssetTypes();
  }, []);

  useEffect(() => {
    loadAssets();
  }, [search, accountSearch, categoryFilter, statusFilter, page]);

    const loadAssetTypes = async () => {
      try {
        const data = await apiClient.get<AssetType[]>('/api/admin/asset-types');
        setAssetTypes(data.filter((type: AssetType) => type.isEnabled));
      } catch (err) {
        console.error('Error loading asset types:', err);
      }
    };
  
    const loadAssets = async () => {
      try {
        setIsLoading(true);
        setError(null);
  
        // Build query params
        const params = new URLSearchParams({
          page: page.toString(),
          limit: limit.toString(),
        });
  
        if (search) params.append('search', search);
        if (accountSearch) params.append('accountSearch', accountSearch);
        if (categoryFilter && categoryFilter !== 'all') params.append('category', categoryFilter);
        if (statusFilter && statusFilter !== 'all') params.append('status', statusFilter);
  
        const data = await apiClient.get<{ assets: Asset[]; total: number }>(`/api/admin/assets?${params.toString()}`);
        if (!data || !Array.isArray(data.assets)) {
          console.error('[AdminAssets] Unexpected response shape:', data);
          throw new Error(`Réponse inattendue du serveur : ${JSON.stringify(data)}`);
        }
        setAssets(data.assets);
        setTotal(data.total ?? 0);
      } catch (err) {
        console.error('Error loading assets:', err);
        setError(err instanceof Error ? err.message : 'Erreur inconnue');
      } finally {
        setIsLoading(false);
      }
    };


  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const getStatusLabel = (status: string) => {
    return STATUS_OPTIONS.find(o => o.value === status)?.label ?? status;
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Non défini';
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  const formatPrice = (price: string | null) => {
    if (!price) return 'Non défini';
    return `${parseFloat(price).toLocaleString('fr-FR')} €`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">Gestion des biens</h1>
        <p className="text-muted-foreground mt-1">
          Liste complète de tous les biens enregistrés sur la plateforme
        </p>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filtres</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Rechercher par nom de bien..."
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-9"
              />
            </div>

            <div className="relative">
              <Building2 className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Rechercher par nom de compte..."
                value={accountSearch}
                onChange={(e) => { setAccountSearch(e.target.value); setPage(1); }}
                className="pl-9"
              />
            </div>

            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Tous les types de biens" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les types de biens</SelectItem>
                {assetTypes.map((type) => (
                  <SelectItem key={type.id} value={type.code}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
              <SelectTrigger>
                <SelectValue placeholder="Tous les statuts" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Assets List */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <Package className="w-5 h-5" />
              Biens {!error && `(${total})`}
            </span>
            <Button variant="outline" size="sm" onClick={loadAssets} disabled={isLoading}>
              <RefreshCw className={`w-3.5 h-3.5 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Rafraîchir
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <AlertTriangle className="w-8 h-8 text-destructive" />
              <p className="text-sm text-destructive font-medium">{error}</p>
              <Button variant="outline" size="sm" onClick={loadAssets}>
                <RefreshCw className="w-3.5 h-3.5 mr-2" />
                Réessayer
              </Button>
            </div>
          ) : assets.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Aucun bien trouvé
            </div>
          ) : (
            <div className="space-y-3">
              {assets.map((asset) => (
                <Link
                  key={asset.id}
                  href={`/admin/assets/${asset.id}`}
                  className="flex items-center justify-between p-4 rounded-lg border hover:bg-accent transition-colors"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{asset.name}</span>
                      <Badge variant="outline">
                        {asset.categoryLabel}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${STATUS_STYLES[asset.status] ?? 'bg-muted text-muted-foreground border-border'}`}>
                        {getStatusLabel(asset.status)}
                      </Badge>
                    </div>
                    <div className="text-sm text-muted-foreground mt-1 flex items-center gap-2">
                      {asset.accountName && (
                        <span className="flex items-center gap-1">
                          <Building2 className="w-3 h-3" />
                          {asset.accountName}
                          <span className="text-muted-foreground/50">·</span>
                        </span>
                      )}
                      {asset.owner.firstName} {asset.owner.lastName} ({asset.owner.email})
                    </div>
                    {asset.purchasePrice && (
                      <div className="text-sm text-muted-foreground">
                        Prix d'achat: {formatPrice(asset.purchasePrice)}
                      </div>
                    )}
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium">
                      ID: {asset.id}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Créé le {formatDate(asset.createdAt)}
                    </div>
                    {asset.purchaseDate && (
                      <div className="text-sm text-muted-foreground">
                        Acheté le {formatDate(asset.purchaseDate)}
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          )}

          {/* Pagination */}
          {!isLoading && !error && assets.length > 0 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Précédent
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => p + 1)}
                disabled={page * limit >= total}
              >
                Suivant
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}