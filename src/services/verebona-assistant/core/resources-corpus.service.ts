/**
 * Corpus des RESSOURCES pour l'assistant (T2) — lot 108J (ticket
 * « Suggestions de l'accueil et de T2 », §5).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MÊME MÉCANISME QUE LE CENTRE D'AIDE
 *
 * Le site public publie, au build et depuis les fichiers Markdown des
 * articles (aucune copie manuelle), `/ressources/corpus-t2.json` : articles
 * PUBLIÉS seulement, identifiant stable, titre, chemin et URL canonique,
 * révision, dates, environnement, version et texte en sections citables.
 *
 * Lecture : la même que `/aide/corpus-t2.json` (`help-corpus.service.ts`) —
 *   · URL résolue à l'EXÉCUTION par `resolvePublicCorpusConfig` (mêmes
 *     variables, même refus d'un site d'un autre environnement, ENV-02) ;
 *   · un seul téléchargement à la fois, délai borné, cache de la durée de
 *     `VEREBONA_ASSISTANT_HELP_CACHE_TTL_SECONDS` ;
 *   · DERNIER CORPUS VALIDE en mémoire et en base (clé réservée
 *     `resources-corpus:last-valid:<env>`, jamais purgée) servi tout de suite
 *     pendant une relecture, et en repli si le corpus publié est refusé ;
 *   · codes distincts : RESOURCES_CORPUS_UNAVAILABLE, _TIMEOUT, _HTTP_ERROR,
 *     _INVALID, _WRONG_ENVIRONMENT.
 *
 * Un article retiré ou modifié est pris en compte à la relecture suivante
 * (nouvelle version) : il n'est plus cité, et une suggestion qui en
 * dépendait n'est plus proposée.
 *
 * Les articles sont exposés à la recherche d'aide sous la forme d'un corpus
 * d'aide (`asHelpSearchCorpus`) : sections citables, statut `published`,
 * date de validation (revue éditoriale) — mêmes règles de citation que le
 * Centre d'aide. Identifiant d'article `RES-<ID>`, chemin `/ressources/<slug>`
 * (jamais un lien vers le Centre d'aide).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { HelpCorpus, HelpCorpusArticle } from './help-corpus.service';
import { corpusMatchesEnvironment, helpApplicationEnvironment, resolvePublicCorpusConfig } from './help-corpus.service';
import { getAssistantConfig } from '../config/assistant-config';

export const RESOURCES_T2_CORPUS_PATH = '/ressources/corpus-t2.json';
export const RESOURCES_CORPUS_SCHEMA = 'verebona-ressources-t2-v1';
/** Préfixe des identifiants d'articles Ressources dans les sources de l'assistant. */
export const RESOURCE_ARTICLE_PREFIX = 'RES-';
export const RESOURCES_CORPUS_STORE_KEY_PREFIX = 'resources-corpus:last-valid:';
export const RESOURCES_CORPUS_FETCH_TIMEOUT_MS = 3_000;
const LECTURE_BASE_MS = 1_500;
const REESSAI_REFUS_MS = 5 * 60_000;
const REESSAI_PANNE_MS = 30_000;

export interface ResourceSection { anchor: string; heading: string; text: string }
export interface ResourceArticle {
  id: string;
  title: string;
  path: string;
  canonicalUrl?: string;
  category: string;
  categoryName: string;
  status: string;
  revision: number;
  reviewedAt: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  summary: string;
  intent: string;
  sections: ResourceSection[];
}
export interface ResourcesCorpus {
  schema: typeof RESOURCES_CORPUS_SCHEMA;
  version: string;
  environment: string;
  generatedAt?: string;
  articles: ResourceArticle[];
}

export type ResourcesCorpusAlertCode =
  | 'RESOURCES_CORPUS_UNAVAILABLE' | 'RESOURCES_CORPUS_TIMEOUT' | 'RESOURCES_CORPUS_HTTP_ERROR'
  | 'RESOURCES_CORPUS_INVALID' | 'RESOURCES_CORPUS_WRONG_ENVIRONMENT';

export interface ResourcesCorpusHealth {
  status: 'ok' | 'warning' | 'unknown';
  source: 'live' | 'last_valid_memory' | 'last_valid_db' | 'none';
  version: string | null;
  environment: string | null;
  articles: number;
  /** Origine lue (sans chemin). */
  url: string | null;
  alert: { code: ResourcesCorpusAlertCode; message: string; at: string } | null;
}

const ID = /^[A-Z][0-9]{2}$/;
const PATH = /^\/ressources\/[a-z0-9-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validation d'un corpus publié (pure). Seuls les articles `published` aux
 * champs valides sont conservés ; schéma ou liste illisibles : `null`.
 */
export function parseResourcesCorpus(json: unknown): ResourcesCorpus | null {
  const c = json as Partial<ResourcesCorpus> | null;
  if (!c || c.schema !== RESOURCES_CORPUS_SCHEMA || typeof c.version !== 'string' || typeof c.environment !== 'string' || !Array.isArray(c.articles)) return null;
  const articles = c.articles.filter((a): a is ResourceArticle => !!a && typeof a === 'object'
    && typeof a.id === 'string' && ID.test(a.id) && typeof a.path === 'string' && PATH.test(a.path)
    && typeof a.title === 'string' && a.title.trim().length > 0 && a.status === 'published'
    && Array.isArray(a.sections) && a.sections.every((s) => s && typeof s.anchor === 'string' && typeof s.heading === 'string' && typeof s.text === 'string'));
  return { ...(c as ResourcesCorpus), articles };
}

/** Date de validation éditoriale (revue, sinon publication, sinon mise à jour) — obligatoire pour citer. */
function validatedAtOf(a: ResourceArticle): string | null {
  for (const d of [a.reviewedAt, a.publishedAt, a.updatedAt]) if (typeof d === 'string' && DATE.test(d)) return d;
  return null;
}

/** Corpus Ressources présenté à la recherche d'aide (mêmes règles de citation). */
export function asHelpSearchCorpus(c: ResourcesCorpus): HelpCorpus {
  const articles: HelpCorpusArticle[] = c.articles
    .map((a) => ({ a, validatedAt: validatedAtOf(a) }))
    .filter((x) => x.validatedAt != null)
    .map(({ a, validatedAt }) => ({
      id: `${RESOURCE_ARTICLE_PREFIX}${a.id}`,
      title: a.title,
      path: a.path,
      category: 'ressources',
      categoryName: `Ressources — ${a.categoryName}`,
      summary: a.summary ?? '',
      // Les Ressources ne dépendent d'aucune offre : aucune note d'offre.
      offers: ['standard', 'premium', 'premium_duo'],
      offersLabel: 'Toutes les offres',
      offersNote: null,
      synonyms: a.intent ? [a.intent] : [],
      sections: a.sections,
      status: 'published',
      validatedAt,
    }));
  return { schema: 'verebona-help-t2-v1', version: c.version, environment: c.environment, articles };
}

// ── Lecture (même mécanique que le Centre d'aide) ───────────────────────────

let cache: { at: number; corpus: ResourcesCorpus | null } | null = null;
let enCours: Promise<ResourcesCorpus | null> | null = null;
let dernierValide: { corpus: ResourcesCorpus; origin: 'live' | 'db' } | null = null;
let versionStockee: string | null = null;
let alerte: ResourcesCorpusHealth['alert'] = null;
let servi: ResourcesCorpusHealth['source'] | null = null;
let derniereUrl: string | null = null;
let testOverride = false;

interface Store { read(env: string): Promise<unknown | null>; write(env: string, c: ResourcesCorpus): Promise<void> }
const dbStore: Store = {
  async read(env) {
    const { pgClient } = await import('@/db');
    const r = (await pgClient.unsafe(`SELECT result_json AS c FROM ai_operation_idempotency WHERE key_hash = $1`, [`${RESOURCES_CORPUS_STORE_KEY_PREFIX}${env}`] as never[])) as unknown as Array<{ c: unknown }>;
    return r[0]?.c ?? null;
  },
  async write(env, c) {
    const { pgClient } = await import('@/db');
    await pgClient.unsafe(
      `INSERT INTO ai_operation_idempotency (key_hash, result_json, created_at, expires_at)
       VALUES ($1, $2::jsonb, now(), 'infinity')
       ON CONFLICT (key_hash) DO UPDATE SET result_json = EXCLUDED.result_json, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at`,
      [`${RESOURCES_CORPUS_STORE_KEY_PREFIX}${env}`, JSON.stringify(c)] as never[],
    );
  },
};
let store: Store | null = process.env.NODE_ENV === 'test' ? null : dbStore;

function ttlMs(): number {
  const s = getAssistantConfig().helpCacheTtlSeconds;
  return (Number.isFinite(s) && s > 0 ? s : 86_400) * 1000;
}
const duBonEnvironnement = (c: Pick<ResourcesCorpus, 'environment'>) => corpusMatchesEnvironment(c.environment, helpApplicationEnvironment() ?? undefined);
const origine = (u: string | null) => { try { return u ? new URL(u).origin : null; } catch { return null; } };

function avecDelai<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`délai de ${ms} ms dépassé`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function dernierCorpusValide(): Promise<ResourcesCorpus | null> {
  if (dernierValide && duBonEnvironnement(dernierValide.corpus)) {
    servi = dernierValide.origin === 'db' ? 'last_valid_db' : 'last_valid_memory';
    return dernierValide.corpus;
  }
  dernierValide = null;
  const env = helpApplicationEnvironment();
  if (store && env) {
    try {
      const c = parseResourcesCorpus(await avecDelai(store.read(env), LECTURE_BASE_MS));
      if (c && c.articles.length > 0 && duBonEnvironnement(c)) {
        dernierValide = { corpus: c, origin: 'db' };
        versionStockee = c.version;
        servi = 'last_valid_db';
        return c;
      }
    } catch { /* base indisponible : aucun repli */ }
  }
  servi = 'none';
  return null;
}

async function echec(code: ResourcesCorpusAlertCode, message: string, reessaiMs: number): Promise<ResourcesCorpus | null> {
  console.warn(`[assistant] ${code} — ${message}`);
  alerte = { code, message, at: new Date().toISOString() };
  const repli = await dernierCorpusValide();
  cache = { at: Date.now() - ttlMs() + reessaiMs, corpus: repli };
  return repli;
}

async function lireEnDirect(): Promise<ResourcesCorpus | null> {
  const cfg = resolvePublicCorpusConfig(RESOURCES_T2_CORPUS_PATH);
  derniereUrl = cfg.url;
  if (cfg.problem) {
    const code = cfg.problem.code === 'HELP_CORPUS_WRONG_ENVIRONMENT' ? 'RESOURCES_CORPUS_WRONG_ENVIRONMENT' : 'RESOURCES_CORPUS_UNAVAILABLE';
    return echec(code, `${cfg.problem.message} (Ressources)`, REESSAI_REFUS_MS);
  }
  const url = cfg.url!;
  let res: Response;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RESOURCES_CORPUS_FETCH_TIMEOUT_MS);
    res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/json' } }).finally(() => clearTimeout(timer));
  } catch (e) {
    const err = e as Error;
    const delai = err?.name === 'AbortError' || err?.name === 'TimeoutError' || /abort/i.test(String(err?.message ?? ''));
    return delai
      ? echec('RESOURCES_CORPUS_TIMEOUT', `Corpus Ressources trop lent (${origine(url)}).`, REESSAI_PANNE_MS)
      : echec('RESOURCES_CORPUS_UNAVAILABLE', `Corpus Ressources injoignable (${origine(url)}).`, REESSAI_PANNE_MS);
  }
  if (!res.ok) return echec('RESOURCES_CORPUS_HTTP_ERROR', `Corpus Ressources non publié : HTTP ${res.status} sur ${origine(url)}.`, REESSAI_REFUS_MS);
  const corpus = parseResourcesCorpus(await res.json().catch(() => undefined));
  if (!corpus) return echec('RESOURCES_CORPUS_INVALID', `Corpus Ressources publié invalide sur ${origine(url)}.`, REESSAI_REFUS_MS);
  if (!duBonEnvironnement(corpus)) {
    return echec('RESOURCES_CORPUS_WRONG_ENVIRONMENT',
      `Corpus Ressources d’environnement « ${corpus.environment.slice(0, 20)} » refusé (application « ${helpApplicationEnvironment() ?? 'inconnu'} », ENV-02).`, REESSAI_REFUS_MS);
  }
  cache = { at: Date.now(), corpus };
  alerte = null;
  servi = 'live';
  if (corpus.articles.length > 0) {
    dernierValide = { corpus, origin: 'live' };
    if (store && corpus.version !== versionStockee) {
      const s = store;
      const env = helpApplicationEnvironment() ?? 'inconnu';
      s.write(env, corpus).then(() => { versionStockee = corpus.version; }).catch(() => {});
    }
  }
  return corpus;
}

/**
 * Corpus Ressources de l'environnement (cache, dernier valide en repli). Ne
 * lève jamais. `staleWhileRevalidate` : dernier corpus valide en mémoire
 * servi tout de suite pendant la relecture (une question n'attend jamais le
 * réseau).
 */
export async function loadResourcesCorpus(opts: { staleWhileRevalidate?: boolean } = {}): Promise<ResourcesCorpus | null> {
  if (testOverride) return cache?.corpus ?? null;
  if (cache && Date.now() - cache.at < ttlMs()) return cache.corpus;
  const lecture = enCours ??= lireEnDirect().catch(() => null).finally(() => { enCours = null; });
  if (opts.staleWhileRevalidate && dernierValide && duBonEnvironnement(dernierValide.corpus)) {
    void lecture;
    return dernierValide.corpus;
  }
  return lecture;
}

/** Article Ressources publié dans l'environnement (`RES-<ID>` ou `<ID>`). */
export async function resourceArticlePublished(id: string): Promise<boolean> {
  const brut = id.startsWith(RESOURCE_ARTICLE_PREFIX) ? id.slice(RESOURCE_ARTICLE_PREFIX.length) : id;
  const c = await loadResourcesCorpus({ staleWhileRevalidate: true });
  return Boolean(c?.articles.some((a) => a.id === brut));
}

/** État du corpus (diagnostic BO, sans contenu). */
export function resourcesCorpusHealth(): ResourcesCorpusHealth {
  const c = cache?.corpus ?? dernierValide?.corpus ?? null;
  return {
    status: alerte ? 'warning' : c ? 'ok' : 'unknown',
    source: servi ?? (c ? 'live' : 'none'),
    version: c?.version ?? null,
    environment: c?.environment ?? null,
    articles: c?.articles.length ?? 0,
    url: origine(derniereUrl),
    alert: alerte,
  };
}

/** Réservé aux tests : corpus servi tel quel (`null` : indisponible). */
export function setResourcesCorpusForTests(c: ResourcesCorpus | null): void {
  testOverride = true;
  cache = { at: Date.now(), corpus: c };
  servi = c ? 'live' : 'none';
  alerte = c ? null : { code: 'RESOURCES_CORPUS_UNAVAILABLE', message: 'indisponible (test)', at: new Date().toISOString() };
}

/** Réservé aux tests. */
export function resetResourcesCorpusForTests(): void {
  testOverride = false;
  cache = null; enCours = null; dernierValide = null; versionStockee = null; alerte = null; servi = null; derniereUrl = null;
  store = process.env.NODE_ENV === 'test' ? null : dbStore;
}
