/**
 * Politique d'indexation par environnement — carte #873 (SEO, pré-MEP).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉCISION MÉTIER
 *
 * Aucune URL d'un environnement hors production ne doit être référencée par
 * les moteurs de recherche, quels que soient son contenu, son statut
 * d'authentification et sa ressemblance avec la production. Constat d'origine :
 * Google Search Console a exploré https://app.preprod.verebona.fr/login
 * (« Page en double sans URL canonique sélectionnée par l'utilisateur »).
 *
 * Le correctif n'est NI une balise canonical, NI un robots.txt bloquant (Google
 * doit pouvoir relire la directive pour retirer les URL déjà vues), NI une
 * balise injectée en JavaScript : c'est l'en-tête HTTP `X-Robots-Tag`, posé par
 * le serveur sur TOUTE réponse (pages, redirections, erreurs, API, fichiers de
 * `public/`), via le middleware (`src/middleware.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * D'OÙ VIENT LA DÉCISION
 *
 * 1. `NEXT_PUBLIC_APP_ENV` — la variable d'exploitation qui décide déjà du mode
 *    Stripe (test/live) et de la configuration IA (`services/ai/config/
 *    environment.ts`, dont on réutilise les synonymes). Seule la valeur
 *    `production` (ou ses synonymes `prod`) autorise l'indexation. Absente ou
 *    illisible → NON indexable : en cas de doute, on refuse. La production ne
 *    peut d'ailleurs pas démarrer sans elle (contrôle de démarrage de l'IA).
 *
 * 2. L'hôte effectif de la requête (`X-Forwarded-Host`, puis `Host` — même
 *    résolution que la protection CSRF `lib/csrf.ts`, qui ne fonctionne en
 *    production que si cet hôte est l'hôte public). Il ne peut QU'AJOUTER le
 *    noindex, jamais le retirer : un en-tête forgé par un client ne rend donc
 *    jamais la préproduction indexable ; au pire, il obtient pour lui-même une
 *    réponse noindex. Il protège contre une erreur de déploiement (artefact de
 *    production servi sur un hôte de préproduction) et couvre les alias
 *    techniques de la production (`*.scalingo.io`), qui sont des doublons.
 *
 * Aucun paramètre d'URL, cookie ou en-tête « à la demande » n'est lu.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Module pur, sans dépendance Node : exécuté dans le middleware (Edge).
 */
import { parseEnvironment, type AiEnvironment } from '@/services/ai/config/environment';

/** En-tête HTTP de la directive (insensible à la casse côté HTTP). */
export const ROBOTS_HEADER = 'X-Robots-Tag';

/** Directive posée sur toute réponse d'un environnement non indexable. */
export const NOINDEX_DIRECTIVE = 'noindex, nofollow';

/**
 * Marqueurs d'hôtes hors production, recherchés comme LIBELLÉ entier ou
 * préfixe/suffixe de libellé séparé par un tiret (`app.preprod.verebona.fr`,
 * `verebona-app-preprod.osc-fr1…`, `recette-app.verebona.fr`). Un mot qui ne
 * fait que contenir le marqueur (`reviewers.example`) n'est pas visé.
 */
const NON_PRODUCTION_HOST_MARKERS: readonly string[] = [
  'preprod',
  'preproduction',
  'pre-prod',
  'recette',
  'staging',
  'stage',
  'review',
  'test',
  'dev',
  'demo',
  'sandbox',
];

/**
 * Domaines techniques de l'hébergeur : alias par défaut de chaque application
 * (production comprise) et review apps. Jamais destinés au référencement.
 */
const NON_PRODUCTION_HOST_SUFFIXES: readonly string[] = ['.scalingo.io'];

export type SearchIndexingReason =
  | 'production'
  | 'environment_not_production'
  | 'environment_unknown'
  | 'non_production_host';

export interface SearchIndexingPolicy {
  /** `true` : aucune directive ajoutée (comportement d'avant). */
  readonly indexable: boolean;
  /** Valeur de `X-Robots-Tag` à poser, ou `null` si indexable. */
  readonly directive: string | null;
  readonly environment: AiEnvironment | null;
  readonly reason: SearchIndexingReason;
}

export interface SearchIndexingInput {
  /** Valeur brute de `NEXT_PUBLIC_APP_ENV`. */
  readonly appEnv: string | null | undefined;
  /** Hôte effectif de la requête (avec ou sans port), si connu. */
  readonly host?: string | null;
}

/** Nom d'hôte normalisé (sans port, minuscules), ou `null`. */
export function normalizeHost(raw: string | null | undefined): string | null {
  const first = raw?.split(',')[0]?.trim().toLowerCase();
  if (!first) return null;
  // IPv6 entre crochets : `[::1]:3000` → `::1`.
  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    return end > 1 ? first.slice(1, end) : null;
  }
  const host = first.replace(/:\d+$/, '').replace(/\.$/, '');
  return host || null;
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** L'hôte désigne-t-il un environnement ou un alias hors production ? (pur) */
export function isNonProductionHost(raw: string | null | undefined): boolean {
  const host = normalizeHost(raw);
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || isIpLiteral(host)) return true;
  if (NON_PRODUCTION_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
  const labels = host.split('.');
  return labels.some((label) =>
    NON_PRODUCTION_HOST_MARKERS.some((m) => label === m || label.startsWith(`${m}-`) || label.endsWith(`-${m}`)),
  );
}

/** Politique d'indexation pour un environnement et un hôte (pur, testé). */
export function resolveSearchIndexing(input: SearchIndexingInput): SearchIndexingPolicy {
  const environment = parseEnvironment(input.appEnv);
  const deny = (reason: SearchIndexingReason): SearchIndexingPolicy => ({
    indexable: false, directive: NOINDEX_DIRECTIVE, environment, reason,
  });
  if (environment === null) return deny('environment_unknown');
  if (environment !== 'production') return deny('environment_not_production');
  if (isNonProductionHost(input.host)) return deny('non_production_host');
  return { indexable: true, directive: null, environment, reason: 'production' };
}

/** Hôte effectif d'une requête : `X-Forwarded-Host`, puis `Host` (comme `lib/csrf.ts`). */
export function effectiveRequestHost(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return headers.get('host')?.split(',')[0]?.trim() || null;
}

/**
 * Pose la directive sur une réponse si la politique l'exige. Remplace une
 * éventuelle valeur posée en amont par la même réponse : une seule directive,
 * jamais contradictoire. Sans effet quand l'environnement est indexable.
 */
export function applySearchIndexingPolicy<R extends { headers: Headers }>(response: R, policy: SearchIndexingPolicy): R {
  if (policy.directive) response.headers.set(ROBOTS_HEADER, policy.directive);
  return response;
}
