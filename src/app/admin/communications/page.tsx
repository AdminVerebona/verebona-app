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
import { formatDateTime } from '@/lib/admin/format';
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
  contextual?: boolean;
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

  const [preview, setPreview] = useState<{ event: EventView; data: Preview | null } | null>(null);
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

  const openPreview = async (event: EventView, channel: Channel) => {
    setPreview({ event, data: null });
    try {
      const qs = new URLSearchParams({ eventCode: event.code, channel });
      const res = await fetch(`/api/admin/communications/preview?${qs}`, { credentials: 'include' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || `Erreur ${res.status}`);
      setPreview({ event, data: payload });
    } catch (err) {
      setPreview({ event, data: { channel, available: false, message: err instanceof Error ? err.message : 'Erreur inconnue' } });
    }
  };

  const sendTest = async (event: EventView) => {
    setTesting(event.code);
    try {
      const res = await fetch('/api/admin/communications/test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventCode: event.code }),
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
              {preview.data.contextual && (
                <p className="text-xs text-muted-foreground">
                  Contenu générique du canal ; le détail propre au contexte (bien, document, échéance) n’est pas reproduit.
                </p>
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
