/**
 * Machine à états des demandes de modification — CDC §4.5.4.
 *
 * FONCTION PURE. Les transitions sont une table, pas une suite de conditions
 * réparties dans les routes d'administration : c'est ce qui permet de garantir,
 * par le test, qu'aucun chemin ne mène à `ACTIVE` sans passer par la validation
 * humaine ET par les tests.
 *
 * Critère d'acceptation n°18 : « aucun prompt n'est modifiable sans aperçu,
 * validation distincte et exécution des tests ».
 */
import type { ChangeRequestStatus } from './types';

export type TransitionEvent =
  | 'analyze'          // le modèle produit une proposition
  | 'approve_proposal' // un humain valide la proposition (après diff)
  | 'run_tests'
  | 'tests_passed'
  | 'tests_failed'
  | 'final_approve'    // seconde validation humaine, distincte de la première
  | 'activate'
  | 'reject'
  | 'rollback'
  | 'supersede';

/**
 * Table des transitions autorisées. Toute transition absente est refusée.
 *
 * Deux propriétés structurantes, vérifiées par les tests :
 *   · `ACTIVE` n'est atteignable que depuis `READY_FOR_APPROVAL` ;
 *   · `READY_FOR_APPROVAL` n'est atteignable que depuis `TO_TEST` via
 *     `tests_passed`, donc jamais sans exécution des contrôles.
 */
const TRANSITIONS: Record<ChangeRequestStatus, Partial<Record<TransitionEvent, ChangeRequestStatus>>> = {
  DRAFT: {
    analyze: 'PROPOSED',
    reject: 'REJECTED',
  },
  PROPOSED: {
    // Première validation humaine : elle porte sur le DIFF, pas sur les tests.
    approve_proposal: 'TO_TEST',
    reject: 'REJECTED',
  },
  TO_TEST: {
    run_tests: 'TO_TEST',
    tests_passed: 'READY_FOR_APPROVAL',
    tests_failed: 'TEST_FAILED',
    reject: 'REJECTED',
  },
  TEST_FAILED: {
    // Une correction repasse par la proposition, jamais directement en test.
    analyze: 'PROPOSED',
    reject: 'REJECTED',
  },
  READY_FOR_APPROVAL: {
    // Seconde validation humaine, distincte de la première (§4.5.3).
    final_approve: 'ACTIVE',
    reject: 'REJECTED',
  },
  ACTIVE: {
    rollback: 'ROLLED_BACK',
    supersede: 'SUPERSEDED',
  },
  REJECTED: {},
  ROLLED_BACK: {},
  SUPERSEDED: {},
};

export class InvalidTransition extends Error {
  constructor(from: ChangeRequestStatus, event: TransitionEvent) {
    super(`[gouvernance] Transition « ${event} » interdite depuis l'état « ${from} ».`);
    this.name = 'InvalidTransition';
  }
}

export function canTransition(from: ChangeRequestStatus, event: TransitionEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function transition(from: ChangeRequestStatus, event: TransitionEvent): ChangeRequestStatus {
  const next = TRANSITIONS[from][event];
  if (!next) throw new InvalidTransition(from, event);
  return next;
}

export function allowedEvents(from: ChangeRequestStatus): TransitionEvent[] {
  return Object.keys(TRANSITIONS[from]) as TransitionEvent[];
}

/** États terminaux : aucune transition n'en sort. */
export function isTerminal(status: ChangeRequestStatus): boolean {
  return allowedEvents(status).length === 0;
}

export function getTransitionTable(): typeof TRANSITIONS {
  return TRANSITIONS;
}
