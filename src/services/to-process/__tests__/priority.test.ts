/**
 * Priorités, plafond et ordres de liste — CDC V2.0 §9, §8.2.
 *
 * Les critères PRI-01 à PRI-04 sont vérifiés ici. PRI-03 — « la résolution
 * d'une action ne remplit pas automatiquement la place libérée » — est la
 * règle la plus facile à casser par une bonne intention : elle se teste par
 * ce que le module ne fait PAS.
 */
import { describe, it, expect } from 'vitest';
import * as priorityModule from '@/services/to-process/priority';
import {
  DO_FIRST_CAP,
  admitToDoFirst,
  compareActionMode,
  comparePriorityMode,
  resolvePriority,
  sortActions,
  tiebreakScore,
  type PriorityCandidate,
} from '@/services/to-process/priority';
import {
  PROCESSING_RULES,
  allowsCompletion,
  checkRulesCatalog,
  findRule,
  priorityForRule,
} from '@/services/to-process/rules-catalog';
import type { ActionKind, ActionPriority } from '@/services/to-process/action-model';

const NOW = new Date('2026-09-14T10:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const candidate = (
  ruleCode: string,
  overrides: Partial<PriorityCandidate> = {},
): PriorityCandidate => ({
  ruleCode,
  priority: 'DO_FIRST',
  activeSince: NOW,
  ...overrides,
});

describe('catalogue de règles (§10)', () => {
  it('ne présente aucune anomalie', () => {
    expect(checkRulesCatalog()).toEqual([]);
  });

  it('DOC-TYP-02 / DOC-TYP-03 — le Type est « Peut attendre » dans les deux cas', () => {
    const rule = findRule('DOCUMENT', 'documentTypeCode')!;
    expect(priorityForRule(rule, 'ARBITRATE')).toBe('CAN_WAIT');
    expect(priorityForRule(rule, 'COMPLETE')).toBe('CAN_WAIT');
  });

  it('LINK-ELT-03 — un rattachement secondaire absent ne crée aucune action', () => {
    expect(allowsCompletion('DOCUMENT', 'elementId')).toBe(false);
  });

  it('LINK-ASSET-03 — un bien non rattaché en crée toujours une', () => {
    expect(allowsCompletion('DOCUMENT', 'assetIds')).toBe(true);
  });

  it('§10.6 — allow_not_applicable est faux pour la Rubrique et le bien', () => {
    expect(findRule('DOCUMENT', 'rubricCode')!.allowNotApplicable).toBe(false);
    expect(findRule('DOCUMENT', 'assetIds')!.allowNotApplicable).toBe(false);
    expect(findRule('DOCUMENT', 'documentTypeCode')!.allowNotApplicable).toBe(false);
  });

  it('§9.2 — la priorité dépend de la règle, pas de la nature d’action', () => {
    const byKind = new Set<ActionPriority>();
    for (const rule of PROCESSING_RULES) {
      byKind.add(rule.arbitratePriority);
    }
    // Plusieurs priorités différentes pour une même nature « À arbitrer ».
    expect(byKind.size).toBeGreaterThan(1);
  });
});

describe('plafond de dix (§9.3)', () => {
  const full = Array.from({ length: DO_FIRST_CAP }, (_, i) =>
    candidate('DOC-RUB', { id: i + 1, activeSince: days(-i) }),
  );

  it('PRI-01 — admet tant que le plafond n’est pas atteint', () => {
    const result = admitToDoFirst(candidate('DATA-AGENDA-DATE'), full.slice(0, 9), NOW);
    expect(result.admitted).toBe(true);
    expect(result.demoted).toBeNull();
  });

  it('PRI-02 — une action plus importante déplace la moins importante', () => {
    // DATA-AGENDA-DATE porte un impact de 85, DOC-RUB de 70.
    const result = admitToDoFirst(candidate('DATA-AGENDA-DATE'), full, NOW);
    expect(result.admitted).toBe(true);
    expect(result.demoted).not.toBeNull();
    expect(result.demoted!.ruleCode).toBe('DOC-RUB');
  });

  it('refuse une action moins importante quand le plafond est atteint', () => {
    const strong = Array.from({ length: DO_FIRST_CAP }, (_, i) =>
      candidate('DATA-AGENDA-DATE', { id: i + 1 }),
    );
    const result = admitToDoFirst(candidate('DOC-TYP'), strong, NOW);
    expect(result.admitted).toBe(false);
    expect(result.demoted).toBeNull();
  });

  it('PRI-03 — aucune fonction ne promeut une action après une résolution', () => {
    // La règle se vérifie par l'absence : le module n'expose rien qui
    // recalculerait les priorités d'un compte. Toute fonction ajoutée ici
    // devra justifier qu'elle ne remplit pas la place libérée.
    const api = Object.keys(priorityModule);
    expect(api).not.toContain('promoteNextAction');
    expect(api).not.toContain('recomputeAccountPriorities');
  });
});

describe('départage interne (§9.4)', () => {
  it('classe d’abord par impact métier', () => {
    const agenda = tiebreakScore(candidate('DATA-AGENDA-DATE'), NOW);
    const type = tiebreakScore(candidate('DOC-TYP'), NOW);
    expect(agenda).toBeGreaterThan(type);
  });

  it('puis par proximité d’échéance', () => {
    const soon = tiebreakScore(candidate('DOC-RUB', { dueDate: days(3) }), NOW);
    const later = tiebreakScore(candidate('DOC-RUB', { dueDate: days(200) }), NOW);
    expect(soon).toBeGreaterThan(later);
  });

  it('puis par ancienneté', () => {
    const old = tiebreakScore(candidate('DOC-RUB', { activeSince: days(-100) }), NOW);
    const fresh = tiebreakScore(candidate('DOC-RUB', { activeSince: NOW }), NOW);
    expect(old).toBeGreaterThan(fresh);
  });
});

describe('promotion temporelle (§9.2)', () => {
  it('promeut une échéance dans la fenêtre de la règle', () => {
    const { priority, promotedByDueDate } = resolvePriority(
      'DATA-CONTRACT-END',
      'DO_NEXT',
      days(10),
      NOW,
    );
    expect(priority).toBe('DO_FIRST');
    expect(promotedByDueDate).toBe(true);
  });

  it('laisse la priorité de base hors de la fenêtre', () => {
    const { priority } = resolvePriority('DATA-CONTRACT-END', 'DO_NEXT', days(120), NOW);
    expect(priority).toBe('DO_NEXT');
  });

  it('ne promeut jamais une règle sans seuil temporel', () => {
    const { priority } = resolvePriority('DOC-TYP', 'CAN_WAIT', days(1), NOW);
    expect(priority).toBe('CAN_WAIT');
  });
});

describe('ordres de liste (§9.5)', () => {
  const action = (
    priority: ActionPriority,
    actionKind: ActionKind,
    ageDays: number,
  ) => ({ priority, actionKind, activeSince: days(-ageDays) });

  it('« Par priorité » : priorité puis ancienneté', () => {
    const sorted = sortActions(
      [
        action('CAN_WAIT', 'ARBITRATE', 10),
        action('DO_FIRST', 'COMPLETE', 1),
        action('DO_NEXT', 'ARBITRATE', 5),
      ],
      'BY_PRIORITY',
    );
    expect(sorted.map((a) => a.priority)).toEqual(['DO_FIRST', 'DO_NEXT', 'CAN_WAIT']);
  });

  it('« Par action » : À arbitrer avant À compléter', () => {
    const sorted = sortActions(
      [
        action('DO_FIRST', 'COMPLETE', 1),
        action('CAN_WAIT', 'ARBITRATE', 1),
      ],
      'BY_ACTION',
    );
    expect(sorted[0].actionKind).toBe('ARBITRATE');
  });

  it('départage par ancienneté à priorité et nature égales', () => {
    const older = action('DO_NEXT', 'ARBITRATE', 30);
    const newer = action('DO_NEXT', 'ARBITRATE', 2);
    expect(comparePriorityMode(older, newer)).toBeLessThan(0);
    expect(compareActionMode(older, newer)).toBeLessThan(0);
  });
});
