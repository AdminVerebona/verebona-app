/**
 * Journal technique des actions admin — CDC Back-Office V1 AUD-001 / AUD-003.
 */
import { describe, it, expect } from 'vitest';
import { buildAdminAuditRow } from '@/lib/admin-audit';
import { planAtDate } from '@/lib/admin/plan-at-date';

describe('buildAdminAuditRow (AUD-001)', () => {
  it('porte administrateur, action, cible, date, résultat, ancienne et nouvelle valeur', () => {
    const now = new Date('2026-09-25T10:00:00Z');
    const row = buildAdminAuditRow(
      {
        adminId: 7,
        action: 'ACCOUNT_SUSPEND',
        targetType: 'ACCOUNT',
        targetId: 42,
        result: 'SUCCESS',
        before: { isActive: true },
        after: { isActive: false },
        details: { revokedUserIds: [1, 2] },
      },
      'admin@verebona.fr',
      now,
    );
    expect(row).toEqual({
      timestamp: now,
      adminUserId: 7,
      adminEmail: 'admin@verebona.fr',
      actionType: 'ACCOUNT_SUSPEND',
      targetType: 'ACCOUNT',
      targetId: 42,
      result: 'SUCCESS',
      oldValue: { isActive: true },
      newValue: { isActive: false },
      details: JSON.stringify({ revokedUserIds: [1, 2] }),
    });
  });

  it('valeurs absentes : NULL, pas d’objet vide', () => {
    const row = buildAdminAuditRow(
      { adminId: 1, action: 'USER_FORCE_LOGOUT', targetType: 'USER', targetId: 3, result: 'FAILURE' },
      'a@b.fr',
    );
    expect(row.oldValue).toBeNull();
    expect(row.newValue).toBeNull();
    expect(row.details).toBeNull();
  });
});

describe('planAtDate (SUB-009 : offre d’un paiement)', () => {
  const history = [
    { createdAt: new Date('2026-01-10'), oldTier: 'STANDARD', newTier: 'PREMIUM' },
    { createdAt: new Date('2026-06-01'), oldTier: 'PREMIUM', newTier: 'PREMIUM_DUO' },
  ];
  it('offre en vigueur à la date du paiement', () => {
    expect(planAtDate(history, new Date('2026-03-01'), 'PREMIUM_DUO')).toBe('PREMIUM');
    expect(planAtDate(history, new Date('2026-07-01'), 'PREMIUM_DUO')).toBe('PREMIUM_DUO');
  });
  it('avant le premier changement : l’offre d’origine', () => {
    expect(planAtDate(history, new Date('2025-12-01'), 'PREMIUM_DUO')).toBe('STANDARD');
  });
  it('sans historique : l’offre courante', () => {
    expect(planAtDate([], new Date(), 'PREMIUM')).toBe('PREMIUM');
  });
});
