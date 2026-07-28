/**
 * Machine à états — CDC §4.5.4, critère d'acceptation n°18.
 *
 * « Aucun prompt n'est modifiable sans aperçu, validation distincte et
 *   exécution des tests. »
 *
 * Ces tests sont la preuve formelle de ce critère : ils vérifient qu'AUCUN
 * chemin du graphe ne mène à `ACTIVE` sans passer par les deux validations
 * humaines et par les tests.
 */
import { describe, it, expect } from 'vitest';
import {
  transition, canTransition, allowedEvents, isTerminal, getTransitionTable, InvalidTransition,
} from '../state-machine';
import type { ChangeRequestStatus } from '../types';
import type { TransitionEvent } from '../state-machine';

describe('les neuf statuts du §4.5.4', () => {
  it('sont tous représentés dans la table', () => {
    const expected: ChangeRequestStatus[] = [
      'DRAFT', 'PROPOSED', 'TO_TEST', 'TEST_FAILED', 'READY_FOR_APPROVAL',
      'ACTIVE', 'REJECTED', 'ROLLED_BACK', 'SUPERSEDED',
    ];
    expect(Object.keys(getTransitionTable()).sort()).toEqual([...expected].sort());
  });
});

describe('chemin nominal du §4.5.3', () => {
  it('parcourt instruction → proposition → validation → tests → validation → activation', () => {
    let s: ChangeRequestStatus = 'DRAFT';
    s = transition(s, 'analyze');           expect(s).toBe('PROPOSED');
    s = transition(s, 'approve_proposal');  expect(s).toBe('TO_TEST');
    s = transition(s, 'tests_passed');      expect(s).toBe('READY_FOR_APPROVAL');
    s = transition(s, 'final_approve');     expect(s).toBe('ACTIVE');
  });

  it('permet le retour arrière depuis l\'état actif — critère n°19', () => {
    expect(transition('ACTIVE', 'rollback')).toBe('ROLLED_BACK');
  });
});

describe('PREUVE DU CRITÈRE N°18 — aucun raccourci vers l\'activation', () => {
  const ALL_STATES: ChangeRequestStatus[] = [
    'DRAFT', 'PROPOSED', 'TO_TEST', 'TEST_FAILED', 'READY_FOR_APPROVAL',
    'ACTIVE', 'REJECTED', 'ROLLED_BACK', 'SUPERSEDED',
  ];
  const ALL_EVENTS: TransitionEvent[] = [
    'analyze', 'approve_proposal', 'run_tests', 'tests_passed', 'tests_failed',
    'final_approve', 'activate', 'reject', 'rollback', 'supersede',
  ];

  it('ACTIVE n\'est atteignable que depuis READY_FOR_APPROVAL', () => {
    const entryPoints = ALL_STATES.flatMap((from) =>
      ALL_EVENTS.filter((e) => canTransition(from, e) && transition(from, e) === 'ACTIVE')
        .map((e) => `${from}:${e}`),
    );
    expect(entryPoints).toEqual(['READY_FOR_APPROVAL:final_approve']);
  });

  it('READY_FOR_APPROVAL n\'est atteignable que par la réussite des tests', () => {
    const entryPoints = ALL_STATES.flatMap((from) =>
      ALL_EVENTS.filter((e) => canTransition(from, e) && transition(from, e) === 'READY_FOR_APPROVAL')
        .map((e) => `${from}:${e}`),
    );
    expect(entryPoints).toEqual(['TO_TEST:tests_passed']);
  });

  it('TO_TEST n\'est atteignable que par une validation humaine de la proposition', () => {
    const entryPoints = ALL_STATES.flatMap((from) =>
      ALL_EVENTS.filter((e) => canTransition(from, e) && transition(from, e) === 'TO_TEST')
        .map((e) => `${from}:${e}`),
    );
    expect(entryPoints).toEqual(['PROPOSED:approve_proposal', 'TO_TEST:run_tests']);
  });

  it('une demande dont les tests échouent ne peut pas être activée directement', () => {
    expect(canTransition('TEST_FAILED', 'final_approve')).toBe(false);
    expect(canTransition('TEST_FAILED', 'activate')).toBe(false);
    // Elle doit repasser par une nouvelle proposition.
    expect(transition('TEST_FAILED', 'analyze')).toBe('PROPOSED');
  });

  it('une proposition ne peut pas sauter l\'étape de test', () => {
    expect(canTransition('PROPOSED', 'tests_passed')).toBe(false);
    expect(canTransition('PROPOSED', 'final_approve')).toBe(false);
  });

  it('un brouillon ne peut pas être activé', () => {
    expect(canTransition('DRAFT', 'final_approve')).toBe(false);
    expect(() => transition('DRAFT', 'final_approve')).toThrow(InvalidTransition);
  });
});

describe('états terminaux', () => {
  it.each<ChangeRequestStatus>(['REJECTED', 'ROLLED_BACK', 'SUPERSEDED'])(
    '%s ne permet aucune transition', (s) => {
      expect(isTerminal(s)).toBe(true);
      expect(allowedEvents(s)).toHaveLength(0);
    },
  );

  it('une demande écartée ne peut pas être réactivée', () => {
    expect(() => transition('REJECTED', 'analyze')).toThrow(InvalidTransition);
  });
});

describe('abandon possible à toute étape', () => {
  it.each<ChangeRequestStatus>(['DRAFT', 'PROPOSED', 'TO_TEST', 'TEST_FAILED', 'READY_FOR_APPROVAL'])(
    'une demande à l\'état %s peut être écartée', (s) => {
      expect(transition(s, 'reject')).toBe('REJECTED');
    },
  );
});
