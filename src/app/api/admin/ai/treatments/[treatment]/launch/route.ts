/**
 * POST /api/admin/ai/treatments/[treatment]/launch — lancement manuel batch
 * (CDC BO IA WF-11, OPS-016, T1-021, T1-UI-12, T3-UI-08, T4-UI-07 ; lot IA 2).
 *
 * Corps : { accountIds?: number[]; all?: boolean; dryRun?: boolean }.
 *   · dryRun = true : estimation du périmètre (WF-11 étape 64), rien n'est créé ;
 *   · sinon : un job `origin = manual` par objet, sans déduplication.
 *
 * 409 EMERGENCY_STOP si l'arrêt d'urgence est engagé (précondition WF-11) ;
 * 422 pour un traitement non batch, un périmètre vide ou trop large, ou
 * NO_JOB_CREATED (lot 52A) quand aucun job n'a été persisté (motif explicite).
 * Lot 54A (contrat strict) : 202 SEULEMENT si au moins un job est relu en
 * base (`jobIds` non vide) ; 5xx `INSERT_FAILED` / `PERSISTENCE_NOT_CONFIRMED`
 * (erreur technique, étape et jobs déjà créés dans `details`), 500
 * `LAUNCH_FAILED` pour toute autre panne — message exploitable, journalisé.
 * 202 : `jobIds` = jobs RÉELLEMENT persistés ; le boucleur est réveillé. T4 force
 * un nouveau passage sur les échéances candidates T1 persistées (T4-016). Un traitement désactivé ou suspendu accepte la demande, qui
 * attend sa réactivation (`waitsForReactivation`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  launchManual, defaultManualLaunchDeps, ManualLaunchRefused, ManualLaunchFailed,
} from '@/services/ai/queue/manual-launch';
import { requireAdminContext } from '../../../config-versions/_shared';

const Body = z.object({
  accountIds: z.array(z.number().int().positive()).max(1_000).optional(),
  all: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ treatment: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { treatment } = await params;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'INVALID_PAYLOAD', message: 'Périmètre invalide.' }, { status: 400 });
  }

  try {
    const result = await launchManual(
      treatment, parsed.data, guard.ctx.adminUserId, { dryRun: parsed.data.dryRun }, await defaultManualLaunchDeps(),
    );
    if (!result.dryRun && (!Array.isArray(result.jobIds) || result.jobIds.length === 0)) {
      // Lot 54A : garde-fou du contrat — jamais 202 sans job (ne devrait pas arriver).
      return NextResponse.json(
        { error: 'NO_JOB_CREATED', message: `Aucun job ${treatment} n’a été créé.`, details: { reasons: result.reasons ?? {} } },
        { status: 422 },
      );
    }
    return NextResponse.json(result, { status: result.dryRun ? 200 : 202 });
  } catch (e) {
    if (e instanceof ManualLaunchRefused) {
      // Lot 52A (COR-02) : motif explicite et éléments non retenus, jamais un succès trompeur.
      return NextResponse.json(
        { error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) },
        { status: e.code === 'EMERGENCY_STOP' ? 409 : 422 },
      );
    }
    if (e instanceof ManualLaunchFailed) {
      // Lot 54A : erreur TECHNIQUE — 5xx, étape et cause exploitables (journal + BO).
      console.error(`[POST /api/admin/ai/treatments/${treatment}/launch] ${e.code} (étape ${e.details.stage ?? '?'}) :`, e.cause ?? e);
      return NextResponse.json({ error: e.code, message: e.message, details: e.details }, { status: 500 });
    }
    const message = (e as Error)?.message ?? String(e);
    console.error(`[POST /api/admin/ai/treatments/${treatment}/launch] LAUNCH_FAILED :`, e);
    return NextResponse.json(
      { error: 'LAUNCH_FAILED', message: `Lancement ${treatment} impossible (erreur technique : ${message.slice(0, 300)}).` },
      { status: 500 },
    );
  }
}
