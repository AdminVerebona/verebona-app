import { NextResponse } from 'next/server';
import { db } from '@/db';
import { duoAccounts, dunningEvents } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

/**
 * GET /api/cron/duo-dunning
 * Suivi quotidien des impayés Premium Duo. Appelé par le planificateur externe
 * de l'hébergement (Scalingo Scheduler, crontab…) avec CRON_SECRET — non
 * planifié dans le dépôt (voir .env.example).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PLUS DE PÉRIODE DE GRÂCE (APP-FUNC-31)
 *
 * Cette tâche faisait passer un Duo de PAST_DUE_GRACE (15 jours pendant
 * lesquels tout restait permis) à UNPAID_RECOVERY une fois la « grâce »
 * échue. Le passage est désormais IMMÉDIAT, au premier échec de paiement
 * (webhook `invoice.payment_failed` ou synchronisation `past_due`) : il n'y a
 * plus rien à faire basculer ici.
 *
 * Reste le jalonnement du délai de récupération (`unpaid_recovery_ends_at`,
 * = échéance du cycle du compte payeur) : étapes D14 / D7 / D1 consignées
 * dans `dunning_events` (une fois par étape). Les rappels envoyés aux
 * clients (J-7, J-1) et la fin du délai relèvent du balayage du cycle
 * d'impayé (`billing-unpaid`), pas de cette tâche.
 * ══════════════════════════════════════════════════════════════════════════
 */
export async function GET(request: Request) {
  // Vérification de la clé secrète pour éviter les appels malveillants
  const authHeader = request.headers.get('authorization');
  // Secret non configuré : refus. Sans ce garde, l'en-tête littéral
  // « Bearer undefined » suffisait à déclencher la tâche.
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const results = { d1: 0, d7: 0, d14: 0 };

  try {
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

      await db.insert(dunningEvents).values({ duoId: account.id, stage, sentAt: now }).onConflictDoNothing();
      if (stage === 'D1') results.d1++;
      else if (stage === 'D7') results.d7++;
      else results.d14++;
    }

    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error('[Dunning Cron Error]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
