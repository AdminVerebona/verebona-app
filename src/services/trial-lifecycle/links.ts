/**
 * Lot 100G — liens des e-mails de fin d'essai. PUR (hors lecture de
 * `process.env`, injectable).
 *
 * {{offersUrl}} — PARCOURS WEB DE SOUSCRIPTION UNIQUEMENT (A9, E2, F) :
 *   · `app_offers` (défaut) : `<application>/mon-compte/offres`. Un
 *     utilisateur déjà inscrit est RECONNU : avec une session, il arrive sur
 *     ses offres ; sans session, le middleware l'envoie à la connexion
 *     (`/login?returnUrl=/mon-compte/offres`) puis le ramène à ses offres.
 *     AUCUN jeton dans l'URL. Dans l'application mobile, la page est remplacée
 *     par l'écran d'information (lot 97B, aucun achat intégré).
 *   · `public_pricing` : section Tarifs du site public, ancre réglable dans le
 *     BO (défaut `pricing` : seule ancre réelle, `#tarifs` n'existe pas).
 *
 * {{unsubscribeUrl}} — désinscription SANS connexion, SIGNÉE (HMAC-SHA256),
 * IDEMPOTENTE. Le jeton ne donne qu'un seul pouvoir : s'opposer aux
 * communications commerciales de CET utilisateur (jamais une session, jamais
 * une lecture de données) ; il n'expire pas (un lien de désinscription doit
 * rester utilisable). Secret : `MARKETING_UNSUBSCRIBE_SECRET`, à défaut
 * `JWT_SECRET` ; en production sans secret réel, aucun lien n'est produit et
 * les relances commerciales restent en attente (motif `unsubscribe_unavailable`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TrialLifecycleSettings } from './milestones';

type Env = Record<string, string | undefined>;

const INSECURE_DEFAULT_SECRET = 'your-secret-key-change-in-production';
const PURPOSE = 'verebona:marketing-unsubscribe:v1';

/** Adresse publique de l'application (liens d'e-mail), sans « / » final ; null si inconnue. */
export function appBaseUrl(env: Env = process.env): string | null {
  const raw = (env.NEXT_PUBLIC_APP_URL || env.APP_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+/i.test(raw) ? raw : null;
}

/** Adresse du site public (vitrine), sans « / » final. */
function publicSiteBase(env: Env = process.env): string {
  return (env.NEXT_PUBLIC_PUBLIC_SITE_URL || 'https://www.verebona.fr').trim().replace(/\/+$/, '');
}

/** Chemin de la page Offres de l'application (souscription Web). */
export const APP_OFFERS_PATH = '/mon-compte/offres';

export function buildOffersUrl(settings: Pick<TrialLifecycleSettings, 'offers'>, env: Env = process.env): string | null {
  if (settings.offers.target === 'public_pricing') {
    const anchor = settings.offers.pricingAnchor.replace(/^#/, '');
    return `${publicSiteBase(env)}/#${anchor}`;
  }
  const base = appBaseUrl(env);
  return base ? `${base}${APP_OFFERS_PATH}` : null;
}

/** Lien « Mon compte › Mes données » (export). */
export function buildExportUrl(env: Env = process.env): string | null {
  const base = appBaseUrl(env);
  return base ? `${base}/mon-compte#mes-donnees` : null;
}

/** Secret de signature ; null en production sans secret réel. */
export function unsubscribeSecret(env: Env = process.env): string | null {
  const configured = (env.MARKETING_UNSUBSCRIBE_SECRET || env.JWT_SECRET || '').trim();
  if (env.NODE_ENV === 'production' && (!configured || configured === INSECURE_DEFAULT_SECRET)) return null;
  return configured || INSECURE_DEFAULT_SECRET;
}

function signature(userId: number, secret: string): string {
  return createHmac('sha256', secret).update(`${PURPOSE}:${userId}`).digest('base64url').slice(0, 32);
}

export function createUnsubscribeToken(userId: number, secret: string): string {
  return `${userId}.${signature(userId, secret)}`;
}

/** Identifiant de l'utilisateur d'un jeton valide, sinon null (comparaison à temps constant). */
export function verifyUnsubscribeToken(token: unknown, secret: string | null): number | null {
  if (!secret || typeof token !== 'string' || token.length > 80) return null;
  const m = /^(\d{1,10})\.([A-Za-z0-9_-]{32})$/.exec(token.trim());
  if (!m) return null;
  const userId = Number(m[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const expected = Buffer.from(signature(userId, secret));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && timingSafeEqual(expected, given) ? userId : null;
}

/** Page de désinscription (confirmation sans connexion). */
export function buildUnsubscribeUrl(userId: number, env: Env = process.env): string | null {
  const base = appBaseUrl(env);
  const secret = unsubscribeSecret(env);
  if (!base || !secret) return null;
  return `${base}/desinscription?t=${encodeURIComponent(createUnsubscribeToken(userId, secret))}`;
}

/** Désinscription « en un clic » (RFC 8058, en-têtes List-Unsubscribe). */
export function buildOneClickUnsubscribeUrl(userId: number, env: Env = process.env): string | null {
  const base = appBaseUrl(env);
  const secret = unsubscribeSecret(env);
  if (!base || !secret) return null;
  return `${base}/api/public/marketing/unsubscribe?t=${encodeURIComponent(createUnsubscribeToken(userId, secret))}`;
}

/** Date et heure de Paris pour {{trialEndsAt}} (« 12 novembre 2026 à 14 h 05 »). */
export function formatTrialDate(d: Date): string {
  const day = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const parts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${day} à ${Number(hh)} h ${mm}`;
}

/** Date de Paris seule (« 12 novembre 2026 »). */
export function formatParisDay(d: Date): string {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}
