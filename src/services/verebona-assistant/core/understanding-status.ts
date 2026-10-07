/**
 * État de compréhension d'une demande T2 — lot 32 (ticket « T2 : faire de
 * UNDERSTAND le fallback général de compréhension après le déterministe »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI CE MODULE
 *
 * La complétude d'une demande se déduisait de `outcome.kind === 'route'` :
 * une intention reconnue par les règles valait « demande comprise ». Or
 * « Quels documents sont liés à ce bien ? », hors de la fiche d'un bien et
 * sans fil, a bien une intention (ACCOUNT_SEARCH_DOCUMENT) mais AUCUNE cible :
 * la recherche partait à l'échelle du compte et finissait en « Je n'ai rien
 * trouvé ».
 *
 * La compréhension a désormais un état EXPLICITE :
 *
 *   COMPLETE        intention + cibles + faits suffisamment compris → sans IA ;
 *   PARTIAL         intention comprise, demande incomplète :
 *                     MISSING_TARGET       cible requise, aucune trouvée ;
 *                     AMBIGUOUS_TARGET     plusieurs cibles aussi plausibles ;
 *                     UNRESOLVED_REFERENCE renvoi (« l'autre », « celui-là »)
 *                                          que ni le fil ni la page ne lèvent ;
 *                     UNCONSUMED_MEANING   une partie significative de la
 *                                          question n'est pas consommée ;
 *   UNKNOWN_INTENT  aucune règle ne donne d'intention fiable (motifs
 *                   UNKNOWN_INTENT, puis AMBIGUOUS_INTENT si le modèle reste
 *                   ambigu).
 *
 * Cascade (orchestrateur) :
 *
 *   DÉTERMINISTE → COMPLETE ? exécuter sans IA
 *                → le serveur sait EXACTEMENT ce qui manque (MISSING_TARGET,
 *                  AMBIGUOUS_TARGET : candidats connus) ? clarification directe
 *                → sinon UNDERSTAND (si autorisé : traitement T2 actif, arrêt
 *                  d'urgence, budgets, offre) → résolution SERVEUR des indices
 *                  → 0 ou plusieurs cibles : clarification ; 1 : on continue
 *                → IA non autorisée : clarification si possible, sinon repli
 *                  prudent — jamais une compréhension inventée.
 *
 * Règles bloquantes : une cible requise non résolue ne devient JAMAIS une
 * recherche à l'échelle du compte ; une compréhension incomplète ne devient
 * JAMAIS « aucun résultat ». Une recherche globale explicite (« Quels
 * documents ai-je ? ») n'exige aucune cible : COMPLETE.
 *
 * Module PUR (testé) : la détection de ce que la question EXIGE. La
 * résolution des cibles reste dans `assistant-targets` (lectures du compte,
 * règle de disponibilité unique `asset-availability`).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { VerebonaIntent } from '../types/intents';
import { demonstratifBien } from './reference-resolver';
import { assetsNamedIn } from './assistant-targets';

export type UnderstandingStatus = 'COMPLETE' | 'PARTIAL' | 'UNKNOWN_INTENT';

export type UnderstandingReason =
  | 'MISSING_TARGET'
  | 'AMBIGUOUS_TARGET'
  | 'UNRESOLVED_REFERENCE'
  | 'UNCONSUMED_MEANING'
  | 'UNKNOWN_INTENT'
  | 'AMBIGUOUS_INTENT';

/** Qui a établi la compréhension finale (trace). */
export type UnderstandingResolver = 'deterministic' | 'thread' | 'understand' | 'clarification' | null;

export interface UnderstandingAssessment {
  status: UnderstandingStatus;
  reasons: UnderstandingReason[];
  /**
   * Le serveur sait EXACTEMENT ce qui manque (cible requise, candidats du
   * compte connus) : clarification directe, sans appel modèle.
   */
  exactGap: boolean;
  /** Ce que la question exige (cible), tel que détecté. */
  requirement: TargetRequirement | null;
}

/**
 * Cible EXIGÉE par le sens de la question :
 *   · `deictic`   — désignation d'un bien précis sans le nommer : « ce bien »,
 *                   « cette voiture », « les documents qui lui sont liés »,
 *                   « ses factures ». Ce qui manque est connu : QUEL bien ;
 *   · `anaphoric` — renvoi relatif au fil : « l'autre », « celui-là ». Seul
 *                   le contexte (fil, puis UNDERSTAND) peut le lever.
 */
export interface TargetRequirement {
  kind: 'deictic' | 'anaphoric';
  target: 'asset';
  detected: string;
}

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

/** « l'autre », « celui-là » : renvoi relatif, jamais résolu sans contexte. */
const ANAPHORE = /(?<![\p{L}])(l'autre|l autre|celui-la|celle-la|ceux-la|celles-la)(?![\p{L}])/u;
/** « qui lui sont liés », « lui sont rattachés », « leur sont associés ». */
const PRONOM_LIEN = /(?<![\p{L}])(?:lui|leur) (?:(?:sont|est|etaient|etait|ont ete|a ete) )?(?:lie|lies|liee|liees|rattache|rattaches|rattachee|rattachees|associe|associes|associee|associees)(?![\p{L}])/u;
/** « qui le concernent », « qui la concerne ». */
const LE_CONCERNE = /(?<![\p{L}])qui (?:le|la) concerne(?:nt)?(?![\p{L}])/u;
/** « ses documents », « sa garantie » : un objet POSSÉDÉ par un bien non nommé. */
const POSSESSIF_OBJET = /(?<![\p{L}])(?:ses|son|sa) (?:documents?|factures?|fichiers?|echeances?|rappels?|contrats?|garanties?|entretiens?|devis|justificatifs?|pieces? justificatives?)(?![\p{L}])/u;

/**
 * Cible exigée par la question (pure). `null` : la question n'exige aucune
 * cible précise — « Quels documents ai-je ? » est une recherche globale
 * VOLONTAIRE, « la maison », « la Polo » sont des désignations explicites
 * (résolues par `assistant-targets`, nom ou catégorie).
 */
export function targetRequirement(message: string): TargetRequirement | null {
  const m = plain(message ?? '');
  const ana = m.match(ANAPHORE);
  if (ana) return { kind: 'anaphoric', target: 'asset', detected: ana[1] };
  const dem = demonstratifBien(m);
  if (dem) return { kind: 'deictic', target: 'asset', detected: dem };
  const autre = m.match(PRONOM_LIEN) ?? m.match(LE_CONCERNE) ?? m.match(POSSESSIF_OBJET);
  if (autre) return { kind: 'deictic', target: 'asset', detected: autre[0] };
  return null;
}

/** Intentions dont la cible exigée doit être résolue avant toute lecture. */
export function intentRequiresResolvedTarget(intent: VerebonaIntent | string, needsClassification: boolean): boolean {
  return needsClassification || intent === 'UNKNOWN' || String(intent).startsWith('ACCOUNT_');
}

/**
 * Évaluation DÉTERMINISTE de la compréhension (pure, testée).
 *
 * `targetResolved` : une cible (bien, équipement, pièce) est connue —
 * clarification précédente, nom dans la question, fil non ambigu, page,
 * catégorie unique. `targetCandidates` : candidats DU COMPTE déjà identifiés
 * pour une cible requise (≥ 2 : ambiguïté connue).
 */
export function assessUnderstanding(p: {
  needsClassification: boolean;
  intent: VerebonaIntent | string;
  message: string;
  targetResolved: boolean;
  targetCandidates?: number;
  unconsumed?: string[];
}): UnderstandingAssessment {
  const requirement = intentRequiresResolvedTarget(p.intent, p.needsClassification) ? targetRequirement(p.message) : null;
  const reasons: UnderstandingReason[] = [];
  if (p.needsClassification) reasons.push('UNKNOWN_INTENT');
  if (requirement && !p.targetResolved) {
    // Un renvoi relatif (« l'autre ») n'est jamais un manque « exact » : même
    // avec deux biens dans le fil, le sens du renvoi reste à comprendre.
    if (requirement.kind === 'anaphoric') reasons.push('UNRESOLVED_REFERENCE');
    else reasons.push((p.targetCandidates ?? 0) >= 2 ? 'AMBIGUOUS_TARGET' : 'MISSING_TARGET');
  }
  if (!p.needsClassification && (p.unconsumed?.length ?? 0) > 0) reasons.push('UNCONSUMED_MEANING');
  const status: UnderstandingStatus = p.needsClassification ? 'UNKNOWN_INTENT' : reasons.length ? 'PARTIAL' : 'COMPLETE';
  // Manque connu EXACTEMENT : intention comprise, cible désignée sans
  // ambiguïté de sens (« ce bien ») — seul le CHOIX du bien manque.
  const exactGap = status === 'PARTIAL' && reasons.every((r) => r === 'MISSING_TARGET' || r === 'AMBIGUOUS_TARGET');
  return { status, reasons, exactGap, requirement };
}

/**
 * Biens candidats issus du FIL (pure, testée), du plus fiable au moins
 * fiable : candidats d'une référence ambiguë, DERNIÈRE liste présentée,
 * message du DERNIER échange qui nomme des biens. Seuls les biens DISPONIBLES (catalogue
 * lu avec la règle unique `asset-availability`) sont rendus.
 */
export function threadAssetCandidates<T extends { id: number; name: string }>(p: {
  ambiguous?: Array<{ type: string; id: number }>;
  presentedLists?: Array<Array<{ type: string; id: number }>>;
  messages?: Array<{ content: string; sensitive?: boolean }>;
  catalog: T[];
}): T[] {
  const parId = new Map(p.catalog.map((a) => [a.id, a]));
  const biens = (l: Array<{ type: string; id: number }>) => [...new Set(l.filter((e) => e.type === 'asset').map((e) => e.id))]
    .map((id) => parId.get(id)).filter((a): a is T => Boolean(a));
  const amb = biens(p.ambiguous ?? []);
  if (amb.length) return amb;
  // Dernière liste présentée seulement, et dernier échange (question +
  // réponse) : un bien cité trois questions plus tôt n'est plus « le fil ».
  const derniere = biens(p.presentedLists?.[0] ?? []);
  if (derniere.length) return derniere;
  for (const msg of [...(p.messages ?? [])].slice(-2).reverse()) {
    if (msg.sensitive) continue;
    const nommes = assetsNamedIn(msg.content ?? '', p.catalog);
    if (nommes.length) return nommes;
  }
  return [];
}
