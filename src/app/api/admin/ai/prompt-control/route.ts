/**
 * POST /api/admin/ai/prompt-control — CDC BO IA SCR-06, WF-20, T5-001 à T5-015.
 *
 * L'administrateur envoie une demande EN LANGAGE NATUREL, jamais un prompt.
 * Deux actions, conformes au SCR-06 (« Analyser », « Modifier ») :
 *
 *   · `analyze` — diagnostic seul, sur n'importe quelle version. Aucune
 *     écriture, aucun Brouillon créé (T5-006).
 *   · `modify`  — T5 réécrit le prompt ciblé et l'écrit DIRECTEMENT dans le
 *     Brouillon, puis rend résumé et diff (T5-005). Si la version affichée
 *     n'est pas un Brouillon : création depuis l'Active quand aucun n'existe,
 *     ou refus `DRAFT_SELECTION_REQUIRED` avec la liste (T5-007).
 *
 * L'ancienne action `apply`, qui recevait un texte de prompt du client après
 * une analyse, est supprimée (écart E-01) : elle imposait un second geste, et
 * laissait le client envoyer n'importe quel texte comme « proposition de T5 ».
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { analyze, modify, T5Refused } from '@/services/ai/governance/prompt-control.service';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

const Demande = {
  versionId: z.number().int().positive(),
  treatment: z.string().min(2).max(4),
  instruction: z.string().trim().min(5).max(5000),
};

const Analyze = z.object({ action: z.literal('analyze'), ...Demande });

const Modify = z.object({
  action: z.literal('modify'),
  ...Demande,
  /** Créer un nouveau Brouillon depuis l'Active même si d'autres existent. */
  createDraft: z.boolean().optional(),
});

const Body = z.discriminatedUnion('action', [Analyze, Modify]);

/** Statut HTTP d'un refus fonctionnel de T5. */
function statusFor(code: string): number {
  if (code === 'VERSION_NOT_FOUND') return 404;
  if (code === 'UNKNOWN_TREATMENT') return 400;
  if (code === 'AI_BLOCKED') return 503;
  return 409;
}

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_PAYLOAD',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      { status: 400 },
    );
  }

  const compte = Number(process.env.CORPUS_ACCOUNT_ID);
  if (!Number.isInteger(compte) || compte <= 0) {
    // L'appel est imputé à un compte technique, jamais à un compte client.
    return NextResponse.json(
      { error: 'NO_TECHNICAL_ACCOUNT', message: 'CORPUS_ACCOUNT_ID est absente.' },
      { status: 503 },
    );
  }

  const d = parsed.data;
  try {
    const result = d.action === 'analyze'
      ? await analyze(d.versionId, d.treatment, d.instruction, compte, guard.ctx.adminUserId)
      : await modify({
        versionId: d.versionId,
        treatment: d.treatment,
        instruction: d.instruction,
        createDraft: d.createDraft,
        accountId: compte,
        userId: guard.ctx.adminUserId,
      });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof T5Refused) {
      return NextResponse.json(
        { error: e.code, message: e.message, details: e.details ?? null },
        { status: statusFor(e.code) },
      );
    }
    return toErrorResponse(e, 'POST /api/admin/ai/prompt-control');
  }
}
