/**
 * Rappel de fin d'essai à J-2 (CDC §7.6 TRIAL_ENDING).
 *
 * Émis dans le créneau du matin. Sélectionne les abonnements encore en essai
 * dont la fin tombe dans ~2 jours (fenêtre de 24 h). Déduplication stable par
 * compte et date de fin d'essai → un seul rappel par essai.
 */

import { db } from '@/db';
import { accountSubscriptions } from '@/db/schema';
import { and, eq, gte, lt } from 'drizzle-orm';
import { emit } from '@/lib/notifications';

export interface TrialEndingRunResult { emitted: number }

export async function runTrialEndingReminders(now: Date = new Date()): Promise<TrialEndingRunResult> {
  const from = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000); // J+1
  const to = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);   // J+2

  const rows = await db
    .select({ accountId: accountSubscriptions.accountId, trialEndsAt: accountSubscriptions.trialEndsAt })
    .from(accountSubscriptions)
    .where(and(
      eq(accountSubscriptions.status, 'trialing'),
      gte(accountSubscriptions.trialEndsAt, from),
      lt(accountSubscriptions.trialEndsAt, to),
    ));

  let emitted = 0;
  for (const row of rows) {
    if (!row.trialEndsAt) continue;
    const endsDate = new Date(row.trialEndsAt).toISOString().slice(0, 10);
    await emit({
      type: 'TRIAL_ENDING',
      accountId: row.accountId,
      entityType: 'account',
      entityId: row.accountId,
      payload: { endsAt: new Date(row.trialEndsAt).toISOString() },
      dedupeKey: `account:trial-ending:${row.accountId}:${endsDate}`,
      scheduledFor: now,
    });
    emitted++;
  }

  return { emitted };
}
