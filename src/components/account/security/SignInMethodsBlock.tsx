'use client';

/**
 * Mon compte › Sécurité — bloc 1 « Méthodes de connexion » (lot 93, CDC 18
 * §27.1, §10.2, §12.3, §18 ; desktop et mobile, charte Sérénité).
 *
 *   · Adresse e-mail principale — « Modifier » (lot 96A, CDC 18 §11.3, Q8) :
 *     confirmation d'identité, nouvelle adresse, lien envoyé à cette adresse ;
 *     l'adresse actuelle reste celle du compte jusqu'à la confirmation
 *     (« En attente de confirmation » + Annuler) ;
 *   · E-mail et mot de passe : « Actif » / « Non configuré » → Modifier / Ajouter ;
 *   · Google, Apple : « Connecté » / « Non connecté » → Connecter / Déconnecter
 *     (Déconnecter seulement si une autre méthode subsiste).
 *
 * Chaque action sensible exige la preuve de réauthentification du lot 92
 * (5 min, cette session) : la fenêtre UNIQUE « Confirmez votre identité »
 * (`ReauthProvider` : mot de passe, ou Google / Apple déjà associé) s'ouvre
 * si besoin. Au retour d'un fournisseur, l'action demandée reprend
 * (`?securite=reauth&resume=`). Les règles restent contrôlées par le serveur.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Mail, KeyRound, ShieldCheck } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { apiClient, ApiClientError } from '@/lib/api-client';
import { useReauth } from './ReauthProvider';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PasswordInput } from '@/components/ui/password-input';
import { PasswordRequirements } from '@/components/auth/PasswordRequirements';
import { AppleLogo, GoogleLogo } from '@/components/auth/SocialSignInButtons';
import { SECURITY_RETURN_MESSAGES, socialErrorMessage } from '@/lib/auth/oauth/messages';

type Provider = 'google' | 'apple';
const LABEL: Record<Provider, string> = { google: 'Google', apple: 'Apple' };

interface ProviderView {
  available: boolean; linked: boolean; linkedAt: string | null; lastUsedAt: string | null;
  providerEmail: string | null; isPrivateRelay: boolean; canUnlink: boolean;
}
export interface SecuritySummary {
  email: string | null;
  password: { configured: boolean };
  providers: Record<Provider, ProviderView>;
  reauth: { fresh: boolean; method: string | null; expiresAt: string | null; methods: Array<'password' | Provider> };
}

/** Action sensible à reprendre après une confirmation d'identité. */
export type SecurityAction = 'add-password' | 'link-google' | 'link-apple' | 'unlink-google' | 'unlink-apple' | 'delete-account' | 'change-password' | 'change-email';

export function useSecuritySummary() {
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const reload = useCallback(async () => {
    try {
      setSummary(await apiClient.get<SecuritySummary>('/api/users/me/auth-identities'));
    } catch { /* l'écran garde l'état précédent */ }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { summary, reload };
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(new Date(iso));
}

interface PendingEmailChange { newEmail: string; expiresAt: string }

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(new Date(iso));
}

export function SignInMethodsBlock({ passwordAction }: { passwordAction: React.ReactNode }) {
  const { summary, reload } = useSecuritySummary();
  const { ensureFresh, withReauth } = useReauth();
  // Lot 96A (Q8) : changement de l'adresse principale.
  const [emailOpen, setEmailOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [pendingEmail, setPendingEmail] = useState<PendingEmailChange | null>(null);
  const reloadPendingEmail = useCallback(async () => {
    try {
      setPendingEmail((await apiClient.get<{ pending: PendingEmailChange | null }>('/api/users/me/email-change')).pending);
    } catch { /* l'écran garde l'état précédent */ }
  }, []);
  useEffect(() => { void reloadPendingEmail(); }, [reloadPendingEmail]);
  const [addPasswordOpen, setAddPasswordOpen] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [unlinkFor, setUnlinkFor] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown, fallback: string) =>
    toast.error(e instanceof ApiClientError && e.serverMessage ? e.serverMessage : fallback);

  // ── Actions : preuve 92 exigée par le serveur ; 403 REAUTH_* → fenêtre unique, puis l'action est rejouée ──
  const link = useCallback(async (p: Provider) => {
    setBusy(true);
    try {
      const d = await withReauth(
        () => apiClient.post<{ redirectUrl?: string }>(`/api/users/me/auth-identities/${p}/link`, {}),
        `Avant d’associer ${LABEL[p]}.`, `link-${p}`,
      );
      if (d?.redirectUrl) { window.location.assign(d.redirectUrl); return; }
    } catch (e) {
      fail(e, 'Association impossible pour le moment.');
    } finally { setBusy(false); }
  }, [withReauth]);

  const askUnlink = useCallback(async (p: Provider) => {
    if (await ensureFresh(`Avant de déconnecter ${LABEL[p]}.`, `unlink-${p}`)) setUnlinkFor(p);
  }, [ensureFresh]);

  const unlink = useCallback(async (p: Provider) => {
    setBusy(true);
    try {
      await withReauth(() => apiClient.delete(`/api/users/me/auth-identities/${p}`), `Avant de déconnecter ${LABEL[p]}.`, `unlink-${p}`);
      toast.success(`${LABEL[p]} ne permet plus de vous connecter.`);
      setUnlinkFor(null);
      await reload();
    } catch (e) {
      fail(e, 'Dissociation impossible pour le moment.');
    } finally { setBusy(false); }
  }, [reload, withReauth]);

  const askChangeEmail = useCallback(async () => {
    if (await ensureFresh('Avant de modifier votre adresse e-mail.', 'change-email')) { setNewEmail(''); setEmailOpen(true); }
  }, [ensureFresh]);

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await withReauth(
        () => apiClient.post<{ message?: string; pending?: PendingEmailChange }>('/api/users/me/email-change', { newEmail }),
        'Avant de modifier votre adresse e-mail.', 'change-email',
      );
      toast.success(d?.message || 'Demande enregistrée.');
      if (d?.pending) setPendingEmail(d.pending);
      setEmailOpen(false); setNewEmail('');
    } catch (err) {
      fail(err, 'La demande n’a pas pu être enregistrée.');
    } finally { setBusy(false); }
  };

  const cancelEmail = async () => {
    setBusy(true);
    try {
      await apiClient.delete('/api/users/me/email-change');
      toast.success('Demande annulée. Le lien envoyé ne fonctionne plus.');
      setPendingEmail(null);
    } catch (err) {
      fail(err, 'L’annulation n’a pas pu être enregistrée.');
    } finally { setBusy(false); }
  };

  const askAddPassword = useCallback(async () => {
    if (await ensureFresh('Avant d’ajouter un mot de passe.', 'add-password')) setAddPasswordOpen(true);
  }, [ensureFresh]);

  const addPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) { toast.error('Les mots de passe ne correspondent pas.'); return; }
    setBusy(true);
    try {
      const d = await withReauth(
        () => apiClient.post<{ message?: string }>('/api/users/me/password', { newPassword }),
        'Avant d’ajouter un mot de passe.', 'add-password',
      );
      toast.success(d?.message || 'Mot de passe ajouté.');
      setAddPasswordOpen(false); setNewPassword(''); setConfirmPassword('');
      await reload();
    } catch (err) {
      fail(err, 'Le mot de passe n’a pas pu être ajouté.');
    } finally { setBusy(false); }
  };

  // ── Retour d'un fournisseur (liaison, confirmation, erreur) ─────────────────
  useEffect(() => {
    if (!summary || typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const status = url.searchParams.get('securite');
    if (!status) return;
    const resume = url.searchParams.get('resume') as SecurityAction | null;
    const code = url.searchParams.get('code');
    ['securite', 'resume', 'code', 'provider'].forEach((k) => url.searchParams.delete(k));
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    if (status === 'erreur') { toast.error(socialErrorMessage(code) ?? 'Opération impossible.'); return; }
    if (status === 'linked') { toast.success(SECURITY_RETURN_MESSAGES.linked); return; }
    if (status === 'reauth') {
      toast.success(SECURITY_RETURN_MESSAGES.reauth);
      void reload();
      if (resume === 'add-password') setAddPasswordOpen(true);
      else if (resume === 'change-email') { setNewEmail(''); setEmailOpen(true); }
      else if (resume === 'link-google' || resume === 'link-apple') void link(resume.slice(5) as Provider);
      else if (resume === 'unlink-google' || resume === 'unlink-apple') setUnlinkFor(resume.slice(7) as Provider);
      // La carte « Zone dangereuse » s'ouvre sur son ancre (CollapsibleCard).
      else if (resume === 'delete-account') window.location.hash = 'delete-account';
    }
  }, [summary, link, reload]);

  if (!summary) {
    return <div className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]"><Loader2 className="w-4 h-4 animate-spin" /> Chargement des méthodes de connexion…</div>;
  }

  const fresh = summary.reauth.fresh;
  const providers = (['google', 'apple'] as const).filter((p) => summary.providers[p].available || summary.providers[p].linked);

  const row = (icon: React.ReactNode, title: string, status: React.ReactNode, actions: React.ReactNode, testId: string) => (
    <li className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={testId}>
      <div className="flex items-start gap-3 min-w-0">
        <span className="mt-0.5 shrink-0 text-[color:var(--text-muted)] [&_svg]:w-5 [&_svg]:h-5">{icon}</span>
        <div className="min-w-0">
          <p className="font-medium text-[color:var(--text-primary)]">{title}</p>
          <div className="text-sm text-[color:var(--text-muted)] break-words">{status}</div>
        </div>
      </div>
      <div className="flex gap-2 sm:shrink-0">{actions}</div>
    </li>
  );

  return (
    <div className="space-y-2" data-testid="sign-in-methods">
      <ul className="divide-y divide-[color:var(--border-subtle)]">
        {row(
          <Mail />,
          'Adresse e-mail principale',
          <>
            <span>{summary.email ?? '—'}</span>
            {pendingEmail && (
              <span className="block text-xs text-[color:var(--attention-on-soft)]" data-testid="email-change-pending">
                En attente de confirmation : {pendingEmail.newEmail}. Ouvrez le lien reçu à cette adresse avant le {formatDateTime(pendingEmail.expiresAt)}.
                Jusque-là, votre adresse actuelle reste celle du compte.
              </span>
            )}
          </>,
          pendingEmail
            ? <Button variant="outline" className="rounded-full min-h-11 sm:min-h-9 w-full sm:w-auto" disabled={busy} onClick={() => void cancelEmail()}>Annuler la demande</Button>
            : <Button variant="outline" className="rounded-full min-h-11 sm:min-h-9 w-full sm:w-auto" disabled={busy} onClick={() => void askChangeEmail()} data-testid="change-email">Modifier</Button>,
          'method-email',
        )}
        {row(
          <KeyRound />,
          'E-mail et mot de passe',
          summary.password.configured ? <span className="text-[color:var(--text-success)]">Actif</span> : 'Non configuré',
          summary.password.configured
            ? passwordAction
            : <Button variant="outline" className="rounded-full min-h-11 sm:min-h-9" disabled={busy} onClick={() => void askAddPassword()}>Ajouter</Button>,
          'method-password',
        )}
        {providers.map((p) => {
          const v = summary.providers[p];
          const status = v.linked
            ? <><span className="text-[color:var(--text-success)]">Connecté</span>{v.providerEmail ? ` · ${v.isPrivateRelay ? 'adresse masquée par Apple' : v.providerEmail}` : ''}{v.linkedAt ? ` · depuis le ${formatDate(v.linkedAt)}` : ''}</>
            : 'Non connecté';
          const actions = v.linked
            ? (v.canUnlink
              ? <Button variant="outline" className="rounded-full min-h-11 sm:min-h-9" disabled={busy} onClick={() => void askUnlink(p)}>Déconnecter</Button>
              : <span className="text-xs text-[color:var(--text-muted)] max-w-[16rem]">Seule méthode de connexion : ajoutez-en une autre avant de la retirer.</span>)
            : v.available
              ? <Button variant="outline" className="rounded-full min-h-11 sm:min-h-9" disabled={busy} onClick={() => void link(p)}>Connecter</Button>
              : null;
          return <div key={p}>{row(p === 'google' ? <GoogleLogo /> : <AppleLogo />, LABEL[p], status, actions, `method-${p}`)}</div>;
        })}
      </ul>
      {fresh && (
        <p className="flex items-center gap-1.5 text-xs text-[color:var(--text-muted)]"><ShieldCheck className="w-3.5 h-3.5" /> Identité confirmée pour quelques minutes.</p>
      )}

      <Dialog open={!!unlinkFor} onOpenChange={(o) => { if (!o) setUnlinkFor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Déconnecter {unlinkFor ? LABEL[unlinkFor] : ''} ?</DialogTitle>
            <DialogDescription>
              Vous ne pourrez plus vous connecter à Verebona avec {unlinkFor ? LABEL[unlinkFor] : 'ce compte'}. Vous pourrez l’associer à nouveau plus tard.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="ghost" onClick={() => setUnlinkFor(null)} disabled={busy}>Annuler</Button>
            <Button type="button" variant="destructive" onClick={() => unlinkFor && void unlink(unlinkFor)} disabled={busy} data-testid="confirm-unlink">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Déconnecter'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent>
          <form onSubmit={submitEmail}>
            <DialogHeader>
              <DialogTitle>Modifier l’adresse e-mail</DialogTitle>
              <DialogDescription>
                Nous envoyons un lien à la nouvelle adresse. Votre adresse actuelle ({summary.email ?? '—'}) reste celle du compte tant que ce lien n’est pas utilisé.
                Ensuite, vos autres appareils seront déconnectés et un message de sécurité sera envoyé aux deux adresses.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-4">
              <Label htmlFor="new-email">Nouvelle adresse e-mail</Label>
              <Input id="new-email" type="email" autoComplete="email" inputMode="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required />
              <p className="text-xs text-[color:var(--text-muted)]">Vos biens, documents, partages, votre abonnement et vos connexions Google ou Apple ne changent pas.</p>
            </div>
            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={() => setEmailOpen(false)}>Annuler</Button>
              <button type="submit" disabled={busy || !newEmail} className="btn-add disabled:opacity-40">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {busy ? 'Envoi…' : 'Envoyer le lien'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={addPasswordOpen} onOpenChange={setAddPasswordOpen}>
        <DialogContent>
          <form onSubmit={addPassword}>
            <DialogHeader>
              <DialogTitle>Ajouter un mot de passe</DialogTitle>
              <DialogDescription>
                Vous pourrez aussi vous connecter avec votre adresse {summary.email ?? 'principale'} et ce mot de passe. Il pourra être modifié, pas supprimé.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="add-password-new">Nouveau mot de passe</Label>
                <PasswordInput id="add-password-new" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
                <PasswordRequirements password={newPassword} confirmPassword={confirmPassword} showConfirmRule={true} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="add-password-confirm">Confirmer le mot de passe</Label>
                <PasswordInput id="add-password-confirm" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setAddPasswordOpen(false)}>Annuler</Button>
              <button type="submit" disabled={busy} className="btn-add disabled:opacity-40">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {busy ? 'Enregistrement…' : 'Ajouter'}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
