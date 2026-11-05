/**
 * Répondabilité des questions du guide (objectif C) — lot 108J.
 *
 * Une question d'aide ou de découverte n'est proposée comme « répondable »
 * que si l'article qui y répond est PUBLIÉ dans le corpus de l'environnement
 * (Centre d'aide ou Ressources) ET retrouvé par la recherche MÊME de
 * l'assistant (`searchHelpCorpus`, mêmes seuils de couverture) pour ce
 * libellé. Aucun appel IA. Résultat mémorisé par version de corpus.
 *
 * Lot 110E : pour une question RESSOURCES, « retrouvé par la recherche » ne
 * prouvait pas qu'un passage RÉPONDE (E03 retrouvé, C01 servi). La couverture
 * est désormais la PREUVE DE RÉPONSE du catalogue (`resource-questions.ts`) :
 * sections déclarées présentes et sujets attendus retrouvés dans leur texte.
 * Seul `VERIFIED` est proposé ; partiel, non couvert, article retiré ou
 * section disparue : la question n'est pas proposée. Les questions du Centre
 * d'aide gardent la règle du lot 108J (inchangée).
 */
import { searchHelpCorpus, type HelpCorpus } from '@/services/verebona-assistant/core/help-corpus.service';
import type { GuideStockEntry } from './stock';
import { checkResourceEvidence, type EvidenceCheck } from './resource-questions';

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
  if (e.corpus === 'RESOURCES') return resourceCoverageOf(e, corpus).status === 'VERIFIED' ? 'VERIFIED' : 'NOT_ANSWERABLE';
  const articleId = e.articleId;
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

/** Preuve de réponse d'une question Ressources sur le corpus présenté (mémoïsée par version et révision). */
export function resourceCoverageOf(e: Pick<GuideStockEntry, 'id'>, corpus: HelpCorpus | null): EvidenceCheck {
  return checkResourceEvidence(e.id, corpus);
}

/** Réservé aux tests. */
export function resetAnswerabilityMemo(): void { memo.clear(); }
