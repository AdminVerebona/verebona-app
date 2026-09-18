/**
 * GET /api/cron/ai/inventory — CDC §9.7 et §12, critères n°1, 2, 3 et 24.
 *
 * Même rapport que `npm run ai:inventory:observed`, accessible par HTTP.
 *
 * ── POURQUOI CETTE ROUTE ─────────────────────────────────────────────────
 * Le script exige un accès direct à la base. En recette, la preuve du §12
 * devenait donc impossible à produire pour qui n'a pas la main sur la
 * plateforme — alors que tous les autres contrôles de bascule passent par une
 * route protégée par `CRON_SECRET`. Le seul contrôle qui autorise la bascule
 * réglementaire ne pouvait pas être aussi le seul inaccessible.
 *
 * Le calcul est partagé avec le script (`inventory-report.ts`) : un rapport
 * dont le verdict dépendrait de la façon dont on l'a demandé ne prouverait rien.
 *
 * Paramètres :
 *   ?window=30d   fenêtre d'observation (défaut 30 jours ; `90d`, `12h` acceptés)
 *   ?observed=0   section déclarée seule, sans accès base
 *
 * Codes de retour, alignés sur les verdicts du script :
 *   200  conforme
 *   409  non conforme — une opération hors référentiel a été observée
 *   424  indéterminé — fenêtre vide, l'inventaire ne conclut pas
 *   400  fenêtre illisible
 */
import { NextRequest, NextResponse } from 'next/server';
import { ensureMigrations } from '@/db';
import { buildInventoryReport, parseWindow } from '@/services/ai/registry/inventory-report';

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;

  const windowDays = parseWindow(params.get('window'));
  if (windowDays === null) {
    return NextResponse.json(
      {
        error: 'INVALID_WINDOW',
        message: `Fenêtre illisible : « ${params.get('window')} ». Attendu : 30d, 90d, 12h.`,
      },
      { status: 400 },
    );
  }

  // La section observée est le défaut : c'est elle qu'on vient chercher ici.
  // `observed=0` sert au cas où seule la déclaration est voulue, sans base.
  const observed = params.get('observed') !== '0';

  await ensureMigrations();

  try {
    const report = await buildInventoryReport({ observed, windowDays });

    // Un rapport indéterminé ne doit pas passer pour un rapport conforme : il
    // sort en 424 et non en 200, pour qu'un ordonnanceur ou un script appelant
    // le distingue sans avoir à lire le corps.
    const status = report.observe?.verdict === 'non_conforme' ? 409
      : report.observe?.verdict === 'indetermine' ? 424
        : report.compliant ? 200 : 409;

    return NextResponse.json(report, { status });
  } catch (e) {
    console.error('[GET /api/cron/ai/inventory]', e);
    return NextResponse.json(
      { error: 'INVENTORY_FAILED', message: (e as Error).message },
      { status: 500 },
    );
  }
}
