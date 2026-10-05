/**
 * APP-FUNC-31 — statuts d'abonnement sans période de grâce.
 *
 * Compte accessible ≠ abonnement actif ≠ droits d'écriture : un impayé reste
 * connectable (aucun contrôle ici) mais n'est jamais un abonnement actif.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blocksNewCheckout,
  hasActiveSubscriptionStatus,
  isDuoJoinable,
  isDuoUnpaidStatus,
  isUnpaidAccountStatus,
} from '@/lib/billing/subscription-status';
import { SUBSCRIPTION_STATUSES } from '@/types/domain';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('CA-12 — abonnement actif ≠ compte accessible', () => {
  it('seuls ACTIVE et TRIALING sont des abonnements actifs ; un impayé ne l’est pas', () => {
    expect(hasActiveSubscriptionStatus('ACTIVE')).toBe(true);
    expect(hasActiveSubscriptionStatus('TRIALING')).toBe(true);
    for (const s of ['PAST_DUE', 'PAST_DUE_GRACE', 'UNPAID_RECOVERY', 'EXPIRED', 'WITHDRAWN', 'NONE', '', null, undefined]) {
      expect(hasActiveSubscriptionStatus(s)).toBe(false);
    }
  });

  it('impayé = PAST_DUE uniquement', () => {
    expect(isUnpaidAccountStatus('PAST_DUE')).toBe(true);
    expect(isUnpaidAccountStatus('past_due')).toBe(true);
    expect(isUnpaidAccountStatus('ACTIVE')).toBe(false);
  });

  it('un impayé bloque une NOUVELLE souscription (régularisation via le portail), comme un abonnement en cours', () => {
    expect(blocksNewCheckout('PAST_DUE')).toBe(true);
    expect(blocksNewCheckout('ACTIVE')).toBe(true);
    expect(blocksNewCheckout('EXPIRED')).toBe(false);
    expect(blocksNewCheckout('NONE')).toBe(false);
  });

  it('login, refresh, vérification d’e-mail et jetons utilisent le même critère, sans PAST_DUE_GRACE', () => {
    for (const f of [
      'src/app/api/auth/login/route.ts',
      'src/app/api/auth/refresh/route.ts',
      'src/app/api/auth/verify-email/route.ts',
      'src/lib/auth/session-tokens.ts',
    ]) {
      const src = read(f);
      expect(src).toContain('hasActiveSubscriptionStatus(defaultAccount.subscriptionStatus)');
      expect(src).not.toContain('PAST_DUE_GRACE');
    }
  });
});

describe('CA-13 — Premium Duo', () => {
  it('impayé Duo = UNPAID_RECOVERY (récupération ouverte), et un Duo impayé n’accueille personne', () => {
    expect(isDuoUnpaidStatus('UNPAID_RECOVERY')).toBe(true);
    expect(isDuoUnpaidStatus('PAST_DUE_GRACE')).toBe(false);
    expect(isDuoJoinable('ACTIVE')).toBe(true);
    expect(isDuoJoinable('UNPAID_RECOVERY')).toBe(false);
    expect(isDuoJoinable('PAST_DUE_GRACE')).toBe(false);
  });
});

describe('CA-15 — types et contraintes alignés', () => {
  it('les statuts TypeScript sont exactement ceux de la contrainte SQL', () => {
    const schema = read('src/db/schema.ts');
    const m = schema.match(/accounts_subscription_status_check', sql`\$\{table\.subscriptionStatus\} IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const sqlValues = m![1].split(',').map((v) => v.trim().replace(/'/g, '')).sort();
    expect([...SUBSCRIPTION_STATUSES].sort()).toEqual(sqlValues);
    expect(sqlValues).not.toContain('PAST_DUE_GRACE');
    expect(sqlValues).not.toContain('UNPAID_RECOVERY');
  });

  it('la migration 0250 pose la même contrainte', () => {
    const mig = read('src/db/migrations/0250_unpaid_cycle_no_grace.sql');
    expect(mig).toMatch(/ADD CONSTRAINT accounts_subscription_status_check\s+CHECK \(subscription_status IN \(\s*'NONE', 'TRIALING', 'ACTIVE', 'CANCELED', 'PAST_DUE', 'EXPIRED', 'WITHDRAWN'\s*\)\)/);
  });
});

describe('CA-18 — recherche globale : plus aucun usage fonctionnel de l’ancienne grâce', () => {
  const fichiers = [
    'src/lib/session-service.ts',
    'src/app/api/users/me/route.ts',
    'src/app/api/billing/trial-status/route.ts',
    'src/app/api/billing/create-checkout-session/route.ts',
    'src/app/api/duo/join/route.ts',
    'src/lib/prelaunch-invitations.ts',
    'src/services/entitlements.service.ts',
    'src/services/billing/subscription-sync.service.ts',
    'src/services/withdrawal/withdrawal-processor.service.ts',
    'src/services/admin/subscriptions.service.ts',
    'src/lib/session/session-store.ts',
  ];
  it.each(fichiers)('%s', (f) => {
    const src = read(f);
    expect(src).not.toMatch(/'PAST_DUE_GRACE'/);
    expect(src).not.toMatch(/pastDueGrace|graceDeadlineAt|`grace:/);
  });

  it('le bandeau « période de grâce » Duo a disparu', () => {
    expect(() => read('src/components/premium/DuoGracePeriodBanner.tsx')).toThrow();
  });
});
