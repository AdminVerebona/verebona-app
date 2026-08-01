"use client"

/**
 * Réinitialisation du mot de passe.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CETTE PAGE N'EXISTAIT PAS
 *
 * `/api/auth/forgot-password` envoyait bien un email, et
 * `/api/auth/reset-password` savait bien traiter le jeton. Mais le lien du
 * message pointait vers `/reset-password`, une page absente : l'utilisateur
 * recevait son email et tombait sur un 404.
 *
 * Autrement dit, personne ne pouvait récupérer un mot de passe oublié — sans
 * qu'aucun test ni aucune erreur serveur ne le signale, puisque les deux
 * moitiés du parcours fonctionnaient séparément.
 *
 * ── LE JETON EXPIRE EN UNE HEURE ──────────────────────────────────────────
 *
 * L'API le vérifie et rend `TOKEN_EXPIRED`. Ce cas mérite son propre message
 * et un lien vers une nouvelle demande : « jeton invalide » laisserait croire
 * à une erreur de manipulation là où le délai a simplement couru.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { useState, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LogoWithBaseline } from '@/components/Logo';
import { Footer } from '@/components/Footer';
import { CheckCircle, AlertTriangle } from 'lucide-react';
import { ForceTheme } from '@/components/ForceTheme';
import { MIN_PASSWORD_LENGTH } from '@/lib/auth/password-rules';

/**
 * Règles annoncées à l'utilisateur.
 *
 * La longueur est LUE depuis `password-rules`, jamais recopiée : j'allais
 * écrire « 12 caractères » alors que la constante vaut 10. Une règle affichée
 * plus stricte que celle appliquée fait renoncer des utilisateurs à des mots
 * de passe qui auraient été acceptés.
 */
const REGLES = [
  `Minimum ${MIN_PASSWORD_LENGTH} caractères`,
  'Au moins 1 lettre',
  'Au moins 1 chiffre',
  'Au moins 1 caractère spécial',
  'Aucun espace',
];

function Contenu() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';

  const [motDePasse, setMotDePasse] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [erreur, setErreur] = useState('');
  const [expire, setExpire] = useState(false);
  const [enCours, setEnCours] = useState(false);
  const [termine, setTermine] = useState(false);

  const soumettre = async (e: React.FormEvent) => {
    e.preventDefault();
    setErreur('');

    // Vérifié ici ET côté serveur. Le contrôle client évite un aller-retour ;
    // c'est celui du serveur qui fait foi.
    if (motDePasse !== confirmation) {
      setErreur('Les deux mots de passe ne correspondent pas.');
      return;
    }

    setEnCours(true);
    try {
      const reponse = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: motDePasse }),
      });
      const data = await reponse.json();

      if (!reponse.ok) {
        // Un jeton périmé n'est pas une erreur de l'utilisateur : on le dit,
        // et on propose la seule suite utile — en redemander un.
        if (data.code === 'TOKEN_EXPIRED' || data.code === 'INVALID_TOKEN') {
          setExpire(true);
        } else {
          setErreur(data.error || 'Une erreur est survenue.');
        }
        setEnCours(false);
        return;
      }

      setTermine(true);
      // Redirection après un temps de lecture : basculer aussitôt ne laisserait
      // pas voir la confirmation.
      setTimeout(() => router.push('/login'), 2500);
    } catch {
      setErreur('Une erreur est survenue. Veuillez réessayer.');
      setEnCours(false);
    }
  };

  const cadre = (contenu: React.ReactNode) => (
    <div className="public-page min-h-screen flex flex-col bg-[color:var(--bg-page)]">
      <ForceTheme theme="blue" />
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-12">
        <div className="mb-8">
          <LogoWithBaseline />
        </div>
        <Card className="w-full max-w-md">{contenu}</Card>
      </div>
      <Footer />
    </div>
  );

  // ── Lien absent : arriver ici sans jeton n'a pas de sens ────────────────
  if (!token) {
    return cadre(
      <>
        <CardHeader className="text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-2" aria-hidden />
          <CardTitle>Lien incomplet</CardTitle>
          <CardDescription>
            Ce lien ne contient pas de jeton de réinitialisation. Il a peut-être été
            tronqué par votre messagerie.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Link href="/forgot-password" className="text-primary hover:underline">
            Demander un nouveau lien
          </Link>
        </CardContent>
      </>,
    );
  }

  if (expire) {
    return cadre(
      <>
        <CardHeader className="text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-2" aria-hidden />
          <CardTitle>Ce lien n&apos;est plus valable</CardTitle>
          <CardDescription>
            Les liens de réinitialisation expirent au bout d&apos;une heure, pour votre
            sécurité.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Link href="/forgot-password" className="text-primary hover:underline">
            Demander un nouveau lien
          </Link>
        </CardContent>
      </>,
    );
  }

  if (termine) {
    return cadre(
      <>
        <CardHeader className="text-center">
          <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto mb-2" aria-hidden />
          <CardTitle>Mot de passe modifié</CardTitle>
          <CardDescription>
            Vous allez être redirigé vers la page de connexion.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-center">
          <Link href="/login" className="text-primary hover:underline">
            Se connecter maintenant
          </Link>
        </CardContent>
      </>,
    );
  }

  return cadre(
    <>
      <CardHeader>
        <CardTitle>Nouveau mot de passe</CardTitle>
        <CardDescription>Choisissez un mot de passe pour votre compte.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={soumettre} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="motDePasse">Nouveau mot de passe</Label>
            <Input
              id="motDePasse"
              type="password"
              autoComplete="new-password"
              value={motDePasse}
              onChange={(e) => setMotDePasse(e.target.value)}
              required
              disabled={enCours}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmation">Confirmation</Label>
            <Input
              id="confirmation"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              required
              disabled={enCours}
            />
          </div>

          {/* Les règles sont annoncées AVANT la saisie, non après un refus :
              découvrir une contrainte au moment de l'échec oblige à tout
              recommencer. */}
          <ul className="text-xs text-[color:var(--text-muted)] space-y-0.5 pl-4 list-disc">
            {REGLES.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>

          {erreur && (
            <div className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
              {erreur}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={enCours}>
            {enCours ? 'Modification...' : 'Modifier mon mot de passe'}
          </Button>

          <div className="text-center text-sm">
            <Link href="/login" className="text-primary hover:underline">
              Retour à la connexion
            </Link>
          </div>
        </form>
      </CardContent>
    </>,
  );
}

export default function ResetPasswordPage() {
  // `useSearchParams` impose une frontière de suspension au rendu statique.
  return (
    <Suspense fallback={null}>
      <Contenu />
    </Suspense>
  );
}
