/**
 * GET /api/admin/ai/metrics-export — export CSV des métriques agrégées de
 * l'assistant et de l'IA (CDC Assistant §32.2, §32.3, §32.6 ; lot 23).
 *
 *   ?from=AAAA-MM-JJ&to=AAAA-MM-JJ   période (Europe/Paris, incluse ; défaut
 *                                    30 derniers jours ; 366 jours au plus)
 *   ?intent= ?model= ?promptVersion= ?plan=   filtres facultatifs (portée
 *                                    de chacun : lignes `_meta` du fichier)
 *
 * Agrégats seulement (aucun identifiant ni contenu), seuil de 5 comptes,
 * cellules neutralisées contre l'injection de formules. Produit EN FLUX,
 * jour par jour (mémoire bornée).
 *
 * Journalisation OBLIGATOIRE (`AI_METRICS_EXPORT`) : la demande est
 * journalisée AVANT tout envoi — si le journal est indisponible, l'export
 * est refusé (503). La fin du flux est journalisée à son tour (lignes,
 * troncature `details.truncated`, ou échec).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { logAdminAction } from '@/lib/admin-audit';
import {
  MAX_GROUPS_PER_SECTION, metricsExportFilename, MetricsExportRefused, metricsExportStream, parseMetricsExportQuery,
} from '@/services/ai/telemetry/metrics-export';
import { requireAdminContext } from '../config-versions/_shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  let q;
  try {
    q = parseMetricsExportQuery(new URL(req.url).searchParams);
  } catch (e) {
    if (e instanceof MetricsExportRefused) return NextResponse.json({ error: e.code, message: e.message }, { status: 400 });
    throw e;
  }
  const entree = { adminId: guard.ctx.adminUserId, action: 'AI_METRICS_EXPORT' as const, targetType: 'AI_METRICS' as const, targetId: null };
  try {
    // `executor` : une erreur d'écriture du journal est PROPAGÉE (refus).
    await logAdminAction({ ...entree, result: 'SUCCESS', after: { ...q }, details: { phase: 'demande' }, executor: db });
  } catch (e) {
    console.error('[metrics-export] journal indisponible — export refusé :', (e as Error).message);
    return NextResponse.json(
      { error: 'AUDIT_UNAVAILABLE', message: 'Journal d’administration indisponible : export refusé (journalisation obligatoire).' },
      { status: 503 },
    );
  }
  const { stream, done } = metricsExportStream(q);
  done.then(
    (s) => logAdminAction({ ...entree, result: 'SUCCESS', after: { ...q }, details: { phase: 'fin', rows: s.rows, truncated: s.truncated, truncatedDays: s.truncatedDays } }),
    (e: unknown) => logAdminAction({ ...entree, result: 'FAILURE', after: { ...q }, details: { phase: 'fin', error: String((e as Error)?.message ?? e).slice(0, 200) } }),
  ).catch(() => undefined);
  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${metricsExportFilename(q)}"`,
      'Cache-Control': 'no-store',
      // Borne par section et par jour ; un dépassement est signalé par la
      // dernière ligne du fichier (`_meta;…;tronque;oui …`).
      'X-Export-Max-Groups-Per-Day': String(MAX_GROUPS_PER_SECTION),
    },
  });
}
