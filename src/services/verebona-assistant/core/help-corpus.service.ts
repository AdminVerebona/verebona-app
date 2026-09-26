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
import { PUBLIC_SITE_URL } from '@/lib/external-urls';
import { HELP_T2_CORPUS_PATH } from '@/lib/help-center/catalog';
import { helpScreenForRoute } from '@/lib/help-center/screens';
import { parseEnvironment } from '@/services/ai/config/environment';
import type { RetrievedSource } from '../types/sources';
import type { PageContext } from '../types/contracts';

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
}
export interface HelpCorpus {
  schema: 'verebona-help-t2-v1';
  version: string;
  environment: string;
  articles: HelpCorpusArticle[];
}

/** Intentions d'aide à l'utilisation : sources du Centre d'aide uniquement (§5). */
export const HELP_INTENTS = new Set([
  'PRODUCT_HELP_HOW_TO', 'PRODUCT_HELP_EXPLAIN', 'PRODUCT_HELP_STATUS', 'NAVIGATION_FIND', 'EXPORT_HELP',
]);

export function isHelpIntent(intent: string): boolean {
  return HELP_INTENTS.has(intent);
}

// ── Lecture ─────────────────────────────────────────────────────────────────

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;
let cache: { at: number; corpus: HelpCorpus | null } | null = null;

/** Site du Centre d'aide : `HELP_CENTER_URL` côté serveur, sinon le site public. */
export function helpCorpusUrl(): string {
  const base = (process.env.HELP_CENTER_URL || PUBLIC_SITE_URL).replace(/\/+$/, '');
  return `${base}${HELP_T2_CORPUS_PATH}`;
}

export function parseHelpCorpus(json: unknown): HelpCorpus | null {
  const c = json as Partial<HelpCorpus> | null;
  if (!c || c.schema !== 'verebona-help-t2-v1' || !Array.isArray(c.articles)) return null;
  const ok = c.articles.every((a) => a && typeof a.id === 'string' && typeof a.path === 'string'
    && /^\/aide\/[a-z0-9-]+$/.test(a.path) && Array.isArray(a.sections));
  return ok ? (c as HelpCorpus) : null;
}

/**
 * Corpus de l'environnement, mis en cache 5 minutes. Ne lève jamais : sans
 * corpus, l'assistant dit qu'il ne peut pas répondre de façon fiable (T2-03)
 * au lieu d'improviser une procédure.
 */
export async function loadHelpCorpus(): Promise<HelpCorpus | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.corpus;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(helpCorpusUrl(), { signal: ctrl.signal }).finally(() => clearTimeout(timer));
    let corpus = res.ok ? parseHelpCorpus(await res.json()) : null;
    // ENV-02 : la préproduction de l'application ne lit jamais le corpus de
    // production, et inversement. Une variable mal renseignée ferait sinon
    // répondre l'assistant sur des articles d'un autre environnement.
    if (corpus && !corpusMatchesEnvironment(corpus.environment, process.env.NEXT_PUBLIC_APP_ENV)) {
      console.error(`[assistant] Corpus d'aide refusé : environnement « ${corpus.environment} » ≠ application « ${process.env.NEXT_PUBLIC_APP_ENV} » (ENV-02).`);
      corpus = null;
    }
    cache = { at: Date.now(), corpus };
    return corpus;
  } catch (e) {
    console.warn(`[assistant] Corpus du Centre d'aide indisponible (${(e as Error).message}).`);
    cache = { at: Date.now() - TTL_MS + 30_000, corpus: null };
    return null;
  }
}

/**
 * Le corpus appartient-il à l'environnement de l'application (ENV-02) ?
 * Seules la production et la préproduction sont contraintes : en local, lire
 * le corpus de préproduction est l'usage normal.
 */
export function corpusMatchesEnvironment(corpusEnv: string | undefined, appEnvRaw: string | undefined): boolean {
  const app = parseEnvironment(appEnvRaw);
  if (app !== 'production' && app !== 'preprod') return true;
  return parseEnvironment(corpusEnv) === app;
}

/** Réservé aux tests. */
export function setHelpCorpusForTests(corpus: HelpCorpus | null): void {
  cache = corpus ? { at: Date.now(), corpus } : null;
}

// ── Recherche ───────────────────────────────────────────────────────────────

const STOP = new Set(('a au aux avec ce ces comment dans de des du elle en est et il je la le les leur lui ma mais me mes mon ne '
  + 'nos notre nous on ou par pas plus pour qu que quel quelle qui sa se ses son sur ta te tes ton tu un une vos votre vous '
  + 'y d l j m n s t c faire fait peut peux puis dois doit ca pourquoi quand verebona').split(' '));

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
  const q = [...new Set(terms(question))];
  if (q.length === 0) return [];
  const hits: HelpHit[] = [];
  for (const a of corpus.articles) {
    const poids = contextWeight(a, ctx);
    if (poids === 0) continue;
    const head = new Set(terms(`${a.title} ${a.synonyms.join(' ')} ${a.summary}`));
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
      const coverage = found / q.length;
      if (coverage < 0.5) continue;
      hits.push({ article: a, section: s, score: (score / (3 * q.length)) * coverage * poids });
    }
  }
  hits.sort((x, y) => y.score - x.score);
  // Deux sections au plus par article : citer l'article, pas le recopier.
  const perArticle = new Map<string, number>();
  return hits.filter((h) => {
    const n = perArticle.get(h.article.id) ?? 0;
    perArticle.set(h.article.id, n + 1);
    return n < 2;
  }).slice(0, limit);
}

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
}

export function helpContextFromPage(page: PageContext | undefined, role: string | null = null): HelpSearchContext {
  const { screens, objectType } = helpScreenForRoute(page?.route);
  const platform = page?.platform === 'mobile' || page?.platform === 'web' ? page.platform : null;
  return { screens, objectType, platform, role };
}

/**
 * Pondération d'un article selon le contexte :
 *   · plateforme déclarée et différente → article écarté (0) — une
 *     procédure mobile n'est pas une réponse sur le web ;
 *   · écran courant cité par l'article → ×1,25 ; type d'objet → ×1,1 ;
 *   · rôle déclaré, sans « all » ni le rôle de l'utilisateur → ×0,6 (pas
 *     écarté : le rôle n'est pas toujours connu avec certitude).
 */
export function contextWeight(a: HelpCorpusArticle, ctx?: HelpSearchContext): number {
  if (!ctx) return 1;
  if (ctx.platform && a.platforms?.length && !a.platforms.includes(ctx.platform)) return 0;
  let w = 1;
  if (ctx.screens.length && a.screens?.some((s) => ctx.screens.includes(s))) w *= 1.25;
  if (ctx.objectType && a.objectTypes?.includes(ctx.objectType)) w *= 1.1;
  if (ctx.role && a.roles?.length && !a.roles.includes('all') && !a.roles.includes(ctx.role)) w *= 0.6;
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
export function toHelpSources(hits: HelpHit[], planType?: string): RetrievedSource[] {
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
      },
      relevanceScore: Math.min(1, score),
    };
  });
}

/** Recherche complète pour une question d'usage. Vide si le corpus est indisponible. */
export async function retrieveHelpSources(question: string, planType?: string, limit = 4, ctx?: HelpSearchContext): Promise<RetrievedSource[]> {
  const corpus = await loadHelpCorpus();
  if (!corpus) return [];
  return toHelpSources(searchHelpCorpus(corpus, question, limit, ctx), planType);
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
 * profond construit par le serveur). Sans source : l'aveu explicite et le
 * renvoi au support (bouton « Contacter le support »).
 */
export function fallbackFromHelpSources(sources: RetrievedSource[]): string {
  const aide = sources.filter((s) => s.type === 'help_entry');
  if (aide.length === 0) {
    return 'Je ne peux pas répondre de façon fiable à cette question à partir du Centre d’aide. '
      + 'Vous pouvez reformuler votre question ou contacter le support.';
  }
  const meilleure = aide[0];
  const extrait = helpExcerpt(String(meilleure.content).split('\n[Offre]')[0]);
  const autres = [...new Set(aide.slice(1).map(titreArticle))].filter((t) => t !== titreArticle(meilleure)).slice(0, 2);
  const suite = autres.length ? ` Voir aussi ${autres.map((t) => `« ${t} »`).join(' et ')}.` : '';
  const offre = meilleure.meta?.notIncludedInPlan ? ` Cette fonction n’est pas incluse dans votre offre actuelle (${meilleure.meta.offersLabel}).` : '';
  return `D’après l’article « ${titreArticle(meilleure)} » : ${extrait}${offre} La procédure complète est dans l’article.${suite}`;
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
