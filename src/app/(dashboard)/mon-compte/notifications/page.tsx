"use client";

import { useCallback, useEffect, useState } from 'react';
import { useBreadcrumb } from '@/contexts/BreadcrumbContext';
import { apiClient } from '@/lib/api-client';
import { toast } from 'sonner';
import { Lock, Smartphone, ShieldCheck, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface ChannelState { enabled: boolean; locked: boolean; available?: boolean }
interface CategoryPref {
  key: string;
  label: string;
  description: string;
  immediate: { push: ChannelState; email: ChannelState };
  digest?: { push: ChannelState; email: ChannelState };
  /** Lot 79C : ce que contrôle le réglage e-mail, et ce qui part toujours. */
  emailScope?: { essential: string[]; optional: string[] };
}
interface Matrix {
  categories: CategoryPref[];
  push: { supported: boolean; activeDeviceCount: number; mobileDeviceCount?: number };
  newsConsent: { consented: boolean; consentedAt: string | null };
}

export default function NotificationsSettingsPage() {
  const { setBreadcrumbs } = useBreadcrumb();
  const [mounted, setMounted] = useState(false);
  const [matrix, setMatrix] = useState<Matrix | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: 'Mon compte', href: '/mon-compte' }, { label: 'Notifications' }]);
  }, [setBreadcrumbs]);

  const refresh = useCallback(async () => {
    const m = await apiClient.get<Matrix>('/api/notification-preferences').catch(() => null);
    if (m) setMatrix(m);
  }, []);

  useEffect(() => {
    setMounted(true);
    void refresh();
  }, [refresh]);

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
      (c) => c.key !== 'news'
        && ((c.immediate.push.available !== false && c.immediate.push.enabled)
          || (c.digest?.push.available !== false && c.digest?.push.enabled)),
    ),
  );

  return (
    <div className="w-full max-w-3xl space-y-6">
      <div>
        <h1 className="vb-app-title">Notifications</h1>
        <p className="mt-1 text-muted-foreground">
          Choisissez ce que vous recevez par notification sur vos appareils et par email.
        </p>
      </div>

      {/* ── Bloc 1 — Notifications sur vos téléphones ──────────────────────────
          Lot 97 (CDC 12 §18) puis lot 94 (décision PO M3) : les push sont
          exclusivement mobiles. Aucun Web Push : le site ne demande jamais
          l'autorisation du navigateur et n'envoie rien aux navigateurs. */}
      <Card>
        <CardHeader>
          <CardTitle>Notifications sur vos téléphones</CardTitle>
          <CardDescription>
            Les notifications push s&apos;affichent sur les téléphones où vous utilisez l&apos;application mobile
            Verebona (iPhone et Android), même lorsqu&apos;elle est fermée.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!mounted || !matrix ? (
            <div className="h-10 animate-pulse rounded-md bg-muted" />
          ) : (
            <>
              <p className="flex items-center gap-2 text-sm">
                <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                {(matrix.push.mobileDeviceCount ?? 0) > 0
                  ? `Activées sur ${matrix.push.mobileDeviceCount} téléphone${(matrix.push.mobileDeviceCount ?? 0) > 1 ? 's' : ''}.`
                  : 'Aucun téléphone ne reçoit vos notifications pour le moment.'}
              </p>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                Sur ordinateur et dans un navigateur, Verebona n&apos;affiche pas de notifications : la cloche et vos
                e-mails restent actifs.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Bloc 2 — Mes préférences ────────────────────────────────────────── */}
      <TooltipProvider delayDuration={150}>
        <Card>
          <CardHeader>
            <CardTitle>Mes préférences</CardTitle>
            <CardDescription>Par catégorie, choisissez de recevoir un push et/ou un email pour les messages facultatifs. Les messages indispensables (sécurité, paiement, décisions qui vous attendent) sont toujours envoyés.</CardDescription>
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
            {matrix && matrix.push.activeDeviceCount === 0 && pushDemande && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 p-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <p className="text-sm text-[color:var(--text-primary)]">
                  Vous avez activé le push pour au moins une catégorie, mais{' '}
                  <span className="font-medium">aucun téléphone ne les reçoit</span> pour le moment :
                  ils arriveront sur votre téléphone dès que vous serez connecté à l&apos;application
                  mobile Verebona.
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
                        {cat.key !== 'news' && <EmailScopeText scope={cat.emailScope} emailAvailable={(cat.digest ?? cat.immediate).email.available !== false} />}
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
                        {/* Lot 79C : plus d'alerte immédiate pour un élément ordinaire — non proposée. */}
                        {(cat.immediate.push.available !== false || cat.immediate.email.available !== false) && (
                          <SubToggleRow
                            title="Immédiatement lorsqu'un nouvel élément apparaît"
                            push={cat.immediate.push} email={cat.immediate.email}
                            onPush={(v) => toggle(cat.key, 'immediate', 'push', v)}
                            onEmail={(v) => toggle(cat.key, 'immediate', 'email', v)}
                          />
                        )}
                        <SubToggleRow
                          title="Récapitulatif quotidien à 8 h 30, seulement s'il y a du nouveau"
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

    </div>
  );
}

/** Un libellé + switch pour un canal, avec cadenas explicite si verrouillé (§8.2). */
function ChannelToggle({ label, state, onChange }: { label: string; state: ChannelState; onChange: (v: boolean) => void }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {state.available === false ? (
        // Lot 79C : canal supprimé pour ce réglage — non proposé.
        <span className="flex h-6 items-center text-xs text-muted-foreground" aria-label={`${label} non proposé`}>—</span>
      ) : state.locked ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1">
              <Switch checked disabled aria-label={`${label} obligatoire`} />
              <Lock className="h-3 w-3 text-muted-foreground" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[220px] text-center">
            <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" /> Obligatoire</span>
            Tous les e-mails de cette catégorie sont indispensables et toujours envoyés.
          </TooltipContent>
        </Tooltip>
      ) : (
        <Switch checked={state.enabled} onCheckedChange={onChange} aria-label={label} />
      )}
    </div>
  );
}

/**
 * Lot 79C : ce que contrôle le réglage e-mail de la catégorie, et les
 * e-mails indispensables qui partent toujours (décision réelle du moteur).
 */
function EmailScopeText({ scope, emailAvailable }: { scope?: { essential: string[]; optional: string[] }; emailAvailable: boolean }) {
  if (!scope) return null;
  return (
    <div className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
      {emailAvailable && scope.optional.length > 0 && (
        <p>Le réglage Email concerne : {scope.optional.join(', ')}.</p>
      )}
      {scope.essential.length > 0 && (
        <p className="flex items-start gap-1">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>Toujours envoyés par email (indispensables) : {scope.essential.join(', ')}.</span>
        </p>
      )}
      {!emailAvailable && scope.essential.length === 0 && <p>Aucun email pour cette catégorie.</p>}
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
