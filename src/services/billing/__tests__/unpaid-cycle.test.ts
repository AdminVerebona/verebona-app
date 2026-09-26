/**
 * Cycle d'impayé de 90 jours — Centre d'aide GAP-06, AID-BILL-008,
 * AID-TRANSFER-006. Calcul des étapes et décision à l'échéance.
 */
import { describe, it, expect } from 'vitest';
import {
  UNPAID_CYCLE_DAYS,
  computeUnpaidCycle,
  decideAtDeadline,
  unpaidDeadline,
  unpaidRestrictionMessage,
} from '@/services/billing/unpaid-cycle.rules';
import { unpaidReminderDedupeKey } from '@/services/billing/unpaid-cycle.service';
import { unpaidNotificationText } from '@/lib/notifications/catalog';

const DAY = 24 * 60 * 60 * 1000;
const J0 = new Date('2026-06-01T08:00:00Z');
const at = (days: number, extraMs = 0) => new Date(J0.getTime() + days * DAY + extraMs);

describe('échéance', () => {
  it('J+90 exactement', () => {
    expect(UNPAID_CYCLE_DAYS).toBe(90);
    expect(unpaidDeadline(J0).getTime() - J0.getTime()).toBe(90 * DAY);
  });
});

describe('computeUnpaidCycle — étapes', () => {
  it('J0 à J+82 : aucune action (J0 notifié par le webhook)', () => {
    for (const d of [0, 1, 30, 60, 82]) {
      expect(computeUnpaidCycle(J0, at(d)).step).toEqual({ kind: 'none' });
    }
    expect(computeUnpaidCycle(J0, at(0)).daysLeft).toBe(90);
  });

  it('J+83 (7 jours restants) : rappel J-7', () => {
    const s = computeUnpaidCycle(J0, at(83));
    expect(s.daysLeft).toBe(7);
    expect(s.step).toEqual({ kind: 'reminder', stage: 'J-7' });
  });

  it('J+89 (1 jour restant) : rappel J-1 ; un J-7 manqué n’est pas rattrapé', () => {
    expect(computeUnpaidCycle(J0, at(89)).step).toEqual({ kind: 'reminder', stage: 'J-1' });
    expect(computeUnpaidCycle(J0, at(89, 12 * 3600_000)).step).toEqual({ kind: 'reminder', stage: 'J-1' });
  });

  it('J+90 et au-delà : échu', () => {
    expect(computeUnpaidCycle(J0, at(90)).step).toEqual({ kind: 'expired' });
    expect(computeUnpaidCycle(J0, at(90)).daysLeft).toBe(0);
    expect(computeUnpaidCycle(J0, at(120)).step).toEqual({ kind: 'expired' });
  });

  it('juste avant J+90 : pas encore échu', () => {
    expect(computeUnpaidCycle(J0, at(90, -1000)).step.kind).toBe('reminder');
  });

  it('échéance enregistrée (cycle antérieur reporté par la migration 0182) prioritaire', () => {
    const reported = at(130);
    const s = computeUnpaidCycle(J0, at(100), reported);
    expect(s.deadlineAt).toEqual(reported);
    expect(s.step).toEqual({ kind: 'none' });
    expect(computeUnpaidCycle(J0, at(123), reported).step).toEqual({ kind: 'reminder', stage: 'J-7' });
  });

  it('clé de rappel stable par cycle et par étape (idempotence du cron)', () => {
    expect(unpaidReminderDedupeKey(4, J0, 'J-7')).toBe(unpaidReminderDedupeKey(4, J0, 'J-7'));
    expect(unpaidReminderDedupeKey(4, J0, 'J-7')).not.toBe(unpaidReminderDedupeKey(4, J0, 'J-1'));
    expect(unpaidReminderDedupeKey(4, J0, 'J-7')).not.toBe(unpaidReminderDedupeKey(4, at(200), 'J-7'));
  });
});

describe('decideAtDeadline — revérification Stripe avant suppression', () => {
  it('un abonnement actif ou en essai : régularisé, aucune suppression', () => {
    expect(decideAtDeadline([{ id: 'sub_old', status: 'canceled' }, { id: 'sub_new', status: 'active' }]))
      .toEqual({ action: 'regularized', subscriptionId: 'sub_new' });
    expect(decideAtDeadline([{ id: 'sub_t', status: 'trialing' }]).action).toBe('regularized');
  });

  it('impayé encore facturable : résilié avant suppression', () => {
    expect(decideAtDeadline([
      { id: 'sub_1', status: 'past_due' },
      { id: 'sub_2', status: 'unpaid' },
      { id: 'sub_3', status: 'canceled' },
    ])).toEqual({ action: 'delete', cancelFirst: ['sub_1', 'sub_2'] });
  });

  it('aucun abonnement (déjà résilié par Stripe) : suppression', () => {
    expect(decideAtDeadline([])).toEqual({ action: 'delete', cancelFirst: [] });
  });
});

describe('messages (AID-BILL-008)', () => {
  it('le refus d’écriture dit ce qui reste possible et la date limite', () => {
    const m = unpaidRestrictionMessage(new Date('2026-08-30T08:00:00Z'));
    expect(m).toContain('consultables, exportables et transmissibles');
    expect(m).toContain('30 août 2026');
    expect(m).toContain('supprimées');
  });

  it('notification J0 et rappel portent l’échéance', () => {
    expect(unpaidNotificationText('J0', '2026-08-30T08:00:00Z')).toContain('30 août 2026');
    expect(unpaidNotificationText('REMINDER', '2026-08-30T08:00:00Z')).toContain('supprimées le 30 août 2026');
    expect(unpaidNotificationText('J0', null)).toContain('régulariser');
  });
});
