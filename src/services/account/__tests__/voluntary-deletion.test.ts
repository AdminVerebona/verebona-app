/**
 * Suppression volontaire du compte, différée de 30 jours — orchestration.
 *
 * Dépendances simulées (aucune base, aucun Stripe) : on vérifie les
 * décisions et leur ORDRE. Les cascades réelles sont couvertes par
 * `voluntary-deletion.pg.test.ts` (opt-in, PostgreSQL jetable).
 */
import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  BillingUnavailableError,
  accountDeletionSweepMode,
  applyToLiveSubscriptions,
  cancelAccountDeletion,
  closeAccountForDeletion,
  daysUntil,
  getAccountDeletionStatus,
  isBacklog,
  runAccountDeletionSweep,
  runAccountDeletionSweepExclusive,
  sweepOptionsFor,
  toStatusView,
  type DeletionUser,
  type VoluntaryDeletionDeps,
} from '@/services/account/voluntary-deletion.service';
import type { ClaimResult, ExecutionResult, ScheduledDeletion } from '@/services/account/scheduled-deletion.service';
import { DeletionError } from '@/services/account/scheduled-deletion.service';
import { accountDeletionNotificationText } from '@/lib/notifications/catalog';

const DAY = 86_400_000;
const T0 = new Date('2026-10-01T09:00:00Z');

function schedule(over: Partial<ScheduledDeletion> = {}): ScheduledDeletion {
  return {
    id: 7, accountId: 11, userId: 3, reason: 'VOLUNTARY', origin: 'user', scope: 'user',
    confirmedAt: T0, scheduledAt: new Date(T0.getTime() + 30 * DAY), status: 'SCHEDULED',
    reminderJ7SentAt: null, reminderJ1SentAt: null, attemptCount: 0, anomalyReportedAt: null, ...over,
  };
}

function harness(opts: {
  user?: Partial<DeletionUser> | null;
  active?: ScheduledDeletion | null;
  stopRenewal?: () => Promise<string[]>;
  cancelNow?: () => Promise<string[]>;
  due?: ScheduledDeletion[];
  reminders?: { j7: ScheduledDeletion[]; j1: ScheduledDeletion[] };
  pendingFinal?: Array<{ id: number; email: string; confirmedAt: Date; executedAt: Date | null }>;
  sendFinal?: () => Promise<boolean>;
  claim?: ClaimResult;
  execution?: ExecutionResult;
  latest?: ScheduledDeletion | null;
} = {}) {
  const calls: string[] = [];
  const log = (name: string) => (...args: unknown[]) => { calls.push(name); return args; };
  const user: DeletionUser | null = opts.user === null ? null : {
    id: 3, email: 'membre@exemple.fr', firstName: 'Léa', passwordHash: 'hash', status: 'ACTIVE', role: 'USER',
    ...(opts.user ?? {}),
  };
  let active = opts.active ?? null;
  const deps: VoluntaryDeletionDeps = {
    loadUser: vi.fn(async () => user),
    verifyPassword: vi.fn(async (plain: string) => plain === 'bon-mot-de-passe'),
    resolveAccount: vi.fn(async () => 11),
    getActiveUserSchedule: vi.fn(async () => active),
    scheduleDeletion: vi.fn(async (input) => {
      log('schedule')();
      active = schedule({
        accountId: input.accountId, userId: input.userId, confirmedAt: input.confirmedAt!,
        scheduledAt: new Date(input.confirmedAt!.getTime() + (input.delayDays ?? 30) * DAY),
      });
      return active;
    }),
    cancelUserDeletion: vi.fn(async () => { log('cancel')(); const was = active; active = null; return was; }),
    markClosed: vi.fn(async () => { log('markClosed')(); if (user) user.status = 'PENDING_DELETION'; }),
    billing: {
      stopRenewal: vi.fn(async () => { log('stopRenewal')(); return opts.stopRenewal ? opts.stopRenewal() : ['sub_1']; }),
      cancelNow: vi.fn(async () => { log('cancelNow')(); return opts.cancelNow ? opts.cancelNow() : []; }),
    },
    detachSharing: vi.fn(async () => { log('detachSharing')(); return { role: 'duo_member' as const, removedMemberships: 1 }; }),
    revokeSessions: vi.fn(async () => { log('revokeSessions')(); return new Date(); }),
    notify: vi.fn(async (i) => { log(`notify:${i.type}`)(); }),
    markInitialEmailSent: vi.fn(async () => undefined),
    listDueReminders: vi.fn(async () => opts.reminders ?? { j7: [], j1: [] }),
    markReminderSent: vi.fn(async (_id, which) => { log(`markReminder:${which}`)(); }),
    listDueDeletions: vi.fn(async () => opts.due ?? []),
    listOverdueDeletions: vi.fn(async () => []),
    execute: vi.fn(async (_id, o) => {
      log(o.dryRun ? 'execute:dry' : 'execute')();
      if (o.dryRun) return { status: 'skipped' as const, reason: 'DRY_RUN' };
      return opts.execution ?? { status: 'executed' as const };
    }),
    getLatestUserSchedule: vi.fn(async () => opts.latest ?? null),
    claim: vi.fn(async () => {
      log('claim')();
      return opts.claim ?? { ok: true as const, user: user ? { id: user.id, email: user.email, status: user.status } : null };
    }),
    releaseClaim: vi.fn(async () => { log('releaseClaim')(); }),
    markFailed: vi.fn(async (_id, reason) => { log(`markFailed:${reason}`)(); }),
    reportAnomaly: vi.fn(async () => { log('anomaly')(); }),
    markAnomalyReported: vi.fn(async () => { log('anomalyReported')(); }),
    recordNotifyEmail: vi.fn(async () => { log('recordNotifyEmail')(); }),
    listPendingFinalEmails: vi.fn(async () => opts.pendingFinal ?? []),
    sendFinalEmail: vi.fn(async () => { log('sendFinal')(); return opts.sendFinal ? opts.sendFinal() : true; }),
    closeFinalEmail: vi.fn(async (_id, sent) => { log(`closeFinal:${sent}`)(); }),
  };
  return { deps, calls, user: () => user };
}

const confirm = { confirmation: ACCOUNT_DELETION_CONFIRMATION, password: 'bon-mot-de-passe', now: T0 };

describe('clôture (J0)', () => {
  it('exige le texte exact et le mot de passe, sans rien écrire sinon', async () => {
    const h = harness();
    expect(await closeAccountForDeletion({ userId: 3, ...confirm, confirmation: 'supprimer mon compte' }, h.deps))
      .toMatchObject({ ok: false, code: 'INVALID_CONFIRMATION' });
    expect(await closeAccountForDeletion({ userId: 3, ...confirm, password: '' }, h.deps))
      .toMatchObject({ ok: false, code: 'PASSWORD_REQUIRED' });
    expect(await closeAccountForDeletion({ userId: 3, ...confirm, password: 'faux' }, h.deps))
      .toMatchObject({ ok: false, code: 'INVALID_PASSWORD' });
    expect(h.calls).toEqual([]);
  });

  it('clôt le compte : plus de renouvellement AVANT toute écriture, puis date J+30 figée, partages, sessions, e-mail', async () => {
    const h = harness();
    const r = await closeAccountForDeletion({ userId: 3, ...confirm }, h.deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.schedule.scheduledAt.getTime() - T0.getTime()).toBe(30 * DAY);
    expect(r.stoppedSubscriptions).toEqual(['sub_1']);
    expect(h.calls).toEqual([
      'stopRenewal', 'schedule', 'markClosed', 'detachSharing', 'revokeSessions', 'notify:ACCOUNT_DELETION_SCHEDULED',
    ]);
    expect(h.deps.scheduleDeletion).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'VOLUNTARY', origin: 'user', delayDays: 30, confirmedAt: T0,
    }));
  });

  it('Stripe injoignable : refus explicite, rien n’est modifié', async () => {
    const h = harness({ stopRenewal: async () => { throw new BillingUnavailableError('timeout'); } });
    const r = await closeAccountForDeletion({ userId: 3, ...confirm }, h.deps);
    expect(r).toMatchObject({ ok: false, code: 'BILLING_UNAVAILABLE' });
    expect(h.calls).toEqual(['stopRenewal']);
  });

  it('idempotente : un compte déjà clôturé renvoie le compte à rebours existant sans rappeler Stripe', async () => {
    const h = harness({ user: { status: 'PENDING_DELETION' }, active: schedule() });
    const r = await closeAccountForDeletion({ userId: 3, ...confirm }, h.deps);
    expect(r).toMatchObject({ ok: true, alreadyClosed: true });
    expect(h.calls).toEqual([]);
  });

  it('reprise après interruption : compte à rebours existant, statut resté actif — étapes restantes rejouées', async () => {
    const h = harness({ active: schedule() });
    const r = await closeAccountForDeletion({ userId: 3, ...confirm }, h.deps);
    expect(r.ok && !r.alreadyClosed).toBe(true);
    expect(h.calls).not.toContain('schedule');
    expect(h.calls).toContain('markClosed');
  });

  it('compte administrateur ou suspendu : refusé en libre-service', async () => {
    expect(await closeAccountForDeletion({ userId: 3, ...confirm }, harness({ user: { role: 'ADMIN' } }).deps))
      .toMatchObject({ ok: false, code: 'ADMIN_ACCOUNT' });
    expect(await closeAccountForDeletion({ userId: 3, ...confirm }, harness({ user: { status: 'SUSPENDED' } }).deps))
      .toMatchObject({ ok: false, code: 'USER_NOT_ACTIVE' });
  });
});

describe('annulation', () => {
  it('rétablit l’accès et révoque les jetons « clôturés » ; ne touche ni Stripe ni les partages', async () => {
    const h = harness({ user: { status: 'PENDING_DELETION' }, active: schedule() });
    const r = await cancelAccountDeletion({ userId: 3, now: new Date(T0.getTime() + 3 * DAY) }, h.deps);
    expect(r.ok).toBe(true);
    expect(h.calls).toEqual(['cancel', 'revokeSessions']);
    expect(h.deps.billing.stopRenewal).not.toHaveBeenCalled();
    expect(h.deps.billing.cancelNow).not.toHaveBeenCalled();
  });

  it('exécution déjà réservée par le balayage : IN_PROGRESS, sessions intactes', async () => {
    const h = harness({ user: { status: 'PENDING_DELETION' }, active: schedule() });
    (h.deps.cancelUserDeletion as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new DeletionError('DELETION_IN_PROGRESS', 'en cours'));
    expect(await cancelAccountDeletion({ userId: 3 }, h.deps)).toEqual({ ok: false, code: 'IN_PROGRESS' });
    expect(h.deps.revokeSessions).not.toHaveBeenCalled();
  });

  it('compte clôturé sans compte à rebours actif (exécution en échec) : annulation possible', async () => {
    const h = harness({ user: { status: 'PENDING_DELETION' }, active: null });
    expect((await cancelAccountDeletion({ userId: 3 }, h.deps)).ok).toBe(true);
  });

  it('aucune suppression en cours : NOT_PENDING', async () => {
    expect(await cancelAccountDeletion({ userId: 3 }, harness().deps)).toEqual({ ok: false, code: 'NOT_PENDING' });
  });
});

describe('balayage quotidien', () => {
  const closedUser = { status: 'PENDING_DELETION' };

  it('J+30 : résiliation immédiate, partages rompus, adresse relevée, exécution, confirmation finale — dans cet ordre', async () => {
    const h = harness({ user: closedUser, due: [schedule()] });
    const now = new Date(T0.getTime() + 30 * DAY + 60_000);
    const r = await runAccountDeletionSweep({ now }, h.deps);
    expect(r.deletions).toEqual({ executed: 1, skipped: 0, failed: 0, deferred: 0, backlog: 0 });
    // Réservation sous verrou AVANT toute étape irréversible (Stripe, Duo).
    expect(h.calls).toEqual(['claim', 'cancelNow', 'detachSharing', 'recordNotifyEmail', 'execute', 'sendFinal', 'closeFinal:true']);
    expect(h.deps.sendFinalEmail).toHaveBeenCalledWith('membre@exemple.fr', {
      requestedAt: '1 octobre 2026', deletedAt: '31 octobre 2026',
    });
  });

  it('dry-run : rien n’est écrit, résilié ni envoyé', async () => {
    const h = harness({
      user: closedUser, due: [schedule()], reminders: { j7: [schedule({ id: 8 })], j1: [] },
      pendingFinal: [{ id: 1, email: 'x@y.fr', confirmedAt: T0, executedAt: T0 }],
    });
    const r = await runAccountDeletionSweep({ now: T0, dryRun: true }, h.deps);
    expect(r.dryRun).toBe(true);
    expect(h.calls).toEqual(['execute:dry']);
    expect(r.reminders.j7).toBe(1);
  });

  it('Stripe injoignable à J+30 : reportée (reste programmée), rien n’est supprimé', async () => {
    const h = harness({ user: closedUser, due: [schedule()], cancelNow: async () => { throw new BillingUnavailableError('503'); } });
    const r = await runAccountDeletionSweep({ now: T0 }, h.deps);
    expect(r.deletions.deferred).toBe(1);
    expect(r.deferred[0].reason).toContain('STRIPE_UNAVAILABLE');
    // Réservation rendue : l'utilisateur peut encore annuler.
    expect(h.calls).toEqual(['claim', 'cancelNow', 'releaseClaim']);
  });

  it('garde-fou : un utilisateur non clôturé n’est jamais supprimé — état FAILED terminal, anomalie signalée une fois', async () => {
    const h = harness({ due: [schedule()], claim: { ok: false, reason: 'USER_NOT_CLOSED', userStatus: 'ACTIVE' } });
    const r = await runAccountDeletionSweep({ now: T0 }, h.deps);
    expect(r.deletions.failed).toBe(1);
    expect(r.failures[0].reason).toMatch(/USER_NOT_CLOSED/);
    expect(h.calls).toEqual(['claim', 'markFailed:USER_NOT_CLOSED (statut ACTIVE)', 'anomaly', 'anomalyReported']);
    // Déjà signalée : pas de second signalement.
    const h2 = harness({
      due: [schedule({ anomalyReportedAt: T0 })], claim: { ok: false, reason: 'USER_NOT_CLOSED', userStatus: 'ACTIVE' },
    });
    await runAccountDeletionSweep({ now: T0 }, h2.deps);
    expect(h2.calls).not.toContain('anomaly');
  });

  it('annulation concurrente gagnante (plus programmée) ou exécution déjà réservée : rien n’est fait', async () => {
    for (const reason of ['NOT_SCHEDULED', 'IN_PROGRESS'] as const) {
      const h = harness({ user: closedUser, due: [schedule()], claim: { ok: false, reason } });
      const r = await runAccountDeletionSweep({ now: T0 }, h.deps);
      expect(r.deletions.skipped).toBe(1);
      expect(h.calls).toEqual(['claim']);
    }
  });

  it('exécution qui constate une annulation sous verrou (skipped) : réservation rendue, pas d’e-mail final', async () => {
    const h = harness({ user: closedUser, due: [schedule()], execution: { status: 'skipped', reason: 'STATUS_CANCELLED' } });
    await runAccountDeletionSweep({ now: T0 }, h.deps);
    expect(h.calls.slice(-2)).toEqual(['execute', 'releaseClaim']);
    expect(h.deps.sendFinalEmail).not.toHaveBeenCalled();
  });

  it('échec d’exécution : compté, signalé en anomalie (reprise différée gérée par l’exécution)', async () => {
    const h = harness({
      user: closedUser, due: [schedule()],
      execution: { status: 'failed', reason: 'ORPHANS_LEFT', retryAt: new Date(T0.getTime() + DAY) },
    });
    const r = await runAccountDeletionSweep({ now: T0 }, h.deps);
    expect(r.deletions.failed).toBe(1);
    expect(h.deps.reportAnomaly).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: 7, reason: 'ORPHANS_LEFT' }));
    expect(h.deps.sendFinalEmail).not.toHaveBeenCalled();
  });

  it('une erreur inattendue sur une échéance n’interrompt pas les suivantes', async () => {
    const h = harness({ user: closedUser, due: [schedule({ id: 1 }), schedule({ id: 2 })] });
    (h.deps.detachSharing as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boum'));
    const r = await runAccountDeletionSweep({ now: T0 }, h.deps);
    expect(r.deletions.failed).toBe(1);
    expect(r.deletions.executed).toBe(1);
    expect(h.calls).toContain('releaseClaim');
  });

  it('utilisateur déjà disparu : l’exécution constate et clôt la trace, sans Stripe ni e-mail', async () => {
    const h = harness({ user: null, due: [schedule()] });
    await runAccountDeletionSweep({ now: T0 }, h.deps);
    expect(h.calls).toEqual(['claim', 'execute']);
  });

  it('arriéré (échéance > 7 j jamais tentée) : ignoré et signalé une fois, sauf includeBacklog', async () => {
    const now = new Date(T0.getTime() + 45 * DAY); // échéance J+30 dépassée de 15 j
    const h = harness({ user: closedUser, due: [schedule()] });
    const r = await runAccountDeletionSweep({ now }, h.deps);
    expect(r.deletions.backlog).toBe(1);
    expect(h.calls).toEqual(['anomaly', 'anomalyReported']);

    const reported = harness({ user: closedUser, due: [schedule({ anomalyReportedAt: now })] });
    await runAccountDeletionSweep({ now }, reported.deps);
    expect(reported.calls).toEqual([]);

    const live = harness({ user: closedUser, due: [schedule()] });
    expect((await runAccountDeletionSweep({ now, includeBacklog: true }, live.deps)).deletions.executed).toBe(1);

    // Une reprise après échec n'est pas un arriéré.
    expect(isBacklog(schedule({ attemptCount: 2 }), now)).toBe(false);
    expect(isBacklog(schedule(), new Date(T0.getTime() + 36 * DAY))).toBe(false);
    expect(isBacklog(schedule(), new Date(T0.getTime() + 38 * DAY))).toBe(true);
  });

  it('autres motifs (rétractation, impayé…) : exécution directe par le workflow unique', async () => {
    const h = harness({ due: [schedule({ reason: 'WITHDRAWAL', scope: 'account' })] });
    await runAccountDeletionSweep({ now: T0 }, h.deps);
    expect(h.calls).toEqual(['execute']);
  });

  it('rappels : e-mail J-7 pour la seule suppression volontaire ; J-1 marqué sans e-mail', async () => {
    const h = harness({
      reminders: {
        j7: [schedule({ id: 1 }), schedule({ id: 2, reason: 'WITHDRAWAL', scope: 'account' })],
        j1: [schedule({ id: 3, reminderJ7SentAt: T0 })],
      },
    });
    const r = await runAccountDeletionSweep({ now: new Date(T0.getTime() + 23 * DAY) }, h.deps);
    expect(r.reminders).toEqual({ j7: 2, j1: 1, emails: 1 });
    expect(h.calls).toEqual(['notify:ACCOUNT_DELETION_REMINDER', 'markReminder:j7', 'markReminder:j7', 'markReminder:j1']);
    expect(h.deps.notify).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: 1, daysLeft: 7 }));
  });

  it('rappel J-7 manqué : envoyé au moment du J-1 (suppression volontaire)', async () => {
    const h = harness({ reminders: { j7: [], j1: [schedule({ id: 4 }), schedule({ id: 5, reminderJ7SentAt: T0 })] } });
    const r = await runAccountDeletionSweep({ now: new Date(T0.getTime() + 29.5 * DAY) }, h.deps);
    expect(r.reminders.emails).toBe(1);
    expect(h.calls).toEqual(['notify:ACCOUNT_DELETION_REMINDER', 'markReminder:j7', 'markReminder:j1', 'markReminder:j1']);
  });

  it('rappel J-7 en échec : non marqué, retenté au passage suivant', async () => {
    const h = harness({ reminders: { j7: [schedule()], j1: [] } });
    (h.deps.notify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('smtp'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await runAccountDeletionSweep({ now: T0 }, h.deps);
    expect(h.deps.markReminderSent).not.toHaveBeenCalled();
  });

  it('confirmation finale : renvoyée si l’envoi avait échoué, abandonnée (adresse effacée) au-delà de 7 jours', async () => {
    const now = new Date('2026-11-10T09:00:00Z');
    const h = harness({
      pendingFinal: [
        { id: 1, email: 'a@b.fr', confirmedAt: T0, executedAt: new Date(now.getTime() - 2 * DAY) },
        { id: 2, email: 'c@d.fr', confirmedAt: T0, executedAt: new Date(now.getTime() - 8 * DAY) },
      ],
    });
    const r = await runAccountDeletionSweep({ now }, h.deps);
    expect(r.finalEmails).toEqual({ sent: 1, abandoned: 1 });
    expect(h.calls).toEqual(['sendFinal', 'closeFinal:true', 'closeFinal:false']);
  });

  it('idempotence : un second passage le même jour ne refait rien (échéances déjà exécutées)', async () => {
    const h = harness({ user: closedUser, due: [schedule()] });
    await runAccountDeletionSweep({ now: T0 }, h.deps);
    (h.deps.listDueDeletions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    h.calls.length = 0;
    const r = await runAccountDeletionSweep({ now: T0 }, h.deps);
    expect(r.deletions).toEqual({ executed: 0, skipped: 0, failed: 0, deferred: 0, backlog: 0 });
    expect(h.calls).toEqual([]);
  });
});

describe('état exposé à l’écran « Compte en cours de suppression »', () => {
  it('clôturé sans compte à rebours actif : « closed » (jamais « none », qui renverrait en boucle)', async () => {
    const h = harness({ user: { status: 'PENDING_DELETION' }, active: null, latest: schedule({ status: 'SCHEDULED' }) });
    const v = await getAccountDeletionStatus(3, T0, h.deps);
    expect(v.status).toBe('closed');
    expect(v.scheduledAt).toBe('2026-10-31T09:00:00.000Z');
    expect((await getAccountDeletionStatus(3, T0, harness().deps)).status).toBe('none');
    expect((await getAccountDeletionStatus(3, T0, harness({ active: schedule() }).deps)).status).toBe('scheduled');
  });
});

describe('verrou d’exécution partagé (tâche interne / route)', () => {
  it('balayage déjà en cours : rien n’est fait ; sinon verrou pris puis rendu', async () => {
    const h = harness();
    const busy = { acquire: vi.fn(async () => null), release: vi.fn(async () => undefined) };
    expect(await runAccountDeletionSweepExclusive({ now: T0 }, h.deps, busy)).toBeNull();
    expect(h.deps.listDueDeletions).not.toHaveBeenCalled();
    const free = { acquire: vi.fn(async () => ({ id: 'bail' })), release: vi.fn(async () => undefined) };
    expect(await runAccountDeletionSweepExclusive({ now: T0 }, h.deps, free)).not.toBeNull();
    expect(free.acquire).toHaveBeenCalledWith('account-deletion-sweep', expect.any(Number));
    expect(free.release).toHaveBeenCalledWith({ id: 'bail' });
  });
});

describe('Stripe : fin du renouvellement (J0) et résiliation (J+30)', () => {
  function stripe(subs: Record<string, { status: string; cancel_at_period_end?: boolean } | 'missing' | 'down'>) {
    const client = {
      subscriptions: {
        retrieve: vi.fn(async (id: string) => {
          const s = subs[id];
          if (s === 'missing' || !s) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 });
          if (s === 'down') throw Object.assign(new Error('api_connection_error'), { code: 'api_connection_error' });
          return { id, status: s.status, cancel_at_period_end: Boolean(s.cancel_at_period_end) };
        }),
        update: vi.fn(async () => ({})),
        cancel: vi.fn(async () => ({})),
      },
    };
    return { client, factory: () => client as unknown as Pick<Stripe, 'subscriptions'> };
  }

  it('J0 : actif → fin de période (pas de remboursement) ; impayé → résilié immédiatement ; déjà résilié ou inconnu → ignoré', async () => {
    const s = stripe({
      sub_actif: { status: 'active' },
      sub_impaye: { status: 'past_due' },
      sub_deja: { status: 'active', cancel_at_period_end: true },
      sub_fini: { status: 'canceled' },
      sub_inconnu: 'missing',
    });
    const touched = await applyToLiveSubscriptions(['sub_actif', 'sub_impaye', 'sub_deja', 'sub_fini', 'sub_inconnu'], s.factory, 'stop_renewal');
    expect(touched).toEqual(['sub_actif', 'sub_impaye']);
    expect(s.client.subscriptions.update).toHaveBeenCalledWith('sub_actif', { cancel_at_period_end: true });
    expect(s.client.subscriptions.cancel).toHaveBeenCalledWith('sub_impaye', { invoice_now: false, prorate: false });
  });

  it('J+30 : tout ce qui facture encore est résilié immédiatement, sans prorata', async () => {
    const s = stripe({ a: { status: 'active', cancel_at_period_end: true }, b: { status: 'trialing' }, c: { status: 'canceled' } });
    expect(await applyToLiveSubscriptions(['a', 'b', 'c'], s.factory, 'cancel_now')).toEqual(['a', 'b']);
    expect(s.client.subscriptions.cancel).toHaveBeenCalledTimes(2);
  });

  it('erreur Stripe autre qu’un abonnement inconnu : BillingUnavailableError', async () => {
    const s = stripe({ a: 'down' });
    await expect(applyToLiveSubscriptions(['a'], s.factory, 'stop_renewal')).rejects.toBeInstanceOf(BillingUnavailableError);
  });

  it('aucun abonnement : Stripe n’est pas sollicité (fonctionne sans configuration Stripe)', async () => {
    const factory = vi.fn(() => { throw new BillingUnavailableError('non configuré'); });
    expect(await applyToLiveSubscriptions([], factory, 'cancel_now')).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('règles pures', () => {
  it('ACCOUNT_DELETION_SWEEP : absente ⇒ safe (sans l’arriéré), live explicite ⇒ arriéré compris, faute de frappe ⇒ dry', () => {
    expect(accountDeletionSweepMode(undefined)).toBe('safe');
    expect(accountDeletionSweepMode('')).toBe('safe');
    expect(accountDeletionSweepMode('live')).toBe('live');
    expect(sweepOptionsFor('safe')).toEqual({ dryRun: false, includeBacklog: false });
    expect(sweepOptionsFor('live')).toEqual({ dryRun: false, includeBacklog: true });
    expect(sweepOptionsFor('dry')).toEqual({ dryRun: true, includeBacklog: false });
    expect(accountDeletionSweepMode('dry')).toBe('dry');
    expect(accountDeletionSweepMode('off')).toBe('off');
    expect(accountDeletionSweepMode('lvie')).toBe('dry');
  });

  it('jours restants et état exposé', () => {
    expect(daysUntil(new Date(T0.getTime() + 30 * DAY), T0)).toBe(30);
    expect(daysUntil(new Date(T0.getTime() + 29.5 * DAY), T0)).toBe(30);
    expect(daysUntil(T0, new Date(T0.getTime() + DAY))).toBe(0);
    expect(toStatusView(null, T0)).toEqual({ status: 'none', confirmedAt: null, scheduledAt: null, daysLeft: null });
    expect(toStatusView(schedule(), T0)).toEqual({
      status: 'scheduled', confirmedAt: T0.toISOString(), scheduledAt: '2026-10-31T09:00:00.000Z', daysLeft: 30,
    });
  });

  it('e-mails : la date de suppression figure dans la confirmation et le rappel', () => {
    expect(accountDeletionNotificationText('SCHEDULED', '2026-10-31T09:00:00Z')).toContain('supprimé le 31 octobre 2026');
    expect(accountDeletionNotificationText('SCHEDULED', '2026-10-31T09:00:00Z')).toContain('annuler la suppression');
    expect(accountDeletionNotificationText('REMINDER', '2026-10-31T09:00:00Z')).toContain('le 31 octobre 2026');
  });
});
