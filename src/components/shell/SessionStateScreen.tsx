"use client"

/**
 * Écrans d'état de session de la coquille — APP-PERF-02 / APP-PERF-21.
 *
 * · Indisponibilité temporaire : la vérification de session n'a pas abouti
 *   (lenteur, panne, réseau). Ce n'est PAS une session expirée : on propose
 *   de réessayer, sans renvoyer à la connexion ni laisser un chargement
 *   permanent.
 * · Sortie : déconnexion en cours (bornée), puis, si le serveur n'a pas
 *   confirmé, un choix explicite — réessayer ou quitter — sans annoncer une
 *   révocation qui n'a pas eu lieu.
 * · Carte #793 : preuve forte exigée (403 `MFA_REQUIRED`). La session EXISTE
 *   et le serveur l'a comprise : ce n'est pas une panne. Écran propre, avec
 *   la reconnexion demandée et AUCUN bouton « Réessayer » (le même appel
 *   recevrait le même refus : c'était la boucle signalée par la carte).
 */
import { LogoLoader } from '@/components/LogoLoader';
import { Button } from '@/components/ui/button';
import { MFA_REQUIRED_MESSAGE } from '@/lib/auth/mfa/constants';

const cadre = 'min-h-screen flex items-center justify-center bg-[color:var(--bg-page)] p-6';
const carte = 'w-full max-w-sm space-y-4 rounded-2xl border border-[color:var(--border-subtle)] bg-[color:var(--bg-card)] p-6 text-center shadow-relief-md';

export function SessionUnavailableScreen({
  onRetry,
  retrying = false,
  requestId,
}: {
  onRetry: () => void;
  retrying?: boolean;
  requestId?: string;
}) {
  return (
    <div className={cadre}>
      <div className={carte} role="alert">
        <LogoLoader size={36} />
        <h1 className="text-base font-semibold text-[color:var(--text-primary)]">
          Connexion au service momentanément impossible
        </h1>
        {/* Carte #793 §5 : plus d'affirmation que le système ne peut pas
            garantir (« votre session n'est pas en cause », « vos données sont
            intactes »). Texte NOUVEAU, à valider par le PO. */}
        <p className="text-sm text-[color:var(--text-muted)]">
          La vérification de votre session n&apos;a pas abouti. Réessayez dans un instant.
        </p>
        <Button onClick={onRetry} disabled={retrying} className="w-full">
          {retrying ? 'Nouvelle tentative…' : 'Réessayer'}
        </Button>
        {requestId && (
          <p className="text-xs text-[color:var(--text-muted)]">Référence : {requestId}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Carte #793 — session valide mais de preuve insuffisante face à l'obligation
 * de double authentification (403 `MFA_REQUIRED`). Aucun réessai : une seule
 * action, la reconnexion forte, vers le parcours EXISTANT
 * (`/login?reason=mfa_required&returnUrl=…`), qui mène à la clé d'accès, au
 * code de sécurité ou à « Sécurisez votre compte » selon l'enrôlement.
 */
export function SessionReauthRequiredScreen({
  onSignIn,
  requestId,
}: {
  onSignIn: () => void;
  requestId?: string;
}) {
  return (
    <div className={cadre}>
      <div className={carte} role="alert" data-testid="session-reauth-required">
        {/* Titre NOUVEAU, à valider par le PO. */}
        <h1 className="text-base font-semibold text-[color:var(--text-primary)]">
          Confirmez votre identité pour continuer
        </h1>
        {/* Message du serveur (lot 110B), repris à l'identique. */}
        <p className="text-sm text-[color:var(--text-muted)]">{MFA_REQUIRED_MESSAGE}</p>
        <Button onClick={onSignIn} className="w-full" data-testid="session-reauth-signin">
          Se reconnecter
        </Button>
        {requestId && (
          <p className="text-xs text-[color:var(--text-muted)]">Référence : {requestId}</p>
        )}
      </div>
    </div>
  );
}

export function LogoutStatusScreen({
  state,
  onRetry,
  onLeave,
}: {
  state: 'pending' | 'failed';
  onRetry: () => void;
  onLeave: () => void;
}) {
  if (state === 'pending') {
    return (
      <div className={cadre}>
        <div className="flex flex-col items-center gap-3" role="status">
          <LogoLoader size={40} />
          <p className="text-sm text-[color:var(--text-muted)]">Déconnexion…</p>
        </div>
      </div>
    );
  }
  return (
    <div className={cadre}>
      <div className={carte} role="alert">
        <h1 className="text-base font-semibold text-[color:var(--text-primary)]">
          Déconnexion non confirmée
        </h1>
        <p className="text-sm text-[color:var(--text-muted)]">
          Les informations de votre compte ont été retirées de cet écran, mais le serveur
          n&apos;a pas confirmé la fermeture de la session. Sur un appareil partagé,
          réessayez avant de partir.
        </p>
        <div className="flex flex-col gap-2">
          <Button onClick={onRetry} className="w-full">Réessayer la déconnexion</Button>
          <Button variant="outline" onClick={onLeave} className="w-full">Quitter quand même</Button>
        </div>
      </div>
    </div>
  );
}
