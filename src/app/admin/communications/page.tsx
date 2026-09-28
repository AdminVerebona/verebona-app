"use client";

/**
 * Communications — CDC Back-Office V1 §10.
 *
 * Modèles groupés par événement métier ; sous chaque événement, ses canaux
 * disponibles (e-mail, push, in-app) avec statut, dernier envoi réel et
 * nombre d'envois (COM-001 à COM-003). Pas de compteur d'échecs (COM-004),
 * ni date de modification ni variables techniques (COM-005).
 *
 * Actions : activation par canal avec confirmation (COM-011, COM-012),
 * prévisualisation par canal avec les données du compte de l'administrateur
 * (COM-006 à COM-009), e-mail de test vers l'administrateur connecté
 * uniquement (COM-010). Contenu non éditable (COM-013).
 */
import { useCallback, useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EcranEnErreur } from '@/components/admin/EcranEnErreur';
import { formatDate, formatDateTime, formatMoney } from '@/lib/admin/format';
import { relevantPreviewContexts } from '@/lib/admin/communication-contexts';
import { toast } from 'sonner';
import { Bell, Eye, Loader2, Lock, Mail, MessageSquare, RefreshCw, Send, Smartphone } from 'lucide-react';

type Channel = 'email' | 'push' | 'in_app';

interface ChannelView {
  channel: Channel;
  active: boolean;
  locked: boolean;
  lockReason: string | null;
  lastSentAt: string | null;
  sentCount: number;
}

interface EventView {
  code: string;
  label: string;
  kind: 'notification' | 'transactional';
  emailTemplateCode: string | null;
  channels: ChannelView[];
}

interface Group {
  key: string;
  label: string;
  events: EventView[];
}

interface Preview {
  channel: Channel;
  available: boolean;
  message?: string;
  subject?: string;
  body?: string;
  isHtml?: boolean;
  title?: string;
  recipient?: string;
  incomplete?: boolean;
  needsContext?: boolean;
  rejected?: string[];
}

interface ContextOptions {
  hasAccount: boolean;
  assets: Array<{ id: number; name: string }>;
  documents: Array<{ id: number; title: string; assetName: string | null }>;
  deadlines: Array<{ id: number; title: string; date: string | null }>;
  subscription: { planCode: string; status: string; currentPeriodEndAt: string | null } | null;
  payments?: Array<{ id: number; amount: number; currency: string; status: string; date: string | null; planCode: string | null }>;
  withdrawals?: Array<{ id: number; publicReference: string; status: string; requestedAt: string | null }>;
}

interface ContextSelection { assetId: string; documentId: string; deadlineId: string; paymentId: string; withdrawalId: string }
const EMPTY_SELECTION: ContextSelection = { assetId: '', documentId: '', deadlineId: '', paymentId: '', withdrawalId: '' };

/** COM-008 : libellé d'un paiement dans le sélecteur (montant, date, statut). */
const PAYMENT_STATUS: Record<string, string> = { paid: 'payé', open: 'en attente', draft: 'brouillon', uncollectible: 'impayé', void: 'annulé', failed: 'échoué' };
function paymentOptionLabel(p: { amount: number; currency: string; status: string; date: string | null }): string {
  return `${formatMoney(p.amount, p.currency)} — ${p.date ? formatDate(p.date) : 'date inconnue'} (${PAYMENT_STATUS[p.status] ?? p.status})`;
}

const CHANNEL_META: Record<Channel, { label: string; icon: typeof Mail }> = {
  email: { label: 'E-mail', icon: Mail },
  push: { label: 'Push', icon: Smartphone },
  in_app: { label: 'In-app', icon: Bell },
};

export default function AdminCommunicationsPage() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pending, setPending] = useState<{ event: EventView; channel: ChannelView } | null>(null);
  const [saving, setSaving] = useState(false);

  const [preview, setPreview] = useState<{ event: EventView; channel: Channel; data: Preview | null } | null>(null);
  const [ctxOptions, setCtxOptions] = useState<ContextOptions | null>(null);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ContextSelection>(EMPTY_SELECTION);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/communications', { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setGroups(payload.groups ?? []);
    } catch (err) {
      // ERR-001 : pas de donnée partielle présentée comme complète.
      setGroups(null);
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const applyToggle = async () => {
    if (!pending) return;
    const target = !pending.channel.active;
    setSaving(true);
    try {
      const res = await fetch('/api/admin/communications/channels', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventCode: pending.event.code,
          channel: pending.channel.channel,
          isActive: target,
          confirmed: true,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      toast.success(target ? 'Canal activé' : 'Canal désactivé');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setSaving(false);
      setPending(null);
      // ERR-003 : état relu depuis le serveur.
      void load();
    }
  };

  /** COM-008 : objets du compte de l'administrateur, chargés une fois. */
  const loadContextOptions = useCallback(async () => {
    setCtxError(null);
    try {
      const res = await fetch('/api/admin/communications/preview-context', { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setCtxOptions(payload as ContextOptions);
    } catch (err) {
      setCtxError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  }, []);

  const fetchPreview = async (event: EventView, channel: Channel, sel: ContextSelection) => {
    setPreview({ event, channel, data: null });
    try {
      const qs = new URLSearchParams({ eventCode: event.code, channel });
      if (sel.assetId) qs.set('assetId', sel.assetId);
      if (sel.documentId) qs.set('documentId', sel.documentId);
      if (sel.deadlineId) qs.set('deadlineId', sel.deadlineId);
      const rel = relevantPreviewContexts(event.code, event.emailTemplateCode);
      if (rel.payment && sel.paymentId) qs.set('paymentId', sel.paymentId);
      if (rel.withdrawal && sel.withdrawalId) qs.set('withdrawalId', sel.withdrawalId);
      const res = await fetch(`/api/admin/communications/preview?${qs}`, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setPreview({ event, channel, data: payload });
    } catch (err) {
      setPreview({ event, channel, data: { channel, available: false, message: err instanceof Error ? err.message : 'Erreur inconnue' } });
    }
  };

  const openPreview = async (event: EventView, channel: Channel) => {
    if (!ctxOptions) void loadContextOptions();
    await fetchPreview(event, channel, selection);
  };

  const changeSelection = (next: Partial<ContextSelection>) => {
    const sel = { ...selection, ...next };
    setSelection(sel);
    if (preview) void fetchPreview(preview.event, preview.channel, sel);
  };

  const sendTest = async (event: EventView, sel: ContextSelection = EMPTY_SELECTION) => {
    setTesting(event.code);
    const rel = relevantPreviewContexts(event.code, event.emailTemplateCode);
    try {
      const res = await fetch('/api/admin/communications/test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventCode: event.code,
          ...(sel.assetId ? { assetId: Number(sel.assetId) } : {}),
          ...(sel.documentId ? { documentId: Number(sel.documentId) } : {}),
          ...(sel.deadlineId ? { deadlineId: Number(sel.deadlineId) } : {}),
          ...(rel.payment && sel.paymentId ? { paymentId: Number(sel.paymentId) } : {}),
          ...(rel.withdrawal && sel.withdrawalId ? { withdrawalId: Number(sel.withdrawalId) } : {}),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      toast.success(
        `E-mail de test envoyé à ${payload.to}${payload.incomplete ? ' (certaines données sont indisponibles dans votre compte)' : ''}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MessageSquare className="h-6 w-6" />
            Communications
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Modèles par événement et par canal. Le contenu est versionné hors back-office ; l’historique individuel se consulte depuis la fiche Utilisateur.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load()} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Actualiser
        </Button>
      </div>

      {loading && !groups ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <EcranEnErreur titre="Impossible de charger les communications" message={error} onRetry={() => load()} />
      ) : !groups || groups.length === 0 ? (
        <p className="text-center py-12 text-muted-foreground">Aucun modèle de communication.</p>
      ) : (
        groups.map((group) => (
          <section key={group.key} className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h2>
            <div className="grid gap-3">
              {group.events.map((event) => (
                <div key={event.code} className="rounded-xl border bg-card">
                  <div className="flex items-center justify-between gap-3 px-4 py-3 border-b">
                    <p className="font-medium text-sm">{event.label}</p>
                    {event.channels.some((c) => c.channel === 'email') && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => sendTest(event)}
                        disabled={testing === event.code}
                        title="Envoi uniquement vers votre adresse e-mail d’administrateur"
                      >
                        {testing === event.code ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />}
                        E-mail de test
                      </Button>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Canal</th>
                          <th className="px-4 py-2 font-medium">Statut</th>
                          <th className="px-4 py-2 font-medium">Dernier envoi</th>
                          <th className="px-4 py-2 font-medium text-right">Envois</th>
                          <th className="px-4 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {event.channels.map((c) => {
                          const Meta = CHANNEL_META[c.channel];
                          return (
                            <tr key={c.channel} className="border-t">
                              <td className="px-4 py-2">
                                <span className="inline-flex items-center gap-1.5">
                                  <Meta.icon className="h-3.5 w-3.5 text-muted-foreground" />
                                  {Meta.label}
                                </span>
                              </td>
                              <td className="px-4 py-2">
                                <div className="flex items-center gap-2">
                                  <Switch
                                    checked={c.active}
                                    disabled={c.locked || saving}
                                    onCheckedChange={() => setPending({ event, channel: c })}
                                    aria-label={`${c.active ? 'Désactiver' : 'Activer'} ${Meta.label} — ${event.label}`}
                                  />
                                  <span className={c.active ? 'text-emerald-500' : 'text-muted-foreground'}>
                                    {c.active ? 'Actif' : 'Inactif'}
                                  </span>
                                  {c.locked && (
                                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={c.lockReason ?? undefined}>
                                      <Lock className="h-3 w-3" /> {c.lockReason}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-2 text-xs">{c.lastSentAt ? formatDateTime(c.lastSentAt) : 'Jamais'}</td>
                              <td className="px-4 py-2 text-right tabular-nums">{c.sentCount}</td>
                              <td className="px-4 py-2 text-right">
                                <Button size="sm" variant="ghost" onClick={() => openPreview(event, c.channel)}>
                                  <Eye className="h-3.5 w-3.5 mr-1.5" /> Prévisualiser
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {/* COM-012 : confirmation explicite */}
      <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open && !saving) setPending(null); }}>
        <AlertDialogContent>
          {pending && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pending.channel.active ? 'Désactiver' : 'Activer'} le canal {CHANNEL_META[pending.channel.channel].label} ?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  « {pending.event.label} » —{' '}
                  {pending.channel.active
                    ? 'plus aucun envoi sur ce canal, pour tous les utilisateurs, dès maintenant. Les autres canaux de cet événement ne sont pas affectés.'
                    : 'les envois reprendront sur ce canal pour tous les utilisateurs.'}{' '}
                  Action journalisée.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={saving}>Annuler</AlertDialogCancel>
                <AlertDialogAction onClick={applyToggle} disabled={saving}>
                  {pending.channel.active ? 'Désactiver' : 'Activer'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>

      {/* COM-006 à COM-009 : prévisualisation */}
      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Prévisualisation — {preview?.event.label}</DialogTitle>
            <DialogDescription>Rendu avec les données de votre propre compte uniquement.</DialogDescription>
          </DialogHeader>
          {/* COM-008 : contexte choisi dans le compte de l'administrateur */}
          <div className="rounded-lg border p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Contexte utilisé (facultatif) — uniquement parmi les éléments de votre propre compte :
            </p>
            {ctxError ? (
              <p className="text-xs text-red-500">
                Contexte indisponible : {ctxError}{' '}
                <button type="button" className="underline" onClick={() => loadContextOptions()}>Réessayer</button>
              </p>
            ) : !ctxOptions ? (
              <p className="text-xs text-muted-foreground">Chargement…</p>
            ) : !ctxOptions.hasAccount ? (
              <p className="text-xs text-amber-600">Aucun compte Verebona n’est rattaché à votre utilisateur : aucun contexte disponible.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-3">
                <select aria-label="Bien" className="rounded-md border bg-background px-2 py-1.5 text-xs" value={selection.assetId} onChange={(e) => changeSelection({ assetId: e.target.value })}>
                  <option value="">{ctxOptions.assets.length ? 'Bien : aucun' : 'Aucun bien dans votre compte'}</option>
                  {ctxOptions.assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <select aria-label="Document" className="rounded-md border bg-background px-2 py-1.5 text-xs" value={selection.documentId} onChange={(e) => changeSelection({ documentId: e.target.value })}>
                  <option value="">{ctxOptions.documents.length ? 'Document : aucun' : 'Aucun document dans votre compte'}</option>
                  {ctxOptions.documents.map((d) => <option key={d.id} value={d.id}>{d.title}{d.assetName ? ` — ${d.assetName}` : ''}</option>)}
                </select>
                <select aria-label="Échéance" className="rounded-md border bg-background px-2 py-1.5 text-xs" value={selection.deadlineId} onChange={(e) => changeSelection({ deadlineId: e.target.value })}>
                  <option value="">{ctxOptions.deadlines.length ? 'Échéance : aucune' : 'Aucune échéance dans votre compte'}</option>
                  {ctxOptions.deadlines.map((d) => <option key={d.id} value={d.id}>{d.title}{d.date ? ` (${d.date})` : ''}</option>)}
                </select>
                {preview && relevantPreviewContexts(preview.event.code, preview.event.emailTemplateCode).payment && (
                  <select aria-label="Paiement" className="rounded-md border bg-background px-2 py-1.5 text-xs" value={selection.paymentId} onChange={(e) => changeSelection({ paymentId: e.target.value })}>
                    <option value="">{ctxOptions.payments?.length ? 'Paiement : aucun' : 'Aucun paiement dans votre compte'}</option>
                    {(ctxOptions.payments ?? []).map((p) => <option key={p.id} value={p.id}>{paymentOptionLabel(p)}</option>)}
                  </select>
                )}
                {preview && relevantPreviewContexts(preview.event.code, preview.event.emailTemplateCode).withdrawal && (
                  <select aria-label="Rétractation" className="rounded-md border bg-background px-2 py-1.5 text-xs" value={selection.withdrawalId} onChange={(e) => changeSelection({ withdrawalId: e.target.value })}>
                    <option value="">{ctxOptions.withdrawals?.length ? 'Rétractation : aucune' : 'Aucune rétractation dans votre compte'}</option>
                    {(ctxOptions.withdrawals ?? []).map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.publicReference}{w.requestedAt ? ` — ${formatDate(w.requestedAt)}` : ''}
                      </option>
                    ))}
                  </select>
                )}
                <p className="text-[11px] text-muted-foreground sm:col-span-3">
                  Abonnement : {ctxOptions.subscription ? `offre ${ctxOptions.subscription.planCode}, statut ${ctxOptions.subscription.status}` : 'aucun abonnement dans votre compte'} (repris automatiquement).
                </p>
              </div>
            )}
          </div>
          {!preview?.data ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : !preview.data.available ? (
            <p className="text-sm text-muted-foreground">{preview.data.message}</p>
          ) : (
            <div className="space-y-3">
              {preview.data.incomplete && (
                <p className="text-xs rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-600">
                  Prévisualisation incomplète : certaines données nécessaires sont absentes de votre compte et sont signalées « [donnée indisponible] ».
                </p>
              )}
              {preview.data.needsContext && (
                <p className="text-xs text-muted-foreground">
                  Ce modèle attend un contexte : choisissez ci-dessus le bien, le document, l’échéance, le paiement ou la rétractation de votre compte.
                </p>
              )}
              {preview.data.rejected && preview.data.rejected.length > 0 && (
                <p className="text-xs text-red-500">Sélection ignorée (hors de votre compte) : {preview.data.rejected.join(', ')}.</p>
              )}
              {preview.data.channel === 'email' ? (
                <>
                  <p className="text-sm"><span className="text-muted-foreground">Objet :</span> {preview.data.subject}</p>
                  {preview.data.isHtml ? (
                    <iframe
                      title="Prévisualisation e-mail"
                      sandbox=""
                      srcDoc={preview.data.body}
                      className="w-full h-[60vh] rounded border bg-white"
                    />
                  ) : (
                    <pre className="whitespace-pre-wrap text-sm rounded border p-3 max-h-[60vh] overflow-auto">{preview.data.body}</pre>
                  )}
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => sendTest(preview.event, selection)}
                      disabled={testing === preview.event.code}
                      title="Envoi uniquement vers votre adresse e-mail d’administrateur"
                    >
                      <Send className="h-3.5 w-3.5 mr-1.5" /> Envoyer ce rendu en test à mon adresse
                    </Button>
                  </div>
                </>
              ) : (
                <div className="rounded-xl border p-4 max-w-sm">
                  <p className="text-xs text-muted-foreground mb-1">{CHANNEL_META[preview.data.channel].label}</p>
                  <p className="font-medium text-sm">{preview.data.title}</p>
                  <p className="text-sm text-muted-foreground">{preview.data.body}</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
