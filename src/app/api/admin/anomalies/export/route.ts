import { NextRequest, NextResponse } from 'next/server';
import { getSession, requireAdmin } from '@/lib/auth-guards';
import { logAdminAction } from '@/lib/admin-audit';
import { getAppBaseUrl } from '@/lib/app-url';
import { contentDisposition } from '@/lib/download-filename';
import { anomalyExportFileName, parseAnomalyExportQuery, type AnomalyExportQuery } from '@/services/admin/anomalies-export/model';
import { guardAdmin, NO_STORE } from '../../ops/_shared';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

/**
 * GET /api/admin/anomalies/export — lot 113AI (Trello #733) : anomalies de
 * Supervision copiables / exportables pour une analyse externe.
 *
 *   ?status=open|resolved&sort=…&dir=…   MÊMES paramètres que l'écran
 *                                         (`GET /api/admin/anomalies`) ;
 *   &format=json (défaut) | csv           liste filtrée COMPLÈTE (toutes les
 *                                         pages), en flux par curseur,
 *                                         fichier daté en pièce jointe ;
 *   &format=md&page=N                     « Copier » : la page affichée en
 *                                         Markdown (text/markdown).
 *
 * Sécurité : administrateurs BO seulement (`requireAdmin`, mêmes droits que
 * la Supervision) — un refus est rendu AVANT toute lecture (aucune
 * information sur l'existence des données) ; paramètres en liste blanche ;
 * aucune donnée personnelle (identifiants internes seulement, détail masqué) ;
 * réponses jamais mises en cache ; chaque demande (réussie, refusée, en
 * échec, interrompue) est journalisée `ANOMALY_EXPORT` (format, filtres,
 * nombre d'anomalies, issue).
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  const sp = request.nextUrl.searchParams;
  const adminEmail = await getSession(request).then((s) => (typeof s?.email === 'string' ? s.email : undefined), () => undefined);
  const audit = (result: 'SUCCESS' | 'FAILURE', q: AnomalyExportQuery | null, details: Record<string, unknown>) => logAdminAction({
    adminId: g.adminId, adminEmail, action: 'ANOMALY_EXPORT', targetType: 'ANOMALY', targetId: null, result,
    details: {
      scope: q?.format === 'md' ? 'page' : 'liste',
      format: q?.format ?? sp.get('format'),
      filters: q ? { status: q.status, sort: q.sort, dir: q.dir } : { status: sp.get('status'), sort: sp.get('sort'), dir: sp.get('dir') },
      ...(q?.format === 'md' ? { page: q.page } : {}),
      ...details,
    },
  });

  const parsed = parseAnomalyExportQuery(sp);
  if (!parsed.ok) {
    await audit('FAILURE', null, { code: parsed.code });
    return NextResponse.json({ error: parsed.message, code: parsed.code }, { status: 400, headers: NO_STORE });
  }
  const q = parsed.value;
  const baseUrl = getAppBaseUrl(request);
  const { copyAnomalyPage, openAnomalyExportStream } = await import('@/services/admin/anomalies-export/service');

  if (q.format === 'md') {
    try {
      const r = await copyAnomalyPage(q, baseUrl);
      await audit('SUCCESS', q, { count: r.count, total: r.total });
      return new Response(r.text, { status: 200, headers: { ...NO_STORE, 'Content-Type': 'text/markdown; charset=utf-8' } });
    } catch (e) {
      console.error('[admin/anomalies/export] copie :', (e as Error)?.message ?? e);
      await audit('FAILURE', q, { code: 'COPY_FAILED' });
      return NextResponse.json({ error: 'Copie impossible (voir le journal du serveur).', code: 'COPY_FAILED' }, { status: 500, headers: NO_STORE });
    }
  }

  const fmt = q.format;
  const fileName = anomalyExportFileName(q.status, fmt);
  try {
    const s = await openAnomalyExportStream({ ...q, format: fmt }, {
      baseUrl,
      onDone: (o) => audit(o.complete ? 'SUCCESS' : 'FAILURE', q, {
        total: o.total, count: o.exported, complete: o.complete, bytes: o.bytes, fileName, ...(o.error ? { code: o.error } : {}),
      }),
    });
    return new Response(s.body, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': fmt === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'Content-Disposition': contentDisposition(fileName),
        'X-Anomalies-Total': String(s.total),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    const code = (e as { code?: string })?.code;
    console.error('[admin/anomalies/export] ouverture :', (e as Error)?.message ?? e);
    await audit('FAILURE', q, { code: code === '57014' ? 'READ_TIMEOUT' : 'EXPORT_FAILED', fileName });
    return NextResponse.json({ error: 'Export impossible (voir le journal du serveur).', code: 'EXPORT_FAILED' }, { status: 500, headers: NO_STORE });
  }
}
