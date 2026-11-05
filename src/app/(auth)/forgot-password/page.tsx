"use client"

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { AutofillInput } from '@/components/ui/autofill-input';
import { AUTOFILL, formFieldValue } from '@/lib/auth/autofill';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { Footer } from '@/components/Footer';
import { CheckCircle } from 'lucide-react';
import { FollowTheme } from '@/components/FollowTheme';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Lot 111E : adresse réellement affichée (remplissage automatique compris).
    const submittedEmail = formFieldValue(e.currentTarget, 'username', email).trim();
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: submittedEmail }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Une erreur est survenue');
        setIsLoading(false);
        return;
      }

      setIsSubmitted(true);
    } catch {
      setError('Une erreur est survenue. Veuillez réessayer.');
      setIsLoading(false);
    }
  };

  if (isSubmitted) {
    return (
      <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
        <FollowTheme />
        <div className="flex-1 flex items-center justify-center p-4">
          <Card className="w-full max-w-md bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
            <CardHeader className="space-y-4">
              <div className="flex justify-center">
                <CheckCircle className="w-16 h-16 text-[color:var(--text-success)]" />
              </div>
              <CardTitle role="heading" aria-level={1} className="text-center text-[26px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">Email envoyé</CardTitle>
              <CardDescription className="text-center text-[color:var(--text-muted)]">
                Si un compte existe avec cet email, un lien de réinitialisation vous a été envoyé.
                Vérifiez votre boîte de réception.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link href="/login">
                <Button className="w-full">
                  Retour à la connexion
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <FollowTheme />
      <div className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md bg-[color:var(--bg-card)] border-[color:var(--border-subtle)] shadow-xl">
          <CardHeader className="space-y-4">
            <div className="flex justify-center">
              <LogoWithBaseline size={50} />
            </div>
            <CardTitle role="heading" aria-level={1} className="text-center text-[26px] font-extrabold tracking-[-.02em] text-[color:var(--text-primary)]">Mot de passe oublié</CardTitle>
            <CardDescription className="text-center text-[color:var(--text-muted)]">
              Entrez votre email pour recevoir un lien de réinitialisation
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} method="post" className="space-y-4" data-testid="forgot-password-form">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
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

              {error && (
                <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                  {error}
                </div>
              )}

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? 'Envoi...' : 'Envoyer le lien de réinitialisation'}
              </Button>

              <div className="text-center text-sm">
                <Link href="/login" className="text-primary hover:underline">
                  Retour à la connexion
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
      <Footer />
    </div>
  );
}