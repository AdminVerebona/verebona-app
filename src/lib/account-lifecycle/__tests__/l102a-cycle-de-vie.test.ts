/**
 * Lot 102A — cycle de vie des comptes (états restreints, conservation 90 j,
 * purge) : règles pures et garde-fous de source.
 *
 *  L102A-RUL-01 durées centralisées ; date de suppression par motif ;
 *               préavis minimal d'un rattrapage ; plafond technique.
 *  L102A-RUL-02 correspondance motifs ↔ comptes à rebours ; annulation par
 *               souscription ; J+80 dérivé de la conservation.
 *  L102A-RUL-03 bandeau « Lecture seule jusqu'au … » (textes factuels).
 *  L102A-RUL-04 éligibilité aux traitements : suppression demandée ⇒ aucun
 *               traitement (règle pure et SQL).
 *  L102A-RUL-05 registre de rejeu : validation stricte d'un fichier.
 *  L102A-SRC-01 rétractation : plus aucune suppression immédiate ; fin
 *               d'abonnement et resouscription branchées ; aucune durée en dur.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DELETION_REASON_OF, LIFECYCLE_DURATIONS, RESTRICTED_REASONS, cancelledBySubscription, daysUntilPurge,
  purgeDateFor, restrictedReasonOf, trialPurgeReminderOffsetDays, voluntaryCeilingExceeded, voluntaryDeletionDelayMs,
  voluntaryReminderApplies,
} from '../retention-policy';
import { milestoneDef } from '@/services/trial-lifecycle/milestones';
import { restrictedStateTexts } from '@/components/subscription/RestrictedStateNotice';
import { processingEligibilityOf, processingEligibleSql } from '@/services/account/processing-eligibility';

vi.mock('@/db', () => ({ db: {}, pgClient: {} }));

const DAY = 86_400_000;
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const T0 = new Date('2033-03-10T14:05:00Z');

describe('L102A-RUL-01 — durées et dates de suppression', () => {
  it('décision PO : 90 jours de conservation ; suppression demandée au plus tôt (24 h), plafond 30 jours', () => {
    expect(LIFECYCLE_DURATIONS.restrictedRetentionDays).toBe(90);
    expect(LIFECYCLE_DURATIONS.voluntaryDeletionDelayHours).toBe(24);
    expect(LIFECYCLE_DURATIONS.voluntaryDeletionMaxDays).toBe(30);
    expect(voluntaryDeletionDelayMs()).toBeLessThanOrEqual(30 * DAY);
  });
  it.each(['FIN_ESSAI', 'FIN_ABONNEMENT', 'RETRACTATION'] as const)('%s : entrée + 90 jours', (reason) => {
    expect(purgeDateFor(reason, T0).toISOString()).toBe(new Date(T0.getTime() + 90 * DAY).toISOString());
  });
  it('suppression demandée : entrée + délai court, jamais 30 jours', () => {
    expect(purgeDateFor('SUPPRESSION_DEMANDEE', T0).getTime() - T0.getTime()).toBe(24 * 3_600_000);
  });
  it('rattrapage (compte déjà en lecture seule avant la livraison) : jamais moins de 30 jours de préavis', () => {
    const vieux = new Date(T0.getTime() - 200 * DAY);
    expect(purgeDateFor('FIN_ESSAI', vieux, { minNoticeFrom: T0 }).toISOString()).toBe(new Date(T0.getTime() + 30 * DAY).toISOString());
    // Fin d'essai récente : la date normale (fin + 90 j) l'emporte.
    expect(purgeDateFor('FIN_ESSAI', T0, { minNoticeFrom: T0 }).toISOString()).toBe(new Date(T0.getTime() + 90 * DAY).toISOString());
  });
  it('plafond technique et rappel J−7 de la suppression demandée', () => {
    expect(voluntaryCeilingExceeded(T0, new Date(T0.getTime() + 31 * DAY))).toBe(true);
    expect(voluntaryCeilingExceeded(T0, new Date(T0.getTime() + 2 * DAY))).toBe(false);
    expect(voluntaryReminderApplies(T0, new Date(T0.getTime() + DAY))).toBe(false);
    expect(voluntaryReminderApplies(T0, new Date(T0.getTime() + 30 * DAY))).toBe(true);
    expect(daysUntilPurge(new Date(T0.getTime() + 9.2 * DAY), T0)).toBe(10);
    expect(daysUntilPurge(new Date(T0.getTime() - DAY), T0)).toBe(0);
  });
});

describe('L102A-RUL-02 — motifs, annulation, J+80', () => {
  it('quatre motifs, chacun porté par un compte à rebours existant', () => {
    expect(RESTRICTED_REASONS).toEqual(['FIN_ESSAI', 'FIN_ABONNEMENT', 'RETRACTATION', 'SUPPRESSION_DEMANDEE']);
    expect(DELETION_REASON_OF).toEqual({ FIN_ESSAI: 'TRIAL_ABANDONED', FIN_ABONNEMENT: 'SUBSCRIPTION_ENDED', RETRACTATION: 'WITHDRAWAL', SUPPRESSION_DEMANDEE: 'VOLUNTARY' });
    expect(restrictedReasonOf('WITHDRAWAL')).toBe('RETRACTATION');
    expect(restrictedReasonOf('ADMIN')).toBeNull();
    expect(restrictedReasonOf('UNPAID')).toBeNull();
  });
  it('une souscription annule la purge des trois premiers motifs, pas une suppression demandée', () => {
    expect(['FIN_ESSAI', 'FIN_ABONNEMENT', 'RETRACTATION', 'SUPPRESSION_DEMANDEE'].map((r) => cancelledBySubscription(r as never))).toEqual([true, true, true, false]);
  });
  it('J+80 = 90 − 10, dérivé de la conservation (jamais deux sources)', () => {
    expect(trialPurgeReminderOffsetDays()).toBe(80);
    expect(milestoneDef('J80')!.defaultOffsetDays).toBe(trialPurgeReminderOffsetDays());
  });
  it('migration 0900 : motif SUBSCRIPTION_ENDED autorisé, registre minimal (identifiants seulement), additive', () => {
    const mig = read('src/db/migrations/0900_l102a_cycle_vie_comptes.sql');
    expect(mig).toContain("'SUBSCRIPTION_ENDED'");
    expect(mig).toContain('CREATE TABLE IF NOT EXISTS account_deletion_registry');
    expect(mig).not.toMatch(/\bemail\b|\bfirst_name\b|DROP TABLE|DELETE FROM/i);
  });
});

describe('L102A-RUL-03 — bandeau sobre « Lecture seule jusqu’au … »', () => {
  it('date réelle, contexte du motif, export, suppression annulée par une souscription', () => {
    const t = restrictedStateTexts({ reason: 'FIN_ABONNEMENT', purgeAt: '2027-01-29T10:00:00.000Z', daysLeft: 90, cancelledBySubscription: true });
    expect(t.title).toBe('Votre compte est en lecture seule jusqu’au 29 janvier 2027.');
    expect(t.detail).toContain('Votre abonnement est terminé.');
    expect(t.detail).toContain('consultables et exportables');
    expect(t.detail).toContain('sauf souscription');
    const r = restrictedStateTexts({ reason: 'RETRACTATION', purgeAt: '2027-01-29T10:00:00.000Z', daysLeft: 90, cancelledBySubscription: true });
    expect(r.detail).toContain('rétractation');
  });
  it('bandeau branché dans le bandeau d’essai, avant les messages génériques ; export et offres ; aucune couleur brute', () => {
    const banner = read('src/components/subscription/TrialBanner.tsx');
    expect(banner.indexOf('<RestrictedStateNotice')).toBeLessThan(banner.indexOf('Votre essai gratuit est terminé.'));
    const notice = read('src/components/subscription/RestrictedStateNotice.tsx');
    expect(notice).toContain('/mon-compte#mes-donnees');
    expect(notice).toContain('/mon-compte/offres');
    expect(notice).not.toMatch(/#[0-9a-f]{3,6}\b|bg-(red|green|amber|yellow)-/i);
  });
});

describe('L102A-RUL-04 — suppression demandée : plus aucun traitement', () => {
  const row = { accountId: 7, isActive: true, archivedAt: null, accountSubscriptionStatus: 'ACTIVE', subscription: { planCode: 'premium', status: 'active', trialEndsAt: null, firstBilledAt: new Date() } };
  it('règle pure : titulaire clôturé ⇒ DELETION_REQUESTED ; sinon inchangé', () => {
    expect(processingEligibilityOf({ ...row, ownerPendingDeletion: true })).toEqual({ eligible: false, reason: 'DELETION_REQUESTED' });
    expect(processingEligibilityOf(row)).toEqual({ eligible: true, reason: null });
  });
  it('même règle en SQL (sélections par lots)', () => {
    expect(processingEligibleSql('x.id')).toContain("pe_u.status = 'PENDING_DELETION'");
  });
});

describe('L102A-RUL-05 — registre de rejeu : fichier validé strictement', () => {
  it('entrées valides acceptées ; tout champ inattendu ou incomplet refusé', async () => {
    const { parseRegistryEntries } = await import('@/services/account/deletion-registry.service');
    const ok = parseRegistryEntries({ entries: [{ scheduleId: 3, reason: 'VOLUNTARY', scope: 'user', userIds: [4], accountIds: [5], executedAt: '2033-01-01T00:00:00Z' }] });
    expect(ok).toEqual([{ scheduleId: 3, reason: 'VOLUNTARY', scope: 'user', userIds: [4], accountIds: [5], executedAt: '2033-01-01T00:00:00.000Z' }]);
    expect(() => parseRegistryEntries({ entries: [{ reason: 'VOLUNTARY', scope: 'user', userIds: ['4'], accountIds: [], executedAt: '2033-01-01' }] })).toThrow(/invalide/);
    expect(() => parseRegistryEntries({ entries: [{ reason: 'DROP', scope: 'user', userIds: [1], accountIds: [], executedAt: '2033-01-01' }] })).toThrow(/invalide/);
    expect(() => parseRegistryEntries({ foo: 1 })).toThrow(/illisible/);
  });
});

describe('L102A-SRC-01 — branchements', () => {
  it('rétractation : plus de suppression immédiate ; plus de révocation des sessions ; conservation 90 j', () => {
    const proc = read('src/services/withdrawal/withdrawal-processor.service.ts');
    expect(proc).not.toContain('executeScheduledDeletion');
    expect(proc).not.toContain('revokeUserSessionsNow');
    expect(proc).toContain("reason: 'RETRACTATION'");
  });
  it('fin d’abonnement (webhook + synchronisation) et resouscription (synchronisation) branchées', () => {
    expect(read('src/app/api/billing/stripe-webhook/route.ts').match(/onPaidSubscriptionEnded\(/g)?.length).toBeGreaterThanOrEqual(3);
    const sync = read('src/services/billing/subscription-sync.service.ts');
    expect(sync).toContain('lifecycle.liftRestrictedState(account.id');
    expect(sync).toContain('lifecycle.onPaidSubscriptionEnded(account.id');
  });
  it('fin d’essai : purge programmée par la tâche existante `expire-trials` ; restauration : rejeu automatique', () => {
    expect(read('src/services/trial-expiry.job.ts')).toContain('scheduleTrialPurges({ now })');
    expect(read('src/services/backup/database-restore.service.ts')).toContain('replayDeletionRegistry()');
    expect(read('src/services/backup/schema-signature.ts')).toContain("'account_deletion_registry'");
  });
  it('aucune durée du cycle de vie écrite en dur dans les services et écrans du lot', () => {
    for (const f of [
      'src/services/account/restricted-state.service.ts', 'src/services/account/deletion-registry.service.ts',
      'src/services/withdrawal/withdrawal-processor.service.ts', 'src/components/subscription/RestrictedStateNotice.tsx',
      'src/components/account/WithdrawalCard.tsx',
    ]) {
      const code = read(f).split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
      expect(code, f).not.toMatch(/\b(90|80|30)\s*(\*\s*DAY|jours|days)\b/);
    }
  });
});
