/**
 * /api/admin/ai/config-versions/[id] — lot 54 (54C).
 *
 * GET    : la version, sa révision courante et sa configuration complète
 *          (T1, T2, T3, T4, T6 ; prompts maîtres figés). Jamais en lecture
 *          seule du fait d'être active (lot 54) — seule une version
 *          supprimée l'est, jusqu'à sa remise dans la liste.
 * PUT    : enregistre la configuration (traitements modifiés, prompts
 *          maîtres retenus, nom, description) en UNE révision ; `baseRevision`
 *          obligatoire (aucun écrasement silencieux : 409 REVISION_CONFLICT).
 * DELETE : suppression LOGIQUE d'une version non active (409 sur l'active).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getVersion } from '@/services/ai/config/config-version.repository';
import { saveConfiguration, deleteConfigVersion } from '@/services/ai/config/config-version.service';
import { stateLabel } from '@/services/ai/config/version-state-machine';
import { unavailableModels } from '@/services/ai/config/config-validation.service';
import { GEMINI_PUBLIC_CATALOG } from '@/services/ai/gateway/pricing/gemini-public-catalog';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { isTreatment, type Treatment } from '@/services/ai/config/treatments';
import type { TreatmentConfig } from '@/services/ai/config/config-types';
import { EntryPayload } from './entry-payload';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../_shared';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    const version = await getVersion(versionId);
    if (!version) {
      return NextResponse.json({ error: 'VERSION_NOT_FOUND' }, { status: 404 });
    }
    const environment = getAiEnvironment();
    return NextResponse.json({
      ...version,
      stateLabel: stateLabel(version.status, environment),
      // Lot 54 : l'active reste modifiable ; seule une version supprimée ne
      // l'est pas (la remettre dans la liste d'abord).
      readOnly: version.deletedAt !== null,
      executing: version.active,
      unavailableModels: unavailableModels(
        version.entries,
        new Set(GEMINI_PUBLIC_CATALOG.map((e) => e.model)),
      ),
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-versions/[id]');
  }
}

const SaveBody = z.object({
  baseRevision: z.number().int().positive(),
  entries: z.array(EntryPayload.extend({ treatment: z.string() })).max(10).default([]),
  masterPromptVersionIds: z.record(z.string(), z.number().int().positive().nullable()).optional(),
  label: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  comment: z.string().max(1000).nullable().optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  const parsed = SaveBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({
      error: 'INVALID_PAYLOAD',
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    }, { status: 400 });
  }
  const b = parsed.data;
  const inconnu = b.entries.find((e) => !isTreatment(e.treatment));
  if (inconnu) {
    return NextResponse.json({ error: 'UNKNOWN_TREATMENT', message: `Traitement inconnu ou retiré : « ${inconnu.treatment} ».` }, { status: 400 });
  }
  const ids: Partial<Record<Treatment, number | null>> = {};
  for (const [t, v] of Object.entries(b.masterPromptVersionIds ?? {})) {
    if (!isTreatment(t)) {
      return NextResponse.json({ error: 'UNKNOWN_TREATMENT', message: `Traitement inconnu ou retiré : « ${t} ».` }, { status: 400 });
    }
    ids[t] = v;
  }

  try {
    const r = await saveConfiguration(versionId, {
      expectedRevision: b.baseRevision,
      entries: b.entries as unknown as TreatmentConfig[],
      masterPromptVersionIds: b.masterPromptVersionIds ? ids : undefined,
      label: b.label,
      description: b.description,
      comment: b.comment ?? null,
    }, guard.ctx.adminUserId);
    return NextResponse.json(r);
  } catch (e) {
    return toErrorResponse(e, 'PUT /api/admin/ai/config-versions/[id]');
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    await deleteConfigVersion(versionId, guard.ctx.adminUserId);
    return NextResponse.json({ deleted: true });
  } catch (e) {
    return toErrorResponse(e, 'DELETE /api/admin/ai/config-versions/[id]');
  }
}
