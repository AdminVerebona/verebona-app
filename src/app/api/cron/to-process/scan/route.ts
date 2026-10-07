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
 * Lot 25 : planifié DANS l'application (tâche interne `to-process-scan`,
 * horaire, traitement `to-process-scan.job.ts`, même bail en base) ; cette
 * route ne sert plus qu'au déclenchement manuel.
 *
 *   ?account=42   limite à un compte
 *   ?limit=500    nombre de comptes balayés sur ce passage (le suivant
 *                 reprend au curseur) ; défaut : 5 000
 *
 * Lot 28 : chaque passage (route ou tâche) est tracé dans
 * `to_process_scan_runs`, consultable dans le BO (Exploitation › Tâches
 * planifiées). La notification des nouvelles actions est une AUTRE tâche
 * (`/api/cron/notifications/to-process-scan`) : elle ne produit rien.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { runToProcessFullScan } from '@/services/to-process/to-process-scan.job';

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
  const limit = Number(p.get('limit')) || undefined;

  const resultat = await runToProcessFullScan({ accountId, limit, trigger: 'route' });

  if (resultat === null) {
    console.warn(
      '[to-process-scan] Verrou non obtenu. Si aucun autre tour ne tourne, ' +
        'chercher « [job-lock] acquisition impossible » dans les journaux.',
    );
    return NextResponse.json({ skipped: 'locked' });
  }

  return NextResponse.json(resultat);
}
