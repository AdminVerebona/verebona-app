/**
 * Contrats de l'intelligence agenda — USAGE IA n°4, CDC §4.4.
 */
import type { EvidenceConfidence } from '../evidence/evidence.types';

/** Catégorie d'affichage sur la page d'accueil. */
export type HomeCategory = 'action' | 'information';

export type AgendaDecisionAction =
  /** Aucun événement équivalent : création. */
  | 'create'
  /** Événement existant enrichi ou corrigé. */
  | 'update'
  /** Doublon certain : rien à faire (§4.4.4). */
  | 'skip_duplicate'
  /** Contradiction avec un événement manuel : arbitrage utilisateur. */
  | 'create_conflict'
  /**
   * Une source confirme une occurrence PRÉVISIONNELLE (correspondance
   * certaine) : la même occurrence évolue vers CONFIRMED — pas de seconde
   * ligne.
   */
  | 'confirm_forecast'
  /**
   * Prévision automatique devenue sans objet (fin de récurrence explicite) :
   * annulée — seulement si jamais modifiée par l'utilisateur.
   */
  | 'retire_forecast'
  /**
   * Rapprochement PROBABLE avec un événement existant, quel qu'il soit
   * (manuel, automatique, issu d'un document) : arbitrage « même échéance /
   * échéances différentes ». Aucune fusion, aucune modification avant choix.
   */
  | 'arbitrate_duplicate'
  /** Preuve insuffisante pour créer sans validation. */
  | 'propose';

export interface AgendaDecision {
  action: AgendaDecisionAction;
  title: string;
  date: string;
  category: HomeCategory;
  confidence: EvidenceConfidence;
  reasonCode: string;
  /** Identifiant de l'événement existant concerné, le cas échéant. */
  existingItemId?: number;
  /** true si la décision a été prise par règle, sans appel modèle. */
  deterministic: boolean;
  sourceFileId?: number;
  originFieldKey?: string;
  /**
   * Nature et provenance de l'occurrence (récurrences) : une date calculée
   * d'une récurrence est PRÉVISIONNELLE et identifiée comme telle.
   */
  occurrence?: {
    nature: 'FORECAST' | 'CONFIRMED';
    dateSource: 'EXPLICIT_DATE' | 'PREDICTED_FROM_RECURRENCE';
    seriesKey: string;
    recurrence?: {
      mode: 'EXPLICIT_SOURCE' | 'HISTORICAL_PATTERN';
      frequency: string;
      interval: number;
      startDate?: string | null;
      endDate?: string | null;
      occurrenceCount?: number | null;
      rule: string;
      excerpt?: string | null;
      sourceFileId?: number | null;
      /** Occurrence connue qui a servi de point de départ au calcul. */
      referenceDate: string;
      /** Dates historiques ayant établi la récurrence (HISTORICAL_PATTERN). */
      history?: string[];
      computedAt: string;
    };
  };
  /** Rapprochement incertain : ce qui a fait penser au même événement. */
  duplicate?: {
    similarity: number;
    dayGap: number;
    reason: string;
    existingTitle: string;
    existingDate: string;
    existingManual: boolean;
  };
}

/** Événement déjà présent dans l'agenda du compte. */
export interface ExistingAgendaItem {
  id: number;
  title: string;
  date: string;
  category: HomeCategory | null;
  status: string | null;
  /** true si créé ou modifié par un utilisateur (§4.4.4). */
  manual: boolean;
  originFieldKey: string | null;
  /** FORECAST | CONFIRMED (0158) ; absent = CONFIRMED. */
  nature?: 'FORECAST' | 'CONFIRMED';
  seriesKey?: string | null;
}

export interface AgendaClassificationInput {
  title: string;
  description?: string | null;
  originType: string;
  originFieldKey?: string | null;
}
