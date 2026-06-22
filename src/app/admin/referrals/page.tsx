"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Gift, Users, Sparkles, Link2, ChevronLeft, ChevronRight, Check, X } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';

interface GlobalStats {
  totalLinks: number;
  totalUsed: number;
  totalValidated: number;
  totalCreditsGranted: number;
}

interface ReferralLink {
  id: number;
  code: string;
  isActive: boolean;
  accountId: number;
  createdAt: string;
  ownerUserId: number | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  usedCount: number;
  validatedCount: number;
}

interface AdminReferralsData {
  globalStats: GlobalStats;
  links: ReferralLink[];
  pagination: { page: number; limit: number; hasMore: boolean };
}

export default function AdminReferralsPage() {
  const [data, setData] = useState<AdminReferralsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const appUrl = typeof window !== 'undefined' ? window.location.origin : '';

  useEffect(() => {
    loadData(page);
  }, [page]);

  const loadData = async (p: number) => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiClient.get<AdminReferralsData>(`/api/admin/referrals?page=${p}`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (d: string) =>
    format(new Date(d), 'dd MMM yyyy', { locale: fr });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">Parrainage</h1>
        <p className="text-muted-foreground mt-1">Suivi des codes de parrainage et des récompenses.</p>
      </div>

      {/* Stats globales */}
      {loading && !data ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : data ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Codes créés</CardTitle>
              <Link2 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{data.globalStats.totalLinks}</div>
              <p className="text-xs text-muted-foreground mt-1">Liens de parrainage actifs</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Liens utilisés</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{data.globalStats.totalUsed}</div>
              <p className="text-xs text-muted-foreground mt-1">Filleuls inscrits</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Parrainages validés</CardTitle>
              <Gift className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-500">{data.globalStats.totalValidated}</div>
              <p className="text-xs text-muted-foreground mt-1">1ère facturation filleul</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Crédits accordés</CardTitle>
              <Sparkles className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-primary">{data.globalStats.totalCreditsGranted}</div>
              <p className="text-xs text-muted-foreground mt-1">Analyses IA distribuées</p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Tableau des liens */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Link2 className="w-5 h-5" />
            Codes de parrainage
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <div className="text-destructive text-sm py-4 text-center">{error}</div>
          )}

          {loading && !data ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14" />)}
            </div>
          ) : data && data.links.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-8">Aucun code de parrainage créé pour l'instant.</p>
          ) : data ? (
            <>
              {/* Desktop table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-2 pr-4 font-medium">Parrain</th>
                      <th className="text-left py-2 pr-4 font-medium">Code</th>
                      <th className="text-center py-2 pr-4 font-medium">Statut</th>
                      <th className="text-center py-2 pr-4 font-medium">Utilisé</th>
                      <th className="text-center py-2 pr-4 font-medium">Validé</th>
                      <th className="text-left py-2 font-medium">Créé le</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.links.map((link) => (
                      <tr key={link.id} className="border-b hover:bg-muted/30 transition-colors">
                        <td className="py-3 pr-4">
                          <div className="font-medium">
                            {link.firstName && link.lastName
                              ? `${link.firstName} ${link.lastName}`
                              : `Compte #${link.accountId}`}
                          </div>
                          {link.email && (
                            <div className="text-xs text-muted-foreground truncate max-w-[200px]">{link.email}</div>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          <code className="font-mono text-xs bg-muted px-2 py-1 rounded">{link.code}</code>
                        </td>
                        <td className="py-3 pr-4 text-center">
                          {link.isActive ? (
                            <Badge variant="secondary" className="gap-1 text-green-500 border-green-500/30 bg-green-500/10">
                              <Check className="w-3 h-3" />Actif
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="gap-1 text-muted-foreground">
                              <X className="w-3 h-3" />Inactif
                            </Badge>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-center">
                          <span className={`font-semibold ${link.usedCount > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {link.usedCount}
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-center">
                          <span className={`font-semibold ${link.validatedCount > 0 ? 'text-green-500' : 'text-muted-foreground'}`}>
                            {link.validatedCount}
                          </span>
                        </td>
                        <td className="py-3 text-muted-foreground text-xs">
                          {formatDate(link.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="md:hidden space-y-3">
                {data.links.map((link) => (
                  <div key={link.id} className="border rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="font-medium text-sm">
                        {link.firstName && link.lastName
                          ? `${link.firstName} ${link.lastName}`
                          : `Compte #${link.accountId}`}
                      </div>
                      {link.isActive ? (
                        <Badge variant="secondary" className="text-xs text-green-500 border-green-500/30 bg-green-500/10">Actif</Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">Inactif</Badge>
                      )}
                    </div>
                    {link.email && <div className="text-xs text-muted-foreground">{link.email}</div>}
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs bg-muted px-2 py-0.5 rounded">{link.code}</code>
                      <span className="text-xs text-muted-foreground">· créé le {formatDate(link.createdAt)}</span>
                    </div>
                    <div className="flex gap-4 text-xs text-muted-foreground">
                      <span>Utilisé : <strong className="text-foreground">{link.usedCount}</strong></span>
                      <span>Validé : <strong className="text-green-500">{link.validatedCount}</strong></span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              {(data.pagination.page > 1 || data.pagination.hasMore) && (
                <div className="flex items-center justify-between pt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Précédent
                  </Button>
                  <span className="text-sm text-muted-foreground">Page {page}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!data.pagination.hasMore}
                  >
                    Suivant
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
