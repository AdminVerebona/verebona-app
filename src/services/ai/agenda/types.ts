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
  /**
   * CDC 15 T4-10 : classification détaillée (catégorie éventuellement
   * `unknown`, confiance, origine). `category` ci-dessus reste la valeur
   * affichable ; `requiresQualification` signale une classification à faire
   * confirmer par l'utilisateur.
   */
  classification?: AgendaClassification & { requiresQualification: boolean };
  // ── Sémantique T4 recopiée du candidat (CDC 15 T4-04, T4-07, T4-08) ──────
  // Renseignée seulement sous AI_T4_EFFECTS=enabled, depuis les candidats du
  // registre (C) : B en tire la clé fonctionnelle et les liens source.
  /** Nature du registre : fait passé ou échéance à venir. */
  nature?: 'HISTORICAL' | 'DEADLINE' | null;
  /** Type métier de l'EVENT_CATALOG. */
  businessType?: string | null;
  /** Cible de l'événement (id null si non déterminée). */
  target?: { type: 'ASSET' | 'EQUIPMENT' | 'ROOM'; id: number | null } | null;
  /**
   * Index d'occurrence de la clé fonctionnelle : `single` (fait unique d'un
   * champ, une date corrigée met à jour) ou la date de l'occurrence.
   */
  occurrenceIndex?: string | null;
  /** D'où vient la date : le champ ou la date du document. */
  dateSource?: 'FIELD' | 'DOCUMENT_DATE' | null;
  /** Documents de l'événement (liens source ↔ agenda). */
  sources?: Array<{ fileId: number; role: 'SOURCE'; evidenceId?: number | null }>;
  /** Type documentaire de la source et son autorité (T4-04). */
  documentType?: string | null;
  authority?: 'AUTHORITATIVE' | 'SUPPORTING' | 'WEAK' | null;
  mayCreateAgenda?: boolean | null;
  /** Récurrence énoncée par la source (spécification du candidat). */
  recurrence?: import('./rules/recurrence').RecurrenceSpec | null;
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
  /** Type métier (EVENT_CATALOG), s'il est connu — preuves de réalisation (T4-13). */
  businessType?: string | null;
  /** Récurrence de la série, si connue — fenêtre d'occurrence (T4-14). */
  recurrence?: { frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval: number } | null;
}

export interface AgendaClassificationInput {
  title: string;
  description?: string | null;
  originType: string;
  originFieldKey?: string | null;
  /** Type métier de l'EVENT_CATALOG, s'il est connu (CDC 15 T4-02). */
  businessType?: string | null;
  /** Nature HISTORICAL / DEADLINE, si connue (CDC 15 T4-02, D-14). */
  nature?: 'HISTORICAL' | 'DEADLINE' | null;
}

/**
 * Classification T4 avec abstention (CDC 15 T4-10, §26 C5) : `unknown` quand
 * la nature reste réellement ambiguë. Jamais persisté tel quel : voir
 * `prudentCategory`.
 */
export type ClassificationCategory = HomeCategory | 'unknown';
export type ClassificationConfidence = 'certain' | 'probable' | 'ambiguous';

export interface AgendaClassification {
  category: ClassificationCategory;
  confidence: ClassificationConfidence;
  /** registry | business_rule | pattern | model | fallback. */
  source: 'registry' | 'business_rule' | 'pattern' | 'model' | 'fallback';
  ruleCode?: string;
  /** Type métier retenu (catalogue fermé), si connu. */
  businessType?: string | null;
  reason?: string;
}
