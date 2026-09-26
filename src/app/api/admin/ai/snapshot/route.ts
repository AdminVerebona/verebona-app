/**
 * /api/admin/ai/snapshot — CDC BO IA SCR-11, SNP-005 à SNP-009.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CETTE ROUTE NE COPIE RIEN
 *
 * Elle n'expose qu'une chose : la neutralisation d'une base restaurée. Ni
 * génération, ni copie, ni restauration, ni transfert S3 — ces étapes dépendent
 * de l'hébergeur, et une route applicative qui prétendrait les faire donnerait
 * l'illusion d'un mécanisme complet là où il n'y a qu'une moitié.
 *
 * GET  décrit le plan et dit si l'exécution est possible ici.
 * POST l'applique, sous trois gardes.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE GET NE DÉCLENCHE RIEN, ET C'EST INTENTIONNEL
 *
 * L'écran doit pouvoir expliquer pourquoi le bouton est indisponible sans
 * risquer de déclencher quoi que ce soit pour le savoir. Les gardes sont donc
 * évaluées séparément de l'exécution.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  NEUTRALIZATION_PLAN, affectedTables, testAccountEmails, renderNeutralizationScript,
} from '@/services/ai/snapshot/neutralization-plan';
import {
  assertNeutralizationAllowed, runNeutralization, NeutralizationRefused,
} from '@/services/ai/snapshot/neutralization.service';
import { getAiEnvironment } from '@/services/ai/config/environment';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  // SNP-007 / SNP-008 (lot IA 2) : `?format=sql` rend le plan sous forme de
  // script, à appliquer par la chaîne d'exploitation sur la copie CÔTÉ PROD
  // avant publication. Téléchargement seul : rien n'est exécuté ici, et le
  // script est disponible en production précisément pour cet usage.
  if (req.nextUrl.searchParams.get('format') === 'sql') {
    try {
      return new NextResponse(renderNeutralizationScript(), {
        status: 200,
        headers: {
          'Content-Type': 'application/sql; charset=utf-8',
          'Content-Disposition': 'attachment; filename="neutralisation-snapshot.sql"',
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      return NextResponse.json({ error: 'INVALID_TEST_ACCOUNTS', message: (e as Error).message }, { status: 422 });
    }
  }

  const environment = getAiEnvironment();

  let allowed = true;
  let blockedBy: { code: string; message: string } | null = null;
  try {
    assertNeutralizationAllowed(environment);
  } catch (e) {
    allowed = false;
    blockedBy = e instanceof NeutralizationRefused
      ? { code: e.code, message: e.message }
      : { code: 'UNKNOWN', message: (e as Error).message };
  }

  return NextResponse.json({
    environment,
    allowed,
    blockedBy,
    preservedAccounts: testAccountEmails().length,
    affectedTables: affectedTables(),
    // Le plan est rendu en entier, raisons comprises : il doit pouvoir être relu
    // avant d'être appliqué, et non découvert par ses effets.
    plan: NEUTRALIZATION_PLAN.map((s) => ({
      id: s.id, family: s.family, label: s.label, risk: s.risk, tables: s.tables,
    })),
  });
}

const Body = z.object({ confirmEnvironment: z.string().min(1) });

export async function POST(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'CONFIRMATION_REQUIRED',
        message: "Indiquez le nom de l'environnement que vous visez.",
      },
      { status: 400 },
    );
  }

  try {
    const report = await runNeutralization(parsed.data.confirmEnvironment);
    return NextResponse.json(report);
  } catch (e) {
    if (e instanceof NeutralizationRefused) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: 409 });
    }
    return toErrorResponse(e, 'POST /api/admin/ai/snapshot');
  }
}
