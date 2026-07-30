'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/useSession';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { User, CreditCard, Key, ExternalLink, Loader2, ShieldAlert, Users, Calendar, Copy, RefreshCw, ChevronDown, Lock, Trash2, AlertTriangle, Save, Crown } from 'lucide-react';
import { AiHistoryBlock } from '@/components/account/AiHistoryBlock';
import { Switch } from '@/components/ui/switch';
import { DuoInvitationPanel } from '@/components/subscription/DuoInvitationPanel';
import { apiClient } from '@/lib/api-client';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PasswordInput } from '@/components/ui/password-input';
import { PasswordRequirements } from '@/components/auth/PasswordRequirements';
import { getPlanTheme } from '@/lib/plan-theme';
import { AiUsageQuotaWidget } from '@/components/account/AiUsageQuotaWidget';
import { ReferralBlock } from '@/components/account/ReferralBlock';


interface UserProfile {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
}

interface SubscriptionInfo {
  plan_type: string;
  premium_until: string | null;
  subscription_status: string | null;
  has_stripe_subscription: boolean;
  role: string;
  analysis_quota: {
    included_quota: number;
    included_consumed: number;
    included_remaining: number;
    referral_remaining: number;
    pack_remaining: number;
    total_remaining: number;
    period_type: string;
  } | null;
  asset_count: number;
}

function CalendarTutorial() {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-[color:var(--border-subtle)] rounded-lg overflow-hidden mt-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-medium text-muted-foreground hover:bg-[color:var(--bg-hover)] transition-colors"
      >
        <span>Comment ajouter ce calendrier à mon agenda ?</span>
        <ChevronDown
          className="w-3.5 h-3.5 transition-transform duration-200 flex-shrink-0"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-[color:var(--border-subtle)] space-y-3 text-xs text-muted-foreground">
          <div className="space-y-1">
            <p className="font-semibold text-[color:var(--text-secondary)]">🍎 Apple Agenda (iPhone / Mac)</p>
            <ol className="list-decimal list-inside space-y-0.5 pl-1">
              <li>Copiez le lien ci-dessus</li>
              <li>Ouvrez <strong>Agenda</strong> → menu <strong>Fichier</strong> → <strong>Nouvel abonnement à un calendrier</strong></li>
              <li>Collez le lien et cliquez sur <strong>S'abonner</strong></li>
              <li>Choisissez une fréquence de mise à jour (recommandé : toutes les heures)</li>
            </ol>
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-[color:var(--text-secondary)]">📅 Google Agenda</p>
            <ol className="list-decimal list-inside space-y-0.5 pl-1">
              <li>Copiez le lien ci-dessus et <strong>remplacez</strong> <code className="bg-muted px-1 rounded">webcal://</code> par <code className="bg-muted px-1 rounded">https://</code></li>
              <li>Ouvrez <strong>Google Agenda</strong> → colonne gauche → <strong>Autres agendas</strong> (+)</li>
              <li>Choisissez <strong>À partir de l'URL</strong></li>
              <li>Collez le lien modifié et cliquez sur <strong>Ajouter un agenda</strong></li>
            </ol>
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-[color:var(--text-secondary)]">📬 Outlook</p>
            <ol className="list-decimal list-inside space-y-0.5 pl-1">
              <li>Copiez le lien ci-dessus</li>
              <li>Dans Outlook, allez dans <strong>Calendrier</strong> → <strong>Ajouter un calendrier</strong> → <strong>À partir d'Internet</strong></li>
              <li>Collez le lien et confirmez</li>
            </ol>
          </div>
          <p className="text-[11px] pt-1 border-t border-[color:var(--border-subtle)]">
            ℹ️ Les mises à jour peuvent prendre quelques minutes à apparaître selon votre application.
          </p>
        </div>
      )}
    </div>
  );
}

export default function InformationsTab() {
  const router = useRouter();
  const { user: sessionUser, isLoading: sessionLoading, refetch: refetchSession } = useSession({ required: true });
  
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);

  const [profile, setProfile] = useState<UserProfile>({
    firstName: '',
    lastName: '',
    username: '',
    email: '',
  });
  const [initialProfile, setInitialProfile] = useState<UserProfile>({
    firstName: '',
    lastName: '',
    username: '',
    email: '',
  });

  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);
  const [isPortalLoading, setIsPortalLoading] = useState(false);

  const [calToken, setCalToken] = useState<string | null>(null);
  const [calActive, setCalActive] = useState(false);
  const [calGenerating, setCalGenerating] = useState(false);
  const [calToggling, setCalToggling] = useState(false);

  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    if (!sessionLoading && sessionUser) {
      fetchData();
    }
  }, [sessionLoading, sessionUser]);

  // Scroll to anchor after data loads (e.g. coming from agenda page)
  useEffect(() => {
    if (!loading && typeof window !== 'undefined' && window.location.hash === '#sync-agenda') {
      const el = document.getElementById('sync-agenda');
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  }, [loading]);

  const fetchData = async () => {
    try {
      // Use session user data directly (already fetched by useSession)
      const userProfile: UserProfile = {
        firstName: sessionUser?.firstName || '',
        lastName: sessionUser?.lastName || '',
        username: sessionUser?.username || '',
        email: sessionUser?.email || '',
      };
      setProfile(userProfile);
      setInitialProfile(userProfile);

      const [billingResult, calData] = await Promise.all([
        apiClient.get<any>('/api/billing/me').catch((err: unknown) => {
          console.warn('[mon-compte] billing/me error:', err);
          return null;
        }),
        apiClient.get<any>('/api/account/calendar-token').catch(() => null),
      ]);

      if (calData && !calData.error) {
        setCalToken(calData.token ?? null);
        setCalActive(calData.active ?? false);
      }

      setSubscription({
        plan_type: billingResult?.plan_type || sessionUser?.subscription?.plan || 'STANDARD',
        premium_until: billingResult?.premium_until || null,
        subscription_status: billingResult?.subscription_status || null,
        has_stripe_subscription: !!billingResult?.has_stripe_subscription,
        role: billingResult?.role || 'owner',
        analysis_quota: billingResult?.analysis_quota || null,
        asset_count: billingResult?.asset_count ?? 0,
      });

    } catch (error) {
      console.error('Error fetching data:', error);
      toast.error("Erreur lors du chargement des informations");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveProfile = async () => {
    if (!sessionUser) return;
    if (!profile.firstName || !profile.lastName) return toast.error("Le prénom et le nom sont requis");

    try {
      setSavingProfile(true);
      const data = await apiClient.put<any>(`/api/users/me`, {
        firstName: profile.firstName.trim(),
        lastName: profile.lastName.trim(),
        username: profile.username.trim() || null,
      });
      
      if (data.error) throw new Error(data.error);

      // Update localStorage immediately and broadcast so all components re-render at once
      try {
        const cached = localStorage.getItem('user');
        if (cached) {
          const parsed = JSON.parse(cached);
          parsed.firstName = profile.firstName.trim();
          parsed.lastName = profile.lastName.trim();
          parsed.username = profile.username.trim() || null;
          localStorage.setItem('user', JSON.stringify(parsed));
          window.dispatchEvent(new CustomEvent('user-profile-updated', { detail: parsed }));
        }
      } catch {}

      setInitialProfile(profile);
      apiClient.clearCache();
      await refetchSession();
      toast.success("Profil mis à jour");
    } catch (error: any) {
      toast.error(error.message || "Erreur lors de la mise à jour");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      return toast.error("Les mots de passe ne correspondent pas");
    }

    try {
      setChangingPassword(true);
      const response = await fetch('/api/users/me/change-password', {
      credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error);

      toast.success("Mot de passe modifié avec succès");
      setIsPasswordDialogOpen(false);
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (error: any) {
      toast.error(error.message || "Erreur lors du changement de mot de passe");
    } finally {
      setChangingPassword(false);
    }
  };

  const handleOpenPortal = async () => {
    // Ouvrir immédiatement pour éviter le blocage popup du navigateur
    const win = window.open('', '_blank');
    setIsPortalLoading(true);
    try {
      const data = await apiClient.post<any>('/api/billing/create-customer-portal-session', {});
      if (data.portal_url && win) {
        win.location.href = data.portal_url;
      } else {
        win?.close();
        toast.error(data.message || 'Impossible d\'accéder à la gestion de facturation.');
      }
    } catch (error: any) {
      win?.close();
      toast.error(error.message || 'Une erreur est survenue.');
    } finally {
      setIsPortalLoading(false);
    }
  };

  const handleGenerateCalToken = async () => {
    setCalGenerating(true);
    try {
      const data = await apiClient.post<any>('/api/account/calendar-token', {});
      if (data.error) throw new Error(data.error);
      setCalToken(data.token);
      setCalActive(true);
      toast.success('Lien de synchronisation généré');
    } catch {
      toast.error('Erreur lors de la génération du lien');
    } finally {
      setCalGenerating(false);
    }
  };

  const handleToggleCal = async (active: boolean) => {
    setCalToggling(true);
    try {
      const data = await apiClient.patch<any>('/api/account/calendar-token/toggle', { active });
      if (data.error) throw new Error(data.error);
      setCalActive(active);
      toast.success(active ? 'Synchronisation activée' : 'Synchronisation désactivée');
    } catch {
      toast.error('Erreur lors de la mise à jour');
    } finally {
      setCalToggling(false);
    }
  };

  const calFeedUrl = calToken
    ? `webcal://${typeof window !== 'undefined' ? window.location.host : 'app.verebona.fr'}/api/calendar/${calToken}.ics`
    : null;

  const handleCopyCalUrl = () => {
    if (!calFeedUrl) return;
    navigator.clipboard.writeText(calFeedUrl);
    toast.success('Lien copié !');
  };

  if (sessionLoading || loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-[200px] w-full" />
        <Skeleton className="h-[300px] w-full" />
      </div>
    );
  }

  const profileChanged = JSON.stringify(profile) !== JSON.stringify(initialProfile);

  return (
    <div className="w-full max-w-full">

      {/* ══ Grille 2 colonnes ══ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">

        {/* ── Colonne gauche : Profil + Abonnement ── */}
        <div className="flex flex-col gap-4">

          {/* Profil */}
          <Card className="flex flex-col flex-1">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4 text-[#3b82f6]" />
                  <CardTitle className="text-base">Mon profil</CardTitle>
                </div>
                <button
                  onClick={handleSaveProfile}
                  disabled={!profileChanged || savingProfile}
                  className="btn-add disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
                >
                  {savingProfile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {savingProfile ? 'Enregistrement…' : 'Enregistrer'}
                </button>
              </div>
              <CardDescription>Vos informations personnelles.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 flex-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="firstName">Prénom</Label>
                  <Input id="firstName" value={profile.firstName} onChange={e => setProfile({...profile, firstName: e.target.value})} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lastName">Nom</Label>
                  <Input id="lastName" value={profile.lastName} onChange={e => setProfile({...profile, lastName: e.target.value})} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="username">Nom d'utilisateur</Label>
                  <Input id="username" value={profile.username} onChange={e => setProfile({...profile, username: e.target.value})} />
                  <p className="text-xs text-muted-foreground">Affiché dans le message de bienvenue et les emails.</p>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="email">Email <span className="text-muted-foreground">(non modifiable)</span></Label>
                  <Input id="email" value={profile.email} disabled className="bg-muted" />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Abonnement */}
          <Card className="flex flex-col flex-1">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-[#3b82f6]" />
                <CardTitle className="text-base">Abonnement</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 flex-1">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Plan actuel</p>
                  <p className={`text-base font-bold ${getPlanTheme(subscription?.plan_type as any).colors.text}`}>
                    {getPlanTheme(subscription?.plan_type as any).label}
                  </p>
                </div>
                {subscription?.premium_until && (
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Prochain renouvellement</p>
                    <p className="text-sm font-medium">{format(new Date(Number(subscription.premium_until) * 1000), 'PPP', { locale: fr })}</p>
                  </div>
                )}
              </div>

              {/* Compteurs biens + documents analysés — CDC V2 */}
              <AiUsageQuotaWidget isDuoMember={sessionUser?.duoRole === 'MEMBER'} />

              {sessionUser?.duoRole === 'MEMBER' ? (
                <div className="flex items-start gap-2 bg-amber-950/30 border border-amber-500/30 rounded-lg px-3 py-2.5 text-sm text-amber-200">
                  <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-400" />
                  <p>Seul le titulaire de l'abonnement peut modifier l'offre et gérer le paiement.</p>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => router.push('/mon-compte/offres')} className="gap-2 rounded-full h-auto py-2">
                    <Crown className="w-4 h-4" />
                    <span>Changer d'offre</span>
                  </Button>
                  {(subscription?.plan_type !== 'STANDARD' || subscription?.has_stripe_subscription) && (
                    <Button variant="outline" onClick={handleOpenPortal} disabled={isPortalLoading} className="gap-2 rounded-full h-auto py-2 text-left items-start">
                      {isPortalLoading ? <Loader2 className="w-4 h-4 animate-spin mt-0.5 shrink-0" /> : <CreditCard className="w-4 h-4 mt-0.5 shrink-0" />}
                      <span className="flex flex-col">
                        <span>Gérer mon abonnement avec Stripe</span>
                        <span className="text-[10px] text-muted-foreground font-normal">Factures, moyens de paiement…</span>
                      </span>
                    </Button>
                  )}
                </div>
              )}

              {(() => {
                const isDuoBillingOwner = subscription?.plan_type === 'PREMIUM_DUO' && sessionUser?.duoRole === 'BILLING_OWNER';
                const showLockedCta = !isDuoBillingOwner && sessionUser?.duoRole !== 'MEMBER' && subscription?.plan_type !== 'PREMIUM_DUO';
                if (isDuoBillingOwner) return (
                  <div className="pt-3 border-t border-border">
                    <div className="flex items-center gap-2 mb-3">
                      <Users className="w-4 h-4 text-emerald-400" />
                      <span className="text-sm font-medium">2e utilisateur Duo</span>
                    </div>
                    <DuoInvitationPanel />
                  </div>
                );
                if (showLockedCta) return (
                  <div className="pt-3 border-t border-border">
                    <div className="flex flex-col sm:flex-row sm:items-start gap-3 rounded-lg border border-dashed border-emerald-500/30 bg-emerald-500/5 px-3 py-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <Lock className="w-4 h-4 text-emerald-400/60 mt-0.5 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">2e utilisateur — Offre Duo</p>
                          <p className="text-xs text-muted-foreground mt-0.5">Partagez votre espace avec une 2e personne.</p>
                        </div>
                      </div>
                      <Button size="sm" variant="outline" className="w-full sm:w-auto sm:shrink-0 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 gap-1 rounded-full" onClick={() => router.push('/mon-compte/offres')}>
                        <Users className="w-3.5 h-3.5" />Passer au Duo
                      </Button>
                    </div>
                  </div>
                );
                return null;
              })()}

              {/* Parrainage — dans le bloc abonnement */}
              {sessionUser?.duoRole !== 'MEMBER' && (
                <div className="pt-3 border-t border-border">
                  <ReferralBlock />
                </div>
              )}
            </CardContent>
          </Card>

        </div>{/* end left col */}

        {/* ── Colonne droite : Synchronisation + Sécurité + Zone dangereuse ── */}
        <div className="flex flex-col gap-4">

          {/* Synchronisation agenda */}
          <Card id="sync-agenda" className="flex flex-col flex-1">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-[#3b82f6]" />
                  <CardTitle className="text-base">Synchronisation agenda</CardTitle>
                </div>
                {subscription?.plan_type === 'STANDARD' && (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 border border-blue-500/30">Premium</span>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-4 flex-1">
              {subscription?.plan_type === 'STANDARD' ? (() => {
                const premiumTheme = getPlanTheme('PREMIUM');
                return (
                  <div className={`flex flex-col sm:flex-row sm:items-start gap-3 rounded-lg border border-dashed ${premiumTheme.colors.border} bg-blue-500/5 px-3 py-3`}>
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <Lock className={`w-4 h-4 ${premiumTheme.colors.text}/60 mt-0.5 flex-shrink-0`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">Disponible en Premium</p>
                        <p className="text-xs text-muted-foreground mt-0.5">Synchronisez vos événements avec Google Agenda, Apple Agenda ou Outlook.</p>
                      </div>
                    </div>
                    <Button size="sm" variant="outline" className="w-full sm:w-auto sm:shrink-0 border-blue-500/40 text-blue-400 hover:bg-blue-500/10 gap-1 rounded-full" onClick={() => router.push('/mon-compte/offres')}>
                      <Crown className="w-3.5 h-3.5" />Passer Premium
                    </Button>
                  </div>
                );
              })() : !calToken ? (
                <button onClick={handleGenerateCalToken} disabled={calGenerating} className="btn-add disabled:opacity-40">
                  {calGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calendar className="w-4 h-4" />}
                  Générer le lien de synchronisation
                </button>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">Synchronisation active</p>
                      <p className="text-xs text-muted-foreground">Désactivez pour bloquer l'accès sans supprimer le lien</p>
                    </div>
                    <Switch checked={calActive} onCheckedChange={handleToggleCal} disabled={calToggling} />
                  </div>
                  {calActive && calFeedUrl && (
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Lien de votre agenda</label>
                      <div className="flex gap-2">
                        <Input readOnly value={calFeedUrl} className="font-mono text-xs bg-muted" onClick={e => (e.target as HTMLInputElement).select()} />
                        <Button variant="outline" size="icon" onClick={handleCopyCalUrl} title="Copier"><Copy className="w-4 h-4" /></Button>
                        <Button variant="outline" size="icon" asChild title="Ouvrir dans mon agenda"><a href={calFeedUrl}><ExternalLink className="w-4 h-4" /></a></Button>
                      </div>
                      <CalendarTutorial />
                    </div>
                  )}
                  <div className="pt-1 border-t border-border">
                    <Button variant="ghost" size="sm" onClick={() => { if (confirm('Régénérer le lien invalidera l\'ancien. Continuer ?')) handleGenerateCalToken(); }} disabled={calGenerating} className="text-muted-foreground gap-2">
                      {calGenerating ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                      Régénérer le lien
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Historique des modifications automatiques IA */}
          <AiHistoryBlock />

          {/* Sécurité */}
          <Card className="flex flex-col flex-1">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Key className="h-4 w-4 text-[#3b82f6]" />
                <CardTitle className="text-base">Sécurité</CardTitle>
              </div>
              <CardDescription>Gérez vos identifiants de connexion.</CardDescription>
            </CardHeader>
            <CardContent className="flex-1">
              <Dialog open={isPasswordDialogOpen} onOpenChange={setIsPasswordDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="rounded-full gap-2">
                    <Key className="w-4 h-4" />
                    Modifier mon mot de passe
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <form onSubmit={handleChangePassword}>
                    <DialogHeader>
                      <DialogTitle>Modifier le mot de passe</DialogTitle>
                      <DialogDescription>Veuillez saisir votre mot de passe actuel avant d'en choisir un nouveau.</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                      <div className="space-y-2">
                        <Label htmlFor="currentPassword">Mot de passe actuel</Label>
                        <PasswordInput id="currentPassword" value={passwordForm.currentPassword} onChange={e => setPasswordForm({...passwordForm, currentPassword: e.target.value})} required />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="newPassword">Nouveau mot de passe</Label>
                        <PasswordInput id="newPassword" value={passwordForm.newPassword} onChange={e => setPasswordForm({...passwordForm, newPassword: e.target.value})} required />
                        <PasswordRequirements password={passwordForm.newPassword} confirmPassword={passwordForm.confirmPassword} showConfirmRule={true} />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="confirmPassword">Confirmer le nouveau mot de passe</Label>
                        <PasswordInput id="confirmPassword" value={passwordForm.confirmPassword} onChange={e => setPasswordForm({...passwordForm, confirmPassword: e.target.value})} required />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button type="button" variant="ghost" onClick={() => setIsPasswordDialogOpen(false)}>Annuler</Button>
                      <button type="submit" disabled={changingPassword} className="btn-add disabled:opacity-40">
                        {changingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        {changingPassword ? 'Mise à jour…' : 'Mettre à jour'}
                      </button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>

          {/* Zone dangereuse */}
          <DeleteAccountCard />

        </div>{/* end right col */}

      </div>{/* end grid */}

    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Composant : suppression de compte
───────────────────────────────────────────────────────────────── */
function DeleteAccountCard() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);

  const REQUIRED_TEXT = 'SUPPRIMER MON COMPTE';

  const resetDialog = () => {
    setStep(1);
    setConfirmation('');
    setDeleting(false);
  };

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) resetDialog();
  };

  const handleDelete = async () => {
    if (confirmation !== REQUIRED_TEXT) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/users/me', {
      credentials: 'include',
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ confirmation }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.message || 'Une erreur est survenue. Veuillez réessayer.');
        setDeleting(false);
        return;
      }
      // Clear session
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
      toast.success('Votre compte a été supprimé.');
      setOpen(false);
      router.push('/');
    } catch {
      toast.error('Une erreur est survenue. Veuillez réessayer.');
      setDeleting(false);
    }
  };

  return (
    <Card className="border-red-500/30 bg-red-950/10 flex flex-col flex-1">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Trash2 className="h-5 w-5 text-red-500" />
          <CardTitle className="text-red-500">Zone dangereuse</CardTitle>
        </div>
        <CardDescription>
          La suppression de votre compte est irréversible. Toutes vos données seront définitivement perdues.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>
            <Button variant="outline" className="border-red-500/40 text-red-500 hover:bg-red-500/10 hover:border-red-500 gap-2 btn-delete">
              <Trash2 className="w-4 h-4 btn-delete-trash-icon" />
              Supprimer mon compte
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">

            {/* ── Étape 1 : avertissement ── */}
            {step === 1 && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-red-500">
                    <AlertTriangle className="w-5 h-5" />
                    Suppression du compte
                  </DialogTitle>
                  <DialogDescription className="sr-only">Avertissement avant suppression</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="rounded-lg border border-red-500/30 bg-red-950/20 px-4 py-3 space-y-2">
                    <p className="text-sm font-semibold text-red-400">Cette action est irréversible.</p>
                    <ul className="text-sm text-[color:var(--text-secondary)] space-y-1.5 list-disc list-inside">
                      <li>Tous vos <strong>biens</strong> et leurs informations</li>
                      <li>Tous vos <strong>documents</strong> uploadés</li>
                      <li>Tout votre <strong>agenda</strong> de biens</li>
                      <li>Votre <strong>abonnement</strong> et historique de facturation</li>
                      <li>Votre accès à l'<strong>espace Duo</strong> si applicable</li>
                    </ul>
                  </div>
                  <p className="text-sm text-[color:var(--text-muted)]">
                    Si vous avez un abonnement actif, pensez à le résilier d'abord depuis votre portail de paiement.
                  </p>
                </div>
                <DialogFooter className="gap-2">
                  <Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
                  <Button
                    variant="outline"
                    className="border-red-500/40 text-red-500 hover:bg-red-500/10"
                    onClick={() => setStep(2)}
                  >
                    Je comprends, continuer
                  </Button>
                </DialogFooter>
              </>
            )}

            {/* ── Étape 2 : deuxième confirmation ── */}
            {step === 2 && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-red-500">
                    <AlertTriangle className="w-5 h-5" />
                    Êtes-vous vraiment sûr ?
                  </DialogTitle>
                  <DialogDescription className="sr-only">Deuxième confirmation</DialogDescription>
                </DialogHeader>
                <div className="py-2 space-y-3">
                  <p className="text-sm text-[color:var(--text-secondary)]">
                    Vous êtes sur le point de supprimer définitivement votre compte Verebona.
                    Cette opération <strong>ne peut pas être annulée</strong>.
                  </p>
                  <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-3">
                    <p className="text-sm text-amber-300 font-medium">
                      Toutes vos données seront supprimées immédiatement et de façon permanente.
                    </p>
                  </div>
                </div>
                <DialogFooter className="gap-2">
                  <Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
                  <Button
                    variant="outline"
                    className="border-red-500/40 text-red-500 hover:bg-red-500/10"
                    onClick={() => setStep(3)}
                  >
                    Oui, je veux supprimer mon compte
                  </Button>
                </DialogFooter>
              </>
            )}

            {/* ── Étape 3 : saisie de confirmation ── */}
            {step === 3 && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-red-500">
                    <Trash2 className="w-5 h-5" />
                    Confirmation finale
                  </DialogTitle>
                  <DialogDescription className="sr-only">Saisie du texte de confirmation</DialogDescription>
                </DialogHeader>
                <div className="py-2 space-y-4">
                  <p className="text-sm text-[color:var(--text-secondary)]">
                    Pour confirmer, recopiez exactement le texte ci-dessous&nbsp;:
                  </p>
                  <div className="rounded-md bg-[color:var(--bg-page)] border border-[color:var(--border-subtle)] px-3 py-2 text-center">
                    <code className="text-sm font-mono font-bold text-red-400 select-all">{REQUIRED_TEXT}</code>
                  </div>
                  <Input
                    placeholder={REQUIRED_TEXT}
                    value={confirmation}
                    onChange={e => setConfirmation(e.target.value)}
                    className={`font-mono ${confirmation === REQUIRED_TEXT ? 'border-red-500 focus-visible:ring-red-500/30' : ''}`}
                    disabled={deleting}
                    autoFocus
                  />
                </div>
                <DialogFooter className="gap-2">
                  <Button variant="ghost" onClick={() => setOpen(false)} disabled={deleting}>Annuler</Button>
                  <Button
                    variant="destructive"
                    disabled={confirmation !== REQUIRED_TEXT || deleting}
                    onClick={handleDelete}
                    className="gap-2 btn-delete"
                  >
                    {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4 btn-delete-trash-icon" />}
                    {deleting ? 'Suppression…' : 'Supprimer définitivement'}
                  </Button>
                </DialogFooter>
              </>
            )}

          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
