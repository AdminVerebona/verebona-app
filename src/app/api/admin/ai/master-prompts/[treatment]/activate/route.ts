/**
 * POST /api/admin/ai/master-prompts/[treatment]/activate — « Activer la
 * version » en UN geste. Lot 105C (ticket « BO T4 : un prompt maître, une
 * activation ») ; T4 seulement (prompt qui déclare un bundle complet).
 *
 * Corps : `{ content, draftId? }` — le texte ÉDITÉ (même non enregistré) et
 * le brouillon édité (refus 409 `DRAFT_CHANGED` s'il a été remplacé entre-
 * temps). Le serveur enregistre le texte dans le brouillon, résout et valide
 * le bundle complet, le fige avec la version et bascule atomiquement — ou
 * n'active rien :
 *   · 422 `ENGINE_INCOMPATIBLE` « Impossible d'activer T4 : configuration du
 *     moteur incompatible » ; `details.issues` = diagnostic serveur (affiché
 *     replié), `details.draftSaved` = texte conservé dans le brouillon ;
 *   · 422 `TEXT_INVALID` (texte vide, trop long, caractères invalides).
 * Aucun choix de mode, de contrat ni de TASK n'est accepté.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { activateEditedVersion, getPromptDetail } from '@/services/ai/master-prompts/master-prompt.service';
import { requireAdminContext, parseTreatment, masterPromptError } from '../../_shared';

const Body = z.object({ content: z.string(), draftId: z.number().int().positive().nullable().optional() });

export async function POST(req: NextRequest, { params }: { params: Promise<{ treatment: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const t = parseTreatment((await params).treatment);
  if (!t.ok) return t.response;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'INVALID_PAYLOAD', message: 'Requête illisible.' }, { status: 400 });
  try {
    const r = await activateEditedVersion(t.treatment, { content: body.data.content, draftId: body.data.draftId ?? null }, guard.ctx.adminUserId);
    return NextResponse.json({ activated: true, ...r, detail: await getPromptDetail(t.treatment) });
  } catch (e) {
    return masterPromptError(e, 'POST /api/admin/ai/master-prompts/[treatment]/activate');
  }
}
