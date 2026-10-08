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
 */
import type { AssistantRequestInput } from '../types/contracts';
import { getAssistantConfig } from '../config/assistant-config';
import {
  HELP_CORPUS_UNAVAILABLE_RESULT, helpContextFromPage, loadHelpCorpus, searchHelpQueries,
  type HelpCorpusArticle,
} from './help-corpus.service';
import { helpRolesFor } from './retrieval.service';
import type { HelpSearcher } from './help-cascade';

export async function openHelpSearch(input: AssistantRequestInput): Promise<{
  search: HelpSearcher;
  article(id: string): HelpCorpusArticle | null;
}> {
  const [corpus, roles] = await Promise.all([
    loadHelpCorpus(),
    helpRolesFor(input.accountId, input.userId).catch(() => []),
  ]);
  const ctx = helpContextFromPage(input.pageContext, roles);
  const limit = getAssistantConfig().maxSources;
  return {
    search: async (queries, stage) => (corpus
      ? searchHelpQueries(corpus, queries, stage, { limit, ctx, planType: input.planType })
      : HELP_CORPUS_UNAVAILABLE_RESULT),
    article: (id) => corpus?.articles.find((a) => a.id === id) ?? null,
  };
}
