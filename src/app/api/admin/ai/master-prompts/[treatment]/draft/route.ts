/**
 * Brouillon d'un prompt maître — ticket BO-IA-PROMPTS-01 (AC01, AC02).
 *
 *   POST   — « Modifier » : ouvre le brouillon (copie de l'Actif, ou le
 *            brouillon existant). Corps facultatif `{ content }`.
 *   PUT    — « Enregistrer le brouillon » : `{ versionId, content }`.
 *            Seul un brouillon est modifiable ; l'Actif n'est jamais touché.
 *   DELETE — « Abandonner le brouillon » : `?versionId=`.
 *
 * Enregistrer un brouillon imparfait est permis (il n'est pas utilisé) : les
 * contrôles techniques sont rendus pour information et bloquent seulement
 * l'activation.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { startDraft, saveDraft, discardDraft, getPromptDetail } from '@/services/ai/master-prompts/master-prompt.service';
import { requireAdminContext, parseTreatment, parseId, invalidId, masterPromptError } from '../../_shared';

type Ctx = { params: Promise<{ treatment: string }> };

const Start = z.object({ content: z.string().optional() }).nullable();
const Save = z.object({ versionId: z.number().int().positive(), content: z.string() });

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const t = parseTreatment((await params).treatment);
  if (!t.ok) return t.response;
  const body = Start.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'INVALID_PAYLOAD', message: 'Requête illisible.' }, { status: 400 });
  try {
    const d = await startDraft(t.treatment, guard.ctx.adminUserId, body.data?.content);
    const detail = await getPromptDetail(t.treatment);
    return NextResponse.json({ draftId: d.id, versionNumber: d.versionNumber, detail }, { status: 201 });
  } catch (e) {
    return masterPromptError(e, 'POST /api/admin/ai/master-prompts/[treatment]/draft');
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const t = parseTreatment((await params).treatment);
  if (!t.ok) return t.response;
  const body = Save.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'INVALID_PAYLOAD', message: 'Requête illisible.' }, { status: 400 });
  try {
    const d = await saveDraft(t.treatment, body.data.versionId, body.data.content, guard.ctx.adminUserId);
    const detail = await getPromptDetail(t.treatment);
    return NextResponse.json({ draftId: d.id, versionNumber: d.versionNumber, detail });
  } catch (e) {
    return masterPromptError(e, 'PUT /api/admin/ai/master-prompts/[treatment]/draft');
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const t = parseTreatment((await params).treatment);
  if (!t.ok) return t.response;
  const raw = req.nextUrl.searchParams.get('versionId') ?? '';
  const id = parseId(raw);
  if (id === null) return invalidId(raw);
  try {
    await discardDraft(t.treatment, id);
    return NextResponse.json({ discarded: true, detail: await getPromptDetail(t.treatment) });
  } catch (e) {
    return masterPromptError(e, 'DELETE /api/admin/ai/master-prompts/[treatment]/draft');
  }
}
