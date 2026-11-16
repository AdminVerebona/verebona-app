import { NextRequest, NextResponse } from 'next/server';
import { logNotificationAction, requireAdminContext } from '../../_shared';
import { contentDisposition } from '@/lib/download-filename';
import {
  DIAGNOSTIC_SCHEMA_VERSION, estUuid, formatDossierTexte, nomFichierDiagnostic, parseDiagnosticQuery,
} from '@/services/admin/notifications-diagnostic/model';
import { lireDossierEvenement } from '@/services/admin/notifications-diagnostic/service';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * GET /api/admin/notifications/diagnostic/[outboxId] — lot 115B (#800 CA05).
 *
 * Dossier structuré d'UN événement de référence : génération / planification,
 * file, livraisons par canal et par appareil, événements apparentés (les
 * tentatives d'un même récapitulatif, qui ne sont PAS des événements
 * distincts), état de configuration et manifeste de complétude.
 *
 *   ?format=json (défaut) | texte     « Copier le diagnostic »
 *   &download=1                        remise en pièce jointe (JSON)
 *
 * Lecture seule : n'envoie rien, ne réémet rien (#800 CA09).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ outboxId: string }> }) {
  const guard = await requireAdminContext(request);
  if (!guard.ok) return guard.response;

  const { outboxId } = await params;
  if (!outboxId || !estUuid(outboxId)) {
    await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_READ', 'FAILURE', { code: 'IDENTIFIANT_INVALIDE' });
    return NextResponse.json(
      { error: 'Identifiant d’événement de référence invalide.', code: 'IDENTIFIANT_INVALIDE' },
      { status: 400, headers: NO_STORE },
    );
  }

  const sp = request.nextUrl.searchParams;
  // Le dossier porte sur un événement précis : la fenêtre ne sert qu'à
  // renseigner le périmètre du rapport (traçabilité), jamais à filtrer.
  const parsed = parseDiagnosticQuery(sp);
  if (!parsed.ok) {
    await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_READ', 'FAILURE', { code: parsed.code });
    return NextResponse.json({ error: parsed.message, code: parsed.code }, { status: 400, headers: NO_STORE });
  }
  const format = sp.get('format') === 'texte' ? 'texte' : 'json';
  const telechargement = sp.get('download') === '1';

  try {
    const dossier = await lireDossierEvenement(outboxId, parsed.value);
    if (!dossier) {
      await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_READ', 'FAILURE', { code: 'INTROUVABLE', evenement: outboxId });
      return NextResponse.json(
        { error: 'Événement de référence introuvable.', code: 'INTROUVABLE' },
        { status: 404, headers: NO_STORE },
      );
    }
    await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_READ', 'SUCCESS', {
      format,
      portee: 'evenement',
      diagnostic: dossier.perimetre.identifiantDiagnostic,
      evenement: outboxId,
      livraisons: dossier.livraisons.length,
      telechargement,
    });

    if (format === 'texte') {
      return new Response(formatDossierTexte(dossier), {
        status: 200,
        headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const corps = JSON.stringify({ schema: DIAGNOSTIC_SCHEMA_VERSION, ...dossier }, null, 2);
    return new Response(corps, {
      status: 200,
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        ...(telechargement
          ? { 'Content-Disposition': contentDisposition(nomFichierDiagnostic(parsed.value, new Date(), `evenement-${outboxId.slice(0, 8)}`)) }
          : {}),
      },
    });
  } catch (e) {
    const code = (e as { code?: string })?.code === '57014' ? 'READ_TIMEOUT' : 'DIAGNOSTIC_FAILED';
    console.error('[admin/notifications/diagnostic/evenement] lecture :', (e as Error)?.message ?? e);
    await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_READ', 'FAILURE', { code, evenement: outboxId });
    return NextResponse.json(
      { error: 'Diagnostic impossible (voir le journal du serveur).', code },
      { status: 500, headers: NO_STORE },
    );
  }
}
