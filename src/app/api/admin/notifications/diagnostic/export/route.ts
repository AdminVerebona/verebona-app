import { NextRequest, NextResponse } from 'next/server';
import { logNotificationAction, requireAdminContext } from '../../_shared';
import { contentDisposition } from '@/lib/download-filename';
import {
  identifiantDiagnostic, nomFichierDiagnostic, parseDiagnosticQuery, queryVersParams,
} from '@/services/admin/notifications-diagnostic/model';
import { ouvrirExportDiagnostic } from '@/services/admin/notifications-diagnostic/service';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * GET /api/admin/notifications/diagnostic/export — lot 115B (Trello #800).
 *
 * « Télécharger les résultats filtrés » : le périmètre ENTIER de la recherche,
 * pas la page affichée. Fichier JSON UTF-8 valide, schéma versionné, remis en
 * pièce jointe avec un nom daté (`verebona-notifications-diagnostic-…json`).
 *
 * MÊMES FILTRES, MÊMES TOTAUX QUE L'ÉCRAN (#800 CA06) : la clause de
 * sélection est celle du service de lecture, le curseur de l'écran est ignoré,
 * et le nombre attendu est annoncé dans l'en-tête `X-Diagnostic-Total` avant
 * la première ligne.
 *
 * AUCUNE TRONCATURE SILENCIEUSE : le manifeste final porte `attendu`,
 * `exporte`, un statut (`COMPLETE` / `PARTIAL` / `ERROR`) et le motif ; une
 * interruption met le flux en erreur (fichier incomplet jamais présenté comme
 * complet) et est journalisée.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminContext(request);
  if (!guard.ok) return guard.response;

  const sp = request.nextUrl.searchParams;
  const maintenant = new Date();
  const parsed = parseDiagnosticQuery(sp, maintenant);
  if (!parsed.ok) {
    await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_EXPORT', 'FAILURE', { code: parsed.code });
    return NextResponse.json({ error: parsed.message, code: parsed.code }, { status: 400, headers: NO_STORE });
  }
  const q = parsed.value;
  const perimetre = Object.fromEntries(queryVersParams(q).entries());
  const diagnostic = identifiantDiagnostic(q, maintenant);
  const nomFichier = nomFichierDiagnostic(q, maintenant);

  try {
    const flux = await ouvrirExportDiagnostic(q, {
      onDone: (o) => logNotificationAction(
        guard,
        'NOTIFICATION_DIAGNOSTIC_EXPORT',
        o.complet ? 'SUCCESS' : 'FAILURE',
        {
          diagnostic, perimetre, nomFichier,
          attendu: o.attendu, exporte: o.exporte, complet: o.complet, octets: o.octets,
          ...(o.erreur ? { code: o.erreur } : {}),
        },
      ),
    });
    return new Response(flux.body, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': contentDisposition(nomFichier),
        'X-Diagnostic-Id': diagnostic,
        'X-Diagnostic-Total': String(flux.attendu),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    const code = (e as { code?: string })?.code === '57014' ? 'READ_TIMEOUT' : 'EXPORT_FAILED';
    console.error('[admin/notifications/diagnostic/export] ouverture :', (e as Error)?.message ?? e);
    await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_EXPORT', 'FAILURE', { diagnostic, perimetre, nomFichier, code });
    return NextResponse.json(
      { error: 'Export impossible (voir le journal du serveur).', code },
      { status: 500, headers: NO_STORE },
    );
  }
}
