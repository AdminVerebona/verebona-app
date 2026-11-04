/**
 * Répondabilité des questions du guide (objectif C) — lot 108J.
 *
 * Une question d'aide ou de découverte n'est proposée comme « répondable »
 * que si l'article qui y répond est PUBLIÉ dans le corpus de l'environnement
 * (Centre d'aide ou Ressources) ET retrouvé par la recherche MÊME de
 * l'assistant (`searchHelpCorpus`, mêmes seuils de couverture) pour ce
 * libellé. Aucun appel IA. Résultat mémorisé par version de corpus.
 */
import { searchHelpCorpus, type HelpCorpus } from '@/services/verebona-assistant/core/help-corpus.service';
import { RESOURCE_ARTICLE_PREFIX } from '@/services/verebona-assistant/core/resources-corpus.service';
import type { GuideStockEntry } from './stock';

/** Nombre de sections examinées (comme une demande T2). */
const SEARCH_LIMIT = 4;

export type Answerability = 'VERIFIED' | 'UNVERIFIED' | 'NOT_ANSWERABLE';

export interface CorporaForAnswerability {
  /** Corpus du Centre d'aide servi (`null` : indisponible). */
  help: HelpCorpus | null;
  /** Corpus Ressources présenté à la recherche (`null` : indisponible). */
  resources: HelpCorpus | null;
}

const memo = new Map<string, Answerability>();

/**
 * Pure (à mémoïsation près). Centre d'aide indisponible : une question de
 * prise en main reste proposable (`UNVERIFIED`, tracé) — l'accueil ne se
 * vide jamais ; Ressources indisponibles : une question de découverte n'est
 * PAS proposée (`NOT_ANSWERABLE`), faute de pouvoir citer l'article.
 */
export function guideAnswerability(e: GuideStockEntry, c: CorporaForAnswerability): Answerability {
  const corpus = e.corpus === 'HELP' ? c.help : c.resources;
  if (!corpus) return e.corpus === 'HELP' ? 'UNVERIFIED' : 'NOT_ANSWERABLE';
  const articleId = e.corpus === 'RESOURCES' ? `${RESOURCE_ARTICLE_PREFIX}${e.articleId}` : e.articleId;
  const key = `${e.corpus}:${corpus.version}:${corpus.environment}:${e.id}:${e.label}`;
  const known = memo.get(key);
  if (known) return known;
  let out: Answerability = 'NOT_ANSWERABLE';
  if (corpus.articles.some((a) => a.id === articleId)) {
    const hits = searchHelpCorpus(corpus, e.label, SEARCH_LIMIT);
    if (hits.some((h) => h.article.id === articleId)) out = 'VERIFIED';
  }
  if (memo.size > 2_000) memo.clear();
  memo.set(key, out);
  return out;
}

/** Réservé aux tests. */
export function resetAnswerabilityMemo(): void { memo.clear(); }
