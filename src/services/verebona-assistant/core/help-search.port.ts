/**
 * Recherche du Centre d'aide pour la cascade d'aide — lot 33.
 *
 * Ouverte UNE fois par demande : corpus de l'environnement (dernier corpus
 * valide en repli, PUB-01), contexte de page et rôles de l'utilisateur
 * (résolus côté serveur, T2-05). Chaque niveau de la cascade (plein texte,
 * recherche élargie, requêtes d'UNDERSTAND) interroge ensuite ce même corpus,
 * sans relire ni la base ni le site.
 *
 * Corpus indisponible : le résultat le dit (`corpusAvailable: false`) — un
 * « 0 résultat » TECHNIQUE, distinct d'une recherche sans candidat.
 *
 * Lot 34G : le dernier corpus valide en mémoire est servi sans attendre le
 * réseau (relecture en arrière-plan) ; chaque résultat porte l'état du
 * corpus (source, version, environnements, code de diagnostic) pour la trace.
 *
 * Lot 108J : les articles RESSOURCES publiés (`/ressources/corpus-t2.json`,
 * même mécanisme de chargement) sont cherchés avec le Centre d'aide, sous les
 * mêmes règles de citation :
 *   · question de prise en main (par défaut) : le Centre d'aide d'abord — une
 *     Ressource n'est retenue qu'avec un poids réduit ;
 *   · suggestion de DÉCOUVERTE validée par le serveur (`input.suggestion`,
 *     corpus `RESOURCES`) : les Ressources d'abord, le Centre d'aide réduit.
 * Corpus Ressources indisponible : recherche du Centre d'aide seule
 * (inchangée) ; aucun des deux : 0 résultat technique.
 */
import type { AssistantRequestInput } from '../types/contracts';
import { getAssistantConfig } from '../config/assistant-config';
import {
  HELP_CORPUS_UNAVAILABLE_RESULT, helpContextFromPage, loadHelpCorpusDetailed, searchHelpQueries,
  type HelpCorpus, type HelpCorpusArticle, type HelpCorpusLoadInfo,
} from './help-corpus.service';
import { asHelpSearchCorpus, loadResourcesCorpus } from './resources-corpus.service';
import { helpRolesFor } from './retrieval.service';
import { mergeHelpSources, type HelpSearchResult, type HelpSearcher, type StagedHelpSource } from './help-cascade';

/** Poids d'un corpus secondaire (Ressources pour l'aide, aide pour la découverte). */
export const SECONDARY_CORPUS_WEIGHT = 0.8;

const pondere = (l: StagedHelpSource[], w: number): StagedHelpSource[] =>
  (w === 1 ? l : l.map((s) => ({ ...s, relevanceScore: Math.min(1, (s.relevanceScore ?? 0) * w) })));

/**
 * Fusion des deux corpus (pure, testée) : le corpus préféré à plein poids,
 * l'autre réduit ; résultat disponible si l'un des deux l'est.
 */
export function mergeHelpAndResources(
  help: HelpSearchResult | null, resources: HelpSearchResult | null, prefer: 'HELP' | 'RESOURCES', limit: number,
): HelpSearchResult {
  if (!resources) return help ?? HELP_CORPUS_UNAVAILABLE_RESULT;
  if (!help) return { ...resources, sources: resources.sources.slice(0, limit) };
  const wHelp = prefer === 'HELP' ? 1 : SECONDARY_CORPUS_WEIGHT;
  const wRes = prefer === 'RESOURCES' ? 1 : SECONDARY_CORPUS_WEIGHT;
  return {
    ...help,
    corpusAvailable: help.corpusAvailable || resources.corpusAvailable,
    sources: mergeHelpSources(pondere(help.sources, wHelp), pondere(resources.sources, wRes)).slice(0, limit),
    candidateCount: help.candidateCount + resources.candidateCount,
    rejected: {
      lowCoverage: help.rejected.lowCoverage + resources.rejected.lowCoverage,
      contextExcluded: help.rejected.contextExcluded + resources.rejected.contextExcluded,
    },
  };
}

export async function openHelpSearch(input: AssistantRequestInput): Promise<{
  search: HelpSearcher;
  article(id: string): HelpCorpusArticle | null;
  corpus: HelpCorpusLoadInfo;
}> {
  const [{ corpus, info }, roles, ressources] = await Promise.all([
    loadHelpCorpusDetailed({ staleWhileRevalidate: true }),
    helpRolesFor(input.accountId, input.userId).catch(() => []),
    loadResourcesCorpus({ staleWhileRevalidate: true }).catch(() => null),
  ]);
  const res: HelpCorpus | null = ressources && ressources.articles.length > 0 ? asHelpSearchCorpus(ressources) : null;
  const ctx = helpContextFromPage(input.pageContext, roles);
  const limit = getAssistantConfig().maxSources;
  const prefer = input.suggestion?.corpus === 'RESOURCES' ? 'RESOURCES' : 'HELP';
  // Les Ressources ne dépendent ni de l'écran ni de la plateforme : recherche sans contexte de page.
  const corpusInfo: HelpCorpusLoadInfo = !corpus && res
    ? { ...info, corpusAvailable: true, corpusSource: 'live', corpusVersion: res.version, corpusEnvironment: res.environment }
    : info;
  return {
    search: async (queries, stage) => {
      const aide = corpus ? searchHelpQueries(corpus, queries, stage, { limit, ctx, planType: input.planType }) : null;
      const ress = res ? searchHelpQueries(res, queries, stage, { limit, planType: input.planType }) : null;
      return { ...mergeHelpAndResources(aide, ress, prefer, limit), corpus: corpusInfo };
    },
    article: (id) => corpus?.articles.find((a) => a.id === id) ?? res?.articles.find((a) => a.id === id) ?? null,
    corpus: corpusInfo,
  };
}
