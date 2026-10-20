/**
 * Lien permanent « Gérer mon abonnement sur Stripe » — côté client (lot 68C).
 *
 * La page `/mon-compte/abonnement/gerer` (lien du rappel J−7 avant
 * renouvellement annuel) crée À L'OUVERTURE une session Stripe Customer
 * Portal (`POST /api/billing/create-customer-portal-session`, logique unique
 * `services/billing/customer-portal.service.ts`) puis redirige vers Stripe.
 * Un lien ouvert plusieurs jours après réception fonctionne donc toujours.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SESSION ABSENTE OU EXPIRÉE
 *   · aucun cookie de session : le middleware renvoie à `/login?returnUrl=…` ;
 *   · jeton d'accès expiré mais session renouvelable : l'api-client renouvelle
 *     puis rejoue ; session perdue : `/login?expired=1&returnUrl=…`.
 * Après la connexion, retour sur cette page, qui relance la redirection.
 *
 * APPLICATION INSTALLÉE (Capacitor, voir lot 62 `lib/shell/logout-exit.ts`)
 * Une navigation de premier niveau vers un autre domaine (Stripe) est
 * ANNULÉE par la coquille native et confiée au navigateur du téléphone : la
 * vue web reste sur cette page. Elle ne reste jamais « bloquée » : après un
 * court délai, elle affiche « Le portail s'est ouvert dans votre navigateur »,
 * un bouton pour le rouvrir (nouvelle session) et le retour à « Mon compte ».
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isNativeAppShell, type LogoutExitWindow } from '@/lib/shell/logout-exit';

/** Délai au-delà duquel la page propose le repli (navigation non partie). */
export const PORTAL_FALLBACK_MS = 2_500;

export type PortalNavigation = 'replace' | 'external';

export interface PortalWindow {
  location: { href: string; protocol?: string; replace(url: string): void };
  Capacitor?: LogoutExitWindow['Capacitor'];
}

/**
 * Part vers l'URL Stripe. Navigateur : `replace` (le retour arrière ne
 * ramène pas sur la page de redirection). Application installée : navigation
 * confiée au navigateur du système par la coquille ; la page reste affichée.
 */
export function goToPortal(url: string, w: PortalWindow): PortalNavigation {
  if (!/^https:\/\//i.test(url)) throw new Error('PORTAL_URL_INVALID');
  if (isNativeAppShell(w)) {
    w.location.href = url;
    return 'external';
  }
  w.location.replace(url);
  return 'replace';
}

export interface PortalErrorView {
  title: string;
  message: string;
  /** Proposer « Réessayer » (panne passagère). */
  retry: boolean;
}

/** Message affiché pour un refus ou une panne (aucune donnée d'un autre compte). */
export function portalErrorView(code: string | undefined, serverMessage?: string): PortalErrorView {
  switch (code) {
    case 'DUO_GUEST':
      return { title: 'Gestion réservée au titulaire', message: serverMessage || 'La facturation de cet espace Premium Duo est gérée par la personne titulaire de l’abonnement. Vous n’avez pas accès à sa gestion.', retry: false };
    case 'FORBIDDEN':
      return { title: 'Gestion réservée au titulaire', message: 'Seul le titulaire du compte peut gérer l’abonnement et la facturation.', retry: false };
    // Lot 72F : lien contextualisé (compte facturé précis) — jamais d'autre portail.
    case 'ACCOUNT_FORBIDDEN':
      return { title: 'Lien réservé au titulaire de cet abonnement', message: 'Ce lien concerne un abonnement que vous ne pouvez pas gérer avec ce compte Verebona. Déconnectez-vous puis connectez-vous avec le compte titulaire qui a reçu l’e-mail.', retry: false };
    case 'BILLING_MISMATCH':
      return { title: 'Vérification nécessaire', message: 'Les informations de facturation de ce compte doivent être vérifiées par notre équipe avant d’ouvrir l’espace de gestion. Contactez le support depuis « Mon compte ».', retry: false };
    case 'INVALID_ACCOUNT_REF':
      return { title: 'Lien invalide', message: 'Ce lien de gestion de l’abonnement est incomplet. Ouvrez la gestion de votre abonnement depuis « Mon compte ».', retry: false };
    case 'NO_STRIPE_CUSTOMER':
    case 'NO_ACCOUNT':
      return { title: 'Aucun abonnement à gérer', message: 'Aucun abonnement payant n’est associé à ce compte Verebona. Vérifiez que vous êtes connecté avec le compte qui a reçu l’e-mail.', retry: false };
    default:
      return { title: 'Portail momentanément indisponible', message: 'L’espace de gestion Stripe n’a pas pu être ouvert. Réessayez dans quelques instants.', retry: true };
  }
}
