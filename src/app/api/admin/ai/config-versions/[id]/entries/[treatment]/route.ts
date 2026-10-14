/**
 * PUT /api/admin/ai/config-versions/[id]/entries/[treatment] — route
 * HISTORIQUE (enregistrement d'un seul traitement). Lot 54 : délègue à
 * l'enregistrement global — une révision par sauvegarde effective, version
 * active comprise (plus de restriction « Brouillon »). `baseRevision`
 * (facultatif ici, obligatoire sur PUT /config-versions/[id]) : refus 409
 * REVISION_CONFLICT si la version a été enregistrée entre-temps.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { saveTreatmentConfig } from '@/services/ai/config/config-version.service';
import { isRetiredTreatment, isTreatment, type Treatment } from '@/services/ai/config/treatments';
import { recordConfigEntrySave } from '@/services/ai/config/config-entry.audit';
import { EntryPayload } from '../../entry-payload';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../_shared';

const Payload = EntryPayload.extend({ baseRevision: z.number().int().positive().nullable().optional() });

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; treatment: string }> },
) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id, treatment } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  // Lot 49 (ticket 12) : T5 est retiré — refus explicite, aucune ligne créée.
  if (isRetiredTreatment(treatment)) {
    return NextResponse.json(
      { error: 'TREATMENT_RETIRED', message: `Le traitement ${treatment} a été supprimé : il n'a plus de configuration.` },
      { status: 410 },
    );
  }
  if (!isTreatment(treatment)) {
    return NextResponse.json(
      { error: 'UNKNOWN_TREATMENT', message: `Traitement inconnu : « ${treatment} ».` },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = Payload.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_PAYLOAD',
        // Rendus par champ, comme les contrôles du WF-02 : l'administrateur doit
        // savoir quel champ reprendre, pas seulement que quelque chose cloche.
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    );
  }

  try {
    const { baseRevision, ...entry } = parsed.data;
    const { before, after, revisionNumber } = await saveTreatmentConfig(
      versionId,
      { treatment: treatment as Treatment, ...entry },
      guard.ctx.adminUserId,
      baseRevision ?? null,
    );
    // Traçabilité (ticket T4) : utilisateur, version, champs modifiés
    // avant / après — retrait d'un déclencheur incompatible. Rien à tracer si
    // rien n'a changé (seconde sauvegarde).
    await recordConfigEntrySave({
      adminUserId: guard.ctx.adminUserId,
      versionId,
      treatment,
      before,
      after,
    });
    return NextResponse.json({ saved: true, treatment, revisionNumber });
  } catch (e) {
    return toErrorResponse(e, 'PUT /api/admin/ai/config-versions/[id]/entries/[treatment]');
  }
}
