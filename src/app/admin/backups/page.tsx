"use client"

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Database, Loader2, RefreshCw, Play, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { toast } from 'sonner';

/**
 * Sauvegardes de la base — page liée depuis le menu d'administration, qui
 * n'existait pas (lien mort). Elle montre les sauvegardes réellement
 * présentes dans le stockage et permet d'en lancer une.
 */

interface BackupItem {
  key: string;
  date: string;
  sizeBytes: number | null;
  totalRows: number | null;
  tables: number | null;
  durationMs: number | null;
  trigger: string | null;
}

interface BackupsResponse {
  backups: BackupItem[];
  status: 'ok' | 'warning' | 'error';
  hoursSinceLastBackup: number | null;
  config: {
    schedulerEnabled: boolean;
    storageConfigured: boolean;
    retentionDays: number;
    bucket: string;
  };
}

const DECLENCHEURS: Record<string, string> = {
  scheduler: 'Automatique',
  cron: 'Tâche planifiée',
  admin: 'Manuel',
};

function taille(octets: number | null): string {
  if (octets == null) return '—';
  if (octets < 1024 * 1024) return `${Math.max(1, Math.round(octets / 1024))} Ko`;
  return `${(octets / (1024 * 1024)).toFixed(1)} Mo`;
}

function dateFr(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function AdminBackupsPage() {
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/backups', { credentials: 'include', cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || 'Chargement impossible');
      setData(body as BackupsResponse);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const lancer = async () => {
    setRunning(true);
    try {
      const res = await fetch('/api/admin/backups', { method: 'POST', credentials: 'include' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || 'Sauvegarde impossible');
      toast.success(`Sauvegarde terminée : ${body.manifest?.totalRows ?? '?'} lignes`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const statut = data?.status;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Database className="h-6 w-6" /> Sauvegardes
          </h1>
          <p className="text-sm text-muted-foreground">
            Sauvegarde automatique de la base chaque nuit, entre 1 h et 5 h (heure de Paris).
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-2" /> Actualiser
          </Button>
          <Button onClick={lancer} disabled={running || !data?.config.storageConfigured}>
            {running ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            {running ? 'Sauvegarde en cours…' : 'Sauvegarder maintenant'}
          </Button>
        </div>
      </div>

      {error && (
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="py-4 text-sm text-red-500">{error}</CardContent>
        </Card>
      )}

      {loading && !data ? (
        <Skeleton className="h-40 w-full" />
      ) : data && (
        <>
          <Card className={
            statut === 'ok' ? 'border-green-500/30 bg-green-500/5'
            : statut === 'warning' ? 'border-yellow-500/30 bg-yellow-500/5'
            : 'border-red-500/30 bg-red-500/5'
          }>
            <CardContent className="py-4 flex items-start gap-3">
              {statut === 'ok' ? <CheckCircle className="h-5 w-5 text-green-500 mt-0.5" />
                : statut === 'warning' ? <AlertTriangle className="h-5 w-5 text-yellow-500 mt-0.5" />
                : <XCircle className="h-5 w-5 text-red-500 mt-0.5" />}
              <div className="text-sm space-y-1">
                <p className="font-medium">
                  {data.hoursSinceLastBackup === null
                    ? 'Aucune sauvegarde trouvée'
                    : `Dernière sauvegarde il y a ${data.hoursSinceLastBackup} h`}
                </p>
                <p className="text-muted-foreground">
                  Planification : {data.config.schedulerEnabled ? 'active' : 'désactivée (BACKUP_DISABLED)'} ·
                  Stockage : {data.config.storageConfigured ? data.config.bucket : 'identifiants absents'} ·
                  Rétention : {data.config.retentionDays} jours
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Sauvegardes disponibles ({data.backups.length})</CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {data.backups.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucune sauvegarde pour le moment.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Déclenchement</TableHead>
                      <TableHead className="text-right">Tables</TableHead>
                      <TableHead className="text-right">Lignes</TableHead>
                      <TableHead className="text-right">Taille</TableHead>
                      <TableHead className="text-right">Durée</TableHead>
                      <TableHead>Fichier</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.backups.map((b) => (
                      <TableRow key={b.key}>
                        <TableCell className="whitespace-nowrap">{dateFr(b.date)}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{DECLENCHEURS[b.trigger ?? ''] ?? '—'}</Badge>
                        </TableCell>
                        <TableCell className="text-right">{b.tables ?? '—'}</TableCell>
                        <TableCell className="text-right">{b.totalRows?.toLocaleString('fr-FR') ?? '—'}</TableCell>
                        <TableCell className="text-right">{taille(b.sizeBytes)}</TableCell>
                        <TableCell className="text-right">
                          {b.durationMs != null ? `${Math.round(b.durationMs / 1000)} s` : '—'}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{b.key}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
