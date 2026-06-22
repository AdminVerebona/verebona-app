"use client";

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Users, User, Building2, Crown, Loader2, ArrowLeft,
  Shield, Activity, CreditCard,
  Copy, Check, UserMinus, Save, RefreshCw,
  Package, Trash2, AlertTriangle, Ban, Power,
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
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { toast } from 'sonner';
import { apiClient } from '@/lib/api-client';
import { getPlanTheme } from '@/lib/plan-theme';

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
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
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
  joinedAt: number | string | null;
  invitedAt: number | string;
}

interface AccountDetail {
  account: {
    id: number;
    name: string;
    ownerUserId: number;
    planType: string;
    subscriptionTier: string;
    subscriptionStatus: string;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    premiumUntil: number | null;
    proUntil: number | null;
    maxMembers: number;
    isActive: boolean;
    createdAt: number | string;
    updatedAt: number | string;
    ownerEmail: string;
    ownerName: string;
  };
  members: AccountMember[];
  assets: Array<{
    id: number;
    name: string;
    category: string;
    status: string;
    createdAt: number | string;
  }>;
  auditLogs: Array<{
    id: number;
    actionType: string;
    userEmail: string;
    details: string | null;
    timestamp: number | string;
  }>;
  duoAccount: DuoAccountData | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDate(v: number | string | Date | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  // ISO string (tstz columns returned as string by Drizzle/JSON serialization)
  if (typeof v === 'string' && (v.includes('T') || v.includes('-'))) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  // Unix seconds integer (premium_until, etc.)
  const ms = typeof v === 'number' ? v * 1000 : Number(v) * 1000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

function fmtDate(v: number | string | Date | null | undefined, fmt: string): string {
  const d = toDate(v);
  if (!d) return '—';
  try { return format(d, fmt, { locale: fr }); } catch { return '—'; }
}

function PlanBadge({ plan }: { plan: string }) {
  const theme = getPlanTheme(plan as any);
  const bgClass = theme.colors.bg.replace('bg-', 'bg-');
  const textClass = theme.colors.text;
  const borderClass = theme.colors.border.replace('border-', 'border-');

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold border ${bgClass} ${textClass} ${borderClass}`}>
      {plan}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const active = status === 'active';
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${active ? 'bg-emerald-500' : 'bg-zinc-500'}`} />
  );
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="ml-1.5 text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AccountDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [data, setData] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit state
  const [editPlan, setEditPlan] = useState<string>('STANDARD');
  const [editStripeCustomer, setEditStripeCustomer] = useState('');
  const [editStripeSubscription, setEditStripeSubscription] = useState('');
  const [editSubStatus, setEditSubStatus] = useState('NONE');
  const [editPremiumUntil, setEditPremiumUntil] = useState('');
  const [editMaxMembers, setEditMaxMembers] = useState('1');
  const [saving, setSaving] = useState(false);
  const [suspending, setSuspending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removingMember, setRemovingMember] = useState<number | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const d = await apiClient.get<AccountDetail>(`/api/admin/accounts/${params.id}`);
      setData(d);
      const plan = d.account.planType;
      setEditPlan(plan);
      setEditStripeCustomer(d.account.stripeCustomerId ?? '');
      setEditStripeSubscription(d.account.stripeSubscriptionId ?? '');
      // For STANDARD, always show clean defaults regardless of stale DB values
      if (plan === 'STANDARD') {
        setEditSubStatus('NONE');
        setEditPremiumUntil('');
        setEditMaxMembers('1');
      } else {
        setEditSubStatus(d.account.subscriptionStatus ?? 'NONE');
        setEditPremiumUntil(d.account.premiumUntil ? new Date(d.account.premiumUntil * 1000).toISOString().split('T')[0] : '');
        setEditMaxMembers(String(d.account.maxMembers ?? 1));
      }
    } catch {
      setError('Erreur lors du chargement du compte');
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  const handleSavePlan = async () => {
    setSaving(true);
    try {
      await apiClient.patch(`/api/admin/accounts/${params.id}`, {
        planType: editPlan,
        stripeCustomerId: editStripeCustomer || null,
        stripeSubscriptionId: editStripeSubscription || null,
        subscriptionStatus: editSubStatus || 'NONE',
        premiumUntil: editPremiumUntil ? Math.floor(new Date(editPremiumUntil).getTime() / 1000) : null,
        maxMembers: parseInt(editMaxMembers) || 1,
      });
      toast.success('Plan mis à jour');
      load();
    } catch (e) {
      toast.error((e as Error).message || 'Erreur');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSuspend = async () => {
    if (!data) return;
    setSuspending(true);
    try {
      await apiClient.patch(`/api/admin/accounts/${params.id}`, { isActive: !data.account.isActive });
      toast.success(data.account.isActive ? 'Compte suspendu' : 'Compte réactivé');
      load();
    } catch (e) {
      toast.error((e as Error).message || 'Erreur');
    } finally {
      setSuspending(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    try {
      await apiClient.delete(`/api/admin/accounts/${params.id}`);
      toast.success('Compte supprimé définitivement');
      router.push('/admin/accounts');
    } catch (e) {
      toast.error((e as Error).message || 'Erreur lors de la suppression');
      setDeleting(false);
      setDeleteConfirmInput('');
    }
  };

  const handleRemoveMember = async (membershipId: number) => {
    setRemovingMember(membershipId);
    try {
      await apiClient.patch(`/api/admin/accounts/${params.id}`, { removeMembershipId: membershipId });
      toast.success('Membre retiré du compte');
      load();
    } catch (e) {
      toast.error((e as Error).message || 'Erreur');
    } finally {
      setRemovingMember(null);
    }
  };


  if (loading) {
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
        <p className="text-destructive">{error || 'Compte non trouvé'}</p>
      </div>
    );
  }

  const { account, assets, auditLogs, duoAccount } = data;
  const duoIsActive = duoAccount && ['ACTIVE', 'PAST_DUE_GRACE'].includes(duoAccount.subscriptionStatus);
  const activeMembers = data.members.filter(m => m.status === 'active');
  const pendingMembers = data.members.filter(m => m.status === 'pending');

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
              ID #{account.id} · Créé le {fmtDate(account.createdAt, 'dd MMM yyyy')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <PlanBadge plan={account.planType} />
          {duoIsActive && <PlanBadge plan="PREMIUM_DUO" />}
          <Badge variant={account.isActive ? 'outline' : 'destructive'}>
            {account.isActive ? 'Actif' : 'Suspendu'}
          </Badge>
          <Button
            variant={account.isActive ? 'outline' : 'default'}
            size="sm"
            onClick={handleToggleSuspend}
            disabled={suspending}
            className="gap-1.5 text-xs"
          >
            {suspending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : account.isActive ? <Ban className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
            {account.isActive ? 'Suspendre' : 'Réactiver'}
          </Button>
          <Button variant="ghost" size="icon" onClick={load} title="Rafraîchir">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* ═══ Colonne gauche (2/3) ═══ */}
        <div className="lg:col-span-2 space-y-6">

          {/* ── Membres du compte ── */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h2 className="font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                Membres du compte
              </h2>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>{activeMembers.length} actif{activeMembers.length !== 1 ? 's' : ''}</span>
                {pendingMembers.length > 0 && (
                  <span className="text-amber-500">· {pendingMembers.length} en attente</span>
                )}
                <span className="text-xs">/ max {account.maxMembers}</span>
              </div>
            </div>
            <div className="divide-y">
              {data.members.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted-foreground text-center italic">Aucun membre</p>
              ) : (
                data.members.map(m => (
                  <div key={m.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{m.name || m.email}</p>
                      <p className="text-xs text-muted-foreground truncate">{m.email}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 text-xs">
                      <span className={`px-2 py-0.5 rounded-full font-medium ${
                        m.role === 'owner' ? 'bg-amber-500/15 text-amber-400' : 'bg-zinc-500/15 text-zinc-400'
                      }`}>
                        {m.role === 'owner' ? 'Propriétaire' : 'Membre'}
                      </span>
                      <span className={`flex items-center gap-1 ${
                        m.status === 'active' ? 'text-emerald-500' :
                        m.status === 'pending' ? 'text-amber-500' : 'text-zinc-500'
                      }`}>
                        <StatusDot status={m.status} />
                        {m.status === 'pending' ? 'En attente' : m.status}
                      </span>
                      {m.userId && (
                        <button
                          className="text-muted-foreground hover:text-foreground underline"
                          onClick={() => router.push(`/admin/users/${m.userId}`)}
                        >
                          voir
                        </button>
                      )}
                      {m.role !== 'owner' && !['removed'].includes(m.status) && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <button className="text-destructive/70 hover:text-destructive" title="Retirer ce membre">
                              {removingMember === m.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserMinus className="h-3 w-3" />}
                            </button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Retirer ce membre ?</AlertDialogTitle>
                              <AlertDialogDescription>
                                {m.name || m.email} sera retiré du compte. Cette action peut être annulée en réinvitant l'utilisateur.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Annuler</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive hover:bg-destructive/90"
                                onClick={() => handleRemoveMember(m.id)}
                              >
                                Retirer
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {/* ── Abonnement & Plan ── */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b">
              <h2 className="font-semibold flex items-center gap-2">
                <Crown className="h-4 w-4 text-amber-400" />
                Abonnement & Plan
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">Informations Stripe et gestion manuelle</p>
            </div>

            <div className="px-5 py-5 space-y-6">
              {/* Stripe read-only */}
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                  <CreditCard className="h-3.5 w-3.5" /> Stripe (lecture seule)
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {[
                    { label: 'Customer ID', value: account.stripeCustomerId },
                    { label: 'Subscription ID', value: account.stripeSubscriptionId },
                    { label: 'Statut', value: account.subscriptionStatus || 'NONE' },
                    { label: 'Premium jusqu\'au', value: account.premiumUntil ? fmtDate(account.premiumUntil, 'dd/MM/yyyy') : '—' },
                  ].map(({ label, value }) => (
                    <div key={label} className="rounded-lg border bg-muted/30 px-3 py-2.5">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">{label}</p>
                      <div className="flex items-center">
                        <span className="text-xs font-mono truncate">{value || '—'}</span>
                        {value && value !== '—' && ['Customer ID', 'Subscription ID'].includes(label) && (
                          <CopyBtn value={value} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              {/* Edit plan */}
              <div className="space-y-4">
                <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5" /> Modifier le plan (override admin)
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Type de plan</Label>
                    <Select value={editPlan} onValueChange={(val) => {
                      setEditPlan(val);
                      if (val === 'STANDARD') {
                        setEditPremiumUntil('');
                        setEditSubStatus('NONE');
                        setEditMaxMembers('1');
                      } else if (val === 'PREMIUM') {
                        setEditMaxMembers('1');
                      } else if (val === 'PREMIUM_DUO') {
                        setEditMaxMembers('2');
                      }
                    }}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="STANDARD">Standard</SelectItem>
                        <SelectItem value="PREMIUM">Premium</SelectItem>
                        <SelectItem value="PREMIUM_DUO">Premium Duo</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Statut abonnement</Label>
                    <Select value={editSubStatus} onValueChange={setEditSubStatus}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">NONE</SelectItem>
                        <SelectItem value="ACTIVE">ACTIVE</SelectItem>
                        <SelectItem value="CANCELED">CANCELED</SelectItem>
                        <SelectItem value="EXPIRED">EXPIRED</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Stripe Customer ID</Label>
                    <Input value={editStripeCustomer} onChange={e => setEditStripeCustomer(e.target.value)} placeholder="cus_xxxxx" className="font-mono text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Stripe Subscription ID</Label>
                    <Input value={editStripeSubscription} onChange={e => setEditStripeSubscription(e.target.value)} placeholder="sub_xxxxx" className="font-mono text-xs" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Premium valide jusqu'au</Label>
                    <Input type="date" value={editPremiumUntil} onChange={e => setEditPremiumUntil(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Membres max</Label>
                    <Input type="number" min="1" value={editMaxMembers} onChange={e => setEditMaxMembers(e.target.value)} />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button onClick={handleSavePlan} disabled={saving} className="gap-2">
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Enregistrer
                  </Button>
                </div>
              </div>

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
                        <td className="px-5 py-3">
                          <span className="font-medium text-xs">{log.actionType}</span>
                        </td>
                        <td className="px-5 py-3 text-xs text-muted-foreground">{log.userEmail}</td>
                        <td className="px-5 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          {fmtDate(log.timestamp, 'dd/MM/yyyy HH:mm')}
                        </td>
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

          {/* Infos compte */}
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-5 py-4 border-b">
              <h2 className="font-semibold text-sm flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                Propriétaire
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
                <User className="h-3.5 w-3.5" /> Voir le profil utilisateur
              </Button>
            </div>
          </section>

          {/* Biens */}
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
                    <p className="text-[10px] text-muted-foreground mt-0.5">{fmtDate(asset.createdAt, 'dd/MM/yyyy')}</p>
                  </button>
                ))
              )}
            </div>
          </section>
          {/* Danger zone */}
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
                      ? 'Bloque l\'accès de tous les membres. Réversible.'
                      : 'Restaure l\'accès de tous les membres.'}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleToggleSuspend}
                  disabled={suspending}
                  className={`gap-1.5 text-xs shrink-0 ${account.isActive ? 'border-destructive/40 text-destructive hover:bg-destructive/10' : 'border-emerald-500/40 text-emerald-500 hover:bg-emerald-500/10'}`}
                >
                  {suspending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : account.isActive ? <Ban className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                  {account.isActive ? 'Suspendre' : 'Réactiver'}
                </Button>
              </div>

              <div className="rounded-lg border border-destructive/30 bg-background p-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-medium text-destructive">Supprimer définitivement</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Supprime le compte, l'utilisateur propriétaire, tous les biens et données associées. <strong>Irréversible.</strong>
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
                            <li>Le compte et tous ses membres</li>
                            <li>L'utilisateur propriétaire ({account.ownerEmail})</li>
                            <li>Tous les biens ({assets.length})</li>
                            <li>L'historique d'audit</li>
                            <li>Les données Premium Duo associées</li>
                          </ul>
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
