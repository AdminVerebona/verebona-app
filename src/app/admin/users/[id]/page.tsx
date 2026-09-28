"use client"

/**
 * Fiche utilisateur — CDC Back-Office V1 §6.2 et §6.3.
 *
 * Lecture seule (SEC-004, USR-A10) : identité, e-mail, compte rattaché, statut,
 * rôle titulaire / second utilisateur, statut administrateur, dates de
 * création et de rattachement, dates de désactivation / réactivation,
 * dernière connexion, préférences de notifications, invitations liées,
 * historique des communications (COM-014) et des connexions sur 90 jours
 * (USR-D01, USR-D02, REC-USR-05). Les sessions actives ne sont pas listées
 * (USR-D03).
 *
 * Actions (matrice §20) : renvoyer une invitation (USR-A01), désactiver /
 * réactiver (USR-A02..A05), déconnecter toutes les sessions (USR-A06),
 * réinitialisation du mot de passe par le parcours « Mot de passe oublié »
 * (USR-A07), statut administrateur (USR-A08). Le dernier administrateur actif
 * ne peut être ni rétrogradé ni désactivé (USR-A09).
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
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
  Ban,
  CheckCircle,
  MailIcon,
  LogOut,
  Shield,
  ShieldOff,
  Send,
} from 'lucide-react';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { formatDateTime } from '@/lib/admin/format';

interface UserDetails {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  company: string | null;
  role: string;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}

interface LinkedAccount {
  id: number;
  name: string;
  planType: string;
}

interface Membership {
  accountId: number;
  accountName: string;
  role: 'holder' | 'second' | 'member';
  joinedAt: string | null;
}

interface StatusChange {
  at: string;
  action: 'deactivated' | 'reactivated';
  adminEmail: string | null;
}

interface ChannelState { enabled: boolean; locked: boolean }
interface CategoryPreference {
  key: string;
  label: string;
  immediate: { push: ChannelState; email: ChannelState };
  digest?: { push: ChannelState; email: ChannelState };
}

interface Invitation {
  kind: 'duo' | 'account';
  direction: 'sent' | 'received';
  email: string;
  sentAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  status: 'pending' | 'accepted' | 'declined' | 'removed';
  reissuable: boolean;
  blockReason: string | null;
}

interface Communication {
  at: string;
  channel: 'email' | 'push' | 'in_app';
  type: string;
  status: 'sent' | 'failed' | 'pending' | 'skipped';
}

interface LoginEntry { at: string; device: string | null; ip: string | null }

interface UserData {
  user: UserDetails;
  account: LinkedAccount | null;
  adminStatus: { isAdmin: boolean; isLastActiveAdmin: boolean };
  memberships: Membership[];
  statusChanges: StatusChange[];
  notificationPreferences: {
    categories: CategoryPreference[];
    pushDeviceCount: number;
    newsConsent: { consented: boolean; consentedAt: string | null };
  };
  invitations: Invitation[];
  communications: Communication[];
  loginHistory: { days: number; entries: LoginEntry[] };
}

/** Motif affiché quand une action est impossible sur le dernier admin (UX-003). */
const LAST_ADMIN_REASON = "Dernier administrateur actif : accordez d'abord le statut administrateur à un autre utilisateur.";

const ROLE_LABELS: Record<Membership['role'], string> = {
  holder: 'Titulaire',
  second: 'Second utilisateur',
  member: 'Membre',
};
const PLAN_LABELS: Record<string, string> = { STANDARD: 'Standard', PREMIUM: 'Premium', PREMIUM_DUO: 'Premium Duo' };
const CHANNEL_LABELS: Record<Communication['channel'], string> = { email: 'E-mail', push: 'Push', in_app: 'In-app' };
const COMM_STATUS: Record<Communication['status'], { label: string; variant: 'active' | 'destructive' | 'secondary' | 'outline' }> = {
  sent: { label: 'Envoyé', variant: 'active' },
  failed: { label: 'Échec', variant: 'destructive' },
  pending: { label: 'En attente', variant: 'outline' },
  skipped: { label: 'Non envoyé', variant: 'secondary' },
};
const INVITATION_STATUS: Record<Invitation['status'], string> = {
  pending: 'En attente',
  accepted: 'Acceptée',
  declined: 'Refusée',
  removed: 'Retirée',
};

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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium text-sm">{children}</div>
    </div>
  );
}

function PrefCell({ state }: { state: ChannelState | undefined }) {
  if (!state) return <span className="text-muted-foreground">—</span>;
  return (
    <span className={state.enabled ? '' : 'text-muted-foreground'}>
      {state.enabled ? 'Activé' : 'Désactivé'}
      {state.locked && <span className="text-xs text-muted-foreground"> (obligatoire)</span>}
    </span>
  );
}

export default function UserDetailPage() {
  const router = useRouter();
  const params = useParams();
  const userId = params.id as string;

  const [data, setData] = useState<UserData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const [suspendDialogOpen, setSuspendDialogOpen] = useState(false);
  const [reactivateDialogOpen, setReactivateDialogOpen] = useState(false);
  const [resetPasswordDialogOpen, setResetPasswordDialogOpen] = useState(false);
  const [forceLogoutDialogOpen, setForceLogoutDialogOpen] = useState(false);
  const [adminRoleDialogOpen, setAdminRoleDialogOpen] = useState(false);
  const [resendDialogOpen, setResendDialogOpen] = useState(false);

  const loadUserData = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch(`/api/admin/users/${userId}`, { credentials: 'include' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || (response.status === 404 ? 'Utilisateur introuvable.' : 'Erreur lors du chargement de l’utilisateur.'));
      }
      setData(payload as UserData);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => { void loadUserData(); }, [loadUserData]);

  /** Exécute une action puis relit l'état depuis le serveur (ERR-003). */
  const runAction = async (fn: () => Promise<unknown>, success: string, close: () => void, reload = true) => {
    if (actionLoading) return; // ERR-002 : pas de double soumission.
    try {
      setActionLoading(true);
      await fn();
      toast.success(success);
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setActionLoading(false);
      if (reload) void loadUserData();
    }
  };

  const handleSuspend = () =>
    runAction(() => callAdminAction(`/api/admin/users/${userId}/suspend`, 'POST', {}),
      'Utilisateur désactivé — toutes ses sessions ont été révoquées', () => setSuspendDialogOpen(false));
  const handleReactivate = () =>
    runAction(() => callAdminAction(`/api/admin/users/${userId}/reactivate`, 'POST', {}),
      'Utilisateur réactivé', () => setReactivateDialogOpen(false));
  const handleSendPasswordReset = () =>
    runAction(() => callAdminAction(`/api/admin/users/${userId}/send-password-reset`, 'POST', {}),
      "E-mail de réinitialisation envoyé à l'utilisateur", () => setResetPasswordDialogOpen(false), false);
  const handleForceLogout = () =>
    runAction(() => callAdminAction(`/api/admin/users/${userId}/force-logout`, 'POST', {}),
      'Toutes les sessions de l’utilisateur ont été révoquées', () => setForceLogoutDialogOpen(false), false);
  const handleToggleAdmin = () => {
    if (!data) return;
    const makeAdmin = !data.adminStatus.isAdmin;
    return runAction(() => callAdminAction(`/api/admin/users/${userId}`, 'PUT', { isAdmin: makeAdmin }),
      makeAdmin ? 'Statut administrateur accordé' : 'Statut administrateur retiré', () => setAdminRoleDialogOpen(false));
  };
  const handleResendInvitation = () =>
    runAction(() => callAdminAction(`/api/admin/users/${userId}/resend-invitation`, 'POST', {}),
      'Invitation renvoyée', () => setResendDialogOpen(false));

  if (isLoading && !data) {
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
        <EcranEnErreur titre="Chargement de la fiche utilisateur impossible" message={error} onRetry={loadUserData} />
      </div>
    );
  }

  const { user, account: linkedAccount, adminStatus, memberships, statusChanges, notificationPreferences, invitations, communications, loginHistory } = data;
  const lastAdmin = adminStatus?.isLastActiveAdmin ?? false;
  const mainMembership = memberships[0] ?? null;
  const reissuable = invitations.find((i) => i.reissuable) ?? null;
  const resendReason = reissuable
    ? null
    : invitations.length === 0
      ? 'Aucune invitation liée à cet utilisateur.'
      : invitations[0].blockReason ?? 'Aucune invitation réémissible.';

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
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
          {user.status === 'ACTIVE' ? <Badge variant="active">Actif</Badge> : <Badge variant="destructive">Désactivé</Badge>}
          {adminStatus?.isAdmin && <Badge variant="default">Administrateur</Badge>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Informations utilisateur</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Identité">{`${user.firstName} ${user.lastName}`.trim() || '—'}</Field>
          <Field label="E-mail (non modifiable)">{user.email}</Field>
          <Field label="Statut">{user.status === 'ACTIVE' ? 'Actif' : 'Désactivé'}</Field>
          <Field label="Compte rattaché">
            {linkedAccount ? (
              <Link href={`/admin/accounts/${linkedAccount.id}`} className="hover:underline">
                {linkedAccount.name}
              </Link>
            ) : 'Aucun'}
          </Field>
          <Field label="Offre du compte">{linkedAccount ? (PLAN_LABELS[linkedAccount.planType?.toUpperCase()] ?? linkedAccount.planType) : '—'}</Field>
          <Field label="Rôle dans le compte">{mainMembership ? ROLE_LABELS[mainMembership.role] : '—'}</Field>
          <Field label="Statut administrateur">{adminStatus?.isAdmin ? 'Administrateur' : 'Non'}</Field>
          <Field label="Création">{formatDateTime(user.createdAt)}</Field>
          <Field label="Rattachement au compte">{formatDateTime(mainMembership?.joinedAt)}</Field>
          <Field label="Dernière connexion">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Jamais'}</Field>
          {user.company && <Field label="Société">{user.company}</Field>}
        </CardContent>
        {memberships.length > 1 && (
          <CardContent className="pt-0 text-xs text-muted-foreground">
            Autres comptes : {memberships.slice(1).map((m) => (
              <Link key={m.accountId} href={`/admin/accounts/${m.accountId}`} className="underline mr-2">
                {m.accountName} ({ROLE_LABELS[m.role]})
              </Link>
            ))}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => setResendDialogOpen(true)}
              disabled={!reissuable}
              title={resendReason ?? undefined}
            >
              <Send className="h-4 w-4 mr-2" />
              Renvoyer l’invitation
            </Button>
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
              <Button variant="outline" onClick={() => setReactivateDialogOpen(true)}>
                <CheckCircle className="h-4 w-4 mr-2" />
                Réactiver
              </Button>
            )}
            <Button variant="outline" onClick={() => setResetPasswordDialogOpen(true)}>
              <MailIcon className="h-4 w-4 mr-2" />
              Réinitialiser le mot de passe
            </Button>
            <Button variant="outline" onClick={() => setForceLogoutDialogOpen(true)}>
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
          {resendReason && <p className="text-xs text-muted-foreground">Renvoi d’invitation indisponible : {resendReason}</p>}
          {lastAdmin && <p className="text-xs text-muted-foreground">{LAST_ADMIN_REASON}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Désactivations et réactivations</CardTitle>
        </CardHeader>
        <CardContent>
          {statusChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune désactivation enregistrée.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground border-b">
                <tr><th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Événement</th><th className="py-2">Administrateur</th></tr>
              </thead>
              <tbody>
                {statusChanges.map((c, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2 pr-3">{formatDateTime(c.at)}</td>
                    <td className="py-2 pr-3">{c.action === 'deactivated' ? 'Désactivation' : 'Réactivation'}</td>
                    <td className="py-2 text-muted-foreground">{c.adminEmail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Préférences de notifications (lecture seule)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground border-b">
                <tr><th className="py-2 pr-3">Catégorie</th><th className="py-2 pr-3">Push</th><th className="py-2 pr-3">E-mail</th><th className="py-2">Récapitulatif quotidien</th></tr>
              </thead>
              <tbody>
                {notificationPreferences.categories.map((c) => (
                  <tr key={c.key} className="border-b last:border-0">
                    <td className="py-2 pr-3">{c.label}</td>
                    <td className="py-2 pr-3"><PrefCell state={c.immediate.push} /></td>
                    <td className="py-2 pr-3"><PrefCell state={c.immediate.email} /></td>
                    <td className="py-2">
                      {c.digest ? <>Push <PrefCell state={c.digest.push} /> · E-mail <PrefCell state={c.digest.email} /></> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            Appareils push actifs : {notificationPreferences.pushDeviceCount} · Actualités Verebona :{' '}
            {notificationPreferences.newsConsent.consented
              ? `acceptées le ${formatDateTime(notificationPreferences.newsConsent.consentedAt)}`
              : 'non acceptées'}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invitations liées</CardTitle>
        </CardHeader>
        <CardContent>
          {invitations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune invitation liée à cet utilisateur.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground border-b">
                  <tr><th className="py-2 pr-3">Type</th><th className="py-2 pr-3">Sens</th><th className="py-2 pr-3">Destinataire</th><th className="py-2 pr-3">Envoyée le</th><th className="py-2 pr-3">Expiration</th><th className="py-2">Statut</th></tr>
                </thead>
                <tbody>
                  {invitations.map((inv, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-3">{inv.kind === 'duo' ? 'Premium Duo' : 'Partage de compte'}</td>
                      <td className="py-2 pr-3">{inv.direction === 'sent' ? 'Émise' : 'Reçue'}</td>
                      <td className="py-2 pr-3">{inv.email}</td>
                      <td className="py-2 pr-3">{formatDateTime(inv.sentAt)}</td>
                      <td className="py-2 pr-3">{formatDateTime(inv.expiresAt)}{inv.expired && inv.status === 'pending' ? ' (expirée)' : ''}</td>
                      <td className="py-2">{INVITATION_STATUS[inv.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Historique des communications</CardTitle>
        </CardHeader>
        <CardContent>
          {communications.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune communication envoyée à cet utilisateur.</p>
          ) : (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground border-b">
                  <tr><th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Canal</th><th className="py-2 pr-3">Type</th><th className="py-2">Statut</th></tr>
                </thead>
                <tbody>
                  {communications.map((c, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(c.at)}</td>
                      <td className="py-2 pr-3">{CHANNEL_LABELS[c.channel]}</td>
                      <td className="py-2 pr-3">{c.type}</td>
                      <td className="py-2"><Badge variant={COMM_STATUS[c.status].variant}>{COMM_STATUS[c.status].label}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-2">Les anomalies de communication sont suivies dans Supervision.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connexions des {loginHistory.days} derniers jours</CardTitle>
        </CardHeader>
        <CardContent>
          {loginHistory.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune connexion sur les {loginHistory.days} derniers jours.</p>
          ) : (
            <div className="overflow-x-auto max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground border-b">
                  <tr><th className="py-2 pr-3">Date</th><th className="py-2 pr-3">Appareil / navigateur</th><th className="py-2">IP (tronquée)</th></tr>
                </thead>
                <tbody>
                  {loginHistory.entries.map((l, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(l.at)}</td>
                      <td className="py-2 pr-3">{l.device ?? '—'}</td>
                      <td className="py-2 font-mono text-xs">{l.ip ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Resend invitation Dialog (USR-A01) */}
      <AlertDialog open={resendDialogOpen} onOpenChange={setResendDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Renvoyer l’invitation ?</AlertDialogTitle>
            <AlertDialogDescription>
              L’invitation Premium Duo est renvoyée à {reissuable?.email ?? 'son destinataire'} avec le même e-mail que
              le parcours utilisateur. Le destinataire n’est pas modifiable. Si le lien a expiré, un nouveau lien valable
              7 jours est émis. Action journalisée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionLoading}>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleResendInvitation} disabled={actionLoading}>
              {actionLoading ? 'Envoi…' : 'Renvoyer'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
