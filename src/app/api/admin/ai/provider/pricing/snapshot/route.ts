/**
 * GET /api/admin/ai/provider/pricing/snapshot?id=N — lot 113O (carte #713) :
 * contenu INTÉGRAL de la page tarifaire réellement reçue lors d'une
 * synchronisation (`ai_model_pricing_page_snapshots`), en téléchargement
 * texte. Sans `id` : le dernier contenu reçu. Page publique, aucune clé
 * envoyée ; motifs de secret masqués à l'enregistrement. Administrateurs
 * seulement ; lecture seule.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pgClient } from '@/db';
import { requireAdminContext, toErrorResponse } from '../../../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  try {
    const raw = new URL(req.url).searchParams.get('id');
    const id = raw && /^\d{1,12}$/.test(raw) ? Number(raw) : null;
    const rows = (await pgClient.unsafe(
      `SELECT id, fingerprint, body, final_url, http_status, content_type, page_format, first_seen_at, last_seen_at, truncated, redactions
         FROM ai_model_pricing_page_snapshots WHERE ($1::bigint IS NULL OR id = $1) ORDER BY last_seen_at DESC LIMIT 1`,
      [id] as never[],
    ).catch(() => [])) as unknown as Array<Record<string, unknown>>;
    const s = rows[0];
    if (!s) return NextResponse.json({ error: 'NOT_FOUND', message: 'Aucun contenu de page tarifaire conservé : lancez « Synchroniser les tarifs ».' }, { status: 404 });
    const fp = String(s.fingerprint).slice(0, 12);
    return new NextResponse(String(s.body ?? ''), {
      headers: {
        'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="page-tarifaire-google-${fp}.txt"`,
        'x-verebona-snapshot': JSON.stringify({
          id: Number(s.id), fingerprint: String(s.fingerprint), finalUrl: s.final_url ?? null, httpStatus: s.http_status ?? null,
          format: s.page_format ?? null, truncated: Boolean(s.truncated), redactions: Number(s.redactions ?? 0),
        }),
      },
    });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/provider/pricing/snapshot');
  }
}
