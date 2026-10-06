import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { getBackfillReport } from '@/services/admin/ops/backfill/runner';
import { reportFileName } from '@/services/admin/ops/backfill/report-format';
import { redactDeep } from '@/services/admin/ops/redact';
import { guardAdmin, NO_STORE, opsError } from '../../../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/backfills/:id/report — rapport JSON complet (borné) d'une
 * exécution terminée, en pièce jointe : compteurs, cas ambigus, conflits,
 * identifiant d'exécution du script, synthèse texte (`--report`).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const r = await getBackfillReport((await params).id);
    if (!r) return NextResponse.json({ error: 'Introuvable', code: 'NOT_FOUND' }, { status: 404, headers: NO_STORE });
    if (r.report == null) {
      return NextResponse.json(
        { error: 'Rapport indisponible', code: 'REPORT_NOT_READY', message: r.run.status === 'running' ? 'Exécution en cours.' : 'Aucun rapport (exécution en échec avant la fin).' },
        { status: 409, headers: NO_STORE },
      );
    }
    const nom = reportFileName(r.run.script, r.run.action, r.run.step, r.run.startedAt, r.run.id);
    return new NextResponse(JSON.stringify(redactDeep({ run: { ...r.run, summary: undefined }, report: r.report }), null, 2), {
      status: 200,
      headers: { ...NO_STORE, 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${nom}"` },
    });
  } catch (e) {
    return opsError(e, 'rattrapage (rapport)', 'OPS_BACKFILL_REPORT_FAILED');
  }
}
