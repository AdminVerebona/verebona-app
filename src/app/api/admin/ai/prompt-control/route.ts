/**
 * POST /api/admin/ai/prompt-control — CDC BO IA SCR-06, T5-001 à T5-009.
 *
 * Deux gestes distincts, et c'est délibéré :
 *   · `analyze` rend un verdict et, seulement si le prompt est en cause, une
 *     proposition avec son diff ;
 *   · `apply` écrit la proposition dans le brouillon.
 *
 * Les séparer garantit ce que le SCR-06 demande : l'administrateur voit le diff
 * avant que quoi que ce soit ne bouge. C'est exactement ce que l'ancienne route
 * `admin/ai-instructions/apply` ne faisait pas — elle appliquait les patchs dans
 * la requête qui les produisait.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { analyze, applyProposal, T5Refused } from '@/services/ai/governance/prompt-control.service';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

const Analyze = z.object({
  action: z.literal('analyze'),
  versionId: z.number().int().positive(),
  treatment: z.string().min(2).max(4),
  instruction: z.string().min(5).max(5000),
});

const Apply = z.object({
  action: z.literal('apply'),
  versionId: z.number().int().positive(),
  treatment: z.string().min(2).max(4),
  proposedContent: z.string().min(50).max(50_000),
});

const Body = z.discriminatedUnion('action', [Analyze, Apply]);

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

  try {
    if (parsed.data.action === 'analyze') {
      const result = await analyze(
        parsed.data.versionId, parsed.data.treatment, parsed.data.instruction,
        compte, guard.ctx.adminUserId,
      );
      return NextResponse.json(result);
    }

    await applyProposal(
      parsed.data.versionId, parsed.data.treatment,
      parsed.data.proposedContent, guard.ctx.adminUserId,
    );
    return NextResponse.json({ applied: true });
  } catch (e) {
    if (e instanceof T5Refused) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: e.code === 'VERSION_NOT_FOUND' ? 404 : 409 },
      );
    }
    return toErrorResponse(e, 'POST /api/admin/ai/prompt-control');
  }
}
