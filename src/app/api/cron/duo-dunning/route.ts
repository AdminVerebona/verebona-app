import { NextResponse } from 'next/server';
import { runDuoDunning } from '@/services/billing/duo-dunning.job';

/**
 * GET /api/cron/duo-dunning
 * Suivi quotidien des impayés Premium Duo. Lot 25 : planifié DANS
 * l'application (tâche interne `duo-dunning`, traitement `duo-dunning.job.ts`) ;
 * cette route, protégée par CRON_SECRET, ne sert plus qu'au déclenchement
 * manuel. Double passage sans effet (une étape par duo, index unique).
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

  try {
    const results = await runDuoDunning();
    return NextResponse.json({ success: true, results });
  } catch (error) {
    console.error('[Dunning Cron Error]', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
