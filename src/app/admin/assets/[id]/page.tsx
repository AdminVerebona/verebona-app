"use client"

import React, { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Package,
  User,
  Calendar,
  FileText,
  Trash2,
  AlertTriangle,
  Clock,
  Send,
  CheckCircle,
  XCircle,
  Ban,
  History,
  RefreshCw,
} from 'lucide-react';

const ASSET_STATUSES = [
  { value: 'EN_SERVICE',    label: 'En service' },
  { value: 'EN_PANNE',      label: 'En panne' },
  { value: 'EN_REPARATION', label: 'En réparation' },
  { value: 'INACTIF',       label: 'Inactif' },
  { value: 'VENDU',         label: 'Vendu' },
  { value: 'DETRUIT',       label: 'Détruit' },
  { value: 'ARCHIVED',      label: 'Archivé' },
  { value: 'TRANSMIS',      label: 'Transmis' },
];

interface TransmissionRecord {
  id: number;
  status: string;
  recipientEmail: string;
  keepActiveAfter: boolean;
  sentAt: string | null;
  acceptedAt: string | null;
  refusedAt: string | null;
  cancelledAt: string | null;
  duplicatedAssetId: number | null;
}

interface AssetDetails {
  id: number;
  userId: number;
  accountId: number | null;
  category: string;
  categoryLabel: string;
  subtype: string | null;
  name: string;
  status: string;
  archivedReason: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  transmissions: TransmissionRecord[];
  owner: {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
  };
}

interface AssetStats {
  documentsCount: number;
  eventsCount: number;
  deadlinesCount: number;
}

interface AssetData {
  asset: AssetDetails;
  stats: AssetStats;
}

export default function AdminAssetDetailPage() {
  const params = useParams();
  const router = useRouter();
  const assetId = params.id as string;

  const [data, setData] = useState<AssetData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [confirmIdInput, setConfirmIdInput] = useState('');
  const [statusLoading, setStatusLoading] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  

  useEffect(() => {
    loadAssetData();
  }, [assetId]);

  const loadAssetData = async () => {
    try {
      setIsLoading(true);
      setError(null);


      const response = await fetch(`/api/admin/assets/${assetId}`, {
      credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Session expirée ou permissions insuffisantes. Veuillez vous reconnecter.');
        }
        if (response.status === 404) {
          throw new Error('Bien introuvable.');
        }
        throw new Error('Erreur lors du chargement du bien');
      }

      const assetData = await response.json();
      setData(assetData);
      setSelectedStatus(assetData.asset.status);
    } catch (err) {
      console.error('Error loading asset:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleStatusChange = async () => {
    if (!selectedStatus || selectedStatus === data?.asset.status) return;

    try {
      setStatusLoading(true);
      const response = await fetch(`/api/admin/assets/${assetId}`, {
      credentials: 'include',
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: selectedStatus }),
      });

      if (!response.ok) throw new Error('Erreur lors de la mise à jour');

      toast.success(`Statut mis à jour : ${ASSET_STATUSES.find(s => s.value === selectedStatus)?.label}`);
      await loadAssetData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setStatusLoading(false);
    }
  };

  const handleDelete = async () => {
    if (confirmIdInput !== assetId) {
      toast.error('L\'ID saisi ne correspond pas');
      return;
    }

    try {
      setDeleteLoading(true);

      const response = await fetch(`/api/admin/assets/${assetId}`, {
      credentials: 'include',
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirmId: parseInt(assetId),
        }),
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la suppression');
      }

      const result = await response.json();
      
      toast.success(
        `Bien supprimé avec succès. ${result.cascadeDeleted.documents} documents, ${result.cascadeDeleted.events} événements et ${result.cascadeDeleted.deadlines} échéances ont été supprimés.`
      );
      
      // Redirect to assets list after 2 seconds
      setTimeout(() => {
        router.push('/admin/assets');
      }, 2000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
      setDeleteLoading(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Non défini';
    return new Date(dateStr).toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusBadge = (status: string) => {
    const map: Record<string, { label: string; className: string }> = {
      EN_SERVICE:    { label: 'En service',    className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
      EN_MAINTENANCE:{ label: 'Maintenance',   className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
      HORS_SERVICE:  { label: 'Hors service',  className: 'bg-orange-500/15 text-orange-400 border-orange-500/30' },
      VENDU:         { label: 'Vendu',         className: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
      DETRUIT:       { label: 'Détruit',       className: 'bg-red-500/15 text-red-400 border-red-500/30' },
      INACTIF:       { label: 'Inactif',       className: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
      ARCHIVED:      { label: 'Archivé',       className: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
      TRANSMIS:      { label: 'Transmis',      className: 'bg-violet-500/15 text-violet-400 border-violet-500/30' },
      EN_PANNE:      { label: 'En panne',      className: 'bg-red-500/15 text-red-400 border-red-500/30' },
      EN_REPARATION: { label: 'En réparation', className: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
    };
    const s = map[status] ?? { label: status, className: 'bg-muted text-muted-foreground border-border' };
    return <Badge variant="outline" className={`text-xs ${s.className}`}>{s.label}</Badge>;
  };

  const getTransmissionStatusBadge = (status: string) => {
    const map: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
      pending:   { label: 'En attente', icon: <Clock className="w-3 h-3" />,       className: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30' },
      accepted:  { label: 'Acceptée',   icon: <CheckCircle className="w-3 h-3" />, className: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
      refused:   { label: 'Refusée',    icon: <XCircle className="w-3 h-3" />,     className: 'bg-red-500/15 text-red-400 border-red-500/30' },
      cancelled: { label: 'Annulée',    icon: <Ban className="w-3 h-3" />,         className: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
    };
    const s = map[status] ?? { label: status, icon: null, className: 'bg-muted text-muted-foreground border-border' };
    return (
      <Badge variant="outline" className={`flex items-center gap-1 text-xs ${s.className}`}>
        {s.icon}{s.label}
      </Badge>
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Retour
        </Button>
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-destructive">
              {error || 'Bien non trouvé'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { asset, stats } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" onClick={() => router.back()}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Retour
          </Button>
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">{asset.name}</h1>
            <p className="text-muted-foreground">ID: {asset.id}</p>
          </div>
        </div>
        <Badge variant="outline" className="text-base">
          {asset.categoryLabel}
        </Badge>
      </div>

      {/* Status Management */}
      <Card className="border-primary/30">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5" />
            Changer le statut
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            En tant qu&apos;administrateur, vous pouvez modifier le statut de ce bien, y compris le remettre actif depuis &quot;Archivé&quot; ou &quot;Transmis&quot;.
          </p>
          <div className="flex items-center gap-3">
            <Select value={selectedStatus} onValueChange={setSelectedStatus}>
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Choisir un statut" />
              </SelectTrigger>
              <SelectContent>
                {ASSET_STATUSES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={handleStatusChange}
              disabled={statusLoading || selectedStatus === asset.status || !selectedStatus}
            >
              {statusLoading ? 'Mise à jour...' : 'Appliquer'}
            </Button>
            {selectedStatus !== asset.status && selectedStatus && (
              <span className="text-xs text-muted-foreground">
                {asset.status} → {selectedStatus}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="w-5 h-5" />
            Zone dangereuse
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            La suppression de ce bien est irréversible. Tous les documents, événements
            et échéances associés seront également supprimés.
          </p>
          <Button
            variant="destructive"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Supprimer définitivement
          </Button>
        </CardContent>
      </Card>

      {/* Asset Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Informations administratives</span>
            {getStatusBadge(asset.status)}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 grid-cols-1 sm:grid-cols-2">
          <div className="flex items-start gap-3">
            <Package className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">Catégorie</div>
              <div className="font-medium text-sm">
                {asset.categoryLabel}
                {asset.subtype && <span className="text-muted-foreground"> · {asset.subtype}</span>}
              </div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Calendar className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">Créé le</div>
              <div className="font-medium text-sm">{formatDate(asset.createdAt)}</div>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Clock className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">Dernière modification</div>
              <div className="font-medium text-sm">{formatDate(asset.updatedAt)}</div>
            </div>
          </div>
          {asset.archivedReason && (
            <div className="flex items-start gap-3">
              <History className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Raison d&apos;archivage</div>
                <div className="font-medium text-sm capitalize">{asset.archivedReason}</div>
              </div>
            </div>
          )}
          {asset.deletedAt && (
            <div className="flex items-start gap-3">
              <Trash2 className="h-4 w-4 text-destructive mt-0.5" />
              <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider">Supprimé le</div>
                <div className="font-medium text-sm text-destructive">{formatDate(asset.deletedAt)}</div>
              </div>
            </div>
          )}
          <div className="flex items-start gap-3">
            <FileText className="h-4 w-4 text-muted-foreground mt-0.5" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">ID interne</div>
              <div className="font-mono text-sm text-muted-foreground">#{asset.id}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Transmission History */}
      {asset.transmissions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Send className="w-4 h-4" />
              Historique des transmissions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {asset.transmissions.map((tx) => (
              <div key={tx.id} className="flex flex-col gap-1.5 p-3 rounded-lg border bg-muted/30 text-sm">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="font-medium">{tx.recipientEmail}</span>
                  {getTransmissionStatusBadge(tx.status)}
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground mt-1">
                  {tx.sentAt && (
                    <span>Envoyée : <span className="text-foreground">{formatDate(tx.sentAt)}</span></span>
                  )}
                  {tx.acceptedAt && (
                    <span>Acceptée : <span className="text-emerald-500">{formatDate(tx.acceptedAt)}</span></span>
                  )}
                  {tx.refusedAt && (
                    <span>Refusée : <span className="text-red-400">{formatDate(tx.refusedAt)}</span></span>
                  )}
                  {tx.cancelledAt && (
                    <span>Annulée : <span className="text-muted-foreground">{formatDate(tx.cancelledAt)}</span></span>
                  )}
                  {tx.duplicatedAssetId && (
                    <span>Bien dupliqué : <span className="text-foreground font-mono">#{tx.duplicatedAssetId}</span></span>
                  )}
                  <span>Bien conservé actif : <span className="text-foreground">{tx.keepActiveAfter ? 'Oui' : 'Non'}</span></span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Owner Info */}
      <Card>
        <CardHeader>
          <CardTitle>Propriétaire</CardTitle>
        </CardHeader>
        <CardContent>
          <Link
            href={`/admin/users/${asset.owner.id}`}
            className="flex items-center gap-3 p-3 rounded-lg border hover:bg-accent transition-colors"
          >
            <User className="h-8 w-8 text-muted-foreground" />
            <div>
              <div className="font-medium">
                {asset.owner.firstName} {asset.owner.lastName}
              </div>
              <div className="text-sm text-muted-foreground">
                {asset.owner.email}
              </div>
            </div>
          </Link>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Documents</p>
                <p className="text-2xl font-bold">{stats.documentsCount}</p>
              </div>
              <FileText className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Événements</p>
                <p className="text-2xl font-bold">{stats.eventsCount}</p>
              </div>
              <Calendar className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Mes échéances</p>
                <p className="text-2xl font-bold">{stats.deadlinesCount}</p>
              </div>
              <Calendar className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              Confirmer la suppression
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-4">
              <p>
                Vous êtes sur le point de supprimer définitivement le bien <strong>{asset.name}</strong>.
              </p>
              <p>
                Cette action supprimera également:
              </p>
              <ul className="list-disc list-inside space-y-1 text-sm">
                <li>{stats.documentsCount} document(s)</li>
                <li>{stats.eventsCount} événement(s)</li>
                <li>{stats.deadlinesCount} échéance(s)</li>
              </ul>
              <p className="font-semibold">
                Cette action est irréversible. Pour confirmer, veuillez saisir l'ID du bien: <strong>{asset.id}</strong>
              </p>
              <div>
                <Label htmlFor="confirmId">ID du bien</Label>
                <Input
                  id="confirmId"
                  type="text"
                  placeholder={`Saisissez ${asset.id}`}
                  value={confirmIdInput}
                  onChange={(e) => setConfirmIdInput(e.target.value)}
                  className="mt-2"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel 
              disabled={deleteLoading}
              onClick={() => setConfirmIdInput('')}
            >
              Annuler
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteLoading || confirmIdInput !== assetId}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteLoading ? 'Suppression...' : 'Supprimer définitivement'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}