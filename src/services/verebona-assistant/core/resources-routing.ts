/**
 * Routage d'une question LIBRE vers les Ressources — lot 110E.
 *
 * Constat (test L110E-U05) : « Quand faire la révision d’une voiture ? »
 * posée librement partait en recherche d'agenda du compte (règle FAIBLE),
 * « Combien de temps garder une facture d’achat ? » et « Quels documents
 * conserver après des travaux dans un logement ? » en recherche de documents
 * du compte : les Ressources n'étaient jamais consultées hors suggestion.
 *
 * Règle (déterministe, aucun appel IA) : une question formulée de façon
 * GÉNÉRALE (`isDocumentaryQuestion` : objet indéfini, aucune marque
 * personnelle, aucun vocabulaire de l'application, aucun chiffre, aucun
 * objet ouvert) qui n'a été classée qu'en RECHERCHE dans le compte (ou pas du
 * tout), et pour laquelle une Ressource publiée de nature compatible répond
 * avec un score « exact », est routée en question documentaire
 * (`PRODUCT_HELP_EXPLAIN`, Ressources préférées). Sinon rien ne change :
 *   · usage de Verebona (concept du Centre d'aide certain, vocabulaire de
 *     l'application) → Centre d'aide, comme avant ;
 *   · faits du compte (« ma », « mon », un bien nommé, une date…) → compte ;
 *   · intention d'aide, de fait canonique ou d'action → inchangée.
 */
import type { AssistantRequestInput } from '../types/contracts';
import { expandHelpQueries } from '@/lib/help-center/concepts';
import { HELP_EXACT_THRESHOLD, searchHelpQueries } from './help-corpus.service';
import { asHelpSearchCorpus, loadResourcesCorpus } from './resources-corpus.service';
import { guardResourceSources, isDocumentaryQuestion, type ResourcesTrace } from './resources-answer';

/** Intentions de RECHERCHE dans le compte qu'une question documentaire peut remplacer. */
const REMPLACABLES = new Set(['ACCOUNT_SEARCH_DOCUMENT', 'ACCOUNT_SEARCH_AGENDA', 'ACCOUNT_SEARCH_ASSET']);
/** Faits du compte remplaçables seulement quand la règle déterministe était FAIBLE. */
const REMPLACABLES_SI_FAIBLE = new Set(['ACCOUNT_FACT_ASSET', 'ACCOUNT_FACT_DOCUMENT']);

export interface ResourceRouteDecision {
  route: boolean;
  trace: NonNullable<ResourcesTrace['routing']>;
}

/** Décision de routage (ne lève jamais). `outcome` : routage déterministe déjà calculé. */
export async function routeResourceTopic(
  input: Pick<AssistantRequestInput, 'message' | 'pageContext' | 'planType'>,
  outcome: { kind: 'route'; route: { intent: string; deterministicConfidence?: 'STRONG' | 'WEAK' } } | { kind: 'needs_classification' },
): Promise<ResourceRouteDecision | null> {
  const previousIntent = outcome.kind === 'route' ? outcome.route.intent : null;
  const remplacable = outcome.kind === 'needs_classification'
    || REMPLACABLES.has(outcome.route.intent)
    || (REMPLACABLES_SI_FAIBLE.has(outcome.route.intent) && outcome.route.deterministicConfidence === 'WEAK');
  if (!remplacable) return null;
  if (!isDocumentaryQuestion(input.message, input.pageContext)) return null;
  const keep = (reason: string, bestArticle: string | null = null, bestScore: number | null = null): ResourceRouteDecision =>
    ({ route: false, trace: { decision: 'KEPT', previousIntent, bestArticle, bestScore, reason } });
  // Usage de Verebona reconnu par le référentiel du Centre d'aide : jamais détourné.
  if (expandHelpQueries(input.message).concept?.certain) return keep('HELP_CONCEPT');
  const raw = await loadResourcesCorpus({ staleWhileRevalidate: true }).catch(() => null);
  if (!raw || raw.articles.length === 0) return keep('RESOURCES_CORPUS_UNAVAILABLE');
  const r = searchHelpQueries(asHelpSearchCorpus(raw), [input.message], 'fulltext', { limit: 6, planType: input.planType });
  const { kept } = guardResourceSources(input.message, r.sources);
  const best = kept[0] ?? null;
  const score = best ? Math.round((best.relevanceScore ?? 0) * 1000) / 1000 : null;
  const article = best ? String(best.meta?.articleId ?? '') : null;
  if (!best || (best.relevanceScore ?? 0) < HELP_EXACT_THRESHOLD) return keep('NO_EXACT_RESOURCE', article, score);
  return { route: true, trace: { decision: 'RESOURCES', previousIntent, bestArticle: article, bestScore: score, reason: 'DOCUMENTARY_QUESTION' } };
}
