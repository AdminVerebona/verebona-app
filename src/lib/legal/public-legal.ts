/**
 * Liens légaux publics — lot 102B (site public = source juridique unique).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'APPLICATION NE SERT PLUS AUCUN TEXTE JURIDIQUE
 *
 * Mentions légales, CGUV, Confidentialité, Sous-traitants et prestataires,
 * Parrainage : publiés par le SITE PUBLIC (rubrique « Légal »). L'application y
 * renvoie toujours, et renvoie au PERMALIEN d'une version précise pour les
 * versions acceptées. Contrat : docs/exploitation/contrat-site-public-legal.md.
 *
 * ── UNE SEULE CONFIGURATION, AVEC REPLI (jamais de 404) ──────────────────
 *
 * Deux jeux d'adresses sur le site public :
 *   · ACTUELLES (`LEGAL_LEGACY_PATHS`) — pages qui existent déjà : /cgu,
 *     /mentions-legales, /confidentialite (sous-traitants → page
 *     Confidentialité, parrainage → page CGU, en attendant leurs onglets) ;
 *   · NOUVELLES (`LEGAL_PUBLIC_PATHS`, contrat 102B) — /legal/… .
 * Mode « legacy » par défaut ; bascule « v2 » AUTOMATIQUE dès que le manifeste
 * `/legal/cguv/versions.json` a été lu avec succès (le site a livré), ou
 * forcée par `LEGAL_PUBLIC_V2=on` (serveur) / `NEXT_PUBLIC_LEGAL_PUBLIC_V2=on`
 * (navigateur, build) ; `off` fige le repli.
 *
 * Surcharge par contenu (URL absolue ou chemin du site public), prioritaire
 * dans les DEUX modes — mêmes noms que le chantier 102D :
 *   NEXT_PUBLIC_LEGAL_MENTIONS_URL, NEXT_PUBLIC_LEGAL_CGUV_URL,
 *   NEXT_PUBLIC_LEGAL_PRIVACY_URL, NEXT_PUBLIC_LEGAL_SUBPROCESSORS_URL,
 *   NEXT_PUBLIC_LEGAL_REFERRAL_URL.
 * Laisser vide pour profiter de la bascule automatique.
 *
 * Base : `NEXT_PUBLIC_PUBLIC_SITE_URL` (par environnement ; contenu juridique
 * identique en préproduction et en production). Module PUR (client + serveur).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { PUBLIC_SITE_URL, publicSiteUrl } from '@/lib/external-urls';

/** Terminologie unique (décision PO) : jamais CGSU / CGVU à l'écran. */
export const CGUV_SHORT_LABEL = 'CGUV';
export const CGUV_FULL_LABEL = 'Conditions générales d’utilisation et de vente';
export const CGUV_LABEL_WITH_ACRONYM = `${CGUV_FULL_LABEL} (CGUV)`;

/** Les cinq contenus de la rubrique « Légal » du site public. */
export type LegalDocumentKey = 'mentionsLegales' | 'cguv' | 'confidentialite' | 'sousTraitants' | 'parrainage';
export const LEGAL_DOCUMENT_KEYS: readonly LegalDocumentKey[] = ['mentionsLegales', 'cguv', 'confidentialite', 'sousTraitants', 'parrainage'];

/** NOUVELLES adresses stables du site public (contrat 102B, § 2). */
export const LEGAL_PUBLIC_PATHS: Readonly<Record<LegalDocumentKey, string>> = Object.freeze({
  mentionsLegales: '/legal/mentions-legales',
  cguv: '/legal/cguv',
  confidentialite: '/legal/confidentialite',
  sousTraitants: '/legal/sous-traitants',
  parrainage: '/legal/parrainage',
});

/** Adresses ACTUELLES du site public (repli tant que le site n'a pas livré). */
export const LEGAL_LEGACY_PATHS: Readonly<Record<LegalDocumentKey, string>> = Object.freeze({
  mentionsLegales: '/mentions-legales',
  cguv: '/cgu',
  confidentialite: '/confidentialite',
  // Pas encore d'onglet propre : la page actuelle qui en traite.
  sousTraitants: '/confidentialite',
  parrainage: '/cgu',
});

/** Surcharges par contenu : nom de la variable (mapping unique, partagé avec 102D). */
export const LEGAL_URL_ENV: Readonly<Record<LegalDocumentKey, string>> = Object.freeze({
  mentionsLegales: 'NEXT_PUBLIC_LEGAL_MENTIONS_URL',
  cguv: 'NEXT_PUBLIC_LEGAL_CGUV_URL',
  confidentialite: 'NEXT_PUBLIC_LEGAL_PRIVACY_URL',
  sousTraitants: 'NEXT_PUBLIC_LEGAL_SUBPROCESSORS_URL',
  parrainage: 'NEXT_PUBLIC_LEGAL_REFERRAL_URL',
});

export const LEGAL_DOCUMENT_LABELS: Readonly<Record<LegalDocumentKey, string>> = Object.freeze({
  mentionsLegales: 'Mentions légales',
  cguv: CGUV_SHORT_LABEL,
  confidentialite: 'Confidentialité',
  sousTraitants: 'Sous-traitants et prestataires',
  parrainage: 'Parrainage',
});

/** Manifeste machine des versions de CGUV (contrat 102B, § 4). */
export const CGUV_MANIFEST_PATH = '/legal/cguv/versions.json';

export type LegalLinksMode = 'legacy' | 'v2';
export type LegalLinks = Readonly<Record<LegalDocumentKey, string>>;
type Overrides = Partial<Record<LegalDocumentKey, string | null | undefined>>;

/** Pur : mode d'après la variable explicite (`on` / `off` / autre = auto) et la lecture du manifeste. */
export function decideLegalLinksMode(flag: string | null | undefined, manifestEverRead: boolean): LegalLinksMode {
  const f = (flag ?? '').trim().toLowerCase();
  if (f === 'on' || f === 'true' || f === '1') return 'v2';
  if (f === 'off' || f === 'false' || f === '0') return 'legacy';
  return manifestEverRead ? 'v2' : 'legacy';
}

/** Pur : URL d'un contenu (surcharge > mode), absolue. */
export function resolveLegalHref(key: LegalDocumentKey, mode: LegalLinksMode, base: string, overrides: Overrides = {}): string {
  const root = base.replace(/\/+$/, '');
  const o = (overrides[key] ?? '').trim();
  if (o) {
    if (/^https?:\/\//i.test(o)) return o;
    return `${root}${o.startsWith('/') ? o : `/${o}`}`;
  }
  return `${root}${(mode === 'v2' ? LEGAL_PUBLIC_PATHS : LEGAL_LEGACY_PATHS)[key]}`;
}

/** Pur : les cinq liens. */
export function resolveLegalLinks(mode: LegalLinksMode, base: string, overrides: Overrides = {}): LegalLinks {
  const out = {} as Record<LegalDocumentKey, string>;
  for (const k of LEGAL_DOCUMENT_KEYS) out[k] = resolveLegalHref(k, mode, base, overrides);
  return Object.freeze(out);
}

// Valeurs figées au build pour le navigateur (accès LITTÉRAUX : Next les injecte).
const BUILD_OVERRIDES: Overrides = {
  mentionsLegales: process.env.NEXT_PUBLIC_LEGAL_MENTIONS_URL,
  cguv: process.env.NEXT_PUBLIC_LEGAL_CGUV_URL,
  confidentialite: process.env.NEXT_PUBLIC_LEGAL_PRIVACY_URL,
  sousTraitants: process.env.NEXT_PUBLIC_LEGAL_SUBPROCESSORS_URL,
  parrainage: process.env.NEXT_PUBLIC_LEGAL_REFERRAL_URL,
};
const BUILD_V2_FLAG = process.env.NEXT_PUBLIC_LEGAL_PUBLIC_V2;

/** Liens de départ côté navigateur (avant la réponse du serveur, `useLegalLinks`). */
export function clientLegalLinks(): LegalLinks {
  return resolveLegalLinks(decideLegalLinksMode(BUILD_V2_FLAG, false), PUBLIC_SITE_URL, BUILD_OVERRIDES);
}

/** URL d'un contenu côté navigateur (valeur de départ ; préférer `useLegalLinks`). */
export function legalPublicUrl(key: LegalDocumentKey): string {
  return clientLegalLinks()[key];
}

/** Format du code de version `AAAA-MM-JJ-vN` (date réelle exigée). */
const VERSION_CODE_PATTERN = /^\d{4}-\d{2}-\d{2}-v[1-9]\d{0,3}$/;

export function isCguvVersionCode(code: unknown): code is string {
  if (typeof code !== 'string' || !VERSION_CODE_PATTERN.test(code)) return false;
  const [year, month, day] = code.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Chemin du permalien d'une version sur le site public (contrat 102B, § 3). */
export function cguvVersionPath(code: string): string {
  return `${LEGAL_PUBLIC_PATHS.cguv}/versions/${encodeURIComponent(code)}`;
}

/** Permalien public par défaut d'une version (après livraison du site). */
export function defaultCguvPermalink(code: string): string {
  return publicSiteUrl(cguvVersionPath(code));
}

/** Liens de la rubrique « Légal » (ordre des onglets) à partir d'un jeu résolu. */
export function legalLinksList(links: LegalLinks): Array<{ key: LegalDocumentKey; label: string; href: string }> {
  return LEGAL_DOCUMENT_KEYS.map((key) => ({ key, label: LEGAL_DOCUMENT_LABELS[key], href: links[key] }));
}

/** Canal d'une preuve d'acceptation. */
export type AcceptanceChannel = 'WEB' | 'IOS' | 'ANDROID' | 'MOBILE' | 'UNKNOWN';

/**
 * Canal déduit de la requête : en-tête `x-verebona-client` de l'application
 * (IOS / ANDROID), sinon marqueur `VerebonaApp/` de l'agent utilisateur de la
 * vue intégrée (MOBILE), sinon WEB.
 */
export function channelFrom(client: string | null | undefined, userAgent: string | null | undefined): AcceptanceChannel {
  const c = (client ?? '').toUpperCase();
  if (c === 'IOS' || c === 'ANDROID') return c;
  if (/\bVerebonaApp\//.test(userAgent ?? '')) return 'MOBILE';
  return 'WEB';
}
