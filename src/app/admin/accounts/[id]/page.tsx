"use client";

/**
 * Fiche compte — CDC Back-Office V1 §5.2 et §5.3.
 *
 * Lecture seule pour le métier (GEN-001, ACC-D04) : plus aucune édition des
 * identifiants Stripe, de la périodicité, de `premiumUntil`, du nombre de
 * membres ni du statut d'abonnement ; plus de retrait de membre.
 *
 * Actions autorisées (matrice §20) :
 *   - suspendre / réactiver (ACC-A01..A05), avec confirmation (UX-002) ;
 *   - changement exceptionnel d'offre (ACC-A06..A13), Stripe d'abord ;
 *   - suppression définitive par le workflow unique (ACC-A14..A17) ;
 *   - « Ouvrir dans Stripe » (SUB-011, UX-008), sans afficher d'identifiant
 *     (SUB-012) ; resynchronisation Stripe conservée comme outil de diagnostic.
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Users, User, Building2, Crown, Loader2, ArrowLeft,
  Activity, CreditCard, RefreshCw, ExternalLink,
  Package, Trash2, AlertTriangle, Ban, Power, Gauge, Receipt,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { getPlanTheme } from '@/lib/plan-theme';
import { formatBytes, formatDate, formatDateTime, formatMoney } from '@/lib/admin/format';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { AccountWithdrawals } from './_components/AccountWithdrawals';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DuoMember {
  id: number;
  userId: number | null;
  status: string;
  slot: number | null;
  email: string | null;
  name: string | null;
}

interface DuoAccountData {
  id: number;
  subscriptionStatus: string;
  activatedAt: string | null;
  createdAt: string | null;
  members: DuoMember[];
}

interface AccountMember {
  id: number;
  userId: number | null;
  email: string;
  name: string;
  role: string;
  status: string;
  joinedAt: string | null;
  invitedAt: string;
}

interface Quota { used: number; limit: number | null }

interface Payment {
  id: number;
  date: string;
  amountCents: number;
  currency: string;
  status: string;
  plan: string;
  stripeUrl: string | null;
}

interface AccountDetail {
  account: {
    id: number;
    name: string;
    ownerUserId: number;
    planType: string;
    subscriptionStatus: string;
    subscriptionStartedAt: string | null;
    planRenewalDate: string | null;
    premiumUntil: number | null;
    isActive: boolean;
    createdAt: string;
    lastLoginAt: string | null;
    ownerEmail: string;
    ownerName: string;
  };
  /** Ligne account_subscriptions : source des droits effectifs. */
  subscription: {
    planCode: string;
    status: string;
    billingPeriod: 'monthly' | 'yearly' | null;
    currentPeriodStartAt: string | null;
    currentPeriodEndAt: string | null;
    contractConcludedAt: string | null;
    firstBilledAt: string | null;
    cancelAtPeriodEnd: boolean;
    trialEndsAt: string | null;
  } | null;
  stripeLinks: { customer: string | null; subscription: string | null };
  quotas: {
    assets: Quota;
    documents: Quota;
    users: Quota;
    storage: { usedBytes: number; limitBytes: number };
  };
  payments: Payment[];
  assignablePlans: string[];
  members: AccountMember[];
  assets: Array<{ id: number; name: string; category: string; status: string; createdAt: string }>;
  auditLogs: Array<{ id: number; actionType: string; userEmail: string; details: string | null; timestamp: string }>;
  duoAccount: DuoAccountData | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PLAN_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  PREMIUM: 'Premium',
  PREMIUM_DUO: 'Premium Duo',
  standard: 'Standard',
  premium: 'Premium',
  premium_duo: 'Premium Duo',
};

const PAYMENT_STATUS: Record<string, { label: string; cls: string }> = {
  paid: { label: 'Payé', cls: 'text-emerald-400' },
  open: { label: 'En attente', cls: 'text-amber-400' },
  draft: { label: 'Brouillon', cls: 'text-zinc-400' },
  // SUB-010 : l'échec est identifié, sans motif technique.
  uncollectible: { label: 'Échec', cls: 'text-red-400' },
  void: { label: 'Annulé', cls: 'text-zinc-400' },
  failed: { label: 'Échec', cls: 'text-red-400' },
};

function PlanBadge({ plan }: { plan: string }) {
  const theme = getPlanTheme(plan);
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold border ${theme.colors.bg} ${theme.colors.text} ${theme.colors.border}`}>
      {PLAN_LABEL[plan] ?? plan}
    </span>
  );
}

function StripeLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return null;
  return (
    <Button asChild variant="outline" size="sm" className="gap-1.5 text-xs">
      <a href={href} target="_blank" rel="noopener noreferrer">
        <ExternalLink className="h-3.5 w-3.5" /> {label}
      </a>
    </Button>
  );
}

function QuotaRow({ label, used, limit }: { label: string; used: string | number; limit: string | number | null }) {
  return (
    <div className="flex items-center justify-between text-sm py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">
        {used} <span className="text-muted-foreground">/ {limit ?? '—'}</span>
      </span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AccountDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [data, setData] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newPlan, setNewPlan] = useState<string>('');
  const [changingPlan, setChangingPlan] = useState(false);
  const [syncingStripe, setSyncingStripe] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const d = await apiClient.get<AccountDetail>(`/api/admin/accounts/${params.id}`);
      setData(d);
      setNewPlan(d.account.planType);
    } catch (e) {
      setError((e as Error).message || 'Erreur lors du chargement du compte');
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  /** ACC-A06 : changement exceptionnel ; ERR-005 : un échec Stripe est affiché tel quel. */
  const handleChangePlan = async () => {
    setChangingPlan(true);
    try {
      const res = await apiClient.patch<{ message: string }>(`/api/admin/accounts/${params.id}`, { planType: newPlan });
      toast.success(res.message || 'Offre modifiée');
    } catch (e) {
      toast.error((e as Error).message || "Le changement d'offre a échoué");
    } finally {
      setChangingPlan(false);
      // ERR-003 : état relu depuis la source de vérité, succès comme échec.
      load();
    }
  };

  /** Relit l'abonnement chez Stripe et réécrit l'état complet du compte (diagnostic). */
  const handleSyncStripe = async () => {
    if (!data) return;
    setSyncingStripe(true);
    try {
      const res = await apiClient.post<{ changes: { tierChanged: boolean; oldTier: string; newTier: string } }>(
        `/api/admin/users/${data.account.ownerUserId}/sync-stripe`,
        {},
      );
      toast.success(
        res.changes.tierChanged
          ? `Synchronisé : ${res.changes.oldTier} → ${res.changes.newTier}`
          : 'Déjà à jour avec Stripe',
      );
      load();
    } catch (e) {
      toast.error((e as Error).message || 'Synchronisation impossible');
    } finally {
      setSyncingStripe(false);
    }
  };

  const handleToggleSuspend = async () => {
    if (!data) return;
    setSuspending(true);
    const action = data.account.isActive ? 'suspend' : 'reactivate';
    try {
      await apiClient.post(`/api/admin/accounts/${params.id}/${action}`, {});
      toast.success(
        action === 'suspend'
          ? 'Compte suspendu — sessions de tous les utilisateurs révoquées'
          : 'Compte réactivé',
      );
    } catch (e) {
      toast.error((e as Error).message || 'Erreur');
    } finally {
      setSuspending(false);
      load();
    }
  };

  const handleDeleteAccount = async () => {
    if (!data) return;
    setDeleting(true);
    try {
      await apiClient.delete(`/api/admin/accounts/${params.id}`, {
        body: JSON.stringify({ confirmName: deleteConfirmInput }),
      });
      toast.success('Compte supprimé définitivement');
      router.push('/admin/accounts');
    } catch (e) {
      toast.error((e as Error).message || 'Erreur lors de la suppression');
      setDeleting(false);
      setDeleteConfirmInput('');
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.push('/admin/accounts')}>
          <ArrowLeft className="h-4 w-4 mr-1.5" /> Retour
        </Button>
        <EcranEnErreur titre="Fiche compte indisponible" message={error ?? 'Compte non trouvé'} onRetry={load} />
      </div>
    );
  }

  const { account, assets, auditLogs, duoAccount, subscription, quotas, payments, stripeLinks } = data;
  const periodLabel =
    subscription?.billingPeriod === 'monthly' ? 'Mensuel'
    : subscription?.billingPeriod === 'yearly' ? 'Annuel'
    : '—';
  const renewalValue = subscription?.currentPeriodEndAt ?? account.planRenewalDate;
  const duoIsActive = duoAccount && ['ACTIVE', 'PAST_DUE_GRACE'].includes(duoAccount.subscriptionStatus);
  const activeMembers = data.members.filter(m => m.status === 'active');
  const pendingMembers = data.members.filter(m => m.status === 'pending');
  const lastPayment = payments[0] ?? null;
  const planUnchanged = newPlan === account.planType;

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" className="shrink-0" onClick={() => router.push('/admin/accounts')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Building2 className="h-5 w-5 text-muted-foreground" />
              {account.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              Créé le {formatDate(account.createdAt)} · Dernière connexion : {formatDateTime(account.lastLoginAt)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <PlanBadge plan={account.planType} />
          {duoIsActive && account.planType !== 'PREMIUM_DUO' && <PlanBadge plan="PREMIUM_DUO" />}
          <Badge variant={account.isActive ? 'outline' : 'destructive'}>
            {account.isActive ? 'Actif' : 'Suspendu'}
          </Badge>
          <Button variant="ghost" size="icon" onClick={load} title="Rafraîchir" disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* ═══ Colonne gauche (2/3) ═══ */}
        <div className="lg:col-span-2 space-y-6">

          {/* ── Synthèse abonnement & paiement (§5.2.1) ── */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold flex items-center gap-2">
                  <Crown className="h-4 w-4 text-amber-400" />
                  Abonnement et paiement
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">Consultation — les opérations financières se font dans Stripe</p>
              </div>
              <div className="flex flex-wrap gap-2 justify-end">
                <StripeLink href={stripeLinks.subscription} label="Abonnement dans Stripe" />
                <StripeLink href={stripeLinks.customer} label="Client dans Stripe" />
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs"
                  onClick={handleSyncStripe}
                  disabled={syncingStripe || !stripeLinks.customer}
                  title={stripeLinks.customer ? "Relire l'abonnement chez Stripe" : 'Aucun client Stripe pour ce compte'}
                >
                  {syncingStripe ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Resynchroniser
                </Button>
              </div>
            </div>
            <div className="px-5 py-5 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {[
                { label: 'Offre', value: PLAN_LABEL[account.planType] ?? account.planType },
                {
                  label: 'État de l’abonnement',
                  value: subscription
                    ? `${subscription.status}${subscription.cancelAtPeriodEnd ? ' · fin programmée' : ''}`
                    : account.subscriptionStatus || '—',
                },
                { label: 'Périodicité', value: periodLabel },
                {
                  label: subscription?.cancelAtPeriodEnd ? 'Fin effective' : 'Prochain renouvellement',
                  value: formatDate(renewalValue),
                },
                { label: 'Date de souscription', value: formatDate(account.subscriptionStartedAt ?? subscription?.contractConcludedAt) },
                {
                  label: 'Dernier paiement',
                  value: lastPayment
                    ? `${formatDate(lastPayment.date)} · ${PAYMENT_STATUS[lastPayment.status]?.label ?? lastPayment.status}`
                    : '—',
                },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-lg border bg-muted/30 px-3 py-2.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">{label}</p>
                  <span className="text-xs">{value || '—'}</span>
                </div>
              ))}
            </div>
          </section>

          {/* ── Utilisateurs rattachés (§5.2.2) ── */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                Utilisateurs rattachés
              </h2>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{activeMembers.length} actif{activeMembers.length !== 1 ? 's' : ''}</span>
                {pendingMembers.length > 0 && (
                  <span className="text-amber-500">· {pendingMembers.length} invitation{pendingMembers.length !== 1 ? 's' : ''} en attente</span>
                )}
              </div>
            </div>
            <div className="divide-y">
              {data.members.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted-foreground text-center italic">Aucun utilisateur</p>
              ) : (
                data.members.map(m => (
                  <div key={m.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{m.name?.trim() || m.email}</p>
                      <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs">
                      {/* ACC-D02 : titulaire / second utilisateur explicites. */}
                      <span className={`px-2 py-0.5 rounded-full font-medium ${
                        m.role === 'owner' ? 'bg-amber-500/15 text-amber-400' : 'bg-zinc-500/15 text-zinc-400'
                      }`}>
                        {m.role === 'owner' ? 'Titulaire' : 'Second utilisateur'}
                      </span>
                      <span className={
                        m.status === 'active' ? 'text-emerald-500' :
                        m.status === 'pending' ? 'text-amber-500' : 'text-zinc-500'
                      }>
                        {m.status === 'pending' ? 'Invitation en attente' : m.status === 'active' ? 'Actif' : m.status}
                      </span>
                      {m.userId && (
                        <button
                          className="text-muted-foreground hover:text-foreground underline"
                          onClick={() => router.push(`/admin/users/${m.userId}`)}
                        >
                          fiche
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* ── Paiements (§7.3) ── */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b">
              <h2 className="font-semibold flex items-center gap-2">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                Paiements
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] text-muted-foreground uppercase bg-muted/30">
                  <tr>
                    <th className="px-5 py-2.5 font-medium text-left">Date</th>
                    <th className="px-5 py-2.5 font-medium text-right">Montant</th>
                    <th className="px-5 py-2.5 font-medium text-left">Statut</th>
                    <th className="px-5 py-2.5 font-medium text-left">Offre</th>
                    <th className="px-5 py-2.5 font-medium text-right">Stripe</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {payments.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-5 py-6 text-center text-muted-foreground italic text-xs">
                        Aucun paiement enregistré
                      </td>
                    </tr>
                  ) : (
                    payments.map(p => (
                      <tr key={p.id} className="hover:bg-muted/20">
                        <td className="px-5 py-2.5 text-xs whitespace-nowrap">{formatDateTime(p.date)}</td>
                        <td className="px-5 py-2.5 text-xs text-right tabular-nums">{formatMoney(p.amountCents, p.currency)}</td>
                        <td className={`px-5 py-2.5 text-xs font-medium ${PAYMENT_STATUS[p.status]?.cls ?? ''}`}>
                          {PAYMENT_STATUS[p.status]?.label ?? p.status}
                        </td>
                        <td className="px-5 py-2.5 text-xs">{PLAN_LABEL[p.plan] ?? p.plan}</td>
                        <td className="px-5 py-2.5 text-xs text-right">
                          {p.stripeUrl && (
                            <a href={p.stripeUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline text-muted-foreground hover:text-foreground">
                              Ouvrir <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Rétractations (SUB-015) ── */}
          <AccountWithdrawals accountId={account.id} />

          {/* ── Changement exceptionnel d'offre (ACC-A06) ── */}
          <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 overflow-hidden">
            <div className="px-5 py-4 border-b border-amber-500/20">
              <h2 className="font-semibold flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-amber-400" />
                Changement exceptionnel d’offre
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                À réserver aux cas exceptionnels. Les droits changent immédiatement ; Stripe est mis à jour sans prorata,
                ni débit, ni remboursement : le prix normal de la nouvelle offre s’applique à la prochaine échéance,
                à périodicité inchangée.
              </p>
            </div>
            <div className="px-5 py-4 flex flex-col sm:flex-row sm:items-end gap-3">
              <div className="space-y-1.5 flex-1">
                <Label>Nouvelle offre</Label>
                <Select value={newPlan} onValueChange={setNewPlan}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {data.assignablePlans.map(p => (
                      <SelectItem key={p} value={p}>{PLAN_LABEL[p] ?? p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button disabled={changingPlan || planUnchanged} className="gap-2" title={planUnchanged ? 'Choisissez une offre différente de l’offre actuelle' : undefined}>
                    {changingPlan && <Loader2 className="h-4 w-4 animate-spin" />}
                    Changer l’offre
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Changer l’offre de « {account.name} » ?</AlertDialogTitle>
                    <AlertDialogDescription>
                      {PLAN_LABEL[account.planType] ?? account.planType} → {PLAN_LABEL[newPlan] ?? newPlan}.
                      Action exceptionnelle et journalisée. En cas de refus de Stripe, rien n’est modifié.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Annuler</AlertDialogCancel>
                    <AlertDialogAction onClick={handleChangePlan}>Confirmer le changement</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </section>

          {/* ── Activité récente ── */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b">
              <h2 className="font-semibold flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                Activité récente
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] text-muted-foreground uppercase bg-muted/30">
                  <tr>
                    <th className="px-5 py-2.5 font-medium text-left">Action</th>
                    <th className="px-5 py-2.5 font-medium text-left">Utilisateur</th>
                    <th className="px-5 py-2.5 font-medium text-left">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-5 py-6 text-center text-muted-foreground italic text-xs">
                        Aucune activité enregistrée
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map(log => (
                      <tr key={log.id} className="hover:bg-muted/20">
                        <td className="px-5 py-3"><span className="font-medium text-xs">{log.actionType}</span></td>
                        <td className="px-5 py-3 text-xs text-muted-foreground">{log.userEmail}</td>
                        <td className="px-5 py-3 text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(log.timestamp)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* ═══ Colonne droite (1/3) ═══ */}
        <div className="space-y-6">

          {/* Consommations et quotas (§5.2.3, ACC-D04/D05 : lecture seule, sans alerte) */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b">
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <Gauge className="h-4 w-4 text-muted-foreground" />
                Consommations et quotas
              </h2>
            </div>
            <div className="px-5 py-3 divide-y">
              <QuotaRow label="Biens" used={quotas.assets.used} limit={quotas.assets.limit} />
              <QuotaRow label="Documents" used={quotas.documents.used} limit={quotas.documents.limit} />
              <QuotaRow label="Utilisateurs" used={quotas.users.used} limit={quotas.users.limit} />
              <QuotaRow
                label="Stockage"
                used={formatBytes(quotas.storage.usedBytes)}
                limit={formatBytes(quotas.storage.limitBytes)}
              />
            </div>
          </section>

          {/* Titulaire */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b">
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                Titulaire
              </h2>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <p className="text-sm font-medium">{account.ownerName}</p>
                <p className="text-xs text-muted-foreground">{account.ownerEmail}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start gap-2 text-xs"
                onClick={() => router.push(`/admin/users/${account.ownerUserId}`)}
              >
                <User className="h-3.5 w-3.5" /> Voir la fiche utilisateur
              </Button>
            </div>
          </section>

          {/* Biens (ACC-D06 : diagnostic, sans modification) */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <Package className="h-4 w-4 text-muted-foreground" />
                Biens ({assets.length})
              </h2>
            </div>
            <div className="divide-y max-h-64 overflow-y-auto">
              {assets.length === 0 ? (
                <p className="px-5 py-4 text-xs text-muted-foreground italic text-center">Aucun bien</p>
              ) : (
                assets.map(asset => (
                  <button
                    key={asset.id}
                    className="w-full text-left px-5 py-2.5 hover:bg-muted/30 transition-colors"
                    onClick={() => router.push(`/admin/assets/${asset.id}`)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium truncate">{asset.name}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0 ml-2">{asset.category}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">{formatDate(asset.createdAt)}</p>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* Actions sensibles */}
          <section className="rounded-xl border border-destructive/30 bg-destructive/5 overflow-hidden">
            <div className="px-5 py-4 border-b border-destructive/20">
              <h2 className="font-semibold text-sm flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Zone dangereuse
              </h2>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div className="rounded-lg border border-destructive/20 bg-background p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium">{account.isActive ? 'Suspendre le compte' : 'Réactiver le compte'}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {account.isActive
                      ? 'Déconnecte immédiatement tous les utilisateurs et bloque les connexions. Réversible.'
                      : 'Les utilisateurs pourront se reconnecter avec leurs identifiants actuels.'}
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={suspending}
                      className={`gap-1.5 text-xs shrink-0 ${account.isActive ? 'border-destructive/40 text-destructive hover:bg-destructive/10' : 'border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10'}`}
                    >
                      {suspending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : account.isActive ? <Ban className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                      {account.isActive ? 'Suspendre' : 'Réactiver'}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {account.isActive ? `Suspendre « ${account.name} » ?` : `Réactiver « ${account.name} » ?`}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {account.isActive
                          ? 'Toutes les sessions des utilisateurs du compte sont révoquées immédiatement et aucune nouvelle connexion n’est possible. Aucun e-mail n’est envoyé.'
                          : 'La connexion redevient possible avec les identifiants existants. Aucun e-mail n’est envoyé.'}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Annuler</AlertDialogCancel>
                      <AlertDialogAction onClick={handleToggleSuspend}>
                        {account.isActive ? 'Suspendre' : 'Réactiver'}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              <div className="rounded-lg border border-destructive/30 bg-background p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-destructive">Supprimer définitivement</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Même workflow que la suppression demandée par l’utilisateur. <strong>Irréversible.</strong>
                  </p>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="destructive" size="sm" className="gap-1.5 text-xs shrink-0" disabled={deleting}>
                      {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      Supprimer
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                        <AlertTriangle className="h-5 w-5" />
                        Supprimer « {account.name} » ?
                      </AlertDialogTitle>
                      <AlertDialogDescription asChild>
                        <div className="space-y-3">
                          <span className="block">Cette action est <strong>irréversible</strong>. Seront supprimés :</span>
                          <ul className="list-disc list-inside text-sm space-y-1">
                            <li>Le compte, son titulaire ({account.ownerEmail}) et le second utilisateur éventuel</li>
                            <li>Tous les biens ({assets.length}), documents et fichiers stockés</li>
                          </ul>
                          <span className="block text-xs">
                            Les preuves légales (acceptations des CGSU, rétractations) sont conservées sous forme pseudonymisée.
                            Un abonnement Stripe encore actif doit d’abord être résilié dans Stripe.
                          </span>
                          <div className="space-y-1.5 pt-1">
                            <p className="text-sm font-medium text-foreground">
                              Tapez <strong className="font-mono text-destructive">{account.name}</strong> pour confirmer :
                            </p>
                            <Input
                              value={deleteConfirmInput}
                              onChange={e => setDeleteConfirmInput(e.target.value)}
                              placeholder={account.name}
                              className="font-mono text-sm"
                              autoComplete="off"
                            />
                          </div>
                        </div>
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel onClick={() => setDeleteConfirmInput('')}>Annuler</AlertDialogCancel>
                      <AlertDialogAction
                        className="bg-destructive hover:bg-destructive/90 disabled:opacity-50"
                        disabled={deleteConfirmInput !== account.name}
                        onClick={handleDeleteAccount}
                      >
                        Supprimer définitivement
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </section>
        </div>

      </div>
    </div>
  );
}
