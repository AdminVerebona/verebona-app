/**
 * Lot 84A — décision PO L83-Q1 (23/10/2026) : compte non éligible À CAUSE DE
 * SON ABONNEMENT alors que Stripe indique un paiement → resynchronisation de
 * l'abonnement par le contrôle de cohérence (mode correctif seulement).
 *
 *   L84A-U-BILLING-01  le moteur n'ouvre la réparation hors périmètre ÉLIGIBLE
 *                      que par la propriété DÉCLARATIVE du contrôle
 *                      (`repairOnIneligibleBilling`) — jamais par identifiant ;
 *   L84A-U-BILLING-02  seuls COH-BILLING-STRIPE et COH-ENTITLEMENTS la
 *                      déclarent (réparation = synchronisation de l'abonnement),
 *                      tous deux lus sur ces comptes ; Duo reste en détection ;
 *   L84A-U-BILLING-03  à blanc : jamais de réparation (WOULD_REPAIR) ;
 *   L84A-U-BILLING-04  notifications : compte éligible inchangé (aucune),
 *                      compte bloqué → comportement normal de la synchronisation ;
 *   L84A-U-BILLING-05  revérification avant réparation : un compte devenu
 *                      suspendu / archivé / illisible n'est jamais réparé.
 * Preuve sur PostgreSQL : L83E-E2E-08 (attendu modifié au lot 84A).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const eligibilite = vi.hoisted(() => ({ value: { eligible: false, reason: 'SUBSCRIPTION_ENDED' } as { eligible: boolean; reason: string } }));
vi.mock('@/db', () => ({ pgClient: {}, db: {} }));
vi.mock('../eligibility', () => ({ coherenceAccountEligibility: async () => eligibilite.value }));

describe('L84A-U-BILLING — réparation de facturation sur un compte bloqué par son abonnement', () => {
  beforeEach(() => { eligibilite.value = { eligible: false, reason: 'SUBSCRIPTION_ENDED' }; });

  it('L84A-U-BILLING-01 — moteur : propriété déclarative, aucun cas codé en dur', async () => {
    const { repairPermittedInScope } = await import('../engine');
    const repair = async () => new Map();
    expect(repairPermittedInScope({ repair }, 'ELIGIBLE')).toBe(true);
    expect(repairPermittedInScope({}, 'ELIGIBLE')).toBe(false);
    expect(repairPermittedInScope({ repair, ineligibleAccounts: 'SUBSCRIPTION_STATE_READ' }, 'SUBSCRIPTION_STATE_READ')).toBe(false);
    expect(repairPermittedInScope({ repair, ineligibleAccounts: 'SUBSCRIPTION_STATE_READ', repairOnIneligibleBilling: true }, 'SUBSCRIPTION_STATE_READ')).toBe(true);
    // La propriété seule ne suffit pas : le contrôle doit aussi être lu sur ces comptes.
    expect(repairPermittedInScope({ repair, repairOnIneligibleBilling: true }, 'SUBSCRIPTION_STATE_READ')).toBe(false);
    expect(repairPermittedInScope({ ineligibleAccounts: 'SUBSCRIPTION_STATE_READ', repairOnIneligibleBilling: true }, 'SUBSCRIPTION_STATE_READ')).toBe(false);
  });

  it('L84A-U-BILLING-02 — registre : seules les deux resynchronisations d’abonnement le déclarent', async () => {
    const { COHERENCE_REGISTRY } = await import('../registry');
    const { repairPermittedInScope } = await import('../engine');
    const declares = COHERENCE_REGISTRY.filter((c) => c.repairOnIneligibleBilling).map((c) => c.id).sort();
    expect(declares).toEqual(['COH-BILLING-STRIPE', 'COH-ENTITLEMENTS']);
    for (const c of COHERENCE_REGISTRY) {
      if (c.repairOnIneligibleBilling) {
        expect(c.ineligibleAccounts, c.id).toBe('SUBSCRIPTION_STATE_READ');
        expect(c.services.some((s) => s.endsWith('#syncSubscriptionFromStripe')), c.id).toBe(true);
        expect(c.version, c.id).toBeGreaterThanOrEqual(2);
      }
      expect(repairPermittedInScope(c, 'SUBSCRIPTION_STATE_READ'), c.id).toBe(declares.includes(c.id));
    }
    expect(COHERENCE_REGISTRY.find((c) => c.id === 'COH-DUO-RELATIONS')!.repairOnIneligibleBilling).toBeUndefined();
  });

  it('L84A-U-BILLING-03 — mode à blanc : jamais de réparation, même déclarée', async () => {
    const { resultOfVerdict } = await import('../engine');
    expect(resultOfVerdict({ verdict: 'REPAIRABLE' }, 'DRY_RUN', true)).toBe('WOULD_REPAIR');
    expect(resultOfVerdict({ verdict: 'REPAIRABLE' }, 'CORRECTIVE', true)).toBe('TRY_REPAIR');
    expect(resultOfVerdict({ verdict: 'REPAIRABLE' }, 'CORRECTIVE', false)).toBe('FINDING');
  });

  it('L84A-U-BILLING-04 — notifications : éligible sans e-mail (83E), bloqué selon la synchronisation normale', async () => {
    const { resyncNotify } = await import('../registry/checks/billing');
    expect(resyncNotify('ELIGIBLE')).toBe(false);
    expect(resyncNotify(undefined)).toBe(false);
    expect(resyncNotify('SUBSCRIPTION_STATE_READ')).toBeUndefined();
  });

  it('L84A-U-BILLING-05 — revérification avant réparation selon le périmètre', async () => {
    const { repairEligibilityFor } = await import('../orchestrator');
    const now = new Date('2026-10-23T10:00:00Z');
    for (const reason of ['SUBSCRIPTION_ENDED', 'UNPAID', 'TRIAL_EXPIRED', 'READ_ONLY', 'NO_SUBSCRIPTION', 'WITHDRAWN']) {
      eligibilite.value = { eligible: false, reason };
      expect(await repairEligibilityFor(1, 'SUBSCRIPTION_STATE_READ', now), reason).toEqual({ eligible: true, reason });
      expect((await repairEligibilityFor(1, 'ELIGIBLE', now)).eligible, reason).toBe(false);
    }
    for (const reason of ['ACCOUNT_SUSPENDED', 'ACCOUNT_ARCHIVED', 'ACCOUNT_NOT_FOUND', 'ELIGIBILITY_UNREADABLE']) {
      eligibilite.value = { eligible: false, reason };
      expect((await repairEligibilityFor(1, 'SUBSCRIPTION_STATE_READ', now)).eligible, reason).toBe(false);
    }
    eligibilite.value = { eligible: true, reason: 'ELIGIBLE' };
    expect(await repairEligibilityFor(1, 'SUBSCRIPTION_STATE_READ', now)).toEqual({ eligible: true, reason: 'ELIGIBLE' });
  });
});
