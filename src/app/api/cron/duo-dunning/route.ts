import { NextResponse } from 'next/server';
import { db } from '@/db';
import { duoAccounts, dunningEvents, duoMemberships, users } from '@/db/schema';
import { eq, and, isNull, lt, sql } from 'drizzle-orm';

/**
 * GET /api/cron/duo-dunning
 * Cron quotidien pour gérer le dunning des comptes Duo
 * Devrait être appelé via une tâche planifiée (ex: Vercel Cron)
 */
export async function GET(request: Request) {
  // Vérification de la clé secrète pour éviter les appels malveillants
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const results = {
    recovery: 0,
    d1: 0,
    d7: 0,
    d14: 0,
  };

  try {
    // 1. Passage en RECOVERY
    const recoveryAccounts = await db
      .select()
      .from(duoAccounts)
      .where(
        and(
          eq(duoAccounts.subscriptionStatus, 'PAST_DUE_GRACE'),
          lt(duoAccounts.graceDeadlineAt, now)
        )
      );

    for (const account of recoveryAccounts) {
      await db
        .update(duoAccounts)
        .set({
          subscriptionStatus: 'UNPAID_RECOVERY',
          updatedAt: now,
        })
        .where(eq(duoAccounts.id, account.id));
      
      await db.insert(dunningEvents).values({
        duoId: account.id,
        stage: 'RECOVERY',
        sentAt: now,
      }).onConflictDoNothing();

      results.recovery++;
      // TODO: Envoyer email de passage en recovery
    }

    // 2. Dunning progressif (D1, D7, D14)
    const activeGraceAccounts = await db
      .select()
      .from(duoAccounts)
      .where(eq(duoAccounts.subscriptionStatus, 'PAST_DUE_GRACE'));

    for (const account of activeGraceAccounts) {
      if (!account.graceDeadlineAt) continue;

      const deadline = new Date(account.graceDeadlineAt);
      const diffDays = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      let stage: 'D1' | 'D7' | 'D14' | null = null;
      if (diffDays <= 1) stage = 'D1';
      else if (diffDays <= 7) stage = 'D7';
      else if (diffDays <= 14) stage = 'D14';

      if (stage) {
        // Vérifier si déjà envoyé pour ce stage
          const [existing] = await db
            .select()
            .from(dunningEvents)
            .where(and(eq(dunningEvents.duoId, account.id), eq(dunningEvents.stage, stage)))
            .limit(1);

          if (!existing) {
            await db.insert(dunningEvents).values({
            duoId: account.id,
            stage,
            sentAt: now,
          });

          if (stage === 'D1') results.d1++;
          else if (stage === 'D7') results.d7++;
          else if (stage === 'D14') results.d14++;

          // TODO: Envoyer email dunning correspondant
        }
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error('[Dunning Cron Error]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
