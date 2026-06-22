"use client"

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Users, Package, UserCheck, TrendingUp, Clock, Building2, UserPlus, UsersRound, AlertCircle, Database, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';

interface BackupStatus {
  status: 'ok' | 'warning' | 'error';
  lastBackupDate: string | null;
  hoursSinceLastBackup: number | null;
}

interface LastUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: string;
}

interface AuditLog {
  id: number;
  timestamp: string;
  adminEmail: string;
  actionType: string;
  targetType: string;
  targetId: number | null;
}

interface DashboardStats {
  totalUsers: number;
  activeUsers: number;
  totalAssets: number;
  recentSignups: number;
  totalAccounts: number;
  premiumAccounts: number;
  standardAccounts: number;
  usersWithoutAccount: number;
  totalMemberships: number;
  activeMemberships: number;
  pendingMemberships: number;
  premiumAccountsWith2Users: number;
}

interface DashboardData {
  stats: DashboardStats;
  lastUsers: LastUser[];
  lastAuditLogs: AuditLog[];
  backupStatus?: BackupStatus;
}

export default function AdminDashboard() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDashboardData();
  }, []);

    const loadDashboardData = async () => {
      try {
        setIsLoading(true);
        setError(null);
  
        const dashboardData = await apiClient.get<DashboardData>('/api/admin/dashboard');
        setData(dashboardData);
      } catch (err) {
        console.error('Error loading dashboard:', err);
        setError(err instanceof Error ? err.message : 'Erreur inconnue');
      } finally {
        setIsLoading(false);
      }
    };


  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getActionTypeLabel = (actionType: string) => {
    const labels: Record<string, string> = {
      'USER_SUSPEND': 'Suspension utilisateur',
      'USER_REACTIVATE': 'Réactivation utilisateur',
      'ASSET_DELETE': 'Suppression bien',
      'TEMPLATE_UPDATE': 'Modif. template',
      'ASSET_TYPE_UPDATE': 'Modif. type bien',
      'PASSWORD_RESET_SENT': 'Reset mot de passe',
    };
    return labels[actionType] || actionType;
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-destructive">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl md:text-3xl font-bold">Dashboard Administration</h1>
        <p className="text-muted-foreground mt-1">
          Vue d'ensemble de la plateforme Verebona
        </p>
      </div>

      {/* Backup Status */}
      {data.backupStatus && (
        <Card className={`border-2 ${
          data.backupStatus.status === 'ok' ? 'border-green-500/30 bg-green-500/5' :
          data.backupStatus.status === 'warning' ? 'border-yellow-500/30 bg-yellow-500/5' :
          'border-red-500/30 bg-red-500/5'
        }`}>
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                {data.backupStatus.status === 'ok' ? (
                  <CheckCircle2 className="h-8 w-8 text-green-500 flex-shrink-0" />
                ) : data.backupStatus.status === 'warning' ? (
                  <AlertTriangle className="h-8 w-8 text-yellow-500 flex-shrink-0" />
                ) : (
                  <XCircle className="h-8 w-8 text-red-500 flex-shrink-0" />
                )}
                <div>
                  <h2 className="text-lg md:text-xl font-semibold">Sauvegardes automatiques</h2>
                  <p className="text-muted-foreground text-sm">
                    {data.backupStatus.status === 'ok'
                      ? `Dernier backup réussi il y a ${data.backupStatus.hoursSinceLastBackup}h`
                      : data.backupStatus.status === 'warning'
                        ? `Dernière sauvegarde il y a ${data.backupStatus.hoursSinceLastBackup}h - Attention`
                        : `Système critique : dernière sauvegarde il y a ${data.backupStatus.hoursSinceLastBackup}h`}
                  </p>
                </div>
              </div>
              <Link href="/admin/backups" className="flex-shrink-0">
                <Button variant="outline" size="sm">
                  <Database className="h-4 w-4 mr-2" />
                  Gérer les backups
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Cards */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Utilisateurs totaux
            </CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.stats.totalUsers}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Tous les utilisateurs
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Utilisateurs actifs
            </CardTitle>
            <UserCheck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-success">
              {data.stats.activeUsers}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Statut: ACTIVE
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Biens enregistrés
            </CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.stats.totalAssets}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Tous les biens
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Inscriptions récentes
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-primary">
              {data.stats.recentSignups}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Derniers 30 jours
            </p>
          </CardContent>
        </Card>
      </div>

              <div>
                <h2 className="text-lg md:text-xl font-semibold mb-4">Comptes et Utilisateurs</h2>
                <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
                <Card className="lg:col-span-1">
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-sm font-medium">
                      Comptes actifs
                    </CardTitle>
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl md:text-3xl font-bold">
                      {data.stats.totalAccounts}
                    </div>
                    <div className="flex gap-4 mt-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                        <span className="text-muted-foreground">Premium:</span>
                        <span className="font-semibold">{data.stats.premiumAccounts}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full bg-slate-400"></div>
                        <span className="text-muted-foreground">Standard:</span>
                        <span className="font-semibold">{data.stats.standardAccounts}</span>
                      </div>
                    </div>
                    <div className="mt-4 pt-4 border-t">
                      <Link href="/admin/accounts" className="text-xs text-primary hover:underline font-medium flex items-center gap-1">
                        Gérer les comptes →
                      </Link>
                    </div>
                  </CardContent>
                </Card>

                  <Card className="lg:col-span-1">
                    <CardHeader className="flex flex-row items-center justify-between pb-2">
                        <CardTitle className="text-sm font-medium">
                          Utilisateurs actifs
                        </CardTitle>
                        <UserPlus className="h-4 w-4 text-muted-foreground" />
                      </CardHeader>
                      <CardContent>
                        <div className="text-2xl md:text-3xl font-bold text-success">
                          {data.stats.activeMemberships}
                        </div>
                          <div className="flex gap-4 mt-2 text-xs">
                            <div className="flex items-center gap-1.5">
                              <div className="w-2 h-2 rounded-full bg-slate-400"></div>
                              <span className="text-muted-foreground">Total:</span>
                              <span className="font-semibold">{data.stats.totalMemberships}</span>
                            </div>
                            {data.stats.pendingMemberships > 0 && (
                              <div className="flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
                                <span className="text-muted-foreground">En attente:</span>
                                <span className="font-semibold">{data.stats.pendingMemberships}</span>
                              </div>
                            )}
                          </div>
                        <div className="mt-4 pt-4 border-t">
                          <Link href="/admin/memberships" className="text-xs text-primary hover:underline font-medium flex items-center gap-1">
                            Gérer les utilisateurs →
                          </Link>
                        </div>
                      </CardContent>
                  </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-sm font-medium">
                      Premium Duo actifs
                    </CardTitle>
                    <UsersRound className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-success">
                      {data.stats.premiumAccountsWith2Users}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Comptes Duo avec 2 membres actifs
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-sm font-medium">
                      Users sans compte
                    </CardTitle>
                    <AlertCircle className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold text-warning">
                      {data.stats.usersWithoutAccount}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Non propriétaires ni membres
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>

      {/* Recent Users */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Users className="w-5 h-5" />
              Derniers utilisateurs inscrits
            </span>
            <Link
              href="/admin/users"
              className="text-sm text-primary hover:underline font-normal"
            >
              Voir tous
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {data.lastUsers.map((user) => (
              <Link
                key={user.id}
                href={`/admin/users/${user.id}`}
                className="flex items-start sm:items-center justify-between p-3 rounded-lg border hover:bg-accent transition-colors gap-2"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {user.firstName} {user.lastName}
                  </div>
                  <div className="text-sm text-muted-foreground truncate">
                    {user.email}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground flex-shrink-0 mt-0.5 sm:mt-0">
                  {formatDate(user.createdAt)}
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Recent Audit Logs */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Clock className="w-5 h-5" />
              Dernières actions administratives
            </span>
            <Link
              href="/admin/audit-log"
              className="text-sm text-primary hover:underline font-normal"
            >
              Voir tout le journal
            </Link>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {data.lastAuditLogs.map((log) => (
              <div
                key={log.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-lg border gap-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {getActionTypeLabel(log.actionType)}
                    </Badge>
                    <span className="text-xs text-muted-foreground truncate">
                      par {log.adminEmail}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {log.targetType} #{log.targetId}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground flex-shrink-0">
                  {formatDate(log.timestamp)}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
