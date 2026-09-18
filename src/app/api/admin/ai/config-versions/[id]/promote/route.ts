/**
 * POST /api/admin/ai/config-versions/[id]/promote — CDC BO IA WF-02.
 *
 * Promeut un Brouillon en « À tester ». Préproduction uniquement.
 *
 * ── UN REFUS N'EST PAS UNE ERREUR ──────────────────────────────────────────
 * Quand le diff est vide ou que les contrôles échouent, la route rend 200 avec
 * `promoted: false`, le diff et les issues. C'est délibéré : l'écran doit
 * afficher POURQUOI, et une réponse d'erreur l'obligerait à retrouver ces
 * informations ailleurs. Le WF-02 exige « présenter les erreurs par traitement
 * et champ » — elles sont dans la réponse.
 *
 * Les 409 sont réservés aux conflits d'état : version introuvable, statut
 * incompatible, ou environnement de production.
 */
import { NextRequest, NextResponse } from 'next/server';
import { promote } from '@/services/ai/config/config-version.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const result = await promote(versionId);
    return NextResponse.json({
      promoted: result.promoted,
      diff: result.diff,
      validation: result.validation,
      reason: result.promoted
        ? null
        : result.diff.identical
          ? 'IDENTICAL_TO_ACTIVE'
          : 'VALIDATION_FAILED',
    });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/promote');
  }
}
