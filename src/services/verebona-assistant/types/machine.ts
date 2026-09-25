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

/** Candidat proposé : identifiant technique contrôlé par le serveur, jamais par le modèle. */
export interface ClarificationCandidate {
  /** Référence d'entité (« asset_42 »), c'est le `choiceId` présenté au client. */
  id: string;
  /** Identifiant en base de l'entité, re-vérifié avant toute reprise. */
  entityId?: number;
  label: string;
  secondaryLabel?: string;
}

export type ClarificationStatus = 'PENDING' | 'RESOLVED' | 'EXPIRED' | 'EXHAUSTED' | 'ABANDONED';

/**
 * État conservé pour une clarification — CDC §9.8, §20.
 *
 * Contient TOUT ce qu'il faut pour reprendre la demande initiale sans la
 * reconstruire par concaténation : message et intention d'origine, contexte
 * déjà résolu, nature de l'ambiguïté, candidats et compteurs.
 */
export interface ClarificationState {
  clarificationId: string;
  /** Fil, compte et utilisateur propriétaires — contrôlés à la reprise. */
  conversationId?: number;
  accountId?: number;
  userId?: number;
  originalMessageId: string;
  /** Demande utilisateur initiale, rejouée telle quelle à la reprise. */
  originalMessage?: string;
  originalIntent: import('./intents').VerebonaIntent;
  /** Paramètres déjà identifiés (bien de la page, année…). */
  resolvedContext?: { pageAssetId?: number | null; assetId?: number | null };
  /** Ce qui est ambigu : le champ que le choix viendra fixer. */
  ambiguity?: { kind: 'asset'; field: 'assetId'; reason: string };
  candidateType: 'asset' | 'document' | 'agenda' | 'supplier';
  candidates: ClarificationCandidate[];
  question: string;
  createdAt?: string;
  expiresAt: string; // ISO — 30 min (§20.4)
  /** Tentatives infructueuses (choix invalide, réponse non reconnue…) ; ≤ 2 (§20.3). */
  attemptCount: number;
  /** Rang de la clarification dans la même demande (ambiguïtés successives) ; ≤ 2. */
  chainDepth?: number;
  status?: ClarificationStatus;
}

/** Références conversationnelles internes — CDC §16.4. */
export interface ConversationRefs {
  lastPresentedEntities: Array<{ position: number; type: string; id: string | number }>;
  currentAssetId?: number | null;
  pendingClarification?: string | null;
}
