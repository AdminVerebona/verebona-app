'use client';

/**
 * « Retour à l'accueil » des écrans d'authentification — lot 103A (recette
 * iOS du 31/10/2026).
 *
 * Dans l'application iOS / Android, l'écran Connexion (comme Inscription) est
 * un écran RACINE du parcours non connecté : aucun « accueil » vers lequel
 * revenir — le lien renvoyait vers la vitrine Web dans la vue de l'app. Il
 * n'est donc pas RENDU dans l'app (rendu conditionnel, pas de CSS : aucun
 * élément caché ni espace réservé ; le logo devient le premier élément de
 * l'en-tête). Sur le Web, inchangé.
 *
 * Hydratation sans clignotement : la décision du PREMIER rendu vient du
 * serveur (marqueur `VerebonaApp/` de l'agent utilisateur de la vue, lu par
 * `app/(auth)/layout.tsx` → `NativeShellProvider`), identique côté client ;
 * après montage, la détection Capacitor (`isNativeApp`) la confirme — elle
 * ne peut que masquer, jamais faire apparaître le lien dans l'app.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { publicSiteUrl } from '@/lib/external-urls';
import { isNativeApp } from '@/lib/native/bridge';

const NativeShellContext = createContext(false);

/** Indication serveur « vue de l'application native » pour le premier rendu. */
export function NativeShellProvider({ native, children }: { native: boolean; children?: ReactNode }) {
  return <NativeShellContext.Provider value={native}>{children}</NativeShellContext.Provider>;
}

/** Décision pure (testée) : le lien Web n'est rendu que hors de l'application. */
export function showWebBackHomeLink(serverNative: boolean, clientNative: boolean): boolean {
  return !serverNative && !clientNative;
}

/** L'interface tourne-t-elle dans l'app ? (indication serveur, confirmée après montage) */
export function useNativeShell(): boolean {
  const serverNative = useContext(NativeShellContext);
  const [clientNative, setClientNative] = useState(false);
  useEffect(() => { setClientNative(isNativeApp()); }, []);
  return !showWebBackHomeLink(serverNative, clientNative);
}

/** Contenu propre au Web (ex. bouton « Retour à l'accueil ») : jamais rendu dans l'app. */
export function WebOnly({ children }: { children: ReactNode }) {
  return useNativeShell() ? null : <>{children}</>;
}

export function AuthBackHomeLink() {
  const native = useNativeShell();
  if (native) return null;
  return (
    <a
      href={publicSiteUrl('/')}
      data-testid="auth-back-home"
      className="inline-flex items-center gap-2 text-sm text-[color:var(--text-muted)] hover:text-[color:var(--text-primary)] transition-colors w-fit"
    >
      <ArrowLeft className="w-4 h-4" />
      Retour à l&apos;accueil
    </a>
  );
}
