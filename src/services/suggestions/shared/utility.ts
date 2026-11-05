/**
 * Critère d'UTILITÉ des suggestions partagées — lot 111L (ticket
 * « Suggestions : critère d'utilité réelle avant publication »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CAUSE CONSTATÉE (diagnostic par le code, base lot 110)
 *
 * « Quels sont les documents de Maison ? » ne vient NI de T6 (bulle seule
 * depuis le lot 108J : aucune question générée, `home_mascot_cache.suggestions`
 * n'est plus lu pour l'affichage), NI d'un repli éditorial, NI d'un modèle
 * par type de bien. Elle vient du STOCK PERSONNEL du service partagé :
 * `ACCOUNT_STOCK[0]` = entrée `home_asset_docs` du catalogue validé
 * (`capability-registry.ts`, gabarit « Quels sont les documents {de_bien} ? »),
 * objectif EXPLOITER, PRIORITÉ 1, dont la seule précondition est
 * `asset.documents > 0` ; le bien nommé est choisi par `pickSuggestionAssets`
 * (« de préférence avec des documents »). Une seule facture rattachée à
 * « Maison » suffisait donc à la placer en tête, sur l'accueil ET dans T2.
 * La sélection ne vérifiait que la RÉPONDABILITÉ (préconditions, corpus),
 * jamais l'UTILITÉ : une question constructible et répondable était publiée.
 *
 * RÈGLE (générale, aucune phrase ni cas codé)
 *
 * Avant d'être promue spontanément, une candidate doit servir un BESOIN
 * D'INFORMATION qui apporte quelque chose par rapport à la navigation :
 *
 *   FACT          une valeur précise (date, montant, statut, durée…) ;
 *   ANTICIPATION  ce qui va arriver (échéances à venir) ;
 *   GUIDANCE      une aide ou une explication (Centre d'aide, Ressources) ;
 *
 * et ne sont PAS promus :
 *
 *   INVENTORY     la liste d'une famille d'objets (documents, biens,
 *                 exports…) dans un périmètre (un bien, un filtre structurel
 *                 « sans bien », un type) — exactement ce qu'un écran de
 *                 navigation montre déjà (fiche du bien, filtres de
 *                 « Documents », page des exports) ;
 *   ACTION        ce qui attend une action : c'est le rôle d'« À traiter » ;
 *   tout besoin déjà rendu par une surface permanente (`shownBy` : la ligne
 *                 de la mascotte « N documents en cours d'analyse », etc.).
 *
 * Le besoin est porté par deux lectures CUMULÉES, toutes deux fondées sur
 * l'INTENTION, jamais sur le libellé exact :
 *
 *   1. la DÉCLARATION du stock (`need`, obligatoire pour chaque entrée) —
 *      ce que la réponse délivre ;
 *   2. la COMPRÉHENSION DÉTERMINISTE de T2 appliquée au libellé rendu
 *      (`understoodNeedOf`) : intention canonique + découpe canonique de la
 *      requête (`analyserRequeteCanonique` : filtres structurels, types,
 *      période, termes) + attributs demandés (champs du registre, montant /
 *      date / fournisseur d'un document, date / statut d'une échéance). Une
 *      recherche qui, une fois retirés la cible nommée, les mots de famille
 *      et les filtres structurels, ne demande RIEN d'autre, est une liste :
 *      une reformulation de façade (« Quels documents concernent ma
 *      Cupra ? ») est donc écartée même si on la déclarait autrement.
 *
 * La PREUVE reste celle des lots 108J / 110E (préconditions lues côté
 * serveur, bien revalidé au clic ; article publié et passage probant pour le
 * guide). Aucune IA, aucun appel réseau, aucune lecture supplémentaire : la
 * qualification est pure et mémoïsée (coûts et latences du #657 conservés).
 *
 * Les questions d'inventaire restent PLEINEMENT fonctionnelles quand
 * l'utilisateur les pose lui-même à T2 : seul leur caractère de suggestion
 * spontanée est retiré (le catalogue T2 et son test contractuel L34 sont
 * inchangés).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { VerebonaIntent } from '@/services/verebona-assistant/types/intents';
import { analyserRequeteCanonique } from '@/services/verebona-assistant/core/retrieval.service';
import { extractSearchTerms, isInventoryQuery, tokenizeQuery } from '@/services/verebona-assistant/core/query-terms';
import { agendaAttributeOf, documentAttributeOf } from '@/services/verebona-assistant/core/target-answer';
import { findReadableFields } from '@/services/verebona-assistant/canonical/field-vocabulary';
import { isAssetVocabularyWord } from '@/lib/asset-taxonomy';

/** Version de la règle : entre dans la version du stock (sélections et caches obsolètes invalidés au déploiement). */
export const SUGGESTION_UTILITY_RULE_VERSION = 'suggestion-utility-v1';

/** Besoin d'information servi par une question (ce que la réponse DÉLIVRE). */
export type SuggestionNeed = 'INVENTORY' | 'FACT' | 'ANTICIPATION' | 'ACTION' | 'GUIDANCE';

/** Surface permanente qui rend déjà cette information sans question. */
export type SuggestionShownBy = 'MASCOT' | 'TO_PROCESS';

/** Besoin compris par T2 dans le libellé (lecture déterministe). */
export type UnderstoodNeed = 'LISTING' | 'FACT' | 'SUBJECT' | 'ACTION' | 'GUIDANCE';

/** Décision de qualification (codes stables, BO seulement). */
export type UtilityDecision =
  | 'USEFUL'
  /** Déclarée comme simple inventaire : la navigation y répond déjà. */
  | 'INVENTORY_DECLARED'
  /** Comprise par T2 comme une simple liste, quelle que soit la déclaration (reformulation de façade). */
  | 'INVENTORY_UNDERSTOOD'
  /** Ce qui attend une action relève d'« À traiter ». */
  | 'ACTION_SURFACE'
  /** Information déjà rendue par une surface permanente (mascotte…). */
  | 'SHOWN_ELSEWHERE'
  /** Aucune preuve de réponse (précondition, article, passage). */
  | 'NO_PROOF';

const GUIDANCE_INTENTS: ReadonlySet<VerebonaIntent> = new Set([
  'PRODUCT_HELP_HOW_TO', 'PRODUCT_HELP_EXPLAIN', 'PRODUCT_HELP_STATUS', 'PRODUCT_PLAN_LIMIT', 'EXPORT_HELP', 'NAVIGATION_FIND',
]);
const SEARCH_INTENTS: ReadonlySet<VerebonaIntent> = new Set([
  'ACCOUNT_SEARCH_ASSET', 'ACCOUNT_SEARCH_DOCUMENT', 'ACCOUNT_SEARCH_AGENDA', 'ACCOUNT_SEARCH_SUPPLIER',
]);
const ACTION_INTENTS: ReadonlySet<VerebonaIntent> = new Set(['ACCOUNT_TO_PROCESS']);
/**
 * Attributs d'un document qui sont une VALEUR (montant, fournisseur, date) ;
 * « type » et « biens rattachés » décrivent le périmètre d'une liste.
 */
const DOCUMENT_VALUE_ATTRIBUTES: ReadonlySet<string> = new Set(['amount', 'supplier', 'date']);

/** Racines d'un nom de bien (cible nommée : elle désigne le périmètre, jamais un sujet). */
function stemsOfName(name: string | null | undefined): Set<string> {
  const n = (name ?? '').trim();
  if (!n) return new Set();
  return new Set([...tokenizeQuery(n).flatMap((t) => [t.stem, t.raw]), ...extractSearchTerms(n)]);
}

const memo = new Map<string, UnderstoodNeed>();

/**
 * Besoin compris par T2 dans un libellé (pure, mémoïsée). Mêmes fonctions
 * que la compréhension déterministe de l'assistant ; `targetName` : bien
 * nommé par la question (retiré : il fixe le périmètre).
 */
export function understoodNeedOf(p: { label: string; canonicalIntent: VerebonaIntent; targetName?: string | null }): UnderstoodNeed {
  const key = `${p.canonicalIntent}\u0000${p.targetName ?? ''}\u0000${p.label}`;
  const known = memo.get(key);
  if (known) return known;
  const out = compute(p);
  if (memo.size > 2_000) memo.clear();
  memo.set(key, out);
  return out;
}

function compute(p: { label: string; canonicalIntent: VerebonaIntent; targetName?: string | null }): UnderstoodNeed {
  if (GUIDANCE_INTENTS.has(p.canonicalIntent)) return 'GUIDANCE';
  if (ACTION_INTENTS.has(p.canonicalIntent)) return 'ACTION';
  if (!SEARCH_INTENTS.has(p.canonicalIntent)) return 'FACT';
  // Une VALEUR est demandée : champ du registre, attribut d'un document ou d'une échéance.
  if (findReadableFields(p.label).length > 0) return 'FACT';
  const doc = documentAttributeOf(p.label);
  if (doc && DOCUMENT_VALUE_ATTRIBUTES.has(doc)) return 'FACT';
  if (agendaAttributeOf(p.label)) return 'FACT';
  // Inventaire des biens (« Qu'est-ce que j'ai comme biens ? ») : règle de T2.
  if (isInventoryQuery(p.label)) return 'LISTING';
  // Découpe canonique : filtres structurels et période retirés, types de document reconnus.
  const req = analyserRequeteCanonique(p.label);
  if (req.period) return 'SUBJECT';
  const cible = stemsOfName(p.targetName);
  const types = new Set(req.documentTypes);
  const sujet = req.terms.filter((t) => !t.exact
    ? !(cible.has(t.stem) || cible.has(t.raw) || types.has(t.stem) || types.has(t.raw) || isAssetVocabularyWord(t.raw) || isAssetVocabularyWord(t.stem))
    : !cible.has(t.raw));
  // Rien d'autre que le périmètre (bien, famille, type, filtre) : la question demande la liste.
  return sujet.length > 0 ? 'SUBJECT' : 'LISTING';
}

export interface UtilityInput {
  /** Besoin déclaré par le stock. */
  need: SuggestionNeed;
  shownBy?: SuggestionShownBy | null;
  label: string;
  canonicalIntent: VerebonaIntent;
  targetName?: string | null;
  /** La réponse est prouvée (préconditions satisfaites, article publié et probant). */
  proven: boolean;
}

/**
 * Qualification d'une candidate (pure, testée). L'ordre des contrôles fixe
 * le motif tracé : action, inventaire déclaré, inventaire compris, surface
 * qui le montre déjà, preuve.
 */
export function qualifySuggestion(c: UtilityInput): { promotable: boolean; decision: UtilityDecision; understood: UnderstoodNeed } {
  const understood = understoodNeedOf(c);
  const non = (decision: UtilityDecision) => ({ promotable: false, decision, understood });
  if (c.need === 'ACTION' || understood === 'ACTION') return non('ACTION_SURFACE');
  if (c.need === 'INVENTORY') return non('INVENTORY_DECLARED');
  if (understood === 'LISTING') return non('INVENTORY_UNDERSTOOD');
  if (c.shownBy) return non('SHOWN_ELSEWHERE');
  if (!c.proven) return non('NO_PROOF');
  return { promotable: true, decision: 'USEFUL', understood };
}

/** Libellés BO des décisions, en mots simples. */
export const UTILITY_DECISION_LABELS: Readonly<Record<UtilityDecision, string>> = {
  USEFUL: 'Utile : information précise, anticipation ou aide, réponse prouvée.',
  INVENTORY_DECLARED: 'Écartée : simple inventaire (la navigation y répond déjà). Reste possible si l’utilisateur la pose lui-même.',
  INVENTORY_UNDERSTOOD: 'Écartée : comprise comme une simple liste (aucune valeur, aucun sujet précis demandé).',
  ACTION_SURFACE: 'Écartée : ce qui attend une action est présenté par « À traiter ».',
  SHOWN_ELSEWHERE: 'Écartée : information déjà affichée en permanence (mascotte).',
  NO_PROOF: 'Écartée : aucune réponse prouvée pour ce compte.',
};

/** Réservé aux tests. */
export function resetUtilityMemo(): void { memo.clear(); }
