/**
 * GET /api/cron/withdrawal/process — CDC 6 §10 et §21.
 *
 * Traite les déclarations en attente et reprend celles qui ont échoué.
 *
 * Deux populations :
 *   · `received`  — confirmées mais jamais traitées. Cas nominal : la
 *     déclaration est écrite en synchrone, le traitement Stripe en différé
 *     (§7.4) ;
 *   · `failed`    — reprise automatique. Le §10 prévoit « le traitement des
 *     erreurs et les reprises automatiques ».
 *
 * Lot 25 : planifié DANS l'application (tâche interne `withdrawal-process`,
 * horaire, traitement `withdrawal-sweep.job.ts`). Un seul balayage à la fois
 * (bail en base partagé avec la tâche interne) : appelée pendant un passage
 * en cours, la route répond 200 `{ skipped: 'locked' }`.
 *
 * Répond **409** dès qu'une demande reste en échec après reprise, ou qu'une
 * demande attend depuis plus de vingt-quatre heures. Le §21 fait de ces
 * situations des anomalies à détecter — sans ce signal, une demande bloquée
 * resterait invisible jusqu'à la réclamation du consommateur.
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { runWithdrawalSweep } from '@/services/withdrawal/withdrawal-sweep.job';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();
  const r = await runWithdrawalSweep(new Date());
  if (r === null) return NextResponse.json({ skipped: 'locked' });

  return NextResponse.json(
    r,
    { status: r.outcome.failed > 0 || r.stale.length > 0 ? 409 : 200 },
  );
}
