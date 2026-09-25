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
import type { RetrievedSource } from '../types/sources';

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
    const corpus = res.ok ? parseHelpCorpus(await res.json()) : null;
    cache = { at: Date.now(), corpus };
    return corpus;
  } catch (e) {
    console.warn(`[assistant] Corpus du Centre d'aide indisponible (${(e as Error).message}).`);
    cache = { at: Date.now() - TTL_MS + 30_000, corpus: null };
    return null;
  }
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
export function searchHelpCorpus(corpus: HelpCorpus, question: string, limit = 4): HelpHit[] {
  const q = [...new Set(terms(question))];
  if (q.length === 0) return [];
  const hits: HelpHit[] = [];
  for (const a of corpus.articles) {
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
      hits.push({ article: a, section: s, score: (score / (3 * q.length)) * coverage });
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
export async function retrieveHelpSources(question: string, planType?: string, limit = 4): Promise<RetrievedSource[]> {
  const corpus = await loadHelpCorpus();
  if (!corpus) return [];
  return toHelpSources(searchHelpCorpus(corpus, question, limit), planType);
}

/** Article publié dans l'environnement (contrôle d'accès de l'action OPEN_HELP). */
export async function helpArticlePublished(id: string): Promise<boolean> {
  const corpus = await loadHelpCorpus();
  return Boolean(corpus?.articles.some((a) => a.id === id));
}

/**
 * Réponse sans modèle à une question d'usage — T2-01, T2-03.
 *
 * Avec des sources : les articles, cités, que l'utilisateur ouvre d'un clic.
 * Sans source : l'aveu explicite et le contact, jamais une procédure devinée.
 */
export function fallbackFromHelpSources(sources: RetrievedSource[]): string {
  const titles = [...new Set(sources.filter((s) => s.type === 'help_entry')
    .map((s) => String(s.title).split(' — ')[0]))].slice(0, 4);
  if (titles.length === 0) {
    return 'Je ne peux pas répondre de façon fiable à cette question à partir du Centre d’aide. '
      + 'Vous pouvez reformuler votre question ou contacter le support depuis le Centre d’aide.';
  }
  const list = titles.map((t) => `« ${t} »`);
  const joined = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} et ${list[list.length - 1]}`;
  return `Le Centre d’aide traite ce sujet dans ${list.length === 1 ? 'l’article' : 'les articles'} ${joined}. `
    + 'Ouvrez les sources ci-dessous pour la procédure complète.';
}
