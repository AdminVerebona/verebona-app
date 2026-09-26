/**
 * POST /api/admin/ai/treatments/[treatment]/launch — lancement manuel batch
 * (CDC BO IA WF-11, OPS-016, T1-021, T1-UI-12, T3-UI-08, T4-UI-07 ; lot IA 2).
 *
 * Corps : { accountIds?: number[]; all?: boolean; dryRun?: boolean }.
 *   · dryRun = true : estimation du périmètre (WF-11 étape 64), rien n'est créé ;
 *   · sinon : un job `origin = manual` par objet, sans déduplication.
 *
 * 409 EMERGENCY_STOP si l'arrêt d'urgence est engagé (précondition WF-11) ;
 * 422 pour T4 (non lançable seul, voir manual-launch.ts), périmètre vide ou
 * trop large. Un traitement désactivé ou suspendu accepte la demande, qui
 * attend sa réactivation (`waitsForReactivation`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  launchManual, defaultManualLaunchDeps, ManualLaunchRefused,
} from '@/services/ai/queue/manual-launch';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

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
    return NextResponse.json(result, { status: result.dryRun ? 200 : 202 });
  } catch (e) {
    if (e instanceof ManualLaunchRefused) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.code === 'EMERGENCY_STOP' ? 409 : 422 },
      );
    }
    return toErrorResponse(e, 'POST /api/admin/ai/treatments/[treatment]/launch');
  }
}
