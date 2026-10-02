/**
 * Verdict de l'inventaire d'exécution — CDC §12, critères n°1, 2, 3 et 24.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * POURQUOI LE VERDICT NE PORTE PAS SUR `use_case_code`
 *
 * `ai-usage-tracker.ts` estampille les écritures des moteurs HISTORIQUES via
 * la correspondance de la migration 0110 (`ai_legacy_usage_mapping`). Elles remontent donc dans `ai_usage_event` sous les
 * cinq codes cibles. Un `SELECT DISTINCT use_case_code` renverrait cinq usages
 * et conclurait à la conformité pendant que tout le chemin historique
 * s'exécute — exactement le « regroupement artificiel » que le critère n°24
 * interdit.
 *
 * Le discriminant est l'OPÉRATION. La gateway écrit un `operation_type` pris
 * dans le référentiel, catalogue fermé. Deux formes prouvent qu'un moteur
 * historique a tourné :
 *   · une valeur hors catalogue (libellés libres des anciennes écritures,
 *     `operation_complete`, `document_analysis`…, encore présents dans
 *     l'historique) ;
 *   · une opération de relais `legacy_*` : depuis GEN-004, les modules
 *     historiques passent par la passerelle sous ces opérations, et depuis
 *     GEN-005 le tracker n'écrit plus sa ligne « operation_complete ». Sans
 *     cette règle, un moteur historique en service serait lu « conforme ».
 *
 * Cette règle est isolée du script pour être testable : c'est elle qui autorise
 * ou refuse la bascule réglementaire, pas la mise en forme du rapport.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AI_OPERATIONS } from './operations';

export type InventoryVerdict = 'conforme' | 'non_conforme' | 'indetermine';

/** Une ligne d'agrégat lue dans `ai_usage_event`. */
export interface ObservedOperation {
  operationType: string;
  useCaseCode: string | null;
  events: number;
  lastSeen: string;
}

export interface InventoryConclusion {
  verdict: InventoryVerdict;
  reason: string;
  totalEvents: number;
  /** Opérations absentes du référentiel : la preuve recherchée. */
  foreignOperations: string[];
  /** Usages effectivement observés, parmi les cinq déclarés. */
  useCasesSeen: string[];
}

/** Opérations que le code embarqué sait exécuter. */
export function knownOperationCodes(): Set<string> {
  return new Set(Object.keys(AI_OPERATIONS));
}

/** Opération de relais d'un module historique (`legacy_*`, GEN-004). */
export function isLegacyRelayOperation(code: string): boolean {
  return code.startsWith('legacy_');
}

export function concludeExecutionInventory(rows: ObservedOperation[]): InventoryConclusion {
  const connues = knownOperationCodes();

  const totalEvents = rows.reduce((s, r) => s + r.events, 0);

  const historique = (code: string) => !connues.has(code) || isLegacyRelayOperation(code);

  const foreignOperations = [...new Set(
    rows.filter((r) => historique(r.operationType)).map((r) => r.operationType),
  )].sort();

  const useCasesSeen = [...new Set(
    rows
      .filter((r) => !historique(r.operationType) && r.useCaseCode)
      .map((r) => r.useCaseCode as string),
  )].sort();

  // ── Fenêtre vide : on ne conclut pas ────────────────────────────────────
  // L'absence de preuve n'est pas une preuve d'absence. Un rapport vide ne
  // doit jamais pouvoir être présenté comme un rapport conforme — c'est lui
  // qui autoriserait la bascule de onze à cinq usages.
  if (totalEvents === 0) {
    return {
      verdict: 'indetermine',
      reason:
        "aucun appel enregistré sur la fenêtre — l'inventaire ne conclut pas. " +
        'Élargissez la fenêtre ou faites produire du trafic avant de présenter ce rapport.',
      totalEvents, foreignOperations, useCasesSeen,
    };
  }

  if (foreignOperations.length > 0) {
    return {
      verdict: 'non_conforme',
      reason:
        `${foreignOperations.length} opération(s) hors référentiel observée(s) : ` +
        "un moteur historique s'est exécuté sur la fenêtre (critères n°2 et 3).",
      totalEvents, foreignOperations, useCasesSeen,
    };
  }

  return {
    verdict: 'conforme',
    reason:
      'toutes les opérations observées appartiennent au référentiel : aucun moteur ' +
      "historique ne s'est exécuté sur la fenêtre.",
    totalEvents, foreignOperations, useCasesSeen,
  };
}
