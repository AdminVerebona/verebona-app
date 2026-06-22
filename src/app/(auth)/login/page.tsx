"use client"

import { useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { PasswordInput } from '@/components/ui/password-input';
import { AuthFooter } from '@/components/LandingFooter';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { ForceTheme } from '@/components/ForceTheme';

function LoginForm() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const rawReturn = searchParams.get('returnUrl') || '/accueil';
  // Eviter les boucles login→login
  const returnUrl = rawReturn.startsWith('/login') || rawReturn.startsWith('/signup') ? '/accueil' : rawReturn;
  
  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setErrorCode('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      let data: Record<string, string> = {};
      try { data = await response.json(); } catch { /* body vide ou non-JSON */ }

      if (!response.ok) {
        if (response.status === 503 || data.code === 'SERVICE_UNAVAILABLE') {
          setError('Service temporairement indisponible. Veuillez réessayer dans quelques instants.');
        } else if (response.status >= 500) {
          setError('Une erreur est survenue sur le serveur. Veuillez réessayer.');
        } else {
          setError(data.message || data.error || 'Identifiants incorrects. Veuillez réessayer.');
        }
        setErrorCode(data.code || '');
        setIsLoading(false);
        return;
      }

      if (data.accessToken) {
        localStorage.setItem('bearer_token', data.accessToken);
      }
      if (data.refreshToken) {
        localStorage.setItem('refresh_token', data.refreshToken);
      }

      // Pré-remplir le cache user avec le bon format (subscription.plan requis par useSession)
      try {
        const meRes = await fetch('/api/users/me', {
          headers: { Authorization: `Bearer ${data.accessToken}` },
        });
        if (meRes.ok) {
          const meData = await meRes.json();
          localStorage.setItem('user', JSON.stringify(meData));
        }
      } catch { /* silently ignore — useSession refera l'appel */ }

      router.push(returnUrl);
    } catch (err) {
      console.error('[Login] Error:', err);
      setError('Une erreur est survenue. Veuillez réessayer.');
      setErrorCode('NETWORK_ERROR');
      setIsLoading(false);
    }
  };

  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <ForceTheme theme="blue" />
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
          <CardHeader className="space-y-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors w-fit"
            >
              <ArrowLeft className="w-4 h-4" />
              Retour à l'accueil
            </Link>
            <div className="flex justify-center">
              <LogoWithBaseline size={50} />
            </div>
            <CardTitle className="text-center text-[color:var(--text-primary)]">Connexion</CardTitle>
            <CardDescription className="text-center text-[color:var(--text-muted)]">
              Connectez-vous à votre compte Verebona
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
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
                  placeholder="••••••••"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 text-sm bg-red-500/15 border border-red-500/30 text-red-400 p-3 rounded-md">
                  <span className="shrink-0 mt-0.5">⚠</span>
                  <p>{error}</p>
                </div>
              )}

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? 'Connexion...' : 'Se connecter'}
              </Button>

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
      <div className="min-h-screen flex items-center justify-center bg-[#020617]">
        <div className="text-slate-400">Chargement...</div>
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}