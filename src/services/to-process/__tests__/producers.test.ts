/**
 * Producteurs et promotion temporelle — CDC V2.0 §9.2, §9.3, §10.3, §10.5.
 *
 * Les producteurs touchent la base et ne sont donc pas testés ici. Ce qui l'est,
 * c'est le contrat sur lequel ils s'appuient : les règles existent, elles
 * autorisent ce qu'il faut, et la promotion respecte le plafond sans jamais
 * recalculer le reste.
 */
import { describe, it, expect } from 'vitest';
import * as scheduler from '@/services/to-process/priority-scheduler.service';
import {
  DO_FIRST_CAP,
  admitToDoFirst,
  type PriorityCandidate,
} from '@/services/to-process/priority';
import {
  checkRulesCatalog,
  findRule,
  getRule,
  priorityForRule,
} from '@/services/to-process/rules-catalog';

const NOW = new Date('2026-09-16T10:00:00Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

describe('règles des trois familles reprises (§10.3, §10.5)', () => {
  it('le catalogue reste cohérent après ajout', () => {
    expect(checkRulesCatalog()).toEqual([]);
  });

  it('un équipement sans bien produit une complétion', () => {
    const rule = findRule('EQUIPMENT', 'assetId');
    expect(rule?.code).toBe('LINK-EQUIP-ASSET');
    expect(rule?.completePriority).not.toBeNull();
    // Comme pour un document : l'absence de bien n'est jamais un état normal.
    expect(rule?.allowNotApplicable).toBe(false);
  });

  it('un fournisseur ne produit qu’un arbitrage, jamais une complétion', () => {
    const rule = findRule('SUPPLIER', 'identity');
    expect(rule?.code).toBe('SUPPLIER-IDENTITY');
    // P-06 : sans candidat, personne ne saurait quoi saisir depuis la file.
    expect(rule?.completePriority).toBeNull();
    expect(priorityForRule(rule!, 'ARBITRATE')).toBe('DO_NEXT');
  });

  it('un événement d’agenda sans date reste une complétion sans échappatoire', () => {
    const rule = findRule('AGENDA_ITEM', 'date');
    expect(rule?.code).toBe('DATA-AGENDA-DATE');
    expect(rule?.completePriority).not.toBeNull();
    expect(rule?.allowNotApplicable).toBe(false);
    // Le seuil temporel existe : c'est lui que la promotion franchit.
    expect(rule?.dueSoonDays).toBeGreaterThan(0);
  });
});

describe('promotion temporelle (§9.2)', () => {
  const candidate = (
    ruleCode: string,
    overrides: Partial<PriorityCandidate> = {},
  ): PriorityCandidate => ({
    ruleCode,
    priority: 'DO_FIRST',
    activeSince: NOW,
    ...overrides,
  });

  it('respecte le plafond : une promotion peut être refusée', () => {
    const plein = Array.from({ length: DO_FIRST_CAP }, (_, i) =>
      candidate('DATA-AGENDA-DATE', { id: i + 1 }),
    );
    // DOC-TYP a l'impact le plus faible du catalogue : il ne prend la place de
    // personne.
    const result = admitToDoFirst(candidate('DOC-TYP'), plein, NOW);
    expect(result.admitted).toBe(false);
  });

  it('fait descendre la moins importante quand l’entrante prime', () => {
    const plein = Array.from({ length: DO_FIRST_CAP }, (_, i) =>
      candidate('DOC-TYP', { id: i + 1 }),
    );
    const result = admitToDoFirst(
      candidate('DATA-CONTRACT-END', { dueDate: days(5) }),
      plein,
      NOW,
    );
    expect(result.admitted).toBe(true);
    expect(result.demoted?.ruleCode).toBe('DOC-TYP');
  });

  it('seules les règles à seuil temporel sont promouvables', () => {
    expect(getRule('DATA-CONTRACT-END')?.dueSoonDays).toBeGreaterThan(0);
    expect(getRule('DATA-WARRANTY-END')?.dueSoonDays).toBeGreaterThan(0);
    // Le Type n'a pas d'échéance : rien ne le fera jamais remonter.
    expect(getRule('DOC-TYP')?.dueSoonDays).toBeUndefined();
    expect(getRule('LINK-EQUIP-ASSET')?.dueSoonDays).toBeUndefined();
  });

  it('PRI-03 — aucune fonction ne remplit une place libérée', () => {
    // Le §9.2 interdit le recalcul global périodique. `realignPriorities`
    // existe mais est destinée à un usage manuel après évolution du
    // catalogue ; rien ne promeut automatiquement au fil des résolutions.
    const api = Object.keys(scheduler);
    expect(api).toContain('promoteDueActions');
    expect(api).not.toContain('refillDoFirst');
    expect(api).not.toContain('promoteNextAction');
  });
});
