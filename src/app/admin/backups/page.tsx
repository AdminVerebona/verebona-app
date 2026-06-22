"use client"

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { 
  Database, 
  RefreshCw, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle,
  Clock,
  HardDrive,
  Play,
  FileJson,
  FileCode
} from 'lucide-react';
import { toast } from 'sonner';

interface Backup {
  key: string;
  filename: string;
  size: number;
  lastModified: string;
  date: string;
  type: 'database' | 'code';
}

interface BackupsData {
  status: 'ok' | 'warning' | 'error';
  lastBackupDate: string | null;
  hoursSinceLastBackup: number | null;
  backups: Backup[];
  totalBackups: number;
}

export default function AdminBackupsPage() {
  const [data, setData] = useState<BackupsData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingBackup, setIsCreatingBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBackups();
  }, []);

  const loadBackups = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const token = localStorage.getItem('bearer_token');
      if (!token) {
        setError('Non authentifié');
        return;
      }

      const response = await fetch('/api/admin/backups', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Erreur lors du chargement');
      }

      const backupsData = await response.json();
      setData(backupsData);
    } catch (err) {
      console.error('Error loading backups:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateBackup = async () => {
    try {
      setIsCreatingBackup(true);

      const token = localStorage.getItem('bearer_token');
      if (!token) return;

      const response = await fetch('/api/admin/backups', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Erreur lors de la création');
      }

        const result = await response.json();
        toast.success(`Backup créé avec succès ! DB (${result.database.totalRows} lignes) et Code sauvegardés.`);
        loadBackups();

    } catch (err) {
      console.error('Error creating backup:', err);
      toast.error(err instanceof Error ? err.message : 'Erreur lors de la création du backup');
    } finally {
      setIsCreatingBackup(false);
    }
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'ok':
        return <CheckCircle2 className="h-8 w-8 text-green-500" />;
      case 'warning':
        return <AlertTriangle className="h-8 w-8 text-yellow-500" />;
      case 'error':
        return <XCircle className="h-8 w-8 text-red-500" />;
      default:
        return <Clock className="h-8 w-8 text-muted-foreground" />;
    }
  };

  const getStatusText = (status: string, hours: number | null) => {
    if (hours === null) return 'Aucun backup trouvé';
    if (status === 'ok') return `Dernier backup il y a ${hours}h - Tout est en ordre`;
    if (status === 'warning') return `Dernier backup il y a ${hours}h - Attention`;
    return `Dernier backup il y a ${hours}h - Critique !`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'ok':
        return <Badge className="bg-green-500/20 text-green-500 border-green-500/30">Opérationnel</Badge>;
      case 'warning':
        return <Badge className="bg-yellow-500/20 text-yellow-500 border-yellow-500/30">Attention</Badge>;
      case 'error':
        return <Badge className="bg-red-500/20 text-red-500 border-red-500/30">Critique</Badge>;
      default:
        return <Badge variant="outline">Inconnu</Badge>;
    }
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <p className="text-center text-destructive">{error}</p>
            <Button onClick={loadBackups} className="w-full mt-4">
              Réessayer
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Backups Database</h1>
          <p className="text-muted-foreground mt-1">
            Surveillance et gestion des sauvegardes automatiques
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={loadBackups} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Actualiser
          </Button>
          <Button onClick={handleCreateBackup} disabled={isCreatingBackup}>
            <Play className={`h-4 w-4 mr-2 ${isCreatingBackup ? 'animate-pulse' : ''}`} />
            {isCreatingBackup ? 'Backup en cours...' : 'Lancer un backup'}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
      ) : data ? (
        <>
          <Card className={`border-2 ${
            data.status === 'ok' ? 'border-green-500/30 bg-green-500/5' :
            data.status === 'warning' ? 'border-yellow-500/30 bg-yellow-500/5' :
            'border-red-500/30 bg-red-500/5'
          }`}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-6">
                {getStatusIcon(data.status)}
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h2 className="text-xl font-semibold">État du système de backup</h2>
                    {getStatusBadge(data.status)}
                  </div>
                  <p className="text-muted-foreground">
                    {getStatusText(data.status, data.hoursSinceLastBackup)}
                  </p>
                  {data.lastBackupDate && (
                    <p className="text-sm text-muted-foreground mt-1">
                      Dernier backup : {formatDate(data.lastBackupDate)}
                    </p>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-2xl md:text-3xl font-bold">{data.totalBackups}</div>
                  <div className="text-sm text-muted-foreground">backups stockés</div>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Backups totaux</CardTitle>
                <Database className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data.totalBackups}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  Sur OVH S3
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Dernière sauvegarde</CardTitle>
                <Clock className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {data.hoursSinceLastBackup !== null ? `${data.hoursSinceLastBackup}h` : 'N/A'}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  heures écoulées
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Stockage utilisé</CardTitle>
                <HardDrive className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatFileSize(data.backups.reduce((acc, b) => acc + b.size, 0))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  total des backups
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileJson className="h-5 w-5" />
                Historique des backups
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.backups.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  Aucun backup trouvé
                </div>
              ) : (
                <div className="space-y-2">
                  {data.backups.slice(0, 30).map((backup, index) => (
                    <div
                      key={backup.key}
                      className={`flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-lg border gap-2 ${
                        index === 0 ? 'bg-green-500/5 border-green-500/20' : ''
                      }`}
                    >
                        <div className="flex items-center gap-3 min-w-0">
                          {backup.type === 'code' ? (
                            <FileCode className={`h-5 w-5 flex-shrink-0 ${index === 0 ? 'text-blue-500' : 'text-muted-foreground'}`} />
                          ) : (
                            <FileJson className={`h-5 w-5 flex-shrink-0 ${index === 0 ? 'text-green-500' : 'text-muted-foreground'}`} />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium text-sm truncate">{backup.filename}</div>
                            <div className="text-xs text-muted-foreground">
                              {formatDate(backup.lastModified)}
                            </div>
                          </div>
                        </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className="text-sm text-muted-foreground">
                          {formatFileSize(backup.size)}
                        </span>
                        {index === 0 && (
                          <Badge className="bg-green-500/20 text-green-500 border-green-500/30">
                            Plus récent
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                  {data.backups.length > 30 && (
                    <p className="text-sm text-muted-foreground text-center pt-4">
                      ... et {data.backups.length - 30} backups plus anciens
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
