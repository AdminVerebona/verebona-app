/**
 * Corpus du Centre d'aide pour l'assistant — CDC Centre d'aide V1 §5,
 * T2-01 à T2-08, ENV-02.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * L'ASSISTANT NE LISAIT AUCUN ARTICLE
 *
 * `searchHelp` (table `verebona_help_entries`) n'était appelé par personne,
 * et les intentions d'aide ne déclenchaient aucune recherche : à « comment
 * synchroniser mon agenda ? », l'assistant renvoyait vers la page d'aide sans
 * rien en dire.
 *
 * Il lit désormais le corpus publié par le site public de SON environnement
 * (`/aide/corpus-t2.json`) — la même source que les pages et « Besoin
 * d'aide » (§2, ARCH-01). Chaque section est citable : une réponse fondée sur
 * deux articles cite les deux (T2-02).
 *
 * ── CE QUI N'EST JAMAIS TRANSMIS ──────────────────────────────────────────
 * Pour une question d'usage, seules les sections d'articles sont envoyées
 * comme sources : ni document, ni donnée du compte (§5, T2-06). Le contexte
 * utile se limite à l'offre, qui sert à signaler qu'une fonction n'est pas
 * incluse (T2-07) — jamais à pousser un changement d'offre (T2-08).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { HELP_T2_CORPUS_PATH } from '@/lib/help-center/catalog';
import { helpScreenForRoute } from '@/lib/help-center/screens';
import { parseEnvironment, type AiEnvironment } from '@/services/ai/config/environment';
import type { RetrievedSource } from '../types/sources';
import type { PageContext } from '../types/contracts';
import { getAssistantConfig } from '../config/assistant-config';
import { mergeHelpSources, type HelpSearchResult, type HelpStage, type StagedHelpSource } from './help-cascade';

export interface HelpCorpusSection { anchor: string; heading: string; text: string }
export interface HelpCorpusArticle {
  id: string;
  title: string;
  path: string;
  category: string;
  categoryName: string;
  summary: string;
  offers: string[];
  offersLabel: string;
  offersNote: string | null;
  synonyms: string[];
  sections: HelpCorpusSection[];
  // Métadonnées de ciblage publiées par le site (T2-05). Facultatives : un
  // corpus plus ancien qui ne les porte pas reste lisible.
  roles?: string[];
  authState?: string[];
  screens?: string[];
  objectTypes?: string[];
  platforms?: string[];
  /**
   * Contrat de publication (CDC Assistant §10.3 ; décision PO D-O, lot 21) :
   * seul un article `published` AVEC une date de validation est une source.
   * Statut ou date absents : l'article est ignoré (plus de « publié par
   * défaut »).
   */
  status?: string;
  /** Date de validation éditoriale (AAAA-MM-JJ), obligatoire pour être cité. */
  validatedAt?: string | null;
  /** Routes de l'application que l'article mentionne (§10.3). */
  allowedRoutes?: string[];
  /** Actions de l'assistant que l'article autorise (§10.3). */
  allowedActions?: string[];
  /** Version de l'application décrite (§10.3). */
  appVersion?: string | null;
}
export interface HelpCorpus {
  schema: 'verebona-help-t2-v1';
  version: string;
  environment: string;
  articles: HelpCorpusArticle[];
  /**
   * Transition D-O (relecture lot 21) : copie de repli à l'ANCIEN format
   * (articles sans `status` ni `validatedAt`), servie avec l'ancienne règle
   * (« sans statut = publié ») tant que le corpus n'est pas republié.
   * Jamais posé sur un corpus lu en direct.
   */
  legacyPublication?: boolean;
}

/** Intentions d'aide à l'utilisation : sources du Centre d'aide uniquement (§5). */
export const HELP_INTENTS = new Set([
  'PRODUCT_HELP_HOW_TO', 'PRODUCT_HELP_EXPLAIN', 'PRODUCT_HELP_STATUS', 'NAVIGATION_FIND', 'EXPORT_HELP',
]);

export function isHelpIntent(intent: string): boolean {
  return HELP_INTENTS.has(intent);
}

// ── Lecture ─────────────────────────────────────────────────────────────────
//
// ══════════════════════════════════════════════════════════════════════════
// LOT 34G — « COMMENT AJOUTER UN DOCUMENT ? » SANS RÉPONSE EN PRÉPRODUCTION
//
// AID-DOC-001 publié, cascade correcte en local, et pourtant « pas
// d'information fiable » en préproduction. Le défaut n'était pas dans la
// recherche mais dans l'ACCÈS au corpus, et il était muet :
//
//  1. Variables figées au build. `PUBLIC_SITE_URL` et `NEXT_PUBLIC_APP_ENV`
//     sont des `NEXT_PUBLIC_*` : Next les INLINE au build, côté serveur
//     aussi. Une variable posée (ou corrigée) sur l'hébergeur sans nouveau
//     build n'était jamais vue ; absente au build, l'URL retombait sur le
//     site de PRODUCTION (`https://www.verebona.fr`) — corpus `production`
//     refusé par la préproduction (ENV-02), aucun dernier corpus valide :
//     aucune source. Les deux variables sont désormais relues à l'exécution
//     (`process.env[nom]`, jamais inliné), la valeur du build en repli, et
//     une préproduction sans URL de site public refuse d'emblée le site de
//     production au lieu de le lire.
//  2. Site public bâti sans `VITE_ENVIRONMENT=preprod` : son corpus se
//     déclare `production` (défaut du site) — même refus. Le diagnostic le
//     dit désormais avec les deux environnements et l'URL réellement lue
//     (redirection comprise : un `CANONICAL_HOST` posé par erreur en
//     préproduction renvoie vers la production).
//  3. Chargement borné par l'échéance de RECHERCHE (3 s) égale au délai du
//     téléchargement (3 s) : à froid (démarrage, TTL échu, nouvel essai après
//     échec), l'ouverture de la recherche d'aide expirait et l'orchestrateur
//     basculait SILENCIEUSEMENT sur un autre chercheur qui se déclarait
//     « corpus disponible » — d'où « aucune source fiable » au lieu de
//     HELP_CORPUS_TIMEOUT. Désormais : un seul téléchargement à la fois,
//     dernier corpus valide servi IMMÉDIATEMENT pendant le rafraîchissement
//     (une question n'attend jamais le réseau quand un corpus valide est en
//     mémoire), préchargement au démarrage, et un échec d'ouverture est un
//     corpus INDISPONIBLE tracé avec son code.
//  4. En local, le contrôle d'environnement était désactivé (« tout corpus
//     convient ») : rien ne pouvait s'y reproduire. Il est désormais le même
//     partout — local → aide locale, préproduction → aide de préproduction,
//     production → aide de production.
//
// Codes distincts (trace de la demande, `/api/health`, tableau de bord IA) :
// HELP_CORPUS_UNAVAILABLE (injoignable, URL invalide), HELP_CORPUS_TIMEOUT,
// HELP_CORPUS_HTTP_ERROR (statut HTTP), HELP_CORPUS_INVALID (JSON, schéma,
// aucun article citable), HELP_CORPUS_WRONG_ENVIRONMENT (corpus d'un autre
// environnement, ou configuration qui y mènerait).
// ══════════════════════════════════════════════════════════════════════════

/**
 * Durée de cache du corpus : `VEREBONA_ASSISTANT_HELP_CACHE_TTL_SECONDS`
 * (§43 : 86 400 s). Lue à chaque accès : un changement de configuration
 * s'applique sans redémarrage du cache.
 */
function ttlMs(): number {
  const s = getAssistantConfig().helpCacheTtlSeconds;
  return (Number.isFinite(s) && s > 0 ? s : 86_400) * 1000;
}
/** Délai du téléchargement du corpus (le repli en base suit, borné lui aussi). */
export const HELP_CORPUS_FETCH_TIMEOUT_MS = 3_000;
/**
 * Budget d'OUVERTURE de la recherche d'aide pour une demande : téléchargement
 * à froid + lecture du dernier corpus valide en base. Plus large que
 * l'échéance de recherche (3 s), qui l'interrompait avant son terme.
 */
export const HELP_CORPUS_OPEN_BUDGET_MS = HELP_CORPUS_FETCH_TIMEOUT_MS + 1_500;
let cache: { at: number; corpus: HelpCorpus | null } | null = null;
/** Téléchargement en cours : un seul à la fois, partagé par les demandes. */
let enCours: Promise<HelpCorpus | null> | null = null;
/** Dernière version de corpus lue par ce processus (détection des publications). */
let derniereVersion: string | null = null;

/**
 * Publication d'articles d'aide — CDC §25.7 `HELP_ENTRY_PUBLISHED`, §31.7.
 *
 * Les articles sont publiés par le site du Centre d'aide, pas par
 * l'application : la publication se constate ici, quand le corpus relu porte
 * une version différente de la précédente. L'événement est GLOBAL (compte
 * `null`) : il incrémente la version globale d'invalidation, partagée par
 * toutes les instances. Première lecture du processus : aucune référence,
 * aucun événement. Rend `true` si un événement a été émis.
 */
export async function noteHelpCorpusVersion(version: string | null | undefined): Promise<boolean> {
  if (!version) return false;
  const precedente = derniereVersion;
  derniereVersion = version;
  if (precedente == null || precedente === version) return false;
  const { emitBusinessEvent } = await import('../events/business-events');
  await emitBusinessEvent({ type: 'HELP_ENTRY_PUBLISHED', accountId: null, entityId: version.slice(0, 60) });
  return true;
}

/**
 * Invalidation demandée depuis le BO (lot 23, §32.6) : le corpus est relu
 * auprès du Centre d'aide au prochain accès. Le DERNIER CORPUS VALIDE
 * (PUB-01, mémoire et base) est conservé : il reste le repli si la relecture
 * échoue ou si le corpus publié est refusé.
 */
export function invalidateHelpCorpusCache(): void {
  cache = null;
}

/** Réservé aux tests. */
export function resetHelpCorpusCacheForTests(): void {
  cache = null;
  enCours = null;
  derniereVersion = null;
  dernierValide = null;
  versionStockee = null;
  alerte = null;
  servi = null;
  derniereTentative = null;
}

// ── Configuration lue À L'EXÉCUTION ─────────────────────────────────────────

/**
 * Variable d'environnement lue à l'exécution. L'accès par clé CALCULÉE n'est
 * jamais remplacé au build par Next (contrairement à
 * `process.env.NEXT_PUBLIC_X`) : une valeur posée sur l'hébergeur est vue au
 * redémarrage, sans nouveau build.
 */
function runtimeEnv(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// Valeurs du BUILD (inlinées), en repli seulement — `undefined` si la
// variable n'existait pas au build.
const BUILD_PUBLIC_SITE_URL: string | undefined = process.env.NEXT_PUBLIC_PUBLIC_SITE_URL;
const BUILD_APP_ENV: string | undefined = process.env.NEXT_PUBLIC_APP_ENV;

/** Site public de PRODUCTION (repli historique de `PUBLIC_SITE_URL`). */
export const PRODUCTION_HELP_SITE = 'https://www.verebona.fr';
const HOTES_PRODUCTION = new Set(['www.verebona.fr', 'verebona.fr']);

/**
 * Environnement de l'application : `NEXT_PUBLIC_APP_ENV` (exécution, puis
 * build). Absent : `local` en test et en développement (`next dev`), sinon
 * INCONNU — aucun corpus ne peut alors être reconnu comme le sien.
 */
export function helpApplicationEnvironment(): AiEnvironment | null {
  const env = parseEnvironment(runtimeEnv('NEXT_PUBLIC_APP_ENV') ?? BUILD_APP_ENV);
  if (env) return env;
  const nodeEnv = runtimeEnv('NODE_ENV');
  return nodeEnv === 'test' || nodeEnv === 'development' ? 'local' : null;
}

export type HelpCorpusUrlSource = 'HELP_CENTER_URL' | 'NEXT_PUBLIC_PUBLIC_SITE_URL' | 'default_production';

export interface HelpCorpusConfig {
  /** URL complète du corpus, `null` si elle ne peut pas être construite. */
  url: string | null;
  /** Variable qui a fourni l'URL. */
  urlSource: HelpCorpusUrlSource;
  applicationEnvironment: AiEnvironment | null;
  /** Configuration qui interdit la lecture (aucun appel réseau). */
  problem: { code: HelpCorpusAlertCode; message: string } | null;
}

/**
 * Où lire le corpus, et peut-on le lire ? (pure vis-à-vis du réseau).
 *
 * `HELP_CENTER_URL` (serveur) prime, puis `NEXT_PUBLIC_PUBLIC_SITE_URL`,
 * enfin le site de production — seulement POUR la production : ailleurs,
 * c'est le signe d'une configuration incomplète, et lire la production
 * mélangerait les corpus (ENV-02).
 */
export function resolveHelpCorpusConfig(): HelpCorpusConfig {
  const applicationEnvironment = helpApplicationEnvironment();
  const surcharge = runtimeEnv('HELP_CENTER_URL');
  const site = runtimeEnv('NEXT_PUBLIC_PUBLIC_SITE_URL') ?? (BUILD_PUBLIC_SITE_URL?.trim() || undefined);
  const urlSource: HelpCorpusUrlSource = surcharge ? 'HELP_CENTER_URL' : site ? 'NEXT_PUBLIC_PUBLIC_SITE_URL' : 'default_production';
  const base = (surcharge ?? site ?? PRODUCTION_HELP_SITE).replace(/\/+$/, '');
  let url: string | null = null;
  try {
    const u = new URL(`${base}${HELP_T2_CORPUS_PATH}`);
    url = u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    url = null;
  }
  const out = (problem: HelpCorpusConfig['problem']): HelpCorpusConfig => ({ url, urlSource, applicationEnvironment, problem });
  if (!applicationEnvironment) {
    return out({
      code: 'HELP_CORPUS_WRONG_ENVIRONMENT',
      message: 'NEXT_PUBLIC_APP_ENV absente ou illisible : environnement de l’application inconnu, aucun corpus d’aide ne peut être reconnu comme le sien (ENV-02).',
    });
  }
  if (!url) {
    return out({ code: 'HELP_CORPUS_UNAVAILABLE', message: `URL du Centre d’aide invalide (${urlSource} = « ${base.slice(0, 80)} »).` });
  }
  if (applicationEnvironment !== 'production') {
    if (urlSource === 'default_production') {
      return out({
        code: 'HELP_CORPUS_WRONG_ENVIRONMENT',
        message: `NEXT_PUBLIC_PUBLIC_SITE_URL absente : l’application « ${applicationEnvironment} » lirait le Centre d’aide de PRODUCTION — refusé (ENV-02). Renseigner l’URL du site public de cet environnement.`,
      });
    }
    if (HOTES_PRODUCTION.has(new URL(url).hostname)) {
      return out({
        code: 'HELP_CORPUS_WRONG_ENVIRONMENT',
        message: `${urlSource} désigne le site de PRODUCTION (${new URL(url).origin}) pour l’application « ${applicationEnvironment} » — refusé (ENV-02).`,
      });
    }
  }
  return out(null);
}

/** URL du corpus de l'environnement (diagnostic, scripts). */
export function helpCorpusUrl(): string {
  return resolveHelpCorpusConfig().url ?? `${PRODUCTION_HELP_SITE}${HELP_T2_CORPUS_PATH}`;
}

// ── Encadrés éditoriaux « Limites et points d'attention » ──────────────────
//
// Consignes de rédaction (« le Centre d'aide ne doit pas promettre de
// contournement »…) publiées par erreur dans d'anciens corpus : jamais citées
// par l'assistant. Elles apparaissent soit comme section (intitulé), soit
// comme paragraphe encadré DANS le texte d'une section
// (« \nLimites et points d'attention — … »). Les deux formes sont retirées à
// la lecture, y compris du dernier corpus valide relu en base ou gardé en
// mémoire (tous passent par `parseHelpCorpus`). Le site public refuse
// désormais cet encadré au build ; ce filtre couvre les corpus déjà publiés.

/** « Limite(s) et point(s) d'attention », casse et apostrophe indifférentes. */
const EDITORIAL_LABEL = String.raw`limites?\s+et\s+points?\s+d['’‘ʼ]\s*attention`;
const EDITORIAL_HEADING_RE = new RegExp(`^\\s*${EDITORIAL_LABEL}\\s*[:.]?\\s*$`, 'i');
/** Début d'un encadré éditorial : « Limites et points d'attention — … ». */
const EDITORIAL_START_RE = new RegExp(`^[ \\t]*${EDITORIAL_LABEL}\\s*(?:—|–|-|:)`, 'i');
/**
 * Début d'un AUTRE bloc, qui termine l'encadré : intitulé Markdown, étape
 * numérotée, puce, citation, ou encadré « Libellé — texte » (« Résultat
 * attendu — », « À savoir — »…).
 */
const NEXT_BLOCK_RE = /^\s*(?:#{1,6}\s|\d+[.)]\s|[-*•]\s|>\s|[^\n—–]{1,60}\s[—–]\s)/;

/** Section éditoriale (intitulé exact « Limites et points d'attention »). */
export function isEditorialSection(s: Pick<HelpCorpusSection, 'heading'>): boolean {
  return typeof s.heading === 'string' && EDITORIAL_HEADING_RE.test(s.heading.normalize('NFC'));
}

/** Texte d'une section sans les paragraphes encadrés éditoriaux. */
export function stripEditorialParagraphs(text: string): string {
  if (typeof text !== 'string') return text;
  // Paragraphe ENTIER : de l'intitulé jusqu'à la ligne vide ou au début du
  // bloc suivant (une consigne peut courir sur plusieurs lignes).
  const out: string[] = [];
  let dansEncadre = false;
  for (const ligne of text.split('\n')) {
    if (EDITORIAL_START_RE.test(ligne.normalize('NFC'))) { dansEncadre = true; continue; }
    if (dansEncadre) {
      if (ligne.trim() === '') { dansEncadre = false; continue; }
      if (!NEXT_BLOCK_RE.test(ligne)) continue;
      dansEncadre = false;
    }
    out.push(ligne);
  }
  return out.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function sansEncadresEditoriaux(a: HelpCorpusArticle): HelpCorpusArticle {
  const sections = a.sections
    .filter((s) => !isEditorialSection(s))
    .map((s) => ({ ...s, text: stripEditorialParagraphs(s.text) }))
    // Une section qui ne contenait que l'encadré n'a plus rien à citer.
    .filter((s) => typeof s.text !== 'string' || s.text.trim().length > 0);
  return { ...a, sections };
}

export function parseHelpCorpus(json: unknown, opts: { legacy?: boolean } = {}): HelpCorpus | null {
  const c = json as Partial<HelpCorpus> | null;
  if (!c || c.schema !== 'verebona-help-t2-v1' || !Array.isArray(c.articles)) return null;
  const ok = c.articles.every((a) => a && typeof a.id === 'string' && typeof a.path === 'string'
    && /^\/aide\/[a-z0-9-]+$/.test(a.path) && Array.isArray(a.sections));
  if (!ok) return null;
  // §10.4 : un article archivé ou en brouillon n'est jamais une source — ni
  // cité, ni proposé en lien (`helpArticlePublished` lit ce même corpus).
  const { legacyPublication: _ignore, ...base } = c as HelpCorpus;
  void _ignore;
  if (opts.legacy) {
    return {
      ...base, legacyPublication: true,
      articles: c.articles.filter((a) => articlePublieAncienneRegle(a)).map(sansEncadresEditoriaux),
    };
  }
  return { ...base, articles: c.articles.filter((a) => articlePublie(a)).map(sansEncadresEditoriaux) };
}

/** Ancienne règle (avant D-O) : statut absent ou `published`. Repli de transition seulement. */
export function articlePublieAncienneRegle(a: Pick<HelpCorpusArticle, 'status'>): boolean {
  return a.status == null || String(a.status).toLowerCase() === 'published';
}

/** Règle applicable à un corpus (repli de transition : ancienne règle). */
const citable = (corpus: Pick<HelpCorpus, 'legacyPublication'>, a: HelpCorpusArticle) =>
  (corpus.legacyPublication ? articlePublieAncienneRegle(a) : articlePublie(a));

/**
 * Article citable (§10.3, D-O) : statut `published` ET date de validation
 * valide (AAAA-MM-JJ, pas dans le futur). Statut absent, brouillon, archivé
 * ou bloqué, ou date absente : jamais une source, jamais proposé en lien.
 */
export function articlePublie(a: Pick<HelpCorpusArticle, 'status' | 'validatedAt'>, now: Date = new Date()): boolean {
  if (String(a.status ?? '').toLowerCase() !== 'published') return false;
  const d = typeof a.validatedAt === 'string' ? a.validatedAt : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && t <= now.getTime();
}

// ── PUB-01 : dernier corpus valide ──────────────────────────────────────────
//
// Un corpus publié invalide (schéma, articles malformés) ou d'un autre
// environnement (ENV-02) ne doit PAS devenir la référence : l'assistant
// continue sur le DERNIER CORPUS VALIDE de son environnement — en mémoire,
// et en base (`ai_operation_idempotency`, clé `help-corpus:last-valid:<env>`)
// pour qu'une instance qui redémarre ne reparte pas de rien. L'incident est
// signalé dans `/api/health` et au tableau de bord IA (`helpCorpusHealth`).
// Le dernier corpus valide n'est JAMAIS celui d'un autre environnement : son
// environnement est revérifié à chaque service (mémoire comme base).

export type HelpCorpusAlertCode =
  | 'HELP_CORPUS_UNAVAILABLE'
  | 'HELP_CORPUS_TIMEOUT'
  | 'HELP_CORPUS_HTTP_ERROR'
  | 'HELP_CORPUS_INVALID'
  | 'HELP_CORPUS_WRONG_ENVIRONMENT';

export const HELP_CORPUS_ALERT_CODES: readonly HelpCorpusAlertCode[] = [
  'HELP_CORPUS_UNAVAILABLE', 'HELP_CORPUS_TIMEOUT', 'HELP_CORPUS_HTTP_ERROR', 'HELP_CORPUS_INVALID', 'HELP_CORPUS_WRONG_ENVIRONMENT',
];

export type HelpCorpusSource = 'live' | 'last_valid_memory' | 'last_valid_db' | 'none';

export interface HelpCorpusHealth {
  /** `warning` : le corpus publié est refusé ou injoignable. */
  status: 'ok' | 'warning' | 'unknown';
  /** Corpus réellement servi. */
  source: HelpCorpusSource;
  version: string | null;
  /** Environnement du corpus servi. */
  environment: string | null;
  /** Environnement de l'application (`NEXT_PUBLIC_APP_ENV` à l'exécution). */
  applicationEnvironment: AiEnvironment | null;
  /** Origine lue (jamais de chemin ni de paramètre) et variable qui l'a fournie. */
  url: string | null;
  urlSource: HelpCorpusUrlSource;
  /** Lecture du dernier corpus valide (ISO), s'il y en a un. */
  lastValidAt: string | null;
  /** Âge du dernier corpus valide, en secondes (`null` sans corpus valide). */
  lastValidAgeSeconds: number | null;
  /** Dernière tentative de lecture en direct (succès ou code d'échec). */
  lastAttempt: { at: string; durationMs: number; code: HelpCorpusAlertCode | null; httpStatus: number | null; finalUrl: string | null } | null;
  alert: { code: HelpCorpusAlertCode; message: string; at: string } | null;
}

/**
 * État du corpus pour UNE question d'aide (observabilité, lot 34G) :
 * disponible ou non, source servie, version, environnements, et le code
 * de diagnostic de la dernière lecture en direct si elle a échoué.
 */
export interface HelpCorpusLoadInfo {
  corpusAvailable: boolean;
  corpusSource: HelpCorpusSource;
  corpusVersion: string | null;
  applicationEnvironment: AiEnvironment | null;
  corpusEnvironment: string | null;
  /** Code du dernier échec de lecture en direct (corpus servi en repli, ou aucun). */
  diagnostic: HelpCorpusAlertCode | null;
}

/** Stockage durable du dernier corpus valide (base par défaut, injectable en test). */
export interface HelpCorpusStore {
  read(env: string): Promise<{ corpus: unknown; at: string } | null>;
  write(env: string, corpus: HelpCorpus): Promise<void>;
}

/**
 * Clé RÉSERVÉE (`RESERVED_IDEMPOTENCY_KEY_PREFIXES`, service d'idempotence) :
 * exclue de toute purge de la table, sans expiration (`expires_at =
 * 'infinity'`) — seule une nouvelle version valide la remplace.
 */
export const HELP_CORPUS_STORE_KEY_PREFIX = 'help-corpus:last-valid:';
const CLE_STOCKAGE = (env: string) => `${HELP_CORPUS_STORE_KEY_PREFIX}${env}`;

export const dbHelpCorpusStore: HelpCorpusStore = {
  async read(env) {
    const { pgClient } = await import('@/db');
    const rows = (await pgClient.unsafe(
      `SELECT result_json AS corpus, created_at AS at FROM ai_operation_idempotency WHERE key_hash = $1`,
      [CLE_STOCKAGE(env)] as never[],
    )) as unknown as Array<{ corpus: unknown; at: string | Date }>;
    return rows[0] ? { corpus: rows[0].corpus, at: new Date(rows[0].at).toISOString() } : null;
  },
  async write(env, corpus) {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO ai_operation_idempotency (key_hash, result_json, created_at, expires_at)
       VALUES ($1, $2::jsonb, now(), 'infinity')
       ON CONFLICT (key_hash) DO UPDATE
         SET result_json = EXCLUDED.result_json, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
      [CLE_STOCKAGE(env), JSON.stringify(corpus)] as never[],
    );
  },
};

/** Tests unitaires : aucune base, sauf stockage injecté. */
let store: HelpCorpusStore | null = process.env.NODE_ENV === 'test' ? null : dbHelpCorpusStore;
let dernierValide: { corpus: HelpCorpus; at: string; origin: 'live' | 'db' } | null = null;
let versionStockee: string | null = null;
let alerte: HelpCorpusHealth['alert'] = null;
let servi: HelpCorpusSource | null = null;
let derniereTentative: HelpCorpusHealth['lastAttempt'] = null;
/** Nouvel essai après un refus, tant qu'un corpus de repli est servi. */
const REESSAI_REFUS_MS = 5 * 60_000;
const REESSAI_PANNE_MS = 30_000;
/** Lecture du dernier corpus valide en base : bornée (la demande attend). */
const LECTURE_BASE_MS = 1_500;

/** Réservé aux tests : stockage durable (`null` : aucun). */
export function setHelpCorpusStoreForTests(s: HelpCorpusStore | null): void {
  store = s;
}

/** Environnement servi (clé de stockage) : celui de l'application. */
function envApplication(): string {
  return helpApplicationEnvironment() ?? 'inconnu';
}

/** Le corpus est-il celui de l'environnement de l'application ? */
function duBonEnvironnement(c: Pick<HelpCorpus, 'environment'>): boolean {
  return corpusMatchesEnvironment(c.environment, helpApplicationEnvironment() ?? undefined);
}

function retenirValide(corpus: HelpCorpus): void {
  dernierValide = { corpus, at: new Date().toISOString(), origin: 'live' };
  alerte = null;
  servi = 'live';
  if (store && corpus.version !== versionStockee) {
    const s = store;
    s.write(envApplication(), corpus)
      .then(() => { versionStockee = corpus.version; })
      .catch((e) => console.warn(`[assistant] Dernier corpus d'aide valide non enregistré (${(e as Error).message}).`));
  }
}

function avecDelai<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`délai de ${ms} ms dépassé`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** Dernier corpus valide : mémoire, sinon base (même environnement, revalidé). */
async function dernierCorpusValide(): Promise<HelpCorpus | null> {
  if (dernierValide && duBonEnvironnement(dernierValide.corpus)) {
    servi = dernierValide.origin === 'db' ? 'last_valid_db' : 'last_valid_memory';
    if (dernierValide.corpus.legacyPublication) aRepublier();
    return dernierValide.corpus;
  }
  // Mémoire d'un autre environnement (configuration changée) : oubliée.
  if (dernierValide) dernierValide = null;
  const env = helpApplicationEnvironment();
  if (store && env) {
    try {
      const lu = await avecDelai(store.read(env), LECTURE_BASE_MS);
      let corpus = lu ? parseHelpCorpus(lu.corpus) : null;
      // Transition D-O : copie enregistrée à l'ANCIEN format (sans statut ni
      // date de validation) — servie avec l'ancienne règle, jamais vidée, et
      // signalée « à republier ».
      if (corpus && corpus.articles.length === 0 && lu) {
        const ancien = parseHelpCorpus(lu.corpus, { legacy: true });
        if (ancien && ancien.articles.length > 0) {
          corpus = ancien;
          aRepublier();
        }
      }
      if (corpus && corpus.articles.length > 0 && duBonEnvironnement(corpus)) {
        dernierValide = { corpus, at: lu!.at, origin: 'db' };
        versionStockee = corpus.version;
        servi = 'last_valid_db';
        return corpus;
      }
    } catch (e) {
      console.warn(`[assistant] Dernier corpus d'aide valide illisible en base (${(e as Error).message}).`);
    }
  }
  servi = 'none';
  return null;
}

/** Repli sur une copie à l'ancien format : l'alerte le dit (transition D-O). */
function aRepublier(): void {
  const suffixe = 'Repli sur une copie à l’ancien format (sans statut ni date de validation) : corpus d’aide à republier.';
  if (alerte?.message.includes('corpus d’aide à republier') && alerte.message.includes('ancien format')) return;
  signaler('HELP_CORPUS_INVALID', `${alerte?.message ?? 'Corpus d’aide refusé.'} ${suffixe}`);
}

function signaler(code: HelpCorpusAlertCode, message: string): void {
  alerte = { code, message: message.slice(0, 500), at: new Date().toISOString() };
}

/** Origine seule d'une URL (jamais de chemin ni de paramètre dans les journaux). */
function origine(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Corpus servi actuellement (cache, sinon dernier valide). */
function corpusServi(): HelpCorpus | null {
  return cache?.corpus ?? (servi && servi !== 'none' ? dernierValide?.corpus ?? null : null);
}

/** État du corpus d'aide de cette instance — `/api/health`, tableau de bord IA. */
export function helpCorpusHealth(): HelpCorpusHealth {
  const c = corpusServi();
  const cfg = resolveHelpCorpusConfig();
  return {
    status: servi === null ? 'unknown' : alerte ? 'warning' : 'ok',
    source: servi ?? 'none',
    version: c?.version ?? null,
    environment: c?.environment ?? null,
    applicationEnvironment: cfg.applicationEnvironment,
    url: origine(cfg.url),
    urlSource: cfg.urlSource,
    lastValidAt: dernierValide?.at ?? null,
    lastValidAgeSeconds: dernierValide ? Math.max(0, Math.round((Date.now() - new Date(dernierValide.at).getTime()) / 1000)) : null,
    lastAttempt: derniereTentative,
    alert: alerte,
  };
}

/** État du corpus servi à une demande (trace de la question d'aide). */
export function helpCorpusLoadInfo(corpus: HelpCorpus | null): HelpCorpusLoadInfo {
  return {
    corpusAvailable: Boolean(corpus),
    corpusSource: corpus ? (servi && servi !== 'none' ? servi : 'live') : 'none',
    corpusVersion: corpus?.version ?? null,
    applicationEnvironment: helpApplicationEnvironment(),
    corpusEnvironment: corpus?.environment ?? null,
    diagnostic: alerte?.code ?? (corpus ? null : 'HELP_CORPUS_UNAVAILABLE'),
  };
}

/** Échec d'une lecture en direct : code, message, et dernier corpus valide. */
async function echec(
  code: HelpCorpusAlertCode, message: string, debut: number, reessaiMs: number,
  extra: { httpStatus?: number | null; finalUrl?: string | null } = {},
): Promise<HelpCorpus | null> {
  derniereTentative = {
    at: new Date().toISOString(), durationMs: Date.now() - debut, code,
    httpStatus: extra.httpStatus ?? null, finalUrl: origine(extra.finalUrl ?? null),
  };
  const log = code === 'HELP_CORPUS_WRONG_ENVIRONMENT' || code === 'HELP_CORPUS_INVALID' ? console.error : console.warn;
  log(`[assistant] ${code} — ${message}`);
  signaler(code, message);
  const repli = await dernierCorpusValide();
  cache = { at: Date.now() - ttlMs() + reessaiMs, corpus: repli };
  return repli;
}

/** Lecture en direct (un seul appel à la fois). Ne lève jamais. */
async function lireEnDirect(): Promise<HelpCorpus | null> {
  const debut = Date.now();
  const cfg = resolveHelpCorpusConfig();
  if (cfg.problem) return echec(cfg.problem.code, `${cfg.problem.message} Dernier corpus valide conservé.`, debut, REESSAI_REFUS_MS);
  const url = cfg.url!;
  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HELP_CORPUS_FETCH_TIMEOUT_MS);
    res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/json' } })
      .finally(() => clearTimeout(timer));
  } catch (e) {
    const err = e as Error;
    const delai = err?.name === 'AbortError' || err?.name === 'TimeoutError' || estAbandon(err);
    return delai
      ? echec('HELP_CORPUS_TIMEOUT', `Centre d’aide trop lent (${origine(url)}, plus de ${HELP_CORPUS_FETCH_TIMEOUT_MS} ms) : dernier corpus valide conservé.`, debut, REESSAI_PANNE_MS)
      : echec('HELP_CORPUS_UNAVAILABLE', `Corpus d’aide injoignable (${origine(url)} : ${String(err?.message ?? e).slice(0, 120)}) : dernier corpus valide conservé.`, debut, REESSAI_PANNE_MS);
  }
  const finalUrl = res.url || url;
  const redirige = origine(finalUrl) !== origine(url) ? ` (redirigé vers ${origine(finalUrl)})` : '';
  if (!res.ok) {
    return echec('HELP_CORPUS_HTTP_ERROR', `Corpus d’aide non publié ou inaccessible : HTTP ${res.status} sur ${origine(url)}${redirige} — dernier corpus valide conservé.`, debut, REESSAI_REFUS_MS, { httpStatus: res.status, finalUrl });
  }
  let brut: unknown;
  try {
    brut = await res.json();
  } catch {
    brut = undefined;
  }
  if (brut === undefined) {
    return echec('HELP_CORPUS_INVALID', `Corpus d’aide illisible (réponse non JSON de ${origine(finalUrl)}${redirige}) : dernier corpus valide conservé.`, debut, REESSAI_REFUS_MS, { httpStatus: res.status, finalUrl });
  }
  const corpus = parseHelpCorpus(brut);
  const bruts = Array.isArray((brut as { articles?: unknown } | null)?.articles) ? (brut as { articles: unknown[] }).articles.length : 0;
  if (!corpus) {
    return echec('HELP_CORPUS_INVALID', `Corpus d’aide publié invalide (schéma ou articles) sur ${origine(finalUrl)} : dernier corpus valide conservé.`, debut, REESSAI_REFUS_MS, { httpStatus: res.status, finalUrl });
  }
  if (bruts > 0 && corpus.articles.length === 0) {
    // D-O : des articles, mais aucun citable (statut ou date de validation
    // absents — ancien format) : le corpus doit être republié.
    return echec('HELP_CORPUS_INVALID', `Corpus d’aide publié sans article citable (${bruts} article(s) sans statut « published » ni date de validation) : corpus d’aide à republier ; dernier corpus valide conservé.`, debut, REESSAI_REFUS_MS, { httpStatus: res.status, finalUrl });
  }
  if (!duBonEnvironnement(corpus)) {
    // ENV-02 : la préproduction de l'application ne lit jamais le corpus de
    // production, et inversement. Les deux environnements sont nommés.
    const declare = res.headers.get('x-verebona-environment');
    return echec('HELP_CORPUS_WRONG_ENVIRONMENT',
      `Corpus d’aide d’environnement « ${String(corpus.environment).slice(0, 20)} » refusé : application « ${envApplication()} » (ENV-02). `
      + `Lu sur ${origine(finalUrl)}${redirige}${declare ? `, site déclaré « ${declare.slice(0, 20)} »` : ''} — vérifier ${cfg.urlSource} et VITE_ENVIRONMENT du site public. Dernier corpus valide conservé.`,
      debut, REESSAI_REFUS_MS, { httpStatus: res.status, finalUrl });
  }
  derniereTentative = { at: new Date().toISOString(), durationMs: Date.now() - debut, code: null, httpStatus: res.status, finalUrl: origine(finalUrl) };
  // Jamais retenu comme « dernier valide » sans article citable.
  if (corpus.articles.length > 0) retenirValide(corpus);
  else { alerte = null; servi = 'live'; }
  cache = { at: Date.now(), corpus };
  await noteHelpCorpusVersion(corpus.version).catch(() => false);
  return corpus;
}

/** Abandon par le minuteur (certains environnements lèvent un `DOMException` générique). */
function estAbandon(e: Error): boolean {
  return /abort/i.test(String(e?.message ?? ''));
}

/**
 * Corpus de l'environnement, mis en cache (HELP_CACHE_TTL_SECONDS, §43). Ne
 * lève jamais. Corpus publié refusé (invalide, autre environnement) ou
 * injoignable : DERNIER CORPUS VALIDE (PUB-01), alerte levée ; sans aucun
 * corpus valide connu, l'assistant dit qu'il ne peut pas répondre de façon
 * fiable (T2-03) au lieu d'improviser une procédure.
 *
 * `staleWhileRevalidate` (question d'un utilisateur) : cache échu mais
 * dernier corpus valide en mémoire → servi tout de suite, relecture en
 * arrière-plan — la question n'attend pas le réseau.
 */
export async function loadHelpCorpus(opts: { staleWhileRevalidate?: boolean } = {}): Promise<HelpCorpus | null> {
  if (cache && Date.now() - cache.at < ttlMs()) return cache.corpus;
  const lecture = enCours ??= lireEnDirect().finally(() => { enCours = null; });
  if (opts.staleWhileRevalidate && dernierValide && duBonEnvironnement(dernierValide.corpus)) {
    void lecture.catch(() => null);
    if (servi === null || servi === 'live') servi = 'last_valid_memory';
    return dernierValide.corpus;
  }
  return lecture;
}

/** Corpus et état de chargement, pour une question d'aide (trace). */
export async function loadHelpCorpusDetailed(opts: { staleWhileRevalidate?: boolean } = {}): Promise<{ corpus: HelpCorpus | null; info: HelpCorpusLoadInfo }> {
  const corpus = await loadHelpCorpus(opts);
  return { corpus, info: helpCorpusLoadInfo(corpus) };
}

/**
 * Préchargement au démarrage (instrumentation) : la première question d'aide
 * ne paie pas le téléchargement, et la configuration est journalisée — une
 * préproduction mal branchée se voit dès le démarrage.
 */
export async function warmHelpCorpus(): Promise<HelpCorpusHealth> {
  await loadHelpCorpus();
  const h = helpCorpusHealth();
  const resume = `[aide] corpus du Centre d’aide : source ${h.source}, version ${h.version ?? '—'}, environnement ${h.environment ?? '—'} `
    + `(application ${h.applicationEnvironment ?? 'inconnu'}), ${h.url ?? 'URL invalide'} via ${h.urlSource}`;
  if (h.alert) console.error(`${resume} — ${h.alert.code} : ${h.alert.message}`);
  else console.info(resume);
  return h;
}

/**
 * Le corpus appartient-il à l'environnement de l'application (ENV-02) ?
 *
 * Lot 34G : la même règle PARTOUT — local → aide locale (`development` du
 * site public), préproduction → préproduction, production → production.
 * Environnement de l'application inconnu : `local` en test et en
 * développement seulement, sinon aucun corpus ne convient.
 */
export function corpusMatchesEnvironment(corpusEnv: string | undefined, appEnvRaw: string | undefined): boolean {
  const nodeEnv = process.env.NODE_ENV;
  const app = parseEnvironment(appEnvRaw) ?? (nodeEnv === 'test' || nodeEnv === 'development' ? 'local' : null);
  if (!app) return false;
  return parseEnvironment(corpusEnv) === app;
}

/** Réservé aux tests. */
export function setHelpCorpusForTests(corpus: HelpCorpus | null): void {
  cache = corpus ? { at: Date.now(), corpus } : null;
}

// ── Recherche ───────────────────────────────────────────────────────────────

const STOP = new Set(('a au aux avec ce ces comment dans de des du elle en est et il je la le les leur lui ma mais me mes mon ne '
  + 'nos notre nous on ou par pas plus pour qu que quel quelle qui sa se ses son sur ta te tes ton tu un une vos votre vous '
  + 'y d l j m n s t c faire fait peut peux puis dois doit ca pourquoi quand verebona '
  // Lot 33 : mots de tournure sans valeur de recherche (« encore »,
  // « je veux », « j'aimerais »…) — ils faisaient chuter la couverture.
  + 'encore deja toujours aussi alors donc bien tres trop ici quoi tout tous toute toutes cela ceci cette cet '
  + 'veux voudrais souhaite souhaiterais aimerais aimerai suis sont etre avoir ai as fais').split(' '));

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
const SUFFIXES = ['ements', 'ement', 'ations', 'ation', 'ees', 'ee', 'es', 'er', 'ez', 'e', 's', 'x'];
function stem(w: string): string {
  if (w.length <= 4) return w;
  for (const s of SUFFIXES) if (w.endsWith(s) && w.length - s.length >= 4) return w.slice(0, -s.length);
  return w;
}
function terms(s: string): string[] {
  return norm(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
}

export interface HelpHit {
  article: HelpCorpusArticle;
  section: HelpCorpusSection;
  score: number;
}

/**
 * Sections les plus pertinentes pour une question d'usage.
 *
 * Même exigence que la recherche du site (§4) : une section qui couvre moins
 * de la moitié des mots significatifs n'est pas retenue. Mieux vaut « je ne
 * peux pas répondre de façon fiable » qu'une procédure hors sujet.
 */
export function searchHelpCorpus(corpus: HelpCorpus, question: string, limit = 4, ctx?: HelpSearchContext): HelpHit[] {
  return searchHelpCorpusDetailed(corpus, question, limit, ctx).hits;
}

/**
 * Diagnostic d'une recherche (lot 33, observabilité) : distinguer « aucun
 * candidat » de « candidats écartés » (couverture insuffisante, plateforme).
 */
export interface HelpSearchDiagnostics {
  /** Sections retenues comme candidates (couverture ≥ 50 %), avant la limite. */
  candidateCount: number;
  rejected: { lowCoverage: number; contextExcluded: number };
}

/**
 * Index d'en-tête d'un article : titre, mots-clés (`synonyms`), résumé,
 * catégorie, et libellés d'écran de l'application (`screens` : « Mes
 * documents », « Ajout rapide »…) — lot 33.
 */
function enTete(a: HelpCorpusArticle): string {
  return `${a.title} ${a.synonyms.join(' ')} ${a.summary} ${a.categoryName ?? ''} ${(a.screens ?? []).join(' ')}`;
}

/** `searchHelpCorpus` avec son diagnostic (candidats, sections écartées). */
export function searchHelpCorpusDetailed(
  corpus: HelpCorpus, question: string, limit = 4, ctx?: HelpSearchContext,
): { hits: HelpHit[]; diagnostics: HelpSearchDiagnostics } {
  const diagnostics: HelpSearchDiagnostics = { candidateCount: 0, rejected: { lowCoverage: 0, contextExcluded: 0 } };
  const q = [...new Set(terms(question))];
  if (q.length === 0) return { hits: [], diagnostics };
  const hits: HelpHit[] = [];
  for (const a of corpus.articles) {
    // §10.4 : double garde — un corpus construit sans `parseHelpCorpus`
    // (tests, cache) ne fait pas remonter un article archivé.
    if (!citable(corpus, a)) continue;
    const poids = contextWeight(a, ctx);
    const head = new Set(terms(enTete(a)));
    for (const s of a.sections) {
      const body = new Set(terms(`${s.heading} ${s.text}`));
      let score = 0;
      let found = 0;
      for (const t of q) {
        const inHead = head.has(t) || [...head].some((h) => t.length >= 4 && h.startsWith(t));
        const inBody = body.has(t) || [...body].some((b) => t.length >= 4 && b.startsWith(t));
        if (inHead || inBody) found += 1;
        score += (inHead ? 2 : 0) + (inBody ? 1 : 0);
      }
      if (found === 0) continue;
      const coverage = found / q.length;
      if (coverage < 0.5) { diagnostics.rejected.lowCoverage += 1; continue; }
      if (poids === 0) { diagnostics.rejected.contextExcluded += 1; continue; }
      diagnostics.candidateCount += 1;
      hits.push({ article: a, section: s, score: (score / (3 * q.length)) * coverage * poids });
    }
  }
  hits.sort((x, y) => y.score - x.score);
  // Deux sections au plus par article : citer l'article, pas le recopier.
  const perArticle = new Map<string, number>();
  return {
    hits: hits.filter((h) => {
      const n = perArticle.get(h.article.id) ?? 0;
      perArticle.set(h.article.id, n + 1);
      return n < 2;
    }).slice(0, limit),
    diagnostics,
  };
}

/**
 * Recherche MULTI-REQUÊTES (lot 33, cascade du Centre d'aide) : chaque
 * requête est cherchée, les sections fusionnées au meilleur score, avec
 * l'étape et la requête qui les ont retrouvées.
 */
export function searchHelpQueries(
  corpus: HelpCorpus,
  queries: string[],
  stage: HelpStage,
  opts: { limit?: number; ctx?: HelpSearchContext; planType?: string } = {},
): HelpSearchResult {
  const limit = opts.limit ?? 4;
  const lots: StagedHelpSource[][] = [];
  const rejected = { lowCoverage: 0, contextExcluded: 0 };
  let candidateCount = 0;
  for (const query of queries) {
    const { hits, diagnostics } = searchHelpCorpusDetailed(corpus, query, limit, opts.ctx);
    candidateCount += diagnostics.candidateCount;
    rejected.lowCoverage += diagnostics.rejected.lowCoverage;
    rejected.contextExcluded += diagnostics.rejected.contextExcluded;
    lots.push(toHelpSources(hits, opts.planType, corpus.version ?? null).map((s) => ({ ...s, stage, query, queryHits: 1 })));
  }
  return {
    corpusAvailable: true,
    corpusVersion: corpus.version ?? null,
    sources: mergeHelpSources(...lots),
    candidateCount,
    rejected,
  };
}

/** Recherche sur un corpus absent : 0 résultat TECHNIQUE (trace distincte). */
export const HELP_CORPUS_UNAVAILABLE_RESULT: HelpSearchResult = {
  corpusAvailable: false, corpusVersion: null, sources: [], candidateCount: 0, rejected: { lowCoverage: 0, contextExcluded: 0 },
};

/**
 * Contexte de l'interaction — CDC Centre d'aide §5, T2-05.
 *
 * Avant, seule l'offre était exploitée : « comment ajouter un document ? »
 * posée depuis une fiche bien ne privilégiait pas l'article de l'onglet
 * Documents du bien, et une procédure « mobile » pouvait répondre sur le web.
 */
export interface HelpSearchContext {
  /** Libellés d'écran du référentiel (`helpScreenForRoute`). */
  screens: string[];
  objectType: string | null;
  platform: 'web' | 'mobile' | null;
  /** Rôle de l'utilisateur dans le compte (owner, duo_member…), s'il est connu. */
  role: string | null;
  /**
   * Tous les rôles de l'utilisateur (un titulaire de Duo est `owner` ET
   * `billing_owner`). Prioritaire sur `role` quand il est fourni.
   */
  roles?: string[];
}

export function helpContextFromPage(page: PageContext | undefined, role: string | string[] | null = null): HelpSearchContext {
  const { screens, objectType } = helpScreenForRoute(page?.route);
  const platform = page?.platform === 'mobile' || page?.platform === 'web' ? page.platform : null;
  const roles = Array.isArray(role) ? role : role ? [role] : [];
  return { screens, objectType, platform, role: roles[0] ?? null, roles };
}

/**
 * Pondération d'un article selon le contexte :
 *   · plateforme déclarée et différente → article écarté (0) — une
 *     procédure mobile n'est pas une réponse sur le web ;
 *   · écran courant cité par l'article → ×1,25 ; type d'objet → ×1,1 ;
 *   · rôles déclarés, sans « all » ni aucun rôle de l'utilisateur → ×0,6 (pas
 *     écarté : le rôle n'est pas toujours connu avec certitude).
 */
export function contextWeight(a: HelpCorpusArticle, ctx?: HelpSearchContext): number {
  if (!ctx) return 1;
  if (ctx.platform && a.platforms?.length && !a.platforms.includes(ctx.platform)) return 0;
  let w = 1;
  if (ctx.screens.length && a.screens?.some((s) => ctx.screens.includes(s))) w *= 1.25;
  if (ctx.objectType && a.objectTypes?.includes(ctx.objectType)) w *= 1.1;
  const userRoles = ctx.roles ?? (ctx.role ? [ctx.role] : []);
  if (userRoles.length && a.roles?.length && !a.roles.includes('all') && !a.roles.some((r) => userRoles.includes(r))) w *= 0.6;
  return w;
}

/** Offre du compte au format des articles (`STANDARD` → `standard`). */
function offerOf(planType: string | undefined): string | null {
  const p = (planType ?? '').toLowerCase();
  if (p.startsWith('premium_duo') || p === 'duo') return 'premium_duo';
  if (p.startsWith('premium')) return 'premium';
  if (p.startsWith('standard') || p === 'trial') return 'standard';
  return null;
}

/**
 * Sources de l'assistant : une par section retenue, identifiée par l'ID
 * stable de l'article (citable, cliquable — §5).
 *
 * T2-07 : si la fonction décrite n'est pas incluse dans l'offre du compte, la
 * source le dit, et la réponse le dira. Rien n'invite à changer d'offre
 * (T2-08) : c'est un constat, pas une proposition.
 */
export function toHelpSources(hits: HelpHit[], planType?: string, corpusVersion?: string | null): RetrievedSource[] {
  const offer = offerOf(planType);
  return hits.map(({ article: a, section: s, score }) => {
    const notIncluded = offer !== null && !a.offers.includes(offer);
    const offerNote = a.offers.length < 3
      ? `\n[Offre] Fonction réservée à : ${a.offersLabel}.${notIncluded ? ' Elle n’est pas incluse dans l’offre actuelle de ce compte.' : ''}`
      : '';
    return {
      id: `help_${a.id}__${s.anchor}`,
      type: 'help_entry' as const,
      title: s.anchor === 'presentation' ? a.title : `${a.title} — ${s.heading}`,
      content: `${s.text}${offerNote}`,
      meta: {
        articleId: a.id,
        path: s.anchor === 'presentation' ? a.path : `${a.path}#${s.anchor}`,
        category: a.categoryName,
        offersLabel: a.offersLabel,
        notIncludedInPlan: notIncluded,
        // Version du corpus, tracée avec la source (§19.13, §28.4).
        corpusVersion: corpusVersion ?? null,
      },
      relevanceScore: Math.min(1, score),
    };
  });
}

/** Recherche complète pour une question d'usage. Vide si le corpus est indisponible. */
export async function retrieveHelpSources(question: string, planType?: string, limit = 4, ctx?: HelpSearchContext): Promise<RetrievedSource[]> {
  const corpus = await loadHelpCorpus();
  if (!corpus) return [];
  return toHelpSources(searchHelpCorpus(corpus, question, limit, ctx), planType, corpus.version ?? null);
}

/** Article publié dans l'environnement (contrôle d'accès de l'action OPEN_HELP). */
export async function helpArticlePublished(id: string): Promise<boolean> {
  const corpus = await loadHelpCorpus();
  return Boolean(corpus?.articles.some((a) => a.id === id));
}

/** Score à partir duquel un article répond « exactement » (§10.5, §10.6). */
export const HELP_EXACT_THRESHOLD = 0.75;

/** Premier passage utile d'une section, borné à ~240 caractères (§19.5). */
export function helpExcerpt(text: string, max = 240): string {
  const propre = text.replace(/\s+/g, ' ').trim();
  if (propre.length <= max) return propre;
  const coupe = propre.slice(0, max);
  const fin = coupe.lastIndexOf('. ');
  return fin >= 80 ? coupe.slice(0, fin + 1) : `${coupe.replace(/\s+\S*$/, '')}…`;
}

const titreArticle = (s: RetrievedSource) => String(s.title).split(' — ')[0];

/**
 * Réponse sans modèle à une question d'usage — T2-01, T2-03, §10.6.
 *
 * Avant : « Le Centre d'aide traite ce sujet dans l'article… Ouvrez les
 * sources », sans la réponse elle-même — inutile en Standard, qui n'a pas
 * de rédaction par modèle. Désormais : l'extrait pertinent de la meilleure
 * section, puis le renvoi à l'article (bouton « Lire l'article », lien
 * profond construit par le serveur). Sans source : l'aveu explicite, puis
 * « Ouvrir l'aide » (recherche du Centre d'aide) et, en second, le support
 * (décision PO D-J4).
 */
export function fallbackFromHelpSources(sources: RetrievedSource[]): string {
  const aide = sources.filter((s) => s.type === 'help_entry');
  if (aide.length === 0) {
    // Lot 33 : l'aveu dit ce qui s'est réellement passé — aucune
    // correspondance « exacte » n'est exigée ; le Centre d'aide n'a rien
    // fourni d'assez fiable. Boutons : « Ouvrir l'aide », puis le support
    // (décision PO D-J4).
    return HELP_FALLBACK_MESSAGE;
  }
  const meilleure = aide[0];
  const extrait = helpExcerpt(String(meilleure.content).split('\n[Offre]')[0]);
  const autres = [...new Set(aide.slice(1).map(titreArticle))].filter((t) => t !== titreArticle(meilleure)).slice(0, 2);
  const suite = autres.length ? ` Voir aussi ${autres.map((t) => `« ${t} »`).join(' et ')}.` : '';
  const offre = meilleure.meta?.notIncludedInPlan ? ` Cette fonction n’est pas incluse dans votre offre actuelle (${meilleure.meta.offersLabel}).` : '';
  return `D’après l’article « ${titreArticle(meilleure)} » : ${extrait}${offre} La procédure complète est dans l’article.${suite}`;
}

/** Repli d'aide sans source fiable — lot 33 (ticket T2 PRODUCT_HELP_HOW_TO §11). */
export const HELP_FALLBACK_MESSAGE = 'Je n’ai pas trouvé dans le Centre d’aide d’information suffisamment fiable pour répondre à cette question. '
  // D-J4 : l'aide d'abord, le support ensuite (boutons dans le même ordre).
  + 'Vous pouvez consulter l’aide Verebona, ou contacter le support.';

/** Étapes numérotées d'une section « Procédure » (« 1. … »), au plus `max`. */
export function procedureSteps(text: string, max = 8): string[] {
  return String(text ?? '').split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]\s+\S/.test(l))
    .slice(0, max);
}

/** Première phrase d'un texte (≤ `max` caractères), sans encadré « À savoir — ». */
function premierePhrase(text: string, max = 220): string {
  const ligne = String(text ?? '').split('\n').map((l) => l.trim()).find((l) => l && !/^[^\n—–]{1,60}\s[—–]\s/.test(l)) ?? '';
  const fin = ligne.search(/[.!?](\s|$)/);
  const phrase = fin >= 0 ? ligne.slice(0, fin + 1) : ligne;
  return phrase.length <= max ? phrase : helpExcerpt(phrase, max);
}

/**
 * Réponse DIRECTEMENT UTILE tirée de l'article.
 *
 * Lot 34G (ticket « T2 Aide produit », §2) : pour une question « comment… »
 * dont l'article porte une procédure, une SYNTHÈSE DÉTERMINISTE en une ou
 * deux phrases (`shortHowToAnswer`) — l'action directe et « Lire l'article »
 * suivent en boutons ; le Centre d'aide garde la procédure complète. Avant,
 * les étapes étaient recopiées une à une, précédées de « D'après
 * l'article… ». Aucun appel IA pour raccourcir : la synthèse ne reprend que
 * les intitulés d'étapes et le texte de l'article.
 *
 * Sans procédure : l'extrait de la meilleure section (deux phrases au plus
 * pour un « comment… »). Le texte vient toujours du contenu réel de
 * l'article.
 */
export function helpAnswerFromSources(
  sources: RetrievedSource[],
  intent: string,
  article?: HelpCorpusArticle | null,
): string {
  const aide = sources.filter((s) => s.type === 'help_entry');
  if (aide.length === 0) return HELP_FALLBACK_MESSAGE;
  if (intent !== 'PRODUCT_HELP_HOW_TO') return fallbackFromHelpSources(sources);
  const meilleure = aide[0];
  const offre = meilleure.meta?.notIncludedInPlan ? ` Cette fonction n’est pas incluse dans votre offre actuelle (${meilleure.meta.offersLabel}).` : '';
  const court = howToSynthesis(sources, article);
  if (court) return `${court}${offre}`;
  // Pas de procédure : l'essentiel de la meilleure section, sans recopie.
  const extrait = phrasesCourtes(String(meilleure.content).split('\n[Offre]')[0], 2);
  return extrait ? `${extrait}${offre}` : fallbackFromHelpSources(sources);
}

/**
 * Synthèse courte de la procédure de l'article en tête des sources, ou
 * `null` s'il n'en porte pas (lot 34G). L'article complet du corpus est
 * préféré ; à défaut, les sections retrouvées.
 */
export function howToSynthesis(sources: RetrievedSource[], article?: HelpCorpusArticle | null): string | null {
  const aide = sources.filter((s) => s.type === 'help_entry');
  if (aide.length === 0) return null;
  const meilleure = aide[0];
  const articleId = String(meilleure.meta?.articleId ?? '');
  if (article && article.id === articleId) return shortHowToAnswer(article);
  const sections = aide.filter((s) => String(s.meta?.articleId ?? '') === articleId)
    .map((s) => ({ anchor: String(s.id).split('__')[1] ?? '', text: String(s.content).split('\n[Offre]')[0] }));
  return shortHowToAnswer({ title: titreArticle(meilleure), sections });
}

/** Étape de procédure : « 2. Sélectionnez le fichier — Choisissez un format… ». */
export interface HelpProcedureStep { title: string; detail: string }

/** Étapes d'une section « Procédure », intitulé et précision séparés (pure). */
export function parseProcedureSteps(text: string): HelpProcedureStep[] {
  return procedureSteps(text, 20).map((l) => {
    const corps = l.replace(/^\d+[.)]\s+/, '');
    const m = /^(.+?)\s+[—–]\s+(.+)$/.exec(corps);
    return m ? { title: m[1].trim(), detail: m[2].trim() } : { title: corps.trim(), detail: '' };
  }).filter((e) => e.title.length > 0);
}

/** Étape de simple accès à l'écran : le bouton d'action la remplace. */
const ETAPE_ACCES = /^(ouvrez|allez|rendez-vous|accédez|accedez|depuis)\b/i;
const minusculeInitiale = (s: string) => (s ? s.charAt(0).toLocaleLowerCase('fr') + s.slice(1) : s);
const sansPoint = (s: string) => s.replace(/[\s.;:]+$/, '');

/** « a », « a puis b », « a, b puis c ». */
function enchainer(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} puis ${parts[parts.length - 1]}`;
}

/**
 * Synthèse DÉTERMINISTE d'une procédure en une ou deux phrases (lot 34G, pure).
 *
 *   « Pour <but de l'article>, <étape>, <étape> puis <étape>. »
 *   « <Dernière étape> : <sa précision>. »
 *
 * · le but est le titre de l'article (« Ajouter un document » ; « Comprendre
 *   et créer un élément d'agenda » → « créer un élément d'agenda ») ;
 * · l'étape d'accès à l'écran (« Ouvrez… ») est omise : l'action directe
 *   l'accomplit ;
 * · trois étapes au plus dans la première phrase ; la dernière étape, quand
 *   il y en a d'autres, forme la seconde avec sa précision — jamais toutes
 *   les étapes, jamais un mot qui ne soit pas dans l'article.
 * `null` : aucune étape exploitable (l'appelant sert l'extrait).
 */
export function shortHowToAnswer(article: { title: string; sections: Array<Pick<HelpCorpusSection, 'anchor' | 'text'>> }): string | null {
  const procedure = article.sections.find((s) => s.anchor === 'procedure');
  if (!procedure) return null;
  let etapes = parseProcedureSteps(procedure.text);
  if (etapes.length === 0) return null;
  while (etapes.length > 1 && ETAPE_ACCES.test(etapes[0].title)) etapes = etapes.slice(1);
  const titre = String(article.title ?? '').trim();
  const but = minusculeInitiale((/^\S+\s+et\s+(.+)$/i.exec(titre)?.[1] ?? titre).trim());
  const coeur = etapes.length >= 4 ? etapes.slice(0, 3) : etapes;
  const conclusion = etapes.length >= 4 ? etapes[etapes.length - 1] : null;
  const premiere = `${but ? `Pour ${but}, ` : ''}${enchainer(coeur.map((e) => minusculeInitiale(sansPoint(e.title))))}.`;
  const phrase1 = but ? premiere : premiere.charAt(0).toLocaleUpperCase('fr') + premiere.slice(1);
  if (!conclusion) return phrase1;
  const precision = conclusion.detail ? premierePhrase(conclusion.detail, 180) : '';
  const phrase2 = precision && precision.length <= 180
    ? `${sansPoint(conclusion.title)} : ${minusculeInitiale(sansPoint(precision))}.`
    : `${sansPoint(conclusion.title)}.`;
  return `${phrase1} ${phrase2}`;
}

/** Les `n` premières phrases d'un texte, sans encadré « Libellé — » (pure). */
function phrasesCourtes(text: string, n: number): string {
  const lignes = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^[^\n—–]{1,60}\s[—–]\s/.test(l));
  const phrases = lignes.join(' ').match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [];
  return phrases.slice(0, n).map((p) => p.trim()).join(' ').trim();
}

// ── Contradiction entre articles — T2-04 ────────────────────────────────────

const QUANTITE = /(\d+(?:[.,]\d+)?)\s*(mo|go|ko|jours?|heures?|h|minutes?|min|mois|ans?|caract[eè]res?|€|euros?|documents?|biens?)\b/gi;

function quantites(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of text.toLowerCase().matchAll(QUANTITE)) {
    const unite = m[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/s$/, '').replace(/^euro$/, '€').replace(/^h$/, 'heure').replace(/^min$/, 'minute').replace(/^an$/, 'an');
    const v = m[1].replace(',', '.');
    if (!out.has(unite)) out.set(unite, new Set());
    out.get(unite)!.add(v);
  }
  return out;
}

export interface HelpContradiction {
  articles: [string, string];
  titles: [string, string];
  unit: string;
}

/**
 * Deux articles ÉGALEMENT pertinents donnent-ils des valeurs différentes pour
 * une même grandeur (25 Mo / 10 Mo, 24 h / 48 h) ? Le CDC (T2-04) interdit
 * d'arbitrer : l'assistant ne répond pas, renvoie au support, et la
 * contradiction est journalisée pour correction documentaire.
 *
 * « Également pertinents » : score ≥ 80 % du meilleur, articles distincts.
 * Une seule valeur par article et par unité est comparée — un article qui
 * cite lui-même deux valeurs (ancienne / nouvelle limite) n'est pas jugé.
 */
export function detectHelpContradiction(sources: RetrievedSource[]): HelpContradiction | null {
  const aide = sources.filter((s) => s.type === 'help_entry');
  if (aide.length < 2) return null;
  const best = aide[0].relevanceScore ?? 0;
  const proches = aide.filter((s) => (s.relevanceScore ?? 0) >= best * 0.8);
  const parArticle = new Map<string, { title: string; q: Map<string, Set<string>> }>();
  for (const s of proches) {
    const id = String(s.meta?.articleId ?? s.id);
    const prev = parArticle.get(id);
    const q = quantites(String(s.content).split('\n[Offre]')[0]);
    if (!prev) parArticle.set(id, { title: titreArticle(s), q });
    else for (const [u, v] of q) { const set = prev.q.get(u) ?? new Set(); v.forEach((x) => set.add(x)); prev.q.set(u, set); }
  }
  const liste = [...parArticle.entries()];
  for (let i = 0; i < liste.length; i++) {
    for (let j = i + 1; j < liste.length; j++) {
      const [ida, a] = liste[i];
      const [idb, b] = liste[j];
      for (const [unite, va] of a.q) {
        const vb = b.q.get(unite);
        if (!vb || va.size !== 1 || vb.size !== 1) continue;
        const [x] = [...va]; const [y] = [...vb];
        if (x !== y) return { articles: [ida, idb], titles: [a.title, b.title], unit: unite };
      }
    }
  }
  return null;
}

export function contradictionAnswer(c: HelpContradiction): string {
  return `Je ne peux pas vous répondre de façon fiable : les articles « ${c.titles[0]} » et « ${c.titles[1]} » `
    + 'du Centre d’aide donnent des informations différentes sur ce point. Le support peut vous aider, '
    + 'et l’écart a été signalé pour correction.';
}
