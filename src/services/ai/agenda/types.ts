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
}

export interface AgendaClassificationInput {
  title: string;
  description?: string | null;
  originType: string;
  originFieldKey?: string | null;
}
