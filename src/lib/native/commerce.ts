/**
 * Aucun achat ni gestion commerciale dans l'application — lot 97B (CDC 12
 * COM-01, COM-04, COM-05, ACC-04, STORE-08 ; PO M5 « conformité du parcours
 * d'abonnement aux règles des stores » ; règles des stores et choix retenus :
 * `docs/exploitation/cdc12-mobile-ecarts.md` § « Abonnement et règles des
 * stores »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TROIS BARRIÈRES, LE WEB INCHANGÉ
 *
 *   1. Interface : dans l'app (détection `isNativeApp`, `bridge.ts`), les
 *      boutons et liens d'achat, d'offres, d'abonnement et du portail Stripe
 *      sont masqués ; à leur place, le message sobre
 *      `NATIVE_COMMERCE_MESSAGE` — SANS lien ni adresse (Apple 3.1.3(f) :
 *      aucun appel à acheter hors de l'app ; Google Play : aucun renvoi vers
 *      un paiement externe).
 *   2. Navigation directe (lien, saisie, historique) : les pages
 *      commerciales (`NATIVE_COMMERCE_PATHS`) sont remplacées par l'écran
 *      d'information `NATIVE_COMMERCE_INFO_PATH` — côté serveur (middleware,
 *      agent utilisateur de l'app) ET côté interface (hôte natif, interface
 *      embarquée comprise).
 *   3. API : les opérations commerciales (paiement, portail, changement
 *      d'offre, résiliation) sont refusées à un client natif déclaré
 *      (`NATIVE_COMMERCE_API_PATHS`, 403 `NOT_AVAILABLE_IN_APP`).
 * Dans un navigateur : aucune de ces règles ne s'applique.
 * La lecture du plan, de l'essai et des quotas reste affichée (COM-04).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isNativeApp } from './bridge';
import { parseUserAgentMarker } from './shell-info';

/** Message affiché dans l'app à la place de toute action commerciale (point unique). */
export const NATIVE_COMMERCE_MESSAGE = 'La gestion de l’abonnement se fait sur le site.';

/** Écran d'information servi dans l'app à la place d'une page commerciale. */
export const NATIVE_COMMERCE_INFO_PATH = '/app/abonnement';

/** Pages commerciales (préfixes) — les mêmes que les exclusions des liens d'app (`app-links.ts`). */
export const NATIVE_COMMERCE_PATHS: readonly string[] = ['/mon-compte/offres', '/mon-compte/abonnement', '/abonnement', '/retractation'];

/** Opérations commerciales de l'API refusées à l'app (préfixes). */
export const NATIVE_COMMERCE_API_PATHS: readonly string[] = [
  '/api/billing/create-checkout-session',
  '/api/billing/create-customer-portal-session',
  '/api/billing/schedule-change',
  '/api/billing/upgrade',
  '/api/billing/upgrade-apply',
  '/api/billing/upgrade-preview',
  '/api/billing/cancel-subscription',
  '/api/withdrawal',
];

const underPrefix = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Page commerciale ? (pur, testé) */
export function isCommercePath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string') return false;
  return NATIVE_COMMERCE_PATHS.some((p) => underPrefix(pathname, p));
}

/** Opération commerciale de l'API ? (pur, testé) */
export function isCommerceApiPath(pathname: string | null | undefined): boolean {
  if (typeof pathname !== 'string') return false;
  return NATIVE_COMMERCE_API_PATHS.some((p) => underPrefix(pathname, p));
}

/** Navigation de la WebView de l'app (marqueur `VerebonaApp/` posé par le build) — côté serveur. */
export function isNativeAppUserAgent(ua: string | null | undefined): boolean {
  return parseUserAgentMarker(ua) !== null;
}

/** Les actions commerciales sont-elles masquées ici ? (navigateur : jamais) */
export function nativeCommerceHidden(): boolean {
  return isNativeApp();
}
