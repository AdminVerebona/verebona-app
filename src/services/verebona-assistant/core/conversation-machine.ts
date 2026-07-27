/**
 * Machine à états conversationnelle — CDC §9.6 / §9.7.
 *
 * Objet léger qui garantit les invariants de transition. La persistance est assurée
 * par `conversation.service.ts` (colonne `machine_state`). Cette classe ne fait AUCUN
 * appel réseau : elle contrôle uniquement la légalité des transitions et les gardes.
 */
import { canTransition, type MachineState } from '../types/machine';

export interface MachineGuards {
  /** L'offre + le budget autorisent-ils un appel Gemini ? (garde GENERATING — §9.7) */
  aiAllowed: boolean;
  /** Nombre de clarifications déjà posées dans cette demande (≤ 2 — §20.3). */
  clarificationCount: number;
}

export class ConversationMachine {
  private _state: MachineState;

  constructor(initial: MachineState = 'IDLE') {
    this._state = initial;
  }

  get state(): MachineState {
    return this._state;
  }

  /**
   * Tente une transition. Renvoie true si acceptée, false sinon.
   * Applique les gardes spécifiques (§9.7) en plus de la table de transitions.
   */
  transition(to: MachineState, guards?: MachineGuards): boolean {
    if (!canTransition(this._state, to)) return false;

    // Garde : GENERATING interdit sans droit IA (§9.7).
    if (to === 'GENERATING' && guards && !guards.aiAllowed) return false;

    // Garde : pas plus de 2 clarifications successives (§20.3).
    if (to === 'CLARIFYING' && guards && guards.clarificationCount >= 2) return false;

    this._state = to;
    return true;
  }

  /** Force un état d'erreur terminal ou récupérable (utilisé par l'orchestrateur). */
  fail(final: boolean): void {
    this._state = final ? 'ERROR_FINAL' : 'ERROR_RECOVERABLE';
  }

  isTerminal(): boolean {
    return ['READY', 'CANCELLED', 'EXPIRED', 'ERROR_FINAL'].includes(this._state);
  }
}
