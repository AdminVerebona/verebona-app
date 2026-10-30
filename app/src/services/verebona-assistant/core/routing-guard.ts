/**
 * Garde-fou de ROUTAGE T2 et diagnostic PAR TOUR — lot 101A (ticket
 * « Continuité conversationnelle et série d'un équipement », points B et I).
 * Module PUR, testé sans base.
 *
 * B — Une intention inconnue des règles (UNKNOWN) ne déclenche plus
 * automatiquement une recherche plein texte du compte quand la demande :
 *   · dépend du contexte conversationnel (« Et la série ? », ellipse, renvoi) ;
 *   · porte sur une PROPRIÉTÉ d'un objet sans cible métier fiable.
 * La compréhension T2 (UNDERSTAND) et la résolution serveur passent alors
 * AVANT le retrieval métier. Le chemin déterministe reste disponible quand la
 * cible est sûre, la propriété normalisée et les données bornées à la cible.
 * Une recherche par mots-clés sans renvoi ni propriété (« facture Leroy »)
 * garde la cascade gratuite d'abord (coût, lot 32).
 *
 * I — Le diagnostic d'un tour rassemble ce qu'il faut pour comprendre une
 * réponse sans autre investigation (contexte, objets actifs, référence,
 * cibles, intention, propriété, décision de routage, périmètre, candidats,
 * réponse et faits utilisés) — codes et identifiants seulement, aucun
 * contenu ; les anomalies sont nommées (`ELLIPTIC_CONTEXT_UNRESOLVED`…).
 */

export type T2RoutingDecision =
  /** Intention reconnue par les règles, sans dépendance au contexte : la cascade suit son cours. */
  | 'DETERMINISTIC'
  /** Cible sûre + propriété normalisée : lecture déterministe BORNÉE à la cible. */
  | 'DETERMINISTIC_BOUNDED'
  /** Recherche par mots-clés sans renvoi ni propriété : niveaux gratuits d'abord (lot 32). */
  | 'FREE_LEVELS_FIRST'
  /** Compréhension / résolution T2 avant tout retrieval métier. */
  | 'UNDERSTAND_FIRST';

export type T2RoutingReason =
  | 'INTENT_KNOWN' | 'TARGET_AND_PROPERTY' | 'UNKNOWN_KEYWORD_SEARCH'
  | 'UNKNOWN_INTENT' | 'CONTEXT_DEPENDENT' | 'TARGET_UNRESOLVED' | 'PROPERTY_NOT_NORMALIZED';

export interface T2RoutingInput {
  /** Aucune règle n'a tranché et aucune compréhension n'a encore eu lieu. */
  intentUnknown: boolean;
  /** Ellipse, renvoi résolu par le fil, ou question courte posée dans un fil. */
  contextual: boolean;
  /** Une cible métier (objet) est résolue de façon fiable. */
  targetResolved: boolean;
  /** Au moins une propriété du registre est reconnue. */
  propertyNormalized: boolean;
  /** La question porte sur une propriété (normalisée ou non : « Et son prix ? »). */
  propertyQuestion: boolean;
  /** Ellipse sur une propriété (« Et la série ? », « Et son prix ? »). */
  ellipticalProperty?: boolean;
}

export function decideT2Routing(p: T2RoutingInput): { decision: T2RoutingDecision; reasons: T2RoutingReason[] } {
  if (p.targetResolved && p.propertyNormalized) return { decision: 'DETERMINISTIC_BOUNDED', reasons: ['TARGET_AND_PROPERTY'] };
  // Intention reconnue par les règles : la cascade existante (et l'exigence de
  // cible du lot 32) s'applique — sauf une question de PROPRIÉTÉ elliptique
  // sans aucune cible (« Et le modèle ? » reconnu, mais sur quoi ?).
  // Une ellipse de propriété NON normalisée (« Et son prix ? ») n'est jamais
  // déterministe, même si une règle a reconnu une intention voisine.
  if (!p.intentUnknown && !(p.ellipticalProperty && !p.propertyNormalized)
      && (p.targetResolved || !p.contextual || !p.propertyQuestion)) return { decision: 'DETERMINISTIC', reasons: ['INTENT_KNOWN'] };
  if (p.intentUnknown && !p.contextual && !p.propertyQuestion) return { decision: 'FREE_LEVELS_FIRST', reasons: ['UNKNOWN_KEYWORD_SEARCH'] };
  const reasons: T2RoutingReason[] = [];
  if (p.intentUnknown) reasons.push('UNKNOWN_INTENT');
  if (p.contextual) reasons.push('CONTEXT_DEPENDENT');
  if (!p.targetResolved) reasons.push('TARGET_UNRESOLVED');
  if (!p.propertyNormalized) reasons.push('PROPERTY_NOT_NORMALIZED');
  return { decision: 'UNDERSTAND_FIRST', reasons };
}

/** Question courte (≤ 4 mots) : dans un fil, elle dépend presque toujours du contexte. */
export function isShortFollowUp(message: string): boolean {
  return String(message ?? '').replace(/[?!.…,;:]+/g, ' ').trim().split(/\s+/).filter(Boolean).length <= 4;
}

// ── Diagnostic par tour (I) ────────────────────────────────────────────────

export type T2TurnAnomaly =
  /** Contexte présent, requête elliptique, aucune cible résolue. */
  | 'ELLIPTIC_CONTEXT_UNRESOLVED'
  /** Recherche à l'échelle du compte alors qu'un objet actif existait dans le fil. */
  | 'ACCOUNT_SEARCH_WITH_ACTIVE_OBJECT'
  /** La cible du tour n'est pas l'objet actif d'avant le tour, sans désignation explicite. */
  | 'ACTIVE_OBJECT_SWITCHED';

export interface T2TurnDiagnostic {
  version: 1;
  contextMessages: number;
  /** Objets actifs AVANT le tour : dernière désignation et dernière liste présentée. */
  activeObjectsBefore: Array<{ type: string; id: number; via: 'lastSelected' | 'presented' }>;
  /** Renvoi / ellipse détecté et sa résolution. */
  reference: { detected: string | null; outcome: string; method: string | null; entity: { type: string; id: number } | null } | null;
  elliptical: boolean;
  resolvedTargets: Array<{ type: string; id: number; origin: string }>;
  intent: string;
  /** Propriétés normalisées demandées (clés du registre). */
  requestedProperty: string[];
  routing: { decision: T2RoutingDecision; reasons: T2RoutingReason[] } | null;
  understandCalled: boolean;
  strategy: string;
  retrievalScope: { kind: string; objectType: string | null; objectId: number | null; assetId: number | null; reason: string } | null;
  candidates: Array<{ factId: number; fileId: number; sourceObject: { type: string; id: number | null } | null; sourceProperty: string[]; score: number; decision: string; reason: string }>;
  revalidations: Array<{ factId: number; status: string }>;
  answer: { supportLevel: string | null; clarification: boolean; sourceCount: number; claimKeys: string[] };
  /** Faits effectivement utilisés : sources citées par les affirmations. */
  factsUsed: string[];
  anomalies: T2TurnAnomaly[];
}

/** Anomalies d'un tour (pure, testée). */
export function turnAnomalies(d: Pick<T2TurnDiagnostic, 'contextMessages' | 'elliptical' | 'resolvedTargets' | 'activeObjectsBefore' | 'retrievalScope' | 'answer' | 'reference'>): T2TurnAnomaly[] {
  const out: T2TurnAnomaly[] = [];
  if (d.contextMessages > 0 && d.elliptical && d.resolvedTargets.length === 0 && !d.answer.clarification) out.push('ELLIPTIC_CONTEXT_UNRESOLVED');
  if (d.retrievalScope?.kind === 'ACCOUNT' && d.activeObjectsBefore.some((o) => o.via === 'lastSelected')) out.push('ACCOUNT_SEARCH_WITH_ACTIVE_OBJECT');
  const actif = d.activeObjectsBefore.find((o) => o.via === 'lastSelected');
  const cible = d.resolvedTargets[0];
  if (d.elliptical && actif && cible && (actif.type !== cible.type || actif.id !== cible.id)
      && !d.activeObjectsBefore.some((o) => o.via === 'presented' && o.type === cible.type && o.id === cible.id)) {
    out.push('ACTIVE_OBJECT_SWITCHED');
  }
  return out;
}
