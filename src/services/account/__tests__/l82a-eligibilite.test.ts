/**
 * Lot 82A — éligibilité stricte des comptes aux traitements métier (décision
 * PO C-Q10 et §3.3 du 23/10/2026). Règle pure, refus typé, catégories de
 * notifications de contenu, point d'entrée de reprise. La base réelle est
 * couverte par l'e2e `l82a-eligibilite-comptes`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  processingEligibilityOf, processingEligibleSql, AccountIneligibleError, isAccountIneligibleError,
  ineligibilityReasonOf, neutralizedMessage, INELIGIBILITY_LABELS, type AccountProcessingRow,
} from '../processing-eligibility';
import { entitlementsFromSubscription } from '@/services/entitlements.service';
import { isContentNotificationCategory, CONTENT_NOTIFICATION_CATEGORIES } from '@/lib/notifications/catalog';

const NOW = new Date('2026-10-23T10:00:00.000Z');
const HIER = new Date('2026-10-22T10:00:00.000Z');
const DEMAIN = new Date('2026-10-24T10:00:00.000Z');

const ligne = (over: Partial<AccountProcessingRow> = {}, sub: Partial<NonNullable<AccountProcessingRow['subscription']>> | null = {}): AccountProcessingRow => ({
  accountId: 42, isActive: true, archivedAt: null, accountSubscriptionStatus: 'ACTIVE',
  subscription: sub === null ? null : { planCode: 'premium', status: 'active', trialEndsAt: null, firstBilledAt: HIER, ...sub },
  ...over,
});

afterEach(() => { delete process.env.CORPUS_ACCOUNT_ID; vi.restoreAllMocks(); });

describe('L82A-R01 — règle d’éligibilité (pure)', () => {
  it.each([
    ['abonnement actif', ligne(), true, null],
    ['essai en cours', ligne({}, { status: 'trialing', trialEndsAt: DEMAIN, firstBilledAt: null }), true, null],
    ['essai échu par la DATE, statut encore « trialing » (tâche pas encore passée)', ligne({}, { status: 'trialing', trialEndsAt: HIER, firstBilledAt: null }), false, 'TRIAL_EXPIRED'],
    ['essai échu basculé en lecture seule', ligne({ accountSubscriptionStatus: 'EXPIRED' }, { status: 'readonly', trialEndsAt: HIER, firstBilledAt: null }), false, 'TRIAL_EXPIRED'],
    ['rétractation (lecture seule)', ligne({ accountSubscriptionStatus: 'WITHDRAWN' }, { status: 'readonly' }), false, 'WITHDRAWN'],
    ['lecture seule (autre cause)', ligne({ accountSubscriptionStatus: 'EXPIRED' }, { status: 'readonly' }), false, 'READ_ONLY'],
    ['impayé', ligne({ accountSubscriptionStatus: 'PAST_DUE' }, { status: 'past_due' }), false, 'UNPAID'],
    ['abonnement terminé', ligne({}, { status: 'canceled' }), false, 'SUBSCRIPTION_ENDED'],
    ['aucun abonnement', ligne({}, null), false, 'NO_SUBSCRIPTION'],
    ['compte suspendu (abonnement actif)', ligne({ isActive: false }), false, 'ACCOUNT_SUSPENDED'],
    ['compte neutralisé (lot 72D)', ligne({ archivedAt: HIER }), false, 'ACCOUNT_ARCHIVED'],
  ] as const)('%s', (_l, row, eligible, reason) => {
    expect(processingEligibilityOf(row as AccountProcessingRow, NOW)).toEqual({ eligible, reason });
  });

  it('compte introuvable (supprimé) : non éligible', () => {
    expect(processingEligibilityOf(null, NOW)).toEqual({ eligible: false, reason: 'ACCOUNT_NOT_FOUND' });
  });

  it('même règle de mode restreint que les droits d’écriture (aucun second verrou) : éligible ⇒ canWrite, et réciproquement hors suspension / neutralisation', () => {
    const subs = [
      { planCode: 'premium', status: 'active', trialEndsAt: null, firstBilledAt: HIER },
      { planCode: 'trial', status: 'trialing', trialEndsAt: DEMAIN, firstBilledAt: null },
      { planCode: 'trial', status: 'trialing', trialEndsAt: HIER, firstBilledAt: null },
      { planCode: 'trial', status: 'trialing', trialEndsAt: HIER, firstBilledAt: HIER },
      { planCode: 'premium', status: 'readonly', trialEndsAt: null, firstBilledAt: null },
      { planCode: 'premium', status: 'past_due', trialEndsAt: null, firstBilledAt: HIER },
      { planCode: 'premium', status: 'canceled', trialEndsAt: null, firstBilledAt: HIER },
      null,
    ];
    for (const s of subs) {
      expect(processingEligibilityOf(ligne({}, s as never), NOW).eligible).toBe(entitlementsFromSubscription(s as never, NOW).canWrite);
    }
  });

  it('compte technique des campagnes de mesure (CORPUS_ACCOUNT_ID) : toujours éligible, comme pour le plafond de coût', () => {
    process.env.CORPUS_ACCOUNT_ID = '42';
    expect(processingEligibilityOf(ligne({}, null), NOW)).toEqual({ eligible: true, reason: null });
    expect(processingEligibleSql('x.id')).toContain('x.id = 42 OR ');
  });
});

describe('L82A-R02 — même règle en SQL (sélections par lots)', () => {
  it('suspension, neutralisation, statuts restreints et essai échu par la date', () => {
    const s = processingEligibleSql('f.account_id', '$9::timestamptz');
    expect(s).toContain('pe_a.id = f.account_id');
    expect(s).toContain('pe_a.is_active IS NOT FALSE');
    expect(s).toContain('pe_a.archived_at IS NULL');
    expect(s).toContain(`pe_s.status NOT IN ('readonly', 'canceled', 'past_due')`);
    expect(s).toContain('pe_s.trial_ends_at <= $9::timestamptz');
    // JOIN (et non LEFT JOIN) : sans abonnement, non éligible.
    expect(s).toMatch(/FROM accounts pe_a JOIN account_subscriptions pe_s/);
  });
});

describe('L82A-R03 — refus typé', () => {
  it('AccountIneligibleError porte le code ACCOUNT_INELIGIBLE et son motif', () => {
    const e = new AccountIneligibleError(7, 'TRIAL_EXPIRED');
    expect(isAccountIneligibleError(e)).toBe(true);
    expect(ineligibilityReasonOf(e)).toBe('TRIAL_EXPIRED');
    expect(e.message).toContain(INELIGIBILITY_LABELS.TRIAL_EXPIRED);
    expect(isAccountIneligibleError(new Error('x'))).toBe(false);
    expect(ineligibilityReasonOf({ code: 'ACCOUNT_INELIGIBLE', reason: 'n/a' })).toBeNull();
  });

  it('motif d’un travail neutralisé lisible au BO (File IA)', () => {
    expect(neutralizedMessage('ACCOUNT_SUSPENDED')).toMatch(/^Compte non éligible : compte suspendu — travail neutralisé, réexaminé à la réactivation/);
  });
});

describe('L82A-N01 — notifications de contenu (non indispensables)', () => {
  it('échéances, documents, « À traiter » : soumises à l’éligibilité ; compte, sécurité, Duo, transmissions : jamais', () => {
    expect([...CONTENT_NOTIFICATION_CATEGORIES].sort()).toEqual(['deadlines', 'documents', 'to_process']);
    for (const c of ['account', 'security', 'duo', 'transmission', 'news']) expect(isContentNotificationCategory(c)).toBe(false);
  });
});

describe('L82A-REA — point d’entrée unique de la reprise (onAccountReactivated)', () => {
  it('étapes par défaut dans l’ordre ; une étape remplacée (82B) garde sa position', async () => {
    const L = await import('../processing-lifecycle');
    L.__setProcessingStatesReadyForTests(false);
    expect(L.listAccountReactivationSteps()).toEqual(['reexamine-neutralized-jobs', 'mascot-pregeneration', 'catchup-control']);
    const appels: string[] = [];
    for (const n of L.listAccountReactivationSteps()) {
      L.registerAccountReactivationStep(n, async () => { appels.push(n); return { n }; });
    }
    const coherence = vi.fn(async () => { appels.push('82B'); return { campaign: 'x' }; });
    L.registerAccountReactivationStep('catchup-control', coherence);
    const r = await L.onAccountReactivated(42, { source: 'test', now: NOW });
    expect(appels).toEqual(['reexamine-neutralized-jobs', 'mascot-pregeneration', '82B']);
    expect(r.steps['catchup-control']).toEqual({ ok: true, detail: { campaign: 'x' } });
  });

  it('une étape en échec n’empêche pas les suivantes (consigné) ; compte toujours non éligible : rien n’est relancé', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const L = await import('../processing-lifecycle');
    L.__setProcessingStatesReadyForTests(false);
    const E = await import('../processing-eligibility');
    const suite = vi.fn(async () => undefined);
    L.registerAccountReactivationStep('reexamine-neutralized-jobs', async () => { throw new Error('panne'); });
    L.registerAccountReactivationStep('mascot-pregeneration', suite);
    L.registerAccountReactivationStep('catchup-control', suite);
    const r = await L.onAccountReactivated(42, { source: 'test', now: NOW });
    expect(r.steps['reexamine-neutralized-jobs']).toMatchObject({ ok: false, error: 'panne' });
    expect(suite).toHaveBeenCalledTimes(2);

    suite.mockClear();
    E.__setProcessingEligibilityForTests(async () => ({ eligible: false, reason: 'ACCOUNT_SUSPENDED' }));
    const r2 = await L.onAccountReactivated(42, { source: 'test', now: NOW });
    expect(suite).not.toHaveBeenCalled();
    expect(r2.steps.eligibility).toMatchObject({ ok: false });
  });
});
