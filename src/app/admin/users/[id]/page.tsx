"use client"

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  ArrowLeft,
  User,
  Mail,
  Building,
  Building2,
  Calendar,
  Package,
  FileText,
  Ban,
  CheckCircle,
  MailIcon,
  Edit,
  Trash2,
  Save,
  X,
  LogOut,
  ExternalLink,
} from 'lucide-react';

interface UserDetailPageProps {
  params: { id: string };
}

interface UserDetails {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  username: string | null;
  company: string | null;
  planType: string;
  role: string;
  status: string;
  locale: string;
  createdAt: string;
  lastLoginAt: string | null;
  subscriptionTier: 'free' | 'premium' | 'pro';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  premiumUntil: number | null;
  proUntil: number | null;
}

interface Asset {
  id: number;
  name: string;
  category: string;
  createdAt: string;
}

interface UserStats {
  documentsCount: number;
  eventsCount: number;
  deadlinesCount: number;
}

interface SubscriptionHistoryEntry {
  id: number;
  oldTier: string | null;
  newTier: string;
  oldPremiumUntil: number | null;
  newPremiumUntil: number | null;
  oldProUntil: number | null;
  newProUntil: number | null;
  source: string;
  stripeEventId: string | null;
  createdAt: number;
}

interface LinkedAccount {
  id: number;
  name: string;
  planType: string;
}

interface UserData {
  user: UserDetails;
  account: LinkedAccount | null;
  assets: Asset[];
  stats: UserStats;
  subscriptionHistory: SubscriptionHistoryEntry[];
}

interface EditFormData {
  firstName: string;
  lastName: string;
  username: string;
  company: string;
  planType: string;
  role: string;
  status: string;
  locale: string;
}

export default function UserDetailPage({ params }: UserDetailPageProps) {
  const router = useRouter();
  const userId = params.id as string;

  const [data, setData] = useState<UserData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [showSubscriptionHistory, setShowSubscriptionHistory] = useState(false);
  const [isSyncingStripe, setIsSyncingStripe] = useState(false);

  // Dialog states
  const [suspendDialogOpen, setSuspendDialogOpen] = useState(false);
  const [reactivateDialogOpen, setReactivateDialogOpen] = useState(false);
  const [resetPasswordDialogOpen, setResetPasswordDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteUserDialogOpen, setDeleteUserDialogOpen] = useState(false);
  const [deleteAssetDialogOpen, setDeleteAssetDialogOpen] = useState(false);
  const [forceLogoutDialogOpen, setForceLogoutDialogOpen] = useState(false);
  const [assetToDelete, setAssetToDelete] = useState<Asset | null>(null);

  // Edit form state
  const [editForm, setEditForm] = useState<EditFormData>({
    firstName: '',
    lastName: '',
    username: '',
    company: '',
    planType: 'STANDARD',
    role: 'USER',
    status: 'ACTIVE',
    locale: 'fr',
  });

  useEffect(() => {
    loadUserData();
  }, [userId]);

  const loadUserData = async () => {
    try {
      setIsLoading(true);
      setError(null);


      const response = await fetch(`/api/admin/users/${userId}`, {
      credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors du chargement de l\'utilisateur');
      }

      const userData = await response.json();
      setData(userData);

      // Initialize edit form with user data
      if (userData.user) {
        setEditForm({
          firstName: userData.user.firstName || '',
          lastName: userData.user.lastName || '',
          username: userData.user.username || '',
          company: userData.user.company || '',
          planType: userData.user.planType || 'STANDARD',
          role: userData.user.role || 'USER',
          status: userData.user.status || 'ACTIVE',
          locale: userData.user.locale || 'fr',
        });
      }
    } catch (err) {
      console.error('Error loading user:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSuspend = async () => {
    try {
      setActionLoading(true);

      const response = await fetch(`/api/admin/users/${userId}/suspend`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Suspension via interface admin',
        }),
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la suspension');
      }

      toast.success('Utilisateur suspendu avec succès');
      setSuspendDialogOpen(false);
      loadUserData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReactivate = async () => {
    try {
      setActionLoading(true);

      const response = await fetch(`/api/admin/users/${userId}/reactivate`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la réactivation');
      }

      toast.success('Utilisateur réactivé avec succès');
      setReactivateDialogOpen(false);
      loadUserData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSendPasswordReset = async () => {
    try {
      setActionLoading(true);

      const response = await fetch(`/api/admin/users/${userId}/send-password-reset`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors de l\'envoi du reset password');
      }

      toast.success('Email de réinitialisation envoyé (simulé en V1)');
      setResetPasswordDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
    }
  };

  const handleForceLogout = async () => {
    try {
      setActionLoading(true);

      const response = await fetch(`/api/admin/users/${userId}/force-logout`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la déconnexion forcée');
      }

      const result = await response.json();
      toast.success(`${result.sessionsDeleted} session(s) supprimée(s)`);
      setForceLogoutDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditUser = async () => {
    try {
      setActionLoading(true);

      const response = await fetch(`/api/admin/users/${userId}`, {
      credentials: 'include',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(editForm),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la modification');
      }

      toast.success('Utilisateur modifié avec succès');
      setEditDialogOpen(false);
      loadUserData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async () => {
    try {
      setActionLoading(true);


      const response = await fetch(`/api/admin/users/${userId}`, {
      credentials: 'include',
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirmId: parseInt(userId),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la suppression');
      }

      toast.success('Compte supprimé définitivement');
      setDeleteUserDialogOpen(false);
      router.push('/admin/users');
    } catch (err) {
      console.error('Delete user error:', err);
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteAsset = async () => {
    if (!assetToDelete) return;

    try {
      setActionLoading(true);

      const response = await fetch(`/api/admin/assets/${assetToDelete.id}`, {
      credentials: 'include',
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          confirmId: assetToDelete.id,
        }),
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la suppression du bien');
      }

      const result = await response.json();
      toast.success(`Bien supprimé avec ${result.cascadeDeleted.documents} documents associés`);
      setDeleteAssetDialogOpen(false);
      setAssetToDelete(null);
      loadUserData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
    }
  };

  const openDeleteAssetDialog = (asset: Asset) => {
    setAssetToDelete(asset);
    setDeleteAssetDialogOpen(true);
  };

  const handleSyncStripe = async () => {
    try {
      setIsSyncingStripe(true);

      const response = await fetch(`/api/admin/users/${userId}/sync-stripe`, {
      credentials: 'include',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la synchronisation');
      }

      const result = await response.json();
      
      if (result.changes.tierChanged) {
        toast.success(`Abonnement synchronisé : ${result.changes.oldTier} → ${result.changes.newTier}`);
      } else {
        toast.success('Abonnement déjà à jour avec Stripe');
      }
      
      loadUserData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsSyncingStripe(false);
    }
  };

  const formatDate = (dateStr: string | number) => {
    const date = typeof dateStr === 'string' ? new Date(dateStr) : new Date(dateStr);
    return date.toLocaleDateString('fr-FR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
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

  if (error || !data || !data.user) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => router.push('/admin/users')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Retour
        </Button>
        <Card>
          <CardContent className="pt-6">
            <p className="text-center text-destructive">
              {error || 'Utilisateur non trouvé'}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const { user, account: linkedAccount, assets, stats } = data;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => router.push('/admin/users')}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Retour
          </Button>
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold truncate">
              {user.firstName} {user.lastName}
            </h1>
            <p className="text-muted-foreground text-sm truncate">{user.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {user.status === 'ACTIVE' ? (
            <Badge variant="active">Actif</Badge>
          ) : (
            <Badge variant="destructive">Suspendu</Badge>
          )}
          {user.role === 'ADMIN' && (
            <Badge variant="default">Admin</Badge>
          )}
        </div>
      </div>

      {/* User Info Card - Single card without subscription */}
      <Card>
        <CardHeader>
          <CardTitle>Informations utilisateur</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 grid-cols-1 sm:grid-cols-2">
          <div className="flex items-center gap-3">
            <User className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm text-muted-foreground">Nom complet</div>
              <div className="font-medium">{user.firstName} {user.lastName}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <User className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm text-muted-foreground">Nom d'utilisateur</div>
              <div className="font-medium">{user.username || 'Non défini'}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Mail className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm text-muted-foreground">Email</div>
              <div className="font-medium">{user.email}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Building className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm text-muted-foreground">Entreprise</div>
              <div className="font-medium">{user.company || 'Non définie'}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Package className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm text-muted-foreground">Plan</div>
              <div className="font-medium">{user.planType}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <User className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm text-muted-foreground">Rôle</div>
              <div className="font-medium">{user.role}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm text-muted-foreground">Inscription</div>
              <div className="font-medium">{formatDate(user.createdAt)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Calendar className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="text-sm text-muted-foreground">Dernière connexion</div>
              <div className="font-medium">
                {user.lastLoginAt ? formatDate(user.lastLoginAt) : 'Jamais'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Actions principales */}
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="default"
            onClick={() => setEditDialogOpen(true)}
          >
            <Edit className="h-4 w-4 mr-2" />
            Modifier
          </Button>

          {user.status === 'ACTIVE' ? (
            <Button
              variant="outline"
              onClick={() => setSuspendDialogOpen(true)}
              disabled={user.role === 'ADMIN'}
            >
              <Ban className="h-4 w-4 mr-2" />
              Suspendre
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => setReactivateDialogOpen(true)}
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              Réactiver
            </Button>
          )}

          <Button
            variant="outline"
            onClick={() => setResetPasswordDialogOpen(true)}
          >
            <MailIcon className="h-4 w-4 mr-2" />
            Reset password
          </Button>

          <Button
            variant="outline"
            onClick={() => setForceLogoutDialogOpen(true)}
          >
            <LogOut className="h-4 w-4 mr-2" />
            Forcer la déconnexion
          </Button>

          <Button
            variant="destructive"
            onClick={() => setDeleteUserDialogOpen(true)}
            disabled={user.role === 'ADMIN'}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Supprimer l'utilisateur
          </Button>
        </CardContent>
      </Card>

      {/* Compte rattaché */}
      {linkedAccount && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              Compte rattaché
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{linkedAccount.name}</p>
                <p className="text-sm text-muted-foreground">ID #{linkedAccount.id} · Plan {linkedAccount.planType}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => router.push(`/admin/accounts/${linkedAccount.id}`)}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Voir le compte
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Biens</p>
                <p className="text-2xl font-bold">{assets.length}</p>
              </div>
              <Building className="h-8 w-8 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
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
      </div>

      {/* Assets with management */}
      <Card>
        <CardHeader>
          <CardTitle>Biens ({assets.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {assets.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              Aucun bien enregistré
            </p>
          ) : (
            <div className="space-y-3">
              {assets.map((asset) => (
                <div
                  key={asset.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <Link
                    href={`/admin/assets/${asset.id}`}
                    className="flex-1 hover:text-primary transition-colors"
                  >
                    <div className="font-medium">{asset.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {asset.category} • Créé le {formatDate(asset.createdAt)}
                    </div>
                  </Link>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => router.push(`/admin/assets/${asset.id}`)}
                    >
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openDeleteAssetDialog(asset)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit User Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Modifier l'utilisateur</DialogTitle>
            <DialogDescription>
              Modifiez les informations de {user.firstName} {user.lastName}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">Prénom</Label>
                <Input
                  id="firstName"
                  value={editForm.firstName}
                  onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Nom</Label>
                <Input
                  id="lastName"
                  value={editForm.lastName}
                  onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Nom d'utilisateur</Label>
              <Input
                id="username"
                value={editForm.username}
                onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                placeholder="Optionnel"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="company">Entreprise</Label>
              <Input
                id="company"
                value={editForm.company}
                onChange={(e) => setEditForm({ ...editForm, company: e.target.value })}
                placeholder="Optionnel"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="planType">Plan</Label>
                <Select
                  value={editForm.planType}
                  onValueChange={(value) => setEditForm({ ...editForm, planType: value })}
                >
                  <SelectTrigger id="planType">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="STANDARD">Standard</SelectItem>
                    <SelectItem value="PREMIUM">Premium</SelectItem>
                    <SelectItem value="PREMIUM_DUO">Premium Duo</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="role">Rôle</Label>
                <Select
                  value={editForm.role}
                  onValueChange={(value) => setEditForm({ ...editForm, role: value })}
                >
                  <SelectTrigger id="role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">Utilisateur</SelectItem>
                    <SelectItem value="ADMIN">Super Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="status">Statut</Label>
                <Select
                  value={editForm.status}
                  onValueChange={(value) => setEditForm({ ...editForm, status: value })}
                >
                  <SelectTrigger id="status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ACTIVE">Actif</SelectItem>
                    <SelectItem value="SUSPENDED">Suspendu</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="locale">Langue</Label>
                <Select
                  value={editForm.locale}
                  onValueChange={(value) => setEditForm({ ...editForm, locale: value })}
                >
                  <SelectTrigger id="locale">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fr">Français</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditDialogOpen(false)}
              disabled={actionLoading}
            >
              <X className="h-4 w-4 mr-2" />
              Annuler
            </Button>
            <Button onClick={handleEditUser} disabled={actionLoading}>
              <Save className="h-4 w-4 mr-2" />
              {actionLoading ? 'Enregistrement...' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Dialog */}
      <AlertDialog open={deleteUserDialogOpen} onOpenChange={setDeleteUserDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer définitivement ce compte ?</AlertDialogTitle>
            <AlertDialogDescription>
              ⚠️ <strong>Cette action est irréversible.</strong><br /><br />
              Le compte de <strong>{user.firstName} {user.lastName}</strong> sera définitivement supprimé, ainsi que :
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>{assets.length} bien(s)</li>
                <li>{stats.documentsCount} document(s)</li>
                <li>{stats.eventsCount} événement(s)</li>
                <li>{stats.deadlinesCount} échéance(s)</li>
              </ul>
              <br />
              Cette action sera enregistrée dans le journal d'audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <Button
              onClick={(e) => {
                e.preventDefault();
                handleDeleteUser();
              }}
              disabled={actionLoading}
              className="bg-destructive hover:bg-destructive/90"
            >
              {actionLoading ? 'Suppression...' : 'Supprimer définitivement'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Asset Dialog */}
      <AlertDialog open={deleteAssetDialogOpen} onOpenChange={setDeleteAssetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer ce bien ?</AlertDialogTitle>
            <AlertDialogDescription>
              Le bien <strong>{assetToDelete?.name}</strong> sera définitivement supprimé avec tous ses documents, événements et échéances associés.
              <br /><br />
              Cette action est irréversible et sera enregistrée dans le journal d'audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAsset}
              disabled={actionLoading}
              className="bg-destructive hover:bg-destructive/90"
            >
              {actionLoading ? 'Suppression...' : 'Supprimer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Suspend Dialog */}
      <AlertDialog open={suspendDialogOpen} onOpenChange={setSuspendDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Suspendre cet utilisateur ?</AlertDialogTitle>
            <AlertDialogDescription>
              L'utilisateur {user.firstName} {user.lastName} sera suspendu et ne pourra plus
              accéder à la plateforme. Cette action sera enregistrée dans le journal d'audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSuspend}
              disabled={actionLoading}
              className="bg-destructive hover:bg-destructive/90"
            >
              {actionLoading ? 'Suspension...' : 'Suspendre'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reactivate Dialog */}
      <AlertDialog open={reactivateDialogOpen} onOpenChange={setReactivateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Réactiver cet utilisateur ?</AlertDialogTitle>
            <AlertDialogDescription>
              L'utilisateur {user.firstName} {user.lastName} pourra à nouveau accéder
              à la plateforme. Cette action sera enregistrée dans le journal d'audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleReactivate}
              disabled={actionLoading}
            >
              {actionLoading ? 'Réactivation...' : 'Réactiver'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reset Password Dialog */}
      <AlertDialog open={resetPasswordDialogOpen} onOpenChange={setResetPasswordDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Envoyer un email de réinitialisation ?</AlertDialogTitle>
            <AlertDialogDescription>
              Un email sera envoyé à {user.email} avec un lien de réinitialisation
              de mot de passe. (V1: email simulé, action enregistrée dans le journal)
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSendPasswordReset}
              disabled={actionLoading}
            >
              {actionLoading ? 'Envoi...' : 'Envoyer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Force Logout Dialog */}
      <AlertDialog open={forceLogoutDialogOpen} onOpenChange={setForceLogoutDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forcer la déconnexion de cet utilisateur ?</AlertDialogTitle>
            <AlertDialogDescription>
              Toutes les sessions actives de <strong>{user.firstName} {user.lastName}</strong> seront supprimées.
              L'utilisateur devra se reconnecter pour accéder à nouveau à la plateforme.
              <br /><br />
              Cette action sera enregistrée dans le journal d'audit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleForceLogout}
              disabled={actionLoading}
              className="bg-orange-600 hover:bg-orange-700"
            >
              {actionLoading ? 'Déconnexion...' : 'Forcer la déconnexion'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
