"use client"

/**
 * Fiche utilisateur — CDC Back-Office V1 §6.2 et §6.3.
 *
 * Identité et e-mail en LECTURE SEULE (SEC-004, USR-A10) : le formulaire
 * « Modifier » (nom, prénom, société, offre, statut, langue) est supprimé.
 * Suppression d'utilisateur et suppression de bien retirées (GEN-001,
 * SEC-003) : la suppression passe par la fiche Compte (ACC-A14).
 *
 * Actions (matrice §20) : désactiver / réactiver (USR-A02..A05), déconnecter
 * toutes les sessions (USR-A06), réinitialisation du mot de passe par le
 * parcours « Mot de passe oublié » (USR-A07), statut administrateur
 * (USR-A08). Le dernier administrateur actif ne peut être ni rétrogradé ni
 * désactivé (USR-A09) : bouton désactivé avec son motif (UX-003), refus 409
 * côté serveur.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  LogOut,
  ExternalLink,
  Shield,
  ShieldOff,
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
  /** USR-A08 / USR-A09 : statut admin et protection du dernier admin actif. */
  adminStatus: { isAdmin: boolean; isLastActiveAdmin: boolean };
  assets: Asset[];
  stats: UserStats;
  subscriptionHistory: SubscriptionHistoryEntry[];
}

/** Motif affiché quand une action est impossible sur le dernier admin (UX-003). */
const LAST_ADMIN_REASON = "Dernier administrateur actif : accordez d'abord le statut administrateur à un autre utilisateur.";

/**
 * Appel d'une action administrateur. Rend le message du serveur en cas
 * d'échec (ex. 409 LAST_ADMIN) plutôt qu'un libellé générique.
 */
async function callAdminAction<T = Record<string, unknown>>(url: string, method: 'POST' | 'PUT', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Erreur ${response.status}`);
  }
  return payload as T;
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
  const [forceLogoutDialogOpen, setForceLogoutDialogOpen] = useState(false);
  const [adminRoleDialogOpen, setAdminRoleDialogOpen] = useState(false);

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
    } catch (err) {
      console.error('Error loading user:', err);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  /** USR-A02 / USR-A03 : désactivation sans motif ; sessions révoquées par le serveur. */
  const handleSuspend = async () => {
    try {
      setActionLoading(true);
      await callAdminAction(`/api/admin/users/${userId}/suspend`, 'POST', {});
      toast.success('Utilisateur désactivé — toutes ses sessions ont été révoquées');
      setSuspendDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
      loadUserData();
    }
  };

  /** USR-A04 : accès restauré avec les identifiants existants. */
  const handleReactivate = async () => {
    try {
      setActionLoading(true);
      await callAdminAction(`/api/admin/users/${userId}/reactivate`, 'POST', {});
      toast.success('Utilisateur réactivé');
      setReactivateDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
      loadUserData();
    }
  };

  /** USR-A07 : même parcours que « Mot de passe oublié ». */
  const handleSendPasswordReset = async () => {
    try {
      setActionLoading(true);
      await callAdminAction(`/api/admin/users/${userId}/send-password-reset`, 'POST', {});
      toast.success("E-mail de réinitialisation envoyé à l'utilisateur");
      setResetPasswordDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
    }
  };

  /** USR-A06 : révocation globale, sans détail des sessions. */
  const handleForceLogout = async () => {
    try {
      setActionLoading(true);
      await callAdminAction(`/api/admin/users/${userId}/force-logout`, 'POST', {});
      toast.success('Toutes les sessions de l’utilisateur ont été révoquées');
      setForceLogoutDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
    }
  };

  /** USR-A08 / USR-A09 : accorder ou retirer le statut administrateur. */
  const handleToggleAdmin = async () => {
    if (!data) return;
    try {
      setActionLoading(true);
      const makeAdmin = !data.adminStatus.isAdmin;
      await callAdminAction(`/api/admin/users/${userId}`, 'PUT', { isAdmin: makeAdmin });
      toast.success(makeAdmin ? 'Statut administrateur accordé' : 'Statut administrateur retiré');
      setAdminRoleDialogOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
      loadUserData();
    }
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

  const { user, account: linkedAccount, assets, stats, adminStatus } = data;
  const lastAdmin = adminStatus?.isLastActiveAdmin ?? false;

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
          {adminStatus?.isAdmin && (
            <Badge variant="default">Administrateur</Badge>
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
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {user.status === 'ACTIVE' ? (
              <Button
                variant="outline"
                onClick={() => setSuspendDialogOpen(true)}
                disabled={lastAdmin}
                title={lastAdmin ? LAST_ADMIN_REASON : undefined}
              >
                <Ban className="h-4 w-4 mr-2" />
                Désactiver
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
              Réinitialiser le mot de passe
            </Button>

            <Button
              variant="outline"
              onClick={() => setForceLogoutDialogOpen(true)}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Déconnecter toutes les sessions
            </Button>

            <Button
              variant="outline"
              onClick={() => setAdminRoleDialogOpen(true)}
              disabled={adminStatus?.isAdmin && lastAdmin}
              title={adminStatus?.isAdmin && lastAdmin ? LAST_ADMIN_REASON : undefined}
            >
              {adminStatus?.isAdmin ? <ShieldOff className="h-4 w-4 mr-2" /> : <Shield className="h-4 w-4 mr-2" />}
              {adminStatus?.isAdmin ? 'Retirer le statut administrateur' : 'Accorder le statut administrateur'}
            </Button>
          </div>
          {lastAdmin && (
            <p className="text-xs text-muted-foreground">{LAST_ADMIN_REASON}</p>
          )}
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
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Suspend Dialog */}
      <AlertDialog open={suspendDialogOpen} onOpenChange={setSuspendDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Désactiver cet utilisateur ?</AlertDialogTitle>
            <AlertDialogDescription>
              {user.firstName} {user.lastName} est déconnecté immédiatement de toutes ses sessions et ne
              pourra plus se connecter. Son compte n'est ni supprimé ni transféré. Aucun e-mail n'est envoyé.
              Action journalisée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleSuspend}
              disabled={actionLoading}
              className="bg-destructive hover:bg-destructive/90"
            >
              {actionLoading ? 'Désactivation...' : 'Désactiver'}
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
              {user.firstName} {user.lastName} pourra à nouveau se connecter avec ses identifiants
              actuels. Aucun e-mail n'est envoyé. Action journalisée.
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
              {user.email} recevra le même e-mail que lors d'une demande « Mot de passe oublié »,
              avec un lien valable une heure. Le back-office ne définit jamais de mot de passe.
              Action journalisée.
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
            <AlertDialogTitle>Déconnecter toutes les sessions ?</AlertDialogTitle>
            <AlertDialogDescription>
              Toutes les sessions de <strong>{user.firstName} {user.lastName}</strong> sont révoquées
              immédiatement, sur tous ses appareils. Il pourra se reconnecter avec ses identifiants.
              Action journalisée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleForceLogout}
              disabled={actionLoading}
              className="bg-orange-600 hover:bg-orange-700"
            >
              {actionLoading ? 'Déconnexion...' : 'Déconnecter'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Admin Role Dialog (USR-A08) */}
      <AlertDialog open={adminRoleDialogOpen} onOpenChange={setAdminRoleDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {adminStatus?.isAdmin ? 'Retirer le statut administrateur ?' : 'Accorder le statut administrateur ?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {adminStatus?.isAdmin
                ? `${user.firstName} ${user.lastName} perd l'accès au back-office ; ses sessions sont révoquées.`
                : `${user.firstName} ${user.lastName} aura accès à l'ensemble du back-office.`}
              {' '}Action journalisée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleToggleAdmin} disabled={actionLoading}>
              {actionLoading ? 'Enregistrement...' : 'Confirmer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
