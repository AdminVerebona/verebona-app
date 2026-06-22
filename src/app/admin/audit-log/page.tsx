"use client"

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
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
import { ChevronLeft, ChevronRight, FileText, Filter, Download } from 'lucide-react';
import { toast } from 'sonner';

interface AuditLog {
  id: number;
  timestamp: string;
  adminUserId: number;
  adminEmail: string;
  actionType: string;
  targetType: string;
  targetId: number | null;
  details: string | null;
  admin: {
    email: string;
    firstName: string;
    lastName: string;
  } | null;
}

interface UserActivityLog {
  id: number;
  timestamp: string;
  userId: number | null;
  userEmail: string;
  activityType: string;
  ipAddress: string | null;
  userAgent: string | null;
  details: string | null;
  createdAt: string;
  user: {
    id: number;
    firstName: string;
    lastName: string;
    status: string;
  } | null;
}

type CombinedLog = {
  id: string;
  timestamp: string;
  type: 'ADMIN' | 'USER';
  userEmail: string;
  actionType?: string;
  activityType?: string;
  details: string | null;
  adminEmail?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  targetType?: string;
  targetId?: number | null;
  user?: {
    id?: number;
    firstName?: string;
    lastName?: string;
    status?: string;
  } | null;
};

export default function AdminAuditLogPage() {
  const [adminLogs, setAdminLogs] = useState<AuditLog[]>([]);
  const [userActivityLogs, setUserActivityLogs] = useState<UserActivityLog[]>([]);
  const [combinedLogs, setCombinedLogs] = useState<CombinedLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  
  // Filters
  const [logTypeFilter, setLogTypeFilter] = useState<string>('all');
  const [actionTypeFilter, setActionTypeFilter] = useState<string>('all');
  const [activityTypeFilter, setActivityTypeFilter] = useState<string>('all');
  const [targetTypeFilter, setTargetTypeFilter] = useState<string>('all');
  const [userIdFilter, setUserIdFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const limit = 50;

  useEffect(() => {
    loadLogs();
  }, [actionTypeFilter, activityTypeFilter, targetTypeFilter, userIdFilter, startDate, endDate, page]);

  const loadLogs = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        setError('Non authentifié');
        return;
      }

      // Build query params for admin logs
      const adminParams = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
      });
      if (actionTypeFilter && actionTypeFilter !== 'all') adminParams.append('actionType', actionTypeFilter);
      if (targetTypeFilter && targetTypeFilter !== 'all') adminParams.append('targetType', targetTypeFilter);
      if (startDate) adminParams.append('startDate', new Date(startDate).toISOString());
      if (endDate) adminParams.append('endDate', new Date(endDate).toISOString());

      // Build query params for user activity logs
      const userParams = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
      });
      if (activityTypeFilter && activityTypeFilter !== 'all') userParams.append('activityType', activityTypeFilter);
      if (userIdFilter) userParams.append('userId', userIdFilter);
      if (startDate) userParams.append('startDate', new Date(startDate).toISOString());
      if (endDate) userParams.append('endDate', new Date(endDate).toISOString());

      // Fetch both logs in parallel
      const [adminResponse, userActivityResponse] = await Promise.all([
        fetch(`/api/admin/audit-log?${adminParams.toString()}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }),
        fetch(`/api/admin/user-activity-log?${userParams.toString()}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }),
      ]);

      if (!adminResponse.ok || !userActivityResponse.ok) {
        throw new Error('Erreur lors du chargement du journal');
      }

      const adminData = await adminResponse.json();
      const userActivityData = await userActivityResponse.json();
      
      setAdminLogs(adminData);
      setUserActivityLogs(userActivityData.data || []);

      // Combine and sort logs
      const combined: CombinedLog[] = [
        ...adminData.map((log: AuditLog) => ({
          id: `admin-${log.id}`,
          timestamp: log.timestamp,
          type: 'ADMIN' as const,
          userEmail: log.admin?.email || log.adminEmail,
          actionType: log.actionType,
          details: log.details,
          adminEmail: log.adminEmail,
          targetType: log.targetType,
          targetId: log.targetId,
          user: log.admin ? {
            firstName: log.admin.firstName,
            lastName: log.admin.lastName,
          } : null,
        })),
        ...userActivityLogs.map((log: UserActivityLog) => ({
          id: `user-${log.id}`,
          timestamp: log.timestamp,
          type: 'USER' as const,
          userEmail: log.userEmail,
          activityType: log.activityType,
          details: log.details,
          ipAddress: log.ipAddress,
          userAgent: log.userAgent,
          user: log.user,
        })),
      ];

      // Sort by timestamp descending
      combined.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      // Apply log type filter
      let filteredLogs = combined;
      if (logTypeFilter !== 'all') {
        filteredLogs = combined.filter(log => log.type === logTypeFilter);
      }

      setCombinedLogs(filteredLogs);
    } catch (err) {
      console.error('Error loading audit logs:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearFilters = () => {
    setLogTypeFilter('all');
    setActionTypeFilter('all');
    setActivityTypeFilter('all');
    setTargetTypeFilter('all');
    setUserIdFilter('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  };

  const handleExportCSV = async () => {
    try {
      setIsExporting(true);
      const token = localStorage.getItem('bearer_token');
      if (!token) {
        toast.error('Non authentifié');
        return;
      }

      // Build query params
      const params = new URLSearchParams();
      if (actionTypeFilter && actionTypeFilter !== 'all') params.append('actionType', actionTypeFilter);
      if (activityTypeFilter && activityTypeFilter !== 'all') params.append('activityType', activityTypeFilter);
      if (userIdFilter) params.append('userId', userIdFilter);
      if (startDate) params.append('startDate', new Date(startDate).toISOString());
      if (endDate) params.append('endDate', new Date(endDate).toISOString());

      const response = await fetch(`/api/admin/audit-log/export?${params.toString()}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors de l\'export');
      }

      // Get filename from Content-Disposition header or use default
      const contentDisposition = response.headers.get('Content-Disposition');
      const filenameMatch = contentDisposition?.match(/filename="(.+)"/);
      const filename = filenameMatch ? filenameMatch[1] : `audit-log-export-${new Date().toISOString()}.csv`;

      // Download the CSV file
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast.success('Export CSV réussi');
    } catch (err) {
      console.error('Error exporting CSV:', err);
      toast.error(err instanceof Error ? err.message : 'Erreur lors de l\'export');
    } finally {
      setIsExporting(false);
    }
  };

  const formatDateTime = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getActionTypeLabel = (actionType: string) => {
    const labels: Record<string, string> = {
      'USER_SUSPEND': 'Suspension utilisateur',
      'USER_REACTIVATE': 'Réactivation utilisateur',
      'ASSET_DELETE': 'Suppression bien',
      'TEMPLATE_UPDATE': 'Modification template',
      'ASSET_TYPE_UPDATE': 'Modification type bien',
      'PASSWORD_RESET_SENT': 'Reset mot de passe',
      'USER_CREATE': 'Création utilisateur',
      'USER_UPDATE': 'Modification utilisateur',
      'USER_DELETE': 'Suppression utilisateur',
      'FILE_DELETE': 'Suppression fichier',
    };
    return labels[actionType] || actionType;
  };

  const getActivityTypeLabel = (activityType: string) => {
    const labels: Record<string, string> = {
      'LOGIN_SUCCESS': 'Connexion réussie',
      'LOGIN_FAILED': 'Tentative de connexion échouée',
      'EMAIL_CHANGE': 'Changement d\'e-mail',
      'PROFILE_UPDATE': 'Mise à jour profil',
      'PASSWORD_CHANGE': 'Changement mot de passe',
      'SERVER_ERROR': 'Erreur serveur',
    };
    return labels[activityType] || activityType;
  };

  const getLogTypeBadgeVariant = (type: string): any => {
    return type === 'ADMIN' ? 'default' : 'secondary';
  };

  const getActionTypeBadgeVariant = (actionType: string): any => {
    const variants: Record<string, any> = {
      'USER_SUSPEND': 'destructive',
      'USER_REACTIVATE': 'default',
      'ASSET_DELETE': 'destructive',
      'FILE_DELETE': 'destructive',
      'USER_DELETE': 'destructive',
      'TEMPLATE_UPDATE': 'secondary',
      'ASSET_TYPE_UPDATE': 'secondary',
      'PASSWORD_RESET_SENT': 'outline',
    };
    return variants[actionType] || 'outline';
  };

  const getActivityTypeBadgeVariant = (activityType: string): any => {
    const variants: Record<string, any> = {
      'LOGIN_SUCCESS': 'default',
      'LOGIN_FAILED': 'destructive',
      'EMAIL_CHANGE': 'secondary',
      'PROFILE_UPDATE': 'outline',
      'PASSWORD_CHANGE': 'secondary',
      'SERVER_ERROR': 'destructive',
    };
    return variants[activityType] || 'outline';
  };

  const parseDetails = (details: string | null) => {
    if (!details) return null;
    try {
      return JSON.parse(details);
    } catch {
      return details;
    }
  };

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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Journal d'audit</h1>
          <p className="text-muted-foreground mt-1">
            Historique complet de toutes les actions administratives et activités utilisateurs
          </p>
        </div>
        <Button
          onClick={handleExportCSV}
          disabled={isExporting}
          className="gap-2"
        >
          <Download className="w-4 h-4" />
          {isExporting ? 'Export en cours...' : 'Exporter en CSV'}
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Filter className="w-5 h-5" />
              Filtres
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearFilters}
            >
              Réinitialiser
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="text-sm font-medium mb-2 block">Type de journal</label>
              <Select value={logTypeFilter} onValueChange={setLogTypeFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Tous les types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les types</SelectItem>
                  <SelectItem value="ADMIN">Actions admin</SelectItem>
                  <SelectItem value="USER">Activités utilisateur</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Action admin</label>
              <Select value={actionTypeFilter} onValueChange={setActionTypeFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Toutes les actions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toutes les actions</SelectItem>
                  <SelectItem value="USER_SUSPEND">Suspension utilisateur</SelectItem>
                  <SelectItem value="USER_REACTIVATE">Réactivation utilisateur</SelectItem>
                  <SelectItem value="ASSET_DELETE">Suppression bien</SelectItem>
                  <SelectItem value="FILE_DELETE">Suppression fichier</SelectItem>
                  <SelectItem value="TEMPLATE_UPDATE">Modif. template</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Activité utilisateur</label>
              <Select value={activityTypeFilter} onValueChange={setActivityTypeFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Toutes les activités" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toutes les activités</SelectItem>
                  <SelectItem value="LOGIN_SUCCESS">Connexion réussie</SelectItem>
                  <SelectItem value="LOGIN_FAILED">Tentative échouée</SelectItem>
                  <SelectItem value="EMAIL_CHANGE">Changement e-mail</SelectItem>
                  <SelectItem value="PROFILE_UPDATE">Mise à jour profil</SelectItem>
                  <SelectItem value="PASSWORD_CHANGE">Changement mot de passe</SelectItem>
                  <SelectItem value="SERVER_ERROR">Erreur serveur</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">Type de cible</label>
              <Select value={targetTypeFilter} onValueChange={setTargetTypeFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Tous les types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous les types</SelectItem>
                  <SelectItem value="USER">Utilisateur</SelectItem>
                  <SelectItem value="ASSET">Bien</SelectItem>
                  <SelectItem value="EMAIL_TEMPLATE">Template Email</SelectItem>
                  <SelectItem value="ASSET_TYPE">Type de bien</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-sm font-medium mb-2 block">ID Utilisateur</label>
              <Input
                type="number"
                placeholder="Filtrer par utilisateur"
                value={userIdFilter}
                onChange={(e) => setUserIdFilter(e.target.value)}
              />
            </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Date de début</label>
                <DatePicker
                  value={startDate}
                  onChange={(d) => setStartDate(d)}
                />
              </div>

              <div>
                <label className="text-sm font-medium mb-2 block">Date de fin</label>
                <DatePicker
                  value={endDate}
                  onChange={(d) => setEndDate(d)}
                />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Logs Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Événements ({combinedLogs.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[...Array(10)].map((_, i) => (
                <Skeleton key={i} className="h-24" />
              ))}
            </div>
          ) : combinedLogs.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Aucun événement trouvé
            </div>
          ) : (
            <div className="space-y-3">
              {combinedLogs.map((log) => {
                const details = parseDetails(log.details);
                
                return (
                  <div
                    key={log.id}
                    className="p-4 rounded-lg border hover:bg-accent transition-colors"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                      <div className="flex-1 min-w-0 space-y-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant={getLogTypeBadgeVariant(log.type)}>
                            {log.type === 'ADMIN' ? 'Action Admin' : 'Activité Utilisateur'}
                          </Badge>
                          
                          {log.actionType && (
                            <Badge variant={getActionTypeBadgeVariant(log.actionType)}>
                              {getActionTypeLabel(log.actionType)}
                            </Badge>
                          )}
                          
                          {log.activityType && (
                            <Badge variant={getActivityTypeBadgeVariant(log.activityType)}>
                              {getActivityTypeLabel(log.activityType)}
                            </Badge>
                          )}
                          
                          {log.targetType && log.targetId && (
                            <Badge variant="outline">
                              {log.targetType} #{log.targetId}
                            </Badge>
                          )}
                          
                          <span className="text-sm text-muted-foreground">
                            {log.type === 'ADMIN' ? (
                              <>par {log.user?.firstName} {log.user?.lastName} ({log.userEmail})</>
                            ) : (
                              <>
                                {log.userEmail}
                                {log.user && ` (${log.user.firstName} ${log.user.lastName})`}
                              </>
                            )}
                          </span>
                        </div>

                        {log.ipAddress && (
                          <div className="text-sm text-muted-foreground">
                            IP: {log.ipAddress}
                          </div>
                        )}

                        {details && typeof details === 'object' && (
                          <div className="bg-muted p-3 rounded text-sm">
                            <div className="font-medium mb-1">Détails:</div>
                            <pre className="text-xs overflow-x-auto">
                              {JSON.stringify(details, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>

                      <div className="text-xs text-muted-foreground flex-shrink-0 sm:text-right">
                        {formatDateTime(log.timestamp)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pagination */}
          {!isLoading && combinedLogs.length > 0 && (
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
                disabled={combinedLogs.length < limit}
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
