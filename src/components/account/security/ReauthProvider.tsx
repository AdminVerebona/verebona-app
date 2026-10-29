'use client';

/**
 * Réauthentification du bloc Sécurité — composant UNIQUE (lot 92, CDC 18
 * §18 ; décision PO Q7).
 *
 *   · `useReauth().withReauth(action)` exécute une action sensible ; si le
 *     serveur répond REAUTH_REQUIRED / REAUTH_EXPIRED, la fenêtre « Confirmez
 *     votre identité » s'ouvre, puis l'action est rejouée UNE fois — les
 *     champs déjà saisis ne sont pas perdus (CDC §37) ;
 *   · `useReauth().ensureFresh()` ouvre la fenêtre seulement si la session
 *     n'a pas de confirmation fraîche (< 5 min) ;
 *   · la confirmation vaut 5 minutes pour tout le bloc Sécurité ; c'est le
 *     SERVEUR qui la mémorise (rien n'est stocké dans le navigateur).
 *
 * Méthodes proposées : celles que le serveur annonce (`GET
 * /api/users/me/security`) — mot de passe, et Google / Apple déjà associés
 * (sous-lot 93, boutons de redirection : `POST startUrl { resume }` →
 * `{ redirectUrl }`). Au retour du fournisseur, la page Sécurité reprend
 * l'action indiquée par `resume` (`SignInMethodsBlock`). C'est la SEULE
 * fenêtre « Confirmez votre identité » de l'application.
 * Tous les appels passent par `apiClient` (renouvellement de session au
 * besoin — point d'attention du lot 53A).
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { apiClient, ApiClientError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { ProviderButton } from '@/components/auth/SocialSignInButtons';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';

export const REAUTH_ERROR_CODES = new Set(['REAUTH_REQUIRED', 'REAUTH_EXPIRED']);

export function isReauthError(e: unknown): boolean {
  return e instanceof ApiClientError && e.status === 403 && REAUTH_ERROR_CODES.has(e.code);
}

interface ReauthMethodView { id: string; label: string; kind: 'password' | 'redirect'; startUrl?: string }
interface SecurityStatus { reauth: { fresh: boolean; freshUntil: string | null; methods: ReauthMethodView[] } }

/**
 * Action à reprendre au retour d'une confirmation Google / Apple (la page est
 * quittée) — voir `SecurityAction` (`SignInMethodsBlock`).
 */
export type ReauthResume = string;

interface ReauthContextValue {
  ensureFresh(reason?: string, resume?: ReauthResume): Promise<boolean>;
  withReauth<T>(action: () => Promise<T>, reason?: string, resume?: ReauthResume): Promise<T>;
}

const ReauthContext = createContext<ReauthContextValue | null>(null);

export function useReauth(): ReauthContextValue {
  const ctx = useContext(ReauthContext);
  if (!ctx) throw new Error('useReauth doit être utilisé dans <ReauthProvider>');
  return ctx;
}

export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [methods, setMethods] = useState<ReauthMethodView[] | null>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState<string | null>(null);
  const pending = useRef<((ok: boolean) => void) | null>(null);
  const resumeRef = useRef<ReauthResume | undefined>(undefined);

  const loadStatus = useCallback(async (): Promise<SecurityStatus | null> => {
    try {
      return await apiClient.get<SecurityStatus>('/api/users/me/security');
    } catch {
      return null;
    }
  }, []);

  const ask = useCallback(async (why: string | undefined, wasExpired: boolean, resume?: ReauthResume): Promise<boolean> => {
    resumeRef.current = resume;
    setRedirecting(null);
    const status = await loadStatus();
    setMethods(status?.reauth.methods ?? [{ id: 'password', label: 'Mot de passe', kind: 'password' }]);
    setReason(why ?? null);
    setExpired(wasExpired);
    setPassword('');
    setError(null);
    setOpen(true);
    return new Promise<boolean>((resolve) => { pending.current = resolve; });
  }, [loadStatus]);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    setPassword('');
    const resolve = pending.current;
    pending.current = null;
    resolve?.(ok);
  }, []);

  const ensureFresh = useCallback(async (why?: string, resume?: ReauthResume) => {
    const status = await loadStatus();
    if (status?.reauth.fresh) return true;
    return ask(why, false, resume);
  }, [ask, loadStatus]);

  const withReauth = useCallback(async <T,>(action: () => Promise<T>, why?: string, resume?: ReauthResume): Promise<T> => {
    try {
      return await action();
    } catch (e) {
      if (!isReauthError(e)) throw e;
      const ok = await ask(why, (e as ApiClientError).code === 'REAUTH_EXPIRED', resume);
      if (!ok) throw e;
      return action();
    }
  }, [ask]);

  const submitPassword = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.post('/api/users/me/security/reauth', { method: 'password', password });
      finish(true);
    } catch (e) {
      const msg = e instanceof ApiClientError
        ? (e.code === 'INVALID_CURRENT_PASSWORD' ? 'Mot de passe incorrect.' : (e.serverMessage || 'La confirmation a échoué. Réessayez.'))
        : 'La confirmation a échoué. Réessayez.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  // Google / Apple : la page est quittée ; l'action reprend au retour (`resume`).
  const startRedirect = async (m: ReauthMethodView) => {
    if (!m.startUrl || redirecting) return;
    setRedirecting(m.id);
    setError(null);
    try {
      const r = await apiClient.post<{ redirectUrl?: string }>(m.startUrl, resumeRef.current ? { resume: resumeRef.current } : {});
      if (r?.redirectUrl) { window.location.assign(r.redirectUrl); return; }
      setError('La confirmation est impossible pour le moment. Réessayez.');
    } catch (e) {
      setError(e instanceof ApiClientError && e.serverMessage ? e.serverMessage : 'La confirmation est impossible pour le moment. Réessayez.');
    }
    setRedirecting(null);
  };

  const value = useMemo(() => ({ ensureFresh, withReauth }), [ensureFresh, withReauth]);
  const passwordMethod = methods?.find((m) => m.kind === 'password');
  const redirectMethods = methods?.filter((m) => m.kind === 'redirect' && m.startUrl) ?? [];

  return (
    <ReauthContext.Provider value={value}>
      {children}
      <Dialog open={open} onOpenChange={(v) => { if (!v) finish(false); }}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submitPassword}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[color:var(--accent)]" />
                Confirmez votre identité
              </DialogTitle>
              <DialogDescription>
                {expired
                  ? 'Votre confirmation a expiré. '
                  : ''}
                {reason ? `${reason} ` : ''}
                Cette confirmation reste valable 5 minutes pour les réglages de sécurité.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {passwordMethod && (
                <div className="space-y-2">
                  <Label htmlFor="reauth-password">Votre mot de passe</Label>
                  <PasswordInput
                    id="reauth-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    autoFocus
                    disabled={submitting}
                  />
                </div>
              )}
              {passwordMethod && redirectMethods.length > 0 && <div className="vb-or-separator" role="separator">ou</div>}
              {redirectMethods.map((m) => (m.id === 'google' || m.id === 'apple'
                ? <ProviderButton key={m.id} provider={m.id} label={m.label} onClick={() => void startRedirect(m)} disabled={submitting || redirecting !== null} />
                : (
                  <Button key={m.id} type="button" variant="outline" className="w-full rounded-full" disabled={submitting || redirecting !== null} onClick={() => void startRedirect(m)}>
                    {m.label}
                  </Button>
                )))}
              {methods && methods.length === 0 && (
                <p className="text-sm text-muted-foreground">Aucune méthode de confirmation n’est disponible pour votre compte.</p>
              )}
              {error && <p className="text-sm text-[color:var(--danger)]" role="alert">{error}</p>}
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => finish(false)} disabled={submitting}>Annuler</Button>
              {passwordMethod && (
                <button type="submit" disabled={!password || submitting} className="btn-add disabled:opacity-40">
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  {submitting ? 'Vérification…' : 'Confirmer'}
                </button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </ReauthContext.Provider>
  );
}
