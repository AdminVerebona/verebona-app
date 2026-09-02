"use client";

import { useCallback, useEffect, useState } from 'react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import { Bell, BellOff, Lock, Loader2, Smartphone, Trash2, ShieldCheck, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  isPushSupported, getPermissionState, subscribeCurrentDevice, unsubscribeCurrentDevice,
  type PushPermission,
} from '@/lib/push/push-client';

interface ChannelState { enabled: boolean; locked: boolean }
interface CategoryPref {
  key: string;
  label: string;
  description: string;
  immediate: { push: ChannelState; email: ChannelState };
  digest?: { push: ChannelState; email: ChannelState };
}
interface Matrix {
  categories: CategoryPref[];
  push: { supported: boolean; activeDeviceCount: number };
  newsConsent: { consented: boolean; consentedAt: string | null };
}
interface Device {
  id: string;
  platform: string | null;
  deviceLabel: string | null;
  status: string;
  lastSuccessAt: string | null;
  createdAt: string | null;
}

export default function NotificationsSettingsPage() {
  const { setBreadcrumbs } = useBreadcrumb();
  const [mounted, setMounted] = useState(false);
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [permission, setPermission] = useState<PushPermission>('unsupported');
  const [supported, setSupported] = useState(false);
  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: 'Mon compte', href: '/mon-compte' }, { label: 'Notifications' }]);
  }, [setBreadcrumbs]);

  const refresh = useCallback(async () => {
    const [m, d] = await Promise.all([
      apiClient.get<Matrix>('/api/notification-preferences').catch(() => null),
      apiClient.get<{ devices: Device[] }>('/api/push/subscriptions').catch(() => ({ devices: [] })),
    ]);
    if (m) setMatrix(m);
    setDevices(d?.devices ?? []);
  }, []);

  useEffect(() => {
    setMounted(true);
    const supp = isPushSupported();
    setSupported(supp);
    setPermission(supp ? getPermissionState() : 'unsupported');

    // iOS n'autorise le push que si la PWA est installée sur l'écran d'accueil.
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isIOS = /iphone|ipad|ipod/i.test(ua);
    const standalone = typeof window !== 'undefined'
      && (window.matchMedia?.('(display-mode: standalone)').matches
        || (navigator as unknown as { standalone?: boolean }).standalone === true);
    setIosNeedsInstall(isIOS && !standalone && !supp);

    void refresh();
  }, [refresh]);

  const activateDevice = async () => {
    setBusy(true);
    try {
      const res = await subscribeCurrentDevice('Cet appareil');
      setPermission(res.permission);
      if (res.ok) {
        toast.success('Notifications activées sur cet appareil');
        await refresh();
      } else if (res.reason === 'denied') {
        toast.error('Autorisation refusée. Vous pouvez la réactiver dans les réglages du navigateur.');
      } else if (res.reason === 'no_public_key') {
        toast.error('Le service de notifications n\'est pas disponible pour le moment.');
      } else {
        toast.error('Impossible d\'activer les notifications sur cet appareil.');
      }
    } finally {
      setBusy(false);
    }
  };

  const deactivateDevice = async () => {
    setBusy(true);
    try {
      await unsubscribeCurrentDevice();
      toast.success('Notifications désactivées sur cet appareil');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const removeDevice = async (id: string) => {
    setBusy(true);
    try {
      await apiClient.delete(`/api/push/subscriptions/${id}`);
      await refresh();
    } catch {
      toast.error('Impossible de retirer cet appareil.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (category: string, mode: 'immediate' | 'daily_digest', channel: 'push' | 'email', next: boolean) => {
    if (!matrix) return;
    // Mise à jour optimiste avec rollback en cas d'échec (§8.3).
    const snapshot = matrix;
    setMatrix({
      ...matrix,
      categories: matrix.categories.map((c) => {
        if (c.key !== category) return c;
        const target = mode === 'immediate' ? c.immediate : c.digest;
        if (!target) return c;
        const updated = { ...target, [channel]: { ...target[channel], enabled: next } };
        return mode === 'immediate' ? { ...c, immediate: updated } : { ...c, digest: updated };
      }),
    });
    try {
      const res = await apiClient.patch<Matrix>('/api/notification-preferences', {
        changes: [{ category, channel, deliveryMode: mode, enabled: next }],
      });
      if (res?.categories) setMatrix(res);
    } catch {
      setMatrix(snapshot);
      toast.error('Réglage non enregistré. Réessayez.');
    }
  };

  const toggleNewsConsent = async (next: boolean) => {
    if (!matrix) return;
    const snapshot = matrix;
    setMatrix({ ...matrix, newsConsent: { ...matrix.newsConsent, consented: next } });
    try {
      await apiClient.post('/api/notification-preferences/news-consent', {
        consented: next, source: 'mon-compte/notifications',
      });
      toast.success(next ? 'Vous recevrez nos actualités' : 'Vous ne recevrez plus nos actualités');
      await refresh(); // reflète le verrou de gating côté serveur
    } catch {
      setMatrix(snapshot);
      toast.error('Consentement non enregistré. Réessayez.');
    }
  };

  // Au moins une catégorie attend un push (hors actualités, qui exigent en
  // plus un consentement distinct).
  const pushDemande = Boolean(
    matrix?.categories.some(
      (c) => c.key !== 'news' && (c.immediate.push.enabled || c.digest?.push.enabled),
    ),
  );

  return (
    <div className="w-full max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Notifications</h1>
        <p className="mt-1 text-muted-foreground">
          Choisissez ce que vous recevez par notification sur vos appareils et par email.
        </p>
      </div>

      {/* ── Bloc 1 — Notifications sur cet appareil ─────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Notifications sur cet appareil</CardTitle>
          <CardDescription>Les push apparaissent même lorsque Verebona est fermé.</CardDescription>
        </CardHeader>
        <CardContent>
          {!mounted ? (
            <div className="h-10 animate-pulse rounded-md bg-muted" />
          ) : iosNeedsInstall ? (
            <p className="text-sm text-muted-foreground">
              Pour recevoir des notifications sur iPhone ou iPad, ajoutez d'abord Verebona à votre écran d\'accueil,
              puis rouvrez l'application depuis cette icône.
            </p>
          ) : !supported ? (
            <p className="text-sm text-muted-foreground">
              Ce navigateur ne prend pas en charge les notifications. Vos réglages email ci-dessous restent actifs.
            </p>
          ) : matrix && !matrix.push.supported ? (
            // Clé VAPID absente côté serveur : le bouton « Activer » ne peut
            // qu'échouer. Le dire vaut mieux que de le laisser essayer.
            <p className="text-sm text-muted-foreground">
              Le service de notifications n&apos;est pas disponible pour le moment. Vos réglages email
              ci-dessous restent actifs.
            </p>
          ) : permission === 'denied' ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm font-medium text-amber-600 dark:text-amber-500">
                <BellOff className="h-4 w-4" /> Notifications bloquées
              </p>
              <p className="text-sm text-muted-foreground">
                Les notifications sont bloquées pour Verebona. Pour les réactiver, autorisez-les dans les réglages
                de votre navigateur ou de votre système, puis revenez sur cette page.
              </p>
            </div>
          ) : permission === 'granted' && matrix && matrix.push.activeDeviceCount > 0 ? (
            <div className="flex items-center justify-between gap-4">
              <p className="flex items-center gap-2 text-sm">
                <Bell className="h-4 w-4 text-emerald-600 dark:text-emerald-500" />
                Activées sur cet appareil.
              </p>
              <Button variant="outline" onClick={deactivateDevice} disabled={busy}>
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                Désactiver sur cet appareil
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Recevez un rappel avant vos échéances et la fin de vos analyses, même application fermée.
              </p>
              <Button onClick={activateDevice} disabled={busy} className="shrink-0">
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Bell className="mr-1 h-4 w-4" />}
                Activer les notifications
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Bloc 2 — Mes préférences ────────────────────────────────────────── */}
      <TooltipProvider delayDuration={150}>
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Mes préférences</CardTitle>
            <CardDescription>Par catégorie, choisissez de recevoir un push et/ou un email.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {/* ══════════════════════════════════════════════════════════════
                UN RÉGLAGE « PUSH : OUI » SANS APPAREIL AUTORISÉ N'ENVOIE RIEN

                Le réglage par catégorie dit CE QUE l'on veut recevoir ; il
                n'autorise pas le navigateur à afficher quoi que ce soit.
                Tant qu'aucun appareil n'est enregistré, le moteur note
                « aucun abonnement actif » et n'envoie pas — en silence.

                L'utilisateur cochait « Push : oui », n'en voyait jamais
                arriver, et rien dans l'écran ne le lui expliquait.
                ══════════════════════════════════════════════════════════ */}
            {matrix && matrix.push.supported && matrix.push.activeDeviceCount === 0 && pushDemande && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                <BellOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
                <p className="text-sm text-[color:var(--text-primary)]">
                  Vous avez activé le push pour au moins une catégorie, mais{' '}
                  <span className="font-medium">aucun appareil n&apos;est autorisé</span> :
                  ces notifications ne peuvent pas vous parvenir. Utilisez « Activer les
                  notifications » ci-dessus, sur chaque appareil concerné.
                </p>
              </div>
            )}
            {!matrix ? (
              <div className="space-y-3">
                {[0, 1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-md bg-muted" />)}
              </div>
            ) : (
              matrix.categories.map((cat, idx) => (
                <div key={cat.key}>
                  {idx > 0 && <Separator className="my-1" />}
                  <div className="py-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="font-medium">{cat.label}</p>
                        <p className="mt-0.5 text-sm text-muted-foreground">{cat.description}</p>
                      </div>
                      {cat.key === 'news' ? (
                        <Switch
                          checked={matrix.newsConsent.consented}
                          onCheckedChange={toggleNewsConsent}
                          aria-label="Recevoir les actualités"
                        />
                      ) : !cat.digest && (
                        <div className="flex shrink-0 items-center gap-5">
                          <ChannelToggle label="Push" state={cat.immediate.push}
                            onChange={(v) => toggle(cat.key, 'immediate', 'push', v)} />
                          <ChannelToggle label="Email" state={cat.immediate.email}
                            onChange={(v) => toggle(cat.key, 'immediate', 'email', v)} />
                        </div>
                      )}
                    </div>

                    {/* Actualités : canaux réglables seulement après consentement (§19.5) */}
                    {cat.key === 'news' && matrix.newsConsent.consented && (
                      <div className="mt-3 flex items-center justify-end gap-5">
                        <ChannelToggle label="Push" state={cat.immediate.push}
                          onChange={(v) => toggle('news', 'immediate', 'push', v)} />
                        <ChannelToggle label="Email" state={cat.immediate.email}
                          onChange={(v) => toggle('news', 'immediate', 'email', v)} />
                      </div>
                    )}

                    {/* « À traiter » : immédiat + récapitulatif, jamais dans la cloche */}
                    {cat.digest && (
                      <div className="mt-3 space-y-3 rounded-md border border-border/60 p-3">
                        <SubToggleRow
                          title="Immédiatement lorsqu'un nouvel élément apparaît"
                          push={cat.immediate.push} email={cat.immediate.email}
                          onPush={(v) => toggle(cat.key, 'immediate', 'push', v)}
                          onEmail={(v) => toggle(cat.key, 'immediate', 'email', v)}
                        />
                        <SubToggleRow
                          title="Récapitulatif quotidien à 8 h 30"
                          push={cat.digest.push} email={cat.digest.email}
                          onPush={(v) => toggle(cat.key, 'daily_digest', 'push', v)}
                          onEmail={(v) => toggle(cat.key, 'daily_digest', 'email', v)}
                        />
                        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          Ces notifications ne sont jamais ajoutées dans la cloche. Vos éléments restent visibles sur la page À traiter.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </TooltipProvider>

      {/* ── Appareils autorisés ─────────────────────────────────────────────── */}
      {devices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Appareils autorisés</CardTitle>
            <CardDescription>Appareils qui reçoivent vos notifications push.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-4 rounded-md border border-border/60 p-3">
                <div className="flex items-center gap-3">
                  <Smartphone className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{d.deviceLabel || d.platform || 'Appareil'}</p>
                    {d.lastSuccessAt && (
                      <p className="text-xs text-muted-foreground">
                        Dernière notification : {new Date(d.lastSuccessAt).toLocaleDateString('fr-FR')}
                      </p>
                    )}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => removeDevice(d.id)} disabled={busy}>
                  <Trash2 className="mr-1 h-4 w-4" /> Retirer
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Un libellé + switch pour un canal, avec cadenas explicite si verrouillé (§8.2). */
function ChannelToggle({ label, state, onChange }: { label: string; state: ChannelState; onChange: (v: boolean) => void }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {state.locked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1">
              <Switch checked disabled aria-label={`${label} obligatoire`} />
              <Lock className="h-3 w-3 text-muted-foreground" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[220px] text-center">
            <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Obligatoire</span>
            Cet email est toujours envoyé pour les décisions, la sécurité et les paiements.
          </TooltipContent>
        </Tooltip>
      ) : (
        <Switch checked={state.enabled} onCheckedChange={onChange} aria-label={label} />
      )}
    </div>
  );
}

function SubToggleRow({
  title, push, email, onPush, onEmail,
}: {
  title: string; push: ChannelState; email: ChannelState;
  onPush: (v: boolean) => void; onEmail: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{title}</span>
      <div className="flex shrink-0 items-center gap-5">
        <ChannelToggle label="Push" state={push} onChange={onPush} />
        <ChannelToggle label="Email" state={email} onChange={onEmail} />
      </div>
    </div>
  );
}
