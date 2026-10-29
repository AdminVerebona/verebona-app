'use client';

/**
 * Mon compte › Sécurité — blocs du CDC 18 §27 retenus en V1 (lot 92 ;
 * lot 96B : décisions PO Q2-Q4, aucune double authentification en V1 — le
 * bloc « Double authentification » et son « bientôt disponible » sont
 * retirés, rien ne l'annonce).
 *
 *   1. Méthodes de connexion (`SignInMethodsBlock`, lot 93) — adresse e-mail
 *      (modification : bientôt), mot de passe (Modifier / Ajouter, après
 *      confirmation d'identité), Google, Apple (Connecter / Déconnecter).
 *   2. Biométrie — uniquement dans l'application mobile (§27.3) ; réglage
 *      local branché sur `lib/native/app-lock` (lot 97B, `BiometricsBlock`).
 *   3. Appareils connectés — appareil, navigateur ou application, dernière
 *      activité, badge « Cet appareil », « Déconnecter » par appareil,
 *      « Déconnecter tous les autres appareils » après confirmation. Ni IP ni
 *      localisation (SESS-09).
 * Desktop et mobile (lignes empilées sous 640 px), charte Sérénité.
 */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Key, Loader2, LogOut, Monitor, Save, ShieldCheck, Smartphone, Fingerprint, Tablet } from 'lucide-react';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { PasswordRequirements } from '@/components/auth/PasswordRequirements';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { apiClient, ApiClientError } from '@/lib/api-client';
import { isNativeApp } from '@/lib/native/bridge';
import { useReauth } from './ReauthProvider';
import { SignInMethodsBlock } from './SignInMethodsBlock';
import { BiometricsBlock } from './BiometricsBlock';

interface DeviceSession {
  id: string;
  current: boolean;
  clientType: 'WEB' | 'PWA' | 'IOS' | 'ANDROID' | string;
  deviceLabel: string;
  browserLabel: string;
  createdAt: string;
  lastSeenAt: string;
}

const PARIS = 'Europe/Paris';

/** « à l’instant », « il y a 12 min », « aujourd’hui à 09:41 », « le 12 octobre à 09:41 ». */
export function formatLastActivity(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60_000);
  if (diffMin < 1) return 'à l’instant';
  if (diffMin < 60) return `il y a ${diffMin} min`;
  const day = (x: Date) => new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, dateStyle: 'short' }).format(x);
  const time = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit' }).format(d);
  if (day(d) === day(now)) return `aujourd’hui à ${time}`;
  const date = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, day: 'numeric', month: 'long' }).format(d);
  return `le ${date} à ${time}`;
}

function DeviceIcon({ s }: { s: DeviceSession }) {
  const cls = 'w-5 h-5 text-[color:var(--text-secondary)]';
  if (/iPad|Tablette/.test(s.deviceLabel)) return <Tablet className={cls} />;
  if (s.clientType === 'IOS' || s.clientType === 'ANDROID' || /iPhone|Téléphone/.test(s.deviceLabel)) return <Smartphone className={cls} />;
  return <Monitor className={cls} />;
}

function clientLabel(s: DeviceSession): string {
  if (s.clientType === 'PWA') return `${s.browserLabel} · application installée`;
  return s.browserLabel;
}

function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiClientError && e.serverMessage ? e.serverMessage : fallback;
}

function SubBlock({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border border-[color:var(--border-subtle)] px-3 py-3 sm:px-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h3>
      {children}
    </section>
  );
}

/* ── Bloc 1 : mot de passe ─────────────────────────────────────────────── */

function ChangePasswordAction() {
  const router = useRouter();
  const { ensureFresh, withReauth } = useReauth();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ newPassword: '', confirmPassword: '' });
  const [keepCurrentSession, setKeepCurrentSession] = useState(false);
  const [saving, setSaving] = useState(false);

  const start = async () => {
    if (await ensureFresh('Avant de modifier votre mot de passe.', 'change-password')) setOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.newPassword !== form.confirmPassword) {
      toast.error('Les mots de passe ne correspondent pas');
      return;
    }
    setSaving(true);
    try {
      const data = await withReauth(() => apiClient.post<{ reauthRequired?: boolean }>('/api/users/me/change-password', {
        newPassword: form.newPassword,
        keepCurrentSession,
      }), 'Avant de modifier votre mot de passe.', 'change-password');
      if (data?.reauthRequired) {
        toast.success('Mot de passe modifié. Reconnectez-vous avec votre nouveau mot de passe.');
        router.push('/login?raison=mot-de-passe-modifie');
        return;
      }
      toast.success('Mot de passe modifié. Vos autres appareils ont été déconnectés.');
      setOpen(false);
      setForm({ newPassword: '', confirmPassword: '' });
    } catch (err) {
      toast.error(errorMessage(err, 'Erreur lors du changement de mot de passe'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="outline" className="rounded-full gap-2 w-full sm:w-auto" onClick={start}>
        <Key className="w-4 h-4" />
        Modifier
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Modifier le mot de passe</DialogTitle>
              <DialogDescription>Choisissez votre nouveau mot de passe.</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword">Nouveau mot de passe</Label>
                <PasswordInput id="newPassword" value={form.newPassword} onChange={(e) => setForm({ ...form, newPassword: e.target.value })} autoComplete="new-password" required />
                <PasswordRequirements password={form.newPassword} confirmPassword={form.confirmPassword} showConfirmRule={true} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">Confirmer le nouveau mot de passe</Label>
                <PasswordInput id="confirmPassword" value={form.confirmPassword} onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })} autoComplete="new-password" required />
              </div>
              <div className="space-y-1.5 rounded-lg border border-[color:var(--border-subtle)] px-3 py-2.5">
                <p className="text-xs text-muted-foreground">
                  Vos autres appareils et navigateurs seront déconnectés.
                </p>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={keepCurrentSession} onChange={(e) => setKeepCurrentSession(e.target.checked)} className="h-4 w-4" />
                  Rester connecté sur cet appareil
                </label>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
              <button type="submit" disabled={saving} className="btn-add disabled:opacity-40">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {saving ? 'Mise à jour…' : 'Mettre à jour'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ── Bloc 3 : appareils connectés ──────────────────────────────────────── */

function ConnectedDevices() {
  const { withReauth } = useReauth();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (registerCurrent = true) => {
    try {
      const data = await apiClient.get<{ sessions: DeviceSession[]; currentListed: boolean }>('/api/users/me/sessions');
      setLoadError(false);
      // Session ouverte avant le registre (Q5) : un renouvellement l'y inscrit tout de suite.
      if (registerCurrent && !data.currentListed && (await apiClient.refreshToken()) === true) {
        return load(false);
      }
      setSessions(data.sessions);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revokeOne = async (s: DeviceSession) => {
    if (busy) return;
    setBusy(s.id);
    try {
      await apiClient.delete(`/api/users/me/sessions/${encodeURIComponent(s.id)}`);
      toast.success(`${s.deviceLabel} est déconnecté.`);
    } catch (e) {
      toast.error(errorMessage(e, 'La déconnexion de cet appareil a échoué.'));
    } finally {
      setBusy(null);
      void load(false);
    }
  };

  const revokeOthers = async () => {
    if (busy) return;
    setBusy('others');
    try {
      const r = await withReauth(
        () => apiClient.post<{ revoked: number }>('/api/users/me/sessions/revoke-others', {}),
        'Avant de déconnecter vos autres appareils.',
      );
      toast.success(r?.revoked ? 'Vos autres appareils ont été déconnectés.' : 'Aucun autre appareil n’était connecté.');
    } catch (e) {
      toast.error(errorMessage(e, 'La déconnexion des autres appareils a échoué.'));
    } finally {
      setBusy(null);
      void load(false);
    }
  };

  if (loadError) return <p className="text-sm text-[color:var(--danger)]">La liste des appareils n’a pas pu être chargée.</p>;
  if (!sessions) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Chargement…</div>;

  const others = sessions.filter((s) => !s.current);
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-[color:var(--border-subtle)]" aria-label="Appareils connectés">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <DeviceIcon s={s} />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {s.deviceLabel}
                  {s.current && <Badge variant="secondary">Cet appareil</Badge>}
                </p>
                <p className="text-xs text-[color:var(--text-muted)]">
                  {clientLabel(s)} · {s.current ? 'actif maintenant' : `dernière activité ${formatLastActivity(s.lastSeenAt)}`}
                </p>
              </div>
            </div>
            {!s.current && (
              <Button
                size="sm"
                variant="outline"
                className="rounded-full gap-2 w-full sm:w-auto"
                disabled={busy !== null}
                onClick={() => revokeOne(s)}
              >
                {busy === s.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
                Déconnecter
              </Button>
            )}
          </li>
        ))}
      </ul>
      {sessions.length === 0 && <p className="text-sm text-muted-foreground">Aucun appareil à afficher pour le moment.</p>}
      <div className="flex flex-col gap-2 border-t border-[color:var(--border-subtle)] pt-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-[color:var(--text-muted)]">
          Un appareil inconnu ? Déconnectez-le, puis modifiez votre mot de passe.
        </p>
        <Button
          variant="outline"
          className="rounded-full gap-2 w-full sm:w-auto border-[color:var(--danger-edge)] text-[color:var(--danger)] hover:bg-[color:var(--danger-soft)]"
          disabled={busy !== null || others.length === 0}
          onClick={revokeOthers}
        >
          {busy === 'others' ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
          Déconnecter tous les autres appareils
        </Button>
      </div>
    </div>
  );
}

/* ── Carte ─────────────────────────────────────────────────────────────── */

export function SecurityCard() {
  // §27.3 : la biométrie n'existe que dans l'application mobile (lot 97B :
  // détection unique `lib/native/bridge`, décidée après hydratation).
  const [nativeApp, setNativeApp] = useState(false);
  useEffect(() => { setNativeApp(isNativeApp()); }, []);

  return (
    <CollapsibleCard
      anchorId="securite"
      icon={<ShieldCheck className="w-5 h-5" />}
      title="Sécurité"
      description="Méthodes de connexion, appareils connectés et protection de votre compte."
      contentClassName="space-y-4"
    >
      {/* Bloc 1 (lot 93, §27.1) : adresse principale, mot de passe, Google, Apple. */}
      <SubBlock icon={<Key className="w-4 h-4" />} title="Méthodes de connexion">
        <SignInMethodsBlock passwordAction={<ChangePasswordAction />} />
      </SubBlock>

      {nativeApp && (
        <SubBlock icon={<Fingerprint className="w-4 h-4" />} title="Biométrie">
          <BiometricsBlock />
        </SubBlock>
      )}

      <SubBlock icon={<Monitor className="w-4 h-4" />} title="Appareils connectés">
        <ConnectedDevices />
      </SubBlock>
    </CollapsibleCard>
  );
}
