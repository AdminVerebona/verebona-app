/**
 * Jalonnement quotidien du délai de récupération des Duo impayés.
 *
 * Traitement partagé par GET /api/cron/duo-dunning et la tâche planifiée
 * interne `duo-dunning` (lot 25).
 *
 * Plus de période de grâce (APP-FUNC-31) : le passage en UNPAID_RECOVERY est
 * immédiat au premier échec de paiement. Reste à consigner les étapes
 * D14 / D7 / D1 du délai (`unpaid_recovery_ends_at`) dans `dunning_events`,
 * une fois par étape. Les rappels aux clients relèvent du cycle d'impayé
 * (`billing-unpaid`), pas de cette tâche.
 *
 * Sûr en double exécution : index unique (duo, étape) et
 * `ON CONFLICT DO NOTHING` — un second passage simultané n'écrit rien.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { duoAccounts, dunningEvents } from '@/db/schema';

export interface DuoDunningResult { d1: number; d7: number; d14: number }

export async function runDuoDunning(now: Date = new Date()): Promise<DuoDunningResult> {
  const results: DuoDunningResult = { d1: 0, d7: 0, d14: 0 };

  const unpaidDuos = await db
    .select()
    .from(duoAccounts)
    .where(eq(duoAccounts.subscriptionStatus, 'UNPAID_RECOVERY'));

  for (const account of unpaidDuos) {
    if (!account.unpaidRecoveryEndsAt) continue;

    const deadline = new Date(account.unpaidRecoveryEndsAt);
    const diffDays = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    let stage: 'D1' | 'D7' | 'D14' | null = null;
    if (diffDays <= 1) stage = 'D1';
    else if (diffDays <= 7) stage = 'D7';
    else if (diffDays <= 14) stage = 'D14';
    if (!stage) continue;

    // Une seule fois par étape (index unique duo / étape).
    const [existing] = await db
      .select({ id: dunningEvents.id })
      .from(dunningEvents)
      .where(and(eq(dunningEvents.duoId, account.id), eq(dunningEvents.stage, stage)))
      .limit(1);
    if (existing) continue;

    const inserted = await db.insert(dunningEvents)
      .values({ duoId: account.id, stage, sentAt: now })
      .onConflictDoNothing()
      .returning({ id: dunningEvents.id });
    if (inserted.length === 0) continue;
    if (stage === 'D1') results.d1++;
    else if (stage === 'D7') results.d7++;
    else results.d14++;
  }

  return results;
}
