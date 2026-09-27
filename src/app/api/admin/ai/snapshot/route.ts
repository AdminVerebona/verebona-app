/**
 * /api/admin/ai/snapshot — CDC BO IA SCR-11, SNP-005 à SNP-010.
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
 *      `?check=reopening` : contrôle anti-effets (SNP-010), en lecture ;
 *      409 tant que la neutralisation est incomplète — la chaîne
 *      d'exploitation l'interroge avant de rouvrir la préproduction.
 *      `?format=sql-check` : le même contrôle en script SQL autonome.
 * POST l'applique, sous trois gardes, puis rejoue le contrôle.
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
  renderReopeningCheckScript,
} from '@/services/ai/snapshot/neutralization-plan';
import {
  assertNeutralizationAllowed, runNeutralization, NeutralizationRefused, verifyNeutralization,
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

  // SNP-010 : script de contrôle seul, en lecture, pour la chaîne côté
  // préproduction (psql -v ON_ERROR_STOP=1 : échoue s'il reste un résidu).
  if (req.nextUrl.searchParams.get('format') === 'sql-check') {
    try {
      return new NextResponse(renderReopeningCheckScript(), {
        status: 200,
        headers: {
          'Content-Type': 'application/sql; charset=utf-8',
          'Content-Disposition': 'attachment; filename="controle-reouverture-snapshot.sql"',
          'Cache-Control': 'no-store',
        },
      });
    } catch (e) {
      return NextResponse.json({ error: 'INVALID_TEST_ACCOUNTS', message: (e as Error).message }, { status: 422 });
    }
  }

  // SNP-010 : contrôle anti-effets avant réouverture. Lecture seule ; 409 tant
  // qu'un contrôle n'est pas à 0, pour qu'un `curl --fail` arrête la chaîne.
  if (req.nextUrl.searchParams.get('check') === 'reopening') {
    const verification = await verifyNeutralization();
    return NextResponse.json(
      verification.complete
        ? { reopeningAllowed: true, ...verification }
        : { reopeningAllowed: false, error: 'NEUTRALIZATION_INCOMPLETE', ...verification },
      { status: verification.complete ? 200 : 409 },
    );
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
