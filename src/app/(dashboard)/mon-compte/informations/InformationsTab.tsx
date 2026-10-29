'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/hooks/useSession';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { User, ExternalLink, Loader2, Calendar, Copy, RefreshCw, ChevronDown, Lock, Trash2, AlertTriangle, Save, Crown } from 'lucide-react';
import { AiHistoryBlock } from '@/components/account/AiHistoryBlock';
import { Switch } from '@/components/ui/switch';
import { apiClient } from '@/lib/api-client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { getPlanTheme } from '@/lib/plan-theme';
import { SecurityCard } from '@/components/account/security/SecurityCard';
import { ReauthProvider, useReauth } from '@/components/account/security/ReauthProvider';
import { ApiClientError } from '@/lib/api-client';
import { useNativeCommerceHidden } from '@/hooks/useNativeCommerceHidden';
import { NativeCommerceNotice } from '@/components/native/NativeCommerceNotice';


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
              <li>Ouvrez <strong>Calendriers</strong> → <strong>Nouveau calendrier</strong> → <strong>Ajouter un calendrier avec abonnement</strong></li>
              <li>Collez le lien et cliquez sur <strong>Rechercher</strong></li>
              <li>Choisissez le nom que vous voulez donner à votre calendrier</li>
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

/**
 * `beforeDangerZone` (lot 34, point 10) : blocs de la page « Mon compte »
 * (Gestion des notifications, rétractation, données, informations légales)
 * rendus AVANT la « Zone dangereuse », qui reste le dernier bloc de la page.
 * Enveloppe à clé (`display: contents`) : ces blocs gardent leur état
 * quand le squelette de chargement laisse place au contenu.
 */
export default function InformationsTab(props: { beforeDangerZone?: ReactNode } = {}) {
  // Lot 92 : fenêtre de réauthentification UNIQUE (Sécurité, suppression du compte).
  return (
    <ReauthProvider>
      <InformationsTabContent {...props} />
    </ReauthProvider>
  );
}

function InformationsTabContent({ beforeDangerZone }: { beforeDangerZone?: ReactNode } = {}) {
  const router = useRouter();
  // Lot 97B (COM-01/05) : aucun bouton d'offre dans l'application.
  const commerceHidden = useNativeCommerceHidden();
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

  const [calToken, setCalToken] = useState<string | null>(null);
  const [calActive, setCalActive] = useState(false);
  const [calGenerating, setCalGenerating] = useState(false);
  const [calToggling, setCalToggling] = useState(false);

  useEffect(() => {
    if (!sessionLoading && sessionUser) {
      fetchData();
    }
  }, [sessionLoading, sessionUser]);

  // Arrivée par #sync-agenda (page Agenda) : le tiroir s'ouvre seul (CollapsibleCard anchorId).

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
      <div className="flex w-full max-w-full flex-col gap-6">
        <Skeleton className="h-[200px] w-full" />
        <Skeleton className="h-[300px] w-full" />
        {beforeDangerZone && <div key="avant-zone-dangereuse" className="contents">{beforeDangerZone}</div>}
      </div>
    );
  }

  const profileChanged = JSON.stringify(profile) !== JSON.stringify(initialProfile);

  return (
    // Tous les blocs en tiroirs fermés, sur le modèle « Informations légales » :
    // un titre, une ligne, le chevron — aucun autre bouton avant ouverture.
    <div className="flex w-full max-w-full flex-col gap-6">

      {/* Profil */}
      <CollapsibleCard
        icon={<User className="w-5 h-5" />}
        title="Mon profil"
        description="Vos informations personnelles et votre nom d’utilisateur."
        contentClassName="space-y-3"
      >
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
          <div className="space-y-1.5">
            <Label htmlFor="email">Adresse e-mail</Label>
            <Input id="email" value={profile.email} disabled className="bg-muted" />
            {/* Lot 96A (CDC 18 Q8) : le changement d'adresse se fait dans la carte Sécurité (confirmation d'identité, lien à la nouvelle adresse). */}
            <p className="text-xs text-muted-foreground">
              Pour la changer : <a href="#securite" className="text-primary hover:underline">Sécurité › Méthodes de connexion</a>.
            </p>
          </div>
        </div>
        <div className="flex justify-end">
          <button
            onClick={handleSaveProfile}
            disabled={!profileChanged || savingProfile}
            className="btn-add disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
          >
            {savingProfile ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {savingProfile ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </CollapsibleCard>

      {/* Le bloc « Abonnement » faisait doublon avec « Mon abonnement »
          (SubscriptionSummary, en tête de page) : il est supprimé. */}

      {/* Sécurité — lot 92 : 4 blocs (CDC 18 §27), réauthentification 5 min (§18). */}
      <SecurityCard />

      {/* Synchronisation agenda — ancre utilisée par la page Agenda */}
      <CollapsibleCard
        anchorId="sync-agenda"
        icon={<Calendar className="w-5 h-5" />}
        title="Synchronisation agenda"
        description="Retrouvez vos échéances dans Google Agenda, Apple Agenda ou Outlook."
        contentClassName="space-y-4"
      >
        {subscription?.plan_type === 'STANDARD' ? (() => {
          const premiumTheme = getPlanTheme('PREMIUM');
          return (
            <div className={`flex flex-col sm:flex-row sm:items-start gap-3 rounded-lg border border-dashed ${premiumTheme.colors.border} bg-[color:var(--accent-soft)] px-3 py-3`}>
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <Lock className={`w-4 h-4 ${premiumTheme.colors.text} mt-0.5 flex-shrink-0`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Disponible en Premium</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Synchronisez vos événements avec Google Agenda, Apple Agenda ou Outlook.</p>
                </div>
              </div>
              {commerceHidden ? <NativeCommerceNotice /> : (
                <Button size="sm" variant="outline" className="w-full sm:w-auto sm:shrink-0 border-[color:var(--border-info)] text-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] gap-1 rounded-full" onClick={() => router.push('/mon-compte/offres')}>
                  <Crown className="w-3.5 h-3.5" />Passer Premium
                </Button>
              )}
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
      </CollapsibleCard>

      {/* Historique des modifications automatiques IA */}
      <AiHistoryBlock />

      {/* Lot 34 (point 10) : Gestion des notifications et blocs suivants, puis
          la Zone dangereuse, en dernier. */}
      {beforeDangerZone && <div key="avant-zone-dangereuse" className="contents">{beforeDangerZone}</div>}

      {/* Zone dangereuse — dernier bloc de « Mon compte » */}
      <DeleteAccountCard
        duoRole={sessionUser?.duoRole ?? null}
        hasPaidSubscription={Boolean(subscription?.has_stripe_subscription)}
      />

    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
   Composant : suppression de compte — différée de 30 jours
   (décision produit ; AID-ACCOUNT-006). Clôture immédiate, annulation et
   export possibles pendant 30 jours, suppression définitive ensuite.
───────────────────────────────────────────────────────────────── */
const DELETION_DELAY_DAYS = 30;
const REQUIRED_TEXT = 'SUPPRIMER MON COMPTE';

function formatLongDate(d: Date): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long' }).format(d);
}

function DeleteAccountCard({ duoRole, hasPaidSubscription }: {
  duoRole: 'BILLING_OWNER' | 'MEMBER' | null;
  hasPaidSubscription: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Date indicative affichée avant confirmation ; la date qui fait foi est
  // celle renvoyée par le serveur (et rappelée par e-mail).
  const plannedDate = formatLongDate(new Date(Date.now() + DELETION_DELAY_DAYS * 24 * 60 * 60 * 1000));

  const { withReauth } = useReauth();

  const resetDialog = () => {
    setStep(1);
    setConfirmation('');
    setDeleting(false);
    setError(null);
  };

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) resetDialog();
  };

  const handleDelete = async () => {
    if (confirmation !== REQUIRED_TEXT) return;
    setDeleting(true);
    setError(null);
    try {
      // Lot 92 (CDC 18 §25, REAUTH-07) : texte de confirmation + identité
      // confirmée (fenêtre unique, 5 min ; preuve consommée par la clôture).
      // `apiClient` : renouvelle la session si besoin (point d'attention 53A).
      const d = await withReauth(
        () => apiClient.post<{ redirectTo?: string }>('/api/users/me/deletion', { confirmation }),
        'Avant de supprimer votre compte.',
        // Lot 93 : compte sans mot de passe → Google / Apple ; au retour, la carte se rouvre.
        'delete-account',
      );
      localStorage.removeItem('user');
      toast.success('Votre compte est clôturé. Sa suppression est programmée.');
      setOpen(false);
      // Session rouverte en mode « compte en cours de suppression ».
      router.replace(d?.redirectTo || '/compte-en-suppression');
    } catch (e) {
      setError(e instanceof ApiClientError && e.serverMessage ? e.serverMessage : 'Une erreur est survenue. Veuillez réessayer.');
      setDeleting(false);
    }
  };

  return (
    <CollapsibleCard
      anchorId="delete-account"
      className="border-[color:var(--danger-edge)] bg-[color:var(--danger-soft)]"
      titleClassName="text-[color:var(--danger)]"
      icon={<Trash2 className="w-5 h-5 text-[color:var(--danger)]" />}
      title="Zone dangereuse"
      description="Clôturer votre compte, puis le supprimer définitivement."
      contentClassName="space-y-4"
    >
      <p className="text-sm text-muted-foreground">
        Votre compte est clôturé immédiatement, puis supprimé définitivement {DELETION_DELAY_DAYS} jours plus tard.
        Pendant ce délai, vous pouvez annuler la suppression ou exporter vos données.
      </p>
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger asChild>
            <Button variant="outline" className="border-[color:var(--danger-edge)] text-[color:var(--danger)] hover:bg-[color:var(--danger-soft)] hover:border-[color:var(--danger)] gap-2 btn-delete">
              <Trash2 className="w-4 h-4 btn-delete-trash-icon" />
              Supprimer mon compte
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">

            {/* ── Étape 1 : conséquences et date ── */}
            {step === 1 && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-[color:var(--danger)]">
                    <AlertTriangle className="w-5 h-5" />
                    Supprimer votre compte
                  </DialogTitle>
                  <DialogDescription className="sr-only">Conséquences de la suppression du compte</DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2 text-sm">
                  <div className="rounded-lg border border-[color:var(--attention-edge)] bg-[color:var(--attention-soft)] px-4 py-3 space-y-1.5">
                    <p className="font-semibold text-[color:var(--text-warning)]">Ce qui se passe dès votre confirmation</p>
                    <ul className="text-[color:var(--text-secondary)] space-y-1 list-disc list-inside">
                      <li>Votre compte est <strong>clôturé</strong> : vos autres appareils sont déconnectés et vous ne pouvez plus utiliser Verebona normalement.</li>
                      {hasPaidSubscription && (
                        <li>Votre <strong>abonnement ne sera plus renouvelé</strong>. La période en cours n’est pas remboursée : ce n’est pas une rétractation.</li>
                      )}
                      {duoRole === 'BILLING_OWNER' && (
                        <li>Votre <strong>Premium Duo prend fin</strong> : le second utilisateur perd l’accès à votre espace. Il conserve son propre compte et ses propres biens.</li>
                      )}
                      {duoRole === 'MEMBER' && (
                        <li>Vous <strong>quittez le Premium Duo</strong>. Les biens de l’espace partagé, y compris ceux que vous y avez ajoutés, restent au titulaire.</li>
                      )}
                    </ul>
                  </div>

                  <div className="rounded-lg border border-[color:var(--danger-edge)] bg-[color:var(--danger-soft)] px-4 py-3 space-y-1.5">
                    <p className="font-semibold text-[color:var(--danger)]">Le {plannedDate}, suppression définitive de :</p>
                    <ul className="text-[color:var(--text-secondary)] space-y-1 list-disc list-inside">
                      <li>vos <strong>biens</strong> et toutes leurs informations ;</li>
                      <li>vos <strong>documents, photos et fichiers</strong> stockés ;</li>
                      <li>votre <strong>agenda</strong>, vos échéances et vos fournisseurs ;</li>
                      <li>l’historique de l’<strong>assistant</strong>, vos notifications et vos exports ;</li>
                      <li>votre <strong>profil</strong> et vos identifiants de connexion.</li>
                    </ul>
                    <p className="text-xs text-[color:var(--text-muted)] pt-1">
                      Restent conservés, détachés de votre compte : les factures, les preuves d’acceptation des conditions générales, vos éventuelles demandes de rétractation, ainsi que la trace de votre demande de suppression et son inscription au registre des demandes RGPD (sans votre adresse e-mail).
                    </p>
                  </div>

                  <div className="rounded-lg border border-[color:var(--border-subtle)] px-4 py-3 space-y-1">
                    <p className="font-semibold">Jusqu’au {plannedDate}</p>
                    <p className="text-[color:var(--text-secondary)]">
                      Reconnectez-vous pour <strong>annuler la suppression</strong> ou <strong>exporter vos données</strong>.
                      Annuler rétablit votre accès, mais ne réactive pas l’abonnement ni le partage Duo.
                      Un e-mail de rappel vous est envoyé 7 jours avant la suppression.
                    </p>
                  </div>

                  <p className="text-xs text-[color:var(--text-muted)]">
                    Conseil : exportez dès maintenant vos données depuis « Mes données », dans Mon compte.
                  </p>
                </div>
                <DialogFooter className="gap-2">
                  <Button variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
                  <Button
                    variant="outline"
                    className="border-[color:var(--danger-edge)] text-[color:var(--danger)] hover:bg-[color:var(--danger-soft)]"
                    onClick={() => setStep(2)}
                  >
                    Je comprends, continuer
                  </Button>
                </DialogFooter>
              </>
            )}

            {/* ── Étape 2 : confirmation renforcée (texte + identité confirmée, lot 92) ── */}
            {step === 2 && (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-[color:var(--danger)]">
                    <Trash2 className="w-5 h-5" />
                    Confirmation
                  </DialogTitle>
                  <DialogDescription className="sr-only">Saisie du texte de confirmation</DialogDescription>
                </DialogHeader>
                <div className="py-2 space-y-4">
                  <p className="text-sm text-[color:var(--text-secondary)]">
                    Pour confirmer, recopiez exactement le texte ci-dessous&nbsp;:
                  </p>
                  <div className="rounded-md bg-[color:var(--bg-page)] border border-[color:var(--border-subtle)] px-3 py-2 text-center">
                    <code className="text-sm font-mono font-bold text-[color:var(--danger)] select-all">{REQUIRED_TEXT}</code>
                  </div>
                  <Input
                    aria-label="Texte de confirmation"
                    placeholder={REQUIRED_TEXT}
                    value={confirmation}
                    onChange={e => setConfirmation(e.target.value)}
                    className={`font-mono ${confirmation === REQUIRED_TEXT ? 'border-[color:var(--danger)]' : ''}`}
                    disabled={deleting}
                    autoFocus
                  />
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Pour votre sécurité, votre identité vous sera demandée si vous ne l’avez pas confirmée depuis moins de 5 minutes.
                  </p>
                  <p className="text-xs text-[color:var(--text-muted)]">
                    Votre compte sera clôturé immédiatement et supprimé définitivement le {plannedDate}.
                  </p>
                  {error && <p className="text-sm text-[color:var(--danger)]" role="alert">{error}</p>}
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
                    {deleting ? 'Clôture…' : 'Clôturer et supprimer mon compte'}
                  </Button>
                </DialogFooter>
              </>
            )}

          </DialogContent>
        </Dialog>
    </CollapsibleCard>
  );
}
