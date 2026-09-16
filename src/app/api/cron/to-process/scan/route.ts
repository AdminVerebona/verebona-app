/**
 * GET /api/cron/to-process/scan — balayage de la file (CDC V2.0 §9.2, §10).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DEUX TRAVAUX QUI DOIVENT TOURNER ENSEMBLE
 *
 * 1. PRODUIRE. Agenda sans date, équipement sans bien, fournisseur à
 *    confirmer : trois problèmes qui naissent d'un état de la base, et
 *    qu'aucune analyse ne déclenche.
 *
 * 2. PROMOUVOIR. Une échéance qui approche change de priorité (§9.2). Le
 *    franchissement n'est provoqué par personne — le temps passe, c'est tout.
 *
 * Les séparer en deux tâches planifiées n'apporterait rien et doublerait les
 * chances qu'une des deux soit oubliée à la configuration.
 *
 * ── FRÉQUENCE ─────────────────────────────────────────────────────────────
 *
 * Une fois par heure suffit. Le §9.2 parle d'un seuil en JOURS : détecter le
 * franchissement à l'heure près est déjà bien plus précis que nécessaire, et
 * un balayage par minute ferait N requêtes par compte pour ne rien trouver.
 *
 *   ?account=42   limite à un compte
 *   ?limit=500    nombre de comptes balayés sur ce passage
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, ensureMigrations } from '@/db';
import { accounts } from '@/db/schema';
import { withJobLock } from '@/lib/job-lock';
import {
  closeActionsForDeletedTargets,
  produceAccountActions,
} from '@/services/to-process/producers.service';
import { promoteDueActions } from '@/services/to-process/priority-scheduler.service';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  await ensureMigrations();

  const p = req.nextUrl.searchParams;
  const accountId = Number(p.get('account')) || undefined;
  const limit = Number(p.get('limit')) || 500;

  const resultat = await withJobLock('to-process-scan', 10 * 60_000, async () => {
    const cibles = accountId
      ? await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId))
      : await db.select({ id: accounts.id }).from(accounts).limit(limit);

    const totaux = { created: 0, updated: 0, closed: 0, promoted: 0, demoted: 0, refused: 0 };

    for (const compte of cibles) {
      try {
        const production = await produceAccountActions(compte.id);
        totaux.created += production.created;
        totaux.updated += production.updated;
        totaux.closed += production.closed;
        totaux.closed += await closeActionsForDeletedTargets(compte.id);

        const promotion = await promoteDueActions(compte.id);
        totaux.promoted += promotion.promoted;
        totaux.demoted += promotion.demoted;
        totaux.refused += promotion.refused;
      } catch (e) {
        // Un compte en échec ne doit pas arrêter le balayage des autres : le
        // passage suivant le rattrapera.
        console.error('[to-process-scan] compte', compte.id, (e as Error).message);
      }
    }

    return { accounts: cibles.length, ...totaux };
  });

  if (resultat === null) {
    console.warn(
      '[to-process-scan] Verrou non obtenu. Si aucun autre tour ne tourne, ' +
        'chercher « [job-lock] acquisition impossible » dans les journaux.',
    );
    return NextResponse.json({ skipped: 'locked' });
  }

  return NextResponse.json(resultat);
}
