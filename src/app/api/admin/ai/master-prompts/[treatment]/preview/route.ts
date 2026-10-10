/**
 * Aperçu / test d'une version de prompt maître en contexte structuré — lot
 * 34D (ticket « T4 : découpler le contrat d'exécution du texte du prompt »).
 *
 *   POST — `{ versionId: number | 'active' | 'file', task, scenarioId? }` :
 *          prompt envoyé, TASK, contrat d'entrée, contexte construit,
 *          contrat de sortie, sortie brute (enregistrée au corpus, aucun
 *          appel modèle, aucun coût) et résultat validé — chaque étape
 *          inspectable séparément.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { previewStructured } from '@/services/ai/master-prompts/master-prompt.service';
import { requireAdminContext, parseTreatment, masterPromptError } from '../../_shared';

type Ctx = { params: Promise<{ treatment: string }> };

const Body = z.object({
  versionId: z.union([z.number().int().positive(), z.literal('active'), z.literal('file')]),
  task: z.string().min(1).max(60),
  scenarioId: z.string().max(120).nullable().optional(),
});

export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const t = parseTreatment((await params).treatment);
  if (!t.ok) return t.response;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: 'INVALID_PAYLOAD', message: 'Requête illisible.' }, { status: 400 });
  try {
    return NextResponse.json(await previewStructured(t.treatment, body.data));
  } catch (e) {
    return masterPromptError(e, 'POST /api/admin/ai/master-prompts/[treatment]/preview');
  }
}
