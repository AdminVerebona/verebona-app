"use client"

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Download,
  Search,
  Trash2,
  AlertCircle,
  CheckCircle,
  Clock,
  XCircle,
  Loader2,
  ChevronLeft,
  ChevronRight,
  BarChart3,
  FileDown,
  User,
  Package,
  Building2,
  Ban,
} from 'lucide-react';
import { toast } from 'sonner';

const EXPORT_TYPES: Record<string, string> = {
  CIL_REGLEMENTAIRE: 'CIL Réglementaire',
  DOSSIER_VENTE: 'Dossier de vente',
  ASSURANCE_ESTIMATION: 'Assurance – Estimation',
  ASSURANCE_DEVIS: 'Assurance – Devis',
  ASSURANCE_SINISTRE: 'Assurance – Sinistre',
  DOSSIER_COMPLET: 'Dossier complet',
  REVENTE: 'Revente',
  SAV_GARANTIE: 'SAV / Garantie',
  EXPORT_BRUT: 'Export brut',
  AUTRE: 'Autre',
};

const STATUSES: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'active' | 'pending'; icon: React.ReactNode }> = {
  pending: { label: 'En attente', variant: 'secondary', icon: <Clock className="h-3 w-3" /> },
  generating: { label: 'En cours', variant: 'pending', icon: <Loader2 className="h-3 w-3 animate-spin" /> },
  ready: { label: 'Prêt', variant: 'active', icon: <CheckCircle className="h-3 w-3" /> },
  error: { label: 'Erreur', variant: 'destructive', icon: <AlertCircle className="h-3 w-3" /> },
  deleted: { label: 'Supprimé', variant: 'outline', icon: <Trash2 className="h-3 w-3" /> },
  cancelled: { label: 'Annulé', variant: 'secondary', icon: <Ban className="h-3 w-3" /> },
};

interface ExportRow {
  id: number;
  publicId: string;
  exportType: string;
  variant: string | null;
  status: string;
  requestedOutputs: string | null;
  errorPayload: string | null;
  generationAttemptCount: number;
  createdAt: string;
  completedAt: string | null;
  generationStartedAt: string | null;
  asset: { id: number; name: string; category: string; publicId: string } | null;
  user: { id: number; email: string; firstName: string; lastName: string } | null;
  account: { id: number; name: string } | null;
}

interface Stats {
  total: number;
  last30Days: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function AdminExportsPage() {
  const router = useRouter();
  const [exports, setExports] = useState<ExportRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);

  const [deleteDialog, setDeleteDialog] = useState<{ show: boolean; row: ExportRow | null }>({ show: false, row: null });
  const [isDeleting, setIsDeleting] = useState(false);

  const getToken = () => localStorage.getItem('bearer_token');

  const loadExports = useCallback(async (currentPage = 1) => {
    try {
      setIsLoading(true);
      setError(null);
      const token = getToken();
      if (!token) { router.push('/login?redirect=/admin/exports'); return; }

      const params = new URLSearchParams();
      params.append('page', String(currentPage));
      params.append('limit', '50');
      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (typeFilter !== 'all') params.append('exportType', typeFilter);
      if (searchQuery.trim()) params.append('search', searchQuery.trim());
      if (startDate) params.append('startDate', startDate);
      if (endDate) params.append('endDate', endDate);

      const res = await fetch(`/api/admin/exports?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401) { router.push('/login?redirect=/admin/exports'); return; }
      if (!res.ok) throw new Error('Erreur lors du chargement des exports');

      const data = await res.json();
      setExports(data.data);
      setStats(data.stats);
      setPagination(data.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  }, [statusFilter, typeFilter, searchQuery, startDate, endDate, router]);

  useEffect(() => {
    setPage(1);
    loadExports(1);
  }, [statusFilter, typeFilter, startDate, endDate]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => { setPage(1); loadExports(1); }, 400);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    loadExports(page);
  }, [page]);

  const handleDelete = async () => {
    if (!deleteDialog.row) return;
    try {
      setIsDeleting(true);
      const token = getToken();
      const res = await fetch(`/api/admin/exports/${deleteDialog.row.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Erreur lors de la suppression');
      }
      toast.success('Export marqué comme supprimé');
      setDeleteDialog({ show: false, row: null });
      loadExports(page);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setIsDeleting(false);
    }
  };

  const formatDate = (d: string | null) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const getStatusBadge = (status: string) => {
    const s = STATUSES[status] ?? { label: status, variant: 'outline' as const, icon: null };
    return (
      <Badge variant={s.variant} className="flex items-center gap-1 w-fit">
        {s.icon}
        {s.label}
      </Badge>
    );
  };

  const getTypeLabel = (t: string) => EXPORT_TYPES[t] ?? t;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-2">
            <FileDown className="h-8 w-8" />
            Exports
          </h1>
          <p className="text-muted-foreground mt-1">
            Liste et statistiques des exports générés par les utilisateurs
          </p>
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-primary/10 rounded-lg">
                  <BarChart3 className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.total.toLocaleString('fr-FR')}</p>
                  <p className="text-xs text-muted-foreground">Total exports</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-500/10 rounded-lg">
                  <Clock className="h-5 w-5 text-blue-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{stats.last30Days.toLocaleString('fr-FR')}</p>
                  <p className="text-xs text-muted-foreground">30 derniers jours</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-500/10 rounded-lg">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{(stats.byStatus.ready ?? 0).toLocaleString('fr-FR')}</p>
                  <p className="text-xs text-muted-foreground">Prêts</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-destructive/10 rounded-lg">
                  <AlertCircle className="h-5 w-5 text-destructive" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{(stats.byStatus.error ?? 0).toLocaleString('fr-FR')}</p>
                  <p className="text-xs text-muted-foreground">En erreur</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Stats by type */}
      {stats && Object.keys(stats.byType).length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Répartition par type d'export
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {Object.entries(stats.byType)
                .sort(([, a], [, b]) => b - a)
                .map(([type, cnt]) => (
                  <div
                    key={type}
                    className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-full text-sm cursor-pointer hover:bg-accent transition-colors"
                    onClick={() => setTypeFilter(type)}
                  >
                    <span className="font-medium">{getTypeLabel(type)}</span>
                    <Badge variant="secondary" className="text-xs py-0 px-1.5">{cnt}</Badge>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="pt-5">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
            <div className="relative lg:col-span-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Rechercher (utilisateur, bien…)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Statut" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les statuts</SelectItem>
                {Object.entries(STATUSES).map(([v, s]) => (
                  <SelectItem key={v} value={v}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger>
                <SelectValue placeholder="Type d'export" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les types</SelectItem>
                {Object.entries(EXPORT_TYPES).map(([v, l]) => (
                  <SelectItem key={v} value={v}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="text-sm"
                title="Date de début"
              />
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="text-sm"
                title="Date de fin"
              />
            </div>
          </div>
          {(statusFilter !== 'all' || typeFilter !== 'all' || searchQuery || startDate || endDate) && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Filtres actifs :</span>
              {statusFilter !== 'all' && (
                <Badge variant="secondary" className="cursor-pointer" onClick={() => setStatusFilter('all')}>
                  Statut: {STATUSES[statusFilter]?.label} ×
                </Badge>
              )}
              {typeFilter !== 'all' && (
                <Badge variant="secondary" className="cursor-pointer" onClick={() => setTypeFilter('all')}>
                  Type: {getTypeLabel(typeFilter)} ×
                </Badge>
              )}
              {(startDate || endDate) && (
                <Badge variant="secondary" className="cursor-pointer" onClick={() => { setStartDate(''); setEndDate(''); }}>
                  Dates ×
                </Badge>
              )}
              <Button variant="ghost" size="sm" onClick={() => {
                setStatusFilter('all'); setTypeFilter('all');
                setSearchQuery(''); setStartDate(''); setEndDate('');
              }}>
                Tout effacer
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <p>{error}</p>
            </div>
          </CardContent>
        </Card>
      ) : exports.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="text-center py-12">
              <FileDown className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">Aucun export trouvé</h3>
              <p className="text-muted-foreground">Aucun export ne correspond à vos critères de recherche.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="rounded-lg border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Export</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Bien</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Utilisateur</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Compte</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Statut</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {exports.map((row) => (
                    <tr key={row.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3">
                        <div>
                          <p className="font-medium">{getTypeLabel(row.exportType)}</p>
                          {row.variant && (
                            <p className="text-xs text-muted-foreground">{row.variant}</p>
                          )}
                          <p className="text-xs text-muted-foreground font-mono">#{row.id}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {row.asset ? (
                          <div className="flex items-start gap-2">
                            <Package className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                            <div>
                              <p className="font-medium leading-tight">{row.asset.name}</p>
                              <p className="text-xs text-muted-foreground">{row.asset.category}</p>
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.user ? (
                          <div className="flex items-start gap-2">
                            <User className="h-3.5 w-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
                            <div>
                              <p className="font-medium leading-tight">{row.user.firstName} {row.user.lastName}</p>
                              <p className="text-xs text-muted-foreground">{row.user.email}</p>
                            </div>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.account ? (
                          <div className="flex items-center gap-1.5">
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="text-sm">{row.account.name}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="space-y-1">
                          {getStatusBadge(row.status)}
                          {row.generationAttemptCount > 1 && (
                            <p className="text-xs text-muted-foreground">{row.generationAttemptCount} tentatives</p>
                          )}
                          {row.status === 'error' && row.errorPayload && (
                            <p className="text-xs text-destructive truncate max-w-[180px]" title={row.errorPayload}>
                              {(() => {
                                try { return JSON.parse(row.errorPayload)?.message ?? row.errorPayload; }
                                catch { return row.errorPayload; }
                              })()}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm">{formatDate(row.createdAt)}</p>
                          {row.completedAt && (
                            <p className="text-xs text-muted-foreground">Terminé : {formatDate(row.completedAt)}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {row.status !== 'deleted' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeleteDialog({ show: true, row })}
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {((pagination.page - 1) * pagination.limit) + 1}–{Math.min(pagination.page * pagination.limit, pagination.total)} sur {pagination.total.toLocaleString('fr-FR')} exports
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 1}
                  onClick={() => setPage(p => p - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">
                  Page {pagination.page} / {pagination.totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === pagination.totalPages}
                  onClick={() => setPage(p => p + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Delete Dialog */}
      <Dialog open={deleteDialog.show} onOpenChange={(open) => setDeleteDialog({ show: open, row: null })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmer la suppression</DialogTitle>
            <DialogDescription>
              Voulez-vous marquer cet export <strong>#{deleteDialog.row?.id}</strong> ({getTypeLabel(deleteDialog.row?.exportType ?? '')}) comme supprimé ?
              <br />
              Cette action est réversible uniquement en base de données.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialog({ show: false, row: null })} disabled={isDeleting}>
              Annuler
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? 'Suppression...' : 'Supprimer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
