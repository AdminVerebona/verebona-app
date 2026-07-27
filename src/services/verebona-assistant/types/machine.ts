/**
 * Machine à états conversationnelle — CDC §9.6 / §9.7.
 *
 * Invariants (§9.7) appliqués par `core/conversation-machine.ts` :
 *  - une seule demande active par conversation ;
 *  - une réponse ne passe READY qu'après VALIDATING ;
 *  - GENERATING n'est accessible que si offre + budget autorisent Gemini ;
 *  - aucune action UI exécutée pendant ROUTING/RETRIEVING/GENERATING ;
 *  - ≤ 2 clarifications successives.
 */

export const MACHINE_STATES = [
  'IDLE',
  'SUBMITTING',
  'ROUTING',
  'CLARIFYING',
  'RETRIEVING',
  'GENERATING',
  'REPAIRING',
  'VALIDATING',
  'READY',
  // États complémentaires
  'CANCELLED',
  'EXPIRED',
  'ERROR_RECOVERABLE',
  'ERROR_FINAL',
] as const;

export type MachineState = (typeof MACHINE_STATES)[number];

/** Transitions autorisées (§9.6). Toute transition hors table est refusée. */
export const ALLOWED_TRANSITIONS: Record<MachineState, ReadonlyArray<MachineState>> = {
  IDLE: ['SUBMITTING', 'CANCELLED'],
  SUBMITTING: ['ROUTING', 'ERROR_RECOVERABLE', 'CANCELLED'],
  ROUTING: ['CLARIFYING', 'RETRIEVING', 'VALIDATING', 'CANCELLED', 'ERROR_RECOVERABLE'],
  CLARIFYING: ['ROUTING', 'EXPIRED', 'CANCELLED'],
  RETRIEVING: ['CLARIFYING', 'VALIDATING', 'GENERATING', 'ERROR_RECOVERABLE', 'CANCELLED'],
  GENERATING: ['VALIDATING', 'REPAIRING', 'ERROR_RECOVERABLE', 'CANCELLED'],
  REPAIRING: ['VALIDATING', 'ERROR_RECOVERABLE', 'CANCELLED'],
  VALIDATING: ['READY', 'ERROR_FINAL', 'CANCELLED'],
  READY: ['ROUTING'],
  CANCELLED: [],
  EXPIRED: ['ROUTING'],
  ERROR_RECOVERABLE: ['ROUTING', 'READY'],
  ERROR_FINAL: [],
};

export function canTransition(from: MachineState, to: MachineState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** État conservé pour une clarification — CDC §9.8. */
export interface ClarificationState {
  clarificationId: string;
  originalMessageId: string;
  originalIntent: import('./intents').VerebonaIntent;
  candidateType: 'asset' | 'document' | 'agenda' | 'supplier';
  candidates: Array<{ id: string; label: string; secondaryLabel?: string }>;
  question: string;
  expiresAt: string; // ISO — 30 min (§20.4)
  attemptCount: number; // ≤ 2 (§20.3)
}

/** Références conversationnelles internes — CDC §16.4. */
export interface ConversationRefs {
  lastPresentedEntities: Array<{ position: number; type: string; id: string | number }>;
  currentAssetId?: number | null;
  pendingClarification?: string | null;
}
