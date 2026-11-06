"use client"

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { AutofillInput } from '@/components/ui/autofill-input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { PasswordInput } from '@/components/ui/password-input';
import { AuthFooter } from '@/components/LandingFooter';
import { FollowTheme } from '@/components/FollowTheme';
import { publicSiteUrl } from '@/lib/external-urls';
import { AuthBackHomeLink } from '@/components/auth/AuthBackHomeLink';
import { apiClient } from '@/lib/api-client';
import {
  AUTH_EXIT_MESSAGES, LOGIN_BANNER_PARAMS, isLoginAttemptId, loginBannerFromParams, loginFailureMessage,
  newLoginAttemptId, rememberLoginAttempt,
} from '@/lib/auth/login-diagnostics';
import { runAuthStorageMigration } from '@/lib/auth-migration';
import { safeReturnUrl } from '@/lib/safe-redirect';
import { isNetworkError, postLogin } from '@/lib/auth/login-request';
import { SocialSignInButtons } from '@/components/auth/SocialSignInButtons';
import { socialErrorMessage } from '@/lib/auth/oauth/messages';
import { KeyRound } from 'lucide-react';
import { AUTOFILL, formFieldValue } from '@/lib/auth/autofill';
import { PASSKEY_ERROR_TEXT, getPasskeyAssertion, lastLocalMethod, mfaPost, passkeysUsableHere, rememberLocalMethod } from '@/lib/auth/mfa/client';
import {
  LOGIN_STATUS_RETRY_TEXT, NETWORK_ERROR_TEXT, SERVICE_TEMPORARY_TEXT, classifyMfaFailure, fetchLoginMethodsStatus,
  loginPasskeyOffer, loginPasskeyUnavailableText, type ServerLoginStatus,
} from '@/lib/auth/mfa/availability';

function LoginForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  // Chemin interne uniquement (redirection ouverte, voir `safe-redirect.ts`) ;
  // jamais une page d'authentification (boucle login → login).
  const returnUrl = safeReturnUrl(searchParams.get('returnUrl'));
  
  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');
  // CDC §6.3 : message neutre lorsque la session a expire. Il n'indique pas
  // si un compte existe, et n'expose aucun detail technique.
  // Lot 93 : retour d'un parcours Google / Apple refusé ou annulé (code stable, message en clair).
  // Lot 103A : un message PAR MOTIF (`reason` : session expirée, absence de
  // session, session révoquée, rejet juste après une connexion acceptée,
  // compte suspendu) — « Votre session a expiré. Merci de vous reconnecter. »
  // n'est plus affiché que pour une expiration réelle. Lu une seule fois :
  // les paramètres sont retirés de l'adresse (jamais réaffichés).
  const [error, setError] = useState(
    () => loginBannerFromParams(searchParams)?.message ?? socialErrorMessage(searchParams.get('social_error')) ?? '',
  );
  // Lot 103A : code de diagnostic (identifiant de la tentative de connexion),
  // affiché pour que le support retrouve les traces serveur — aucun secret.
  const [diagCode, setDiagCode] = useState<string | null>(() => {
    const d = searchParams.get('diag')?.toUpperCase() ?? null;
    return searchParams.get('reason') === 'post_login_rejected' && isLoginAttemptId(d) ? d : null;
  });
  // Code d'erreur : diagnostic, et proposition de renvoi du lien de
  // vérification quand le serveur répond EMAIL_NOT_VERIFIED — ce qu'il ne
  // fait qu'APRÈS la preuve du mot de passe (lot 37, CDC 18 §9.4).
  const [errorCode, setErrorCode] = useState('');
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [isLoading, setIsLoading] = useState(false);
  // Lot 110B : connexion par clé d'accès (selon compatibilité de cette vue) ;
  // proposée en tête seulement si c'est la dernière méthode employée ICI
  // (préférence locale, aucun privilège — ticket MFA §3).
  // Lot 111W : bouton proposé seulement si la VUE prend en charge WebAuthn ET
  // si le SERVICE WebAuthn du serveur est configuré (statut global anonyme,
  // aucune donnée de compte). Statut illisible (réseau) : message distinct +
  // « Réessayer », sans bloquer les autres méthodes.
  const [clientPasskey, setClientPasskey] = useState<boolean | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerLoginStatus | null>(null);
  const [lastWasPasskey, setLastWasPasskey] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyRetry, setPasskeyRetry] = useState(false);
  const checkServerStatus = async () => {
    setServerStatus(null);
    setServerStatus(await fetchLoginMethodsStatus());
  };
  useEffect(() => {
    void passkeysUsableHere().then((ok) => {
      setClientPasskey(ok);
      setLastWasPasskey(lastLocalMethod() === 'passkey');
    });
    void fetchLoginMethodsStatus().then(setServerStatus);
  }, []);
  const passkeyOffer = loginPasskeyOffer(clientPasskey, serverStatus);
  const passkeyHere = passkeyOffer === 'show';
  const passkeyFirst = passkeyHere && lastWasPasskey;
  const socials = serverStatus?.state === 'ready' ? { google: serverStatus.google, apple: serverStatus.apple } : {};
  // Configuration serveur indisponible constatée à l'usage : bouton retiré, autres méthodes de CONNEXION proposées.
  const passkeyUnavailable = () => {
    setServerStatus((st) => (st?.state === 'ready' ? { ...st, passkey: false } : { state: 'ready', passkey: false, google: false, apple: false }));
    setError(loginPasskeyUnavailableText(socials));
    setErrorCode('MFA_METHOD_UNAVAILABLE');
  };
  const passkeyFailed = (res: { status: number; data: { code?: string; message?: string } }) => {
    const kind = classifyMfaFailure(res.status, res.data.code);
    if (kind === 'unavailable') return passkeyUnavailable();
    if (kind === 'temporary') { setError(SERVICE_TEMPORARY_TEXT); setErrorCode(res.data.code || 'SERVICE_UNAVAILABLE'); setPasskeyRetry(true); return; }
    setError(res.data.message || PASSKEY_ERROR_TEXT.failed);
    setErrorCode(res.data.code ?? '');
  };

  const signInWithPasskey = async () => {
    if (passkeyBusy || isLoading) return;
    setPasskeyBusy(true);
    setError('');
    setErrorCode('');
    setPasskeyRetry(false);
    try {
      const o = await mfaPost<{ options: unknown; challengeId: string }>('/api/auth/mfa/passkey/options', { mode: 'login' });
      if (!o.ok) { passkeyFailed(o); return; }
      const a = await getPasskeyAssertion(o.data.options);
      if (!a.ok) { setError(PASSKEY_ERROR_TEXT[a.error]); return; }
      const v = await mfaPost<{ redirectTo?: string }>('/api/auth/mfa/passkey/verify', { mode: 'login', challengeId: o.data.challengeId, response: a.response, returnUrl });
      if (!v.ok) { passkeyFailed(v); return; }
      rememberLocalMethod('passkey');
      router.push(typeof v.data.redirectTo === 'string' && v.data.redirectTo.startsWith('/') ? v.data.redirectTo : returnUrl);
    } catch {
      // Coupure ponctuelle : état distinct et nouvel essai possible (rien n'est verrouillé).
      setError(NETWORK_ERROR_TEXT);
      setErrorCode('NETWORK_ERROR');
      setPasskeyRetry(true);
    } finally {
      setPasskeyBusy(false);
    }
  };

  // Si une session valide existe deja (cookie HttpOnly), ne pas afficher le
  // formulaire. L'etat de session n'est plus lisible en JavaScript : on
  // interroge le serveur (CDC §5.6).
  // Lot 103A : motif lu → retiré de l'adresse (rechargement, retour arrière,
  // nouvelle tentative : aucun message obsolète réaffiché). `returnUrl` et
  // `email` sont conservés.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    let changed = false;
    for (const k of LOGIN_BANNER_PARAMS) if (url.searchParams.has(k)) { url.searchParams.delete(k); changed = true; }
    if (changed) {
      try { window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`); } catch { /* sans effet */ }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Nettoyage des sessions historiques (CDC §11.2)
      runAuthStorageMigration();
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' });
        if (!cancelled && res.ok) router.replace(returnUrl);
      } catch {
        // Pas de session : on laisse le formulaire s'afficher.
      }
    })();
    return () => { cancelled = true; };
  }, [router, returnUrl]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Lot 111E : valeurs RÉELLES du formulaire (remplissage automatique non vu
    // par React), lues avant toute désactivation des champs.
    const submittedEmail = formFieldValue(e.currentTarget, 'username', email).trim();
    const submittedPassword = formFieldValue(e.currentTarget, 'password', password);
    if (submittedEmail !== email) setEmail(submittedEmail);
    if (submittedPassword !== password) setPassword(submittedPassword);
    // Nouvelle tentative : aucun message ni code de la précédente ne subsiste.
    setError('');
    setErrorCode('');
    setPasskeyRetry(false);
    setDiagCode(null);
    setResendState('idle');
    setIsLoading(true);

    // Lot 103A : identifiant de corrélation de CETTE tentative (journal serveur
    // `[auth.diag]`, BO › historique des connexions). Aucun secret.
    const attemptId = newLoginAttemptId();
    const startedAt = Date.now();
    rememberLoginAttempt({ id: attemptId, at: startedAt, ok: false });

    try {
      // Une reprise automatique sur coupure réseau (mobile), journalisée sans
      // identifiants — voir `login-request.ts` (rejouer la connexion est sûr).
      const response = await postLogin({ email: submittedEmail, password: submittedPassword, returnUrl }, { attemptId });

      let data: Record<string, string> = {};
      try { data = await response.json(); } catch { /* body vide ou non-JSON */ }

      if (!response.ok) {
        // Refus de la CONNEXION (identifiants, compte, anti-abus, version de
        // l'app, origine) : message propre au code, jamais « session expirée ».
        const failure = loginFailureMessage(response.status, data);
        setError(failure.message);
        setErrorCode(failure.code);
        setIsLoading(false);
        return;
      }

      rememberLoginAttempt({ id: attemptId, at: startedAt, ok: true });

      // Lot 110B : double authentification obligatoire pour ce compte — aucune
      // session n'est encore ouverte ; seconde étape (code ou clé d'accès) ou
      // premier enrôlement (« Sécurisez votre compte »).
      if ((data as { mfaRequired?: boolean }).mfaRequired) {
        rememberLocalMethod('password');
        const next = typeof data.redirectTo === 'string' && data.redirectTo.startsWith('/') ? data.redirectTo : '/verification';
        router.push(`${next}?returnUrl=${encodeURIComponent(returnUrl)}`);
        return;
      }

      // Lot 103A — premier appel authentifié AVANT de quitter l'écran : la
      // session tout juste émise est-elle conservée et transmise par cette vue
      // (WKWebView / WebView Android : cookies HttpOnly) ? Un refus ici n'est
      // pas une expiration : l'utilisateur reste sur l'écran, avec un message
      // dédié et le code de diagnostic. Une lenteur ou une panne ne bloque pas.
      try {
        await apiClient.get('/api/users/me', { onAuthFailure: 'silent', dedupe: false, cache: 'no-store' });
      } catch (checkError) {
        const status = (checkError as { status?: unknown })?.status;
        if (status === 401) {
          setError(AUTH_EXIT_MESSAGES.post_login_rejected);
          setErrorCode('POST_LOGIN_SESSION_MISSING');
          setDiagCode(attemptId);
          setIsLoading(false);
          return;
        }
      }

      // Compte clôturé (suppression programmée) : seul l'écran d'annulation
      // et d'export est accessible.
      const loggedUser = (data as { user?: { status?: string } }).user;
      router.push(loggedUser?.status === 'PENDING_DELETION' ? '/compte-en-suppression' : returnUrl);
    } catch (err) {
      // Coupure réseau persistante (déjà journalisée et reprise une fois par
      // `postLogin`) : le dire plutôt qu'un message vague. Toute autre
      // erreur est journalisée ici (jamais les identifiants).
      if (!isNetworkError(err)) console.error('[Login] Error:', (err as Error)?.name ?? 'Error', (err as Error)?.message ?? '');
      setError('Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.');
      setErrorCode('NETWORK_ERROR');
      setIsLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!email) return;
    setResendState('sending');
    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setResendState(response.ok ? 'sent' : 'failed');
    } catch {
      setResendState('failed');
    }
  };

  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <FollowTheme />
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
          <CardHeader className="space-y-4">
            {/* Lot 103A : lien Web seulement — jamais rendu dans l'app iOS / Android
                (écran racine) ; le logo devient alors le premier élément. */}
            <AuthBackHomeLink />
            <div className="flex justify-center">
              <LogoWithBaseline size={50} />
            </div>
            <CardTitle role="heading" aria-level={1} className="text-center text-[26px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">Connexion</CardTitle>
            <CardDescription className="text-center text-[color:var(--text-muted)]">
              Connectez-vous à votre compte Verebona
            </CardDescription>
          </CardHeader>
          <CardContent>
            {/* Lot 110B : clé d'accès en tête si c'est la dernière méthode employée sur cet appareil. */}
            {passkeyHere && passkeyFirst && (
              <Button type="button" className="w-full mb-3" onClick={() => void signInWithPasskey()} disabled={isLoading || passkeyBusy} data-testid="login-passkey-first">
                <KeyRound className="w-4 h-4 mr-2" />{passkeyBusy ? 'Connexion…' : 'Se connecter avec une clé d’accès'}
              </Button>
            )}
            {/* Lot 93 (CDC 18 §9.1) : Google et Apple, puis « ou », puis e-mail + mot de passe. */}
            <SocialSignInButtons mode="login" returnUrl={returnUrl} disabled={isLoading} className="mb-4" />
            <form onSubmit={handleSubmit} method="post" className="space-y-4" data-testid="login-form">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                {/* Lot 111E : identifiant de connexion reconnu par le système
                    (iOS AutoFill, Android, navigateurs, gestionnaires tiers). */}
                <AutofillInput
                  id="email"
                  name="username"
                  type="email"
                  inputMode="email"
                  autoComplete={AUTOFILL.username}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="votre.email@exemple.fr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Mot de passe</Label>
                <PasswordInput
                  id="password"
                  name="password"
                  placeholder="••••••••"
                  autoComplete={AUTOFILL.currentPassword}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>

              {error && (
                <div role="alert" data-error-code={errorCode || undefined} className="flex items-start gap-2 text-sm bg-[color:var(--danger-soft)] border border-[color:var(--danger-edge)] text-[color:var(--danger)] p-3 rounded-md">
                  <span className="shrink-0 mt-0.5">⚠</span>
                  <div>
                    <p>{error}</p>
                    {diagCode && (
                      <p className="mt-1 text-xs">
                        Code de diagnostic : <span className="font-mono select-all" data-testid="login-diag-code">{diagCode}</span>
                      </p>
                    )}
                    {passkeyRetry && (
                      <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void signInWithPasskey()} disabled={isLoading || passkeyBusy} data-testid="login-passkey-retry">
                        Réessayer
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {errorCode === 'EMAIL_NOT_VERIFIED' && (
                <div className="space-y-2 text-sm">
                  {resendState === 'sent' ? (
                    <p className="text-[color:var(--text-muted)]">
                      Demande enregistrée. Si un compte non vérifié correspond à cette adresse, un nouveau lien de
                      vérification va lui être envoyé dans quelques instants. Rien reçu ?{' '}
                      <a href={publicSiteUrl('/contact')} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">
                        Contacter l’assistance
                      </a>
                    </p>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={handleResendVerification}
                      disabled={resendState === 'sending'}
                    >
                      {resendState === 'sending' ? 'Envoi…' : 'Renvoyer l’e-mail de vérification'}
                    </Button>
                  )}
                  {resendState === 'failed' && (
                    <p className="text-[color:var(--danger)]">L’envoi n’a pas pu être demandé. Réessayez dans quelques minutes.</p>
                  )}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? 'Connexion...' : 'Se connecter'}
              </Button>

              {/* Lot 110B : option neutre (appareil inconnu) — aucune information sur le compte. */}
              {passkeyHere && !passkeyFirst && (
                <Button type="button" variant="outline" className="w-full" onClick={() => void signInWithPasskey()} disabled={isLoading || passkeyBusy} data-testid="login-passkey">
                  <KeyRound className="w-4 h-4 mr-2" />{passkeyBusy ? 'Connexion…' : 'Se connecter avec une clé d’accès'}
                </Button>
              )}
              {passkeyOffer === 'retry' && (
                <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-[color:var(--text-muted)] text-center" role="status" data-testid="login-passkey-status-error">
                  <span>{LOGIN_STATUS_RETRY_TEXT}</span>
                  <Button type="button" size="sm" variant="ghost" onClick={() => void checkServerStatus()} data-testid="login-passkey-status-retry">Réessayer</Button>
                </div>
              )}

              <div className="text-center space-y-2 text-sm">
                <div className="text-muted-foreground">
                  <Link href="/forgot-password" className="text-primary hover:underline">
                    Mot de passe oublié ?
                  </Link>
                </div>
                <div className="text-muted-foreground">
                  Pas encore de compte ?{' '}
                  <Link href="/signup" className="text-primary hover:underline">
                    Créer un compte
                  </Link>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
      <AuthFooter />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-[color:var(--bg-page)]">
        <div className="text-[color:var(--text-muted)]">Chargement...</div>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}