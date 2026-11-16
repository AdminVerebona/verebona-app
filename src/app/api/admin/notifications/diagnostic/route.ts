import { NextRequest, NextResponse } from 'next/server';
import { logNotificationAction, requireAdminContext } from '../_shared';
import { formatDiagnosticTexte, parseDiagnosticQuery, queryVersParams } from '@/services/admin/notifications-diagnostic/model';
import { lireRapportDiagnostic } from '@/services/admin/notifications-diagnostic/service';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * GET /api/admin/notifications/diagnostic — lot 115B (Trello #800).
 *
 * Diagnostic des échecs de notification : agrégats cliquables par statut /
 * code / canal, détail des livraisons à curseur, état de configuration du
 * push, file des événements de référence et manifeste de complétude.
 *
 *   ?periode=24h|7j|30j|dates (&depuis=&jusqu= en ISO 8601 pour `dates`)
 *   &canal= &plateforme= &environnement= &statutLivraison= &statutEvenement=
 *   &code= &codeFournisseur= &famille= &nature= &evenement=
 *   &utilisateurId= &compteId= &reference= &curseur= &taille=
 *   &format=texte     « Copier le diagnostic » (text/plain structuré)
 *
 * LECTURE SEULE, SANS EFFET DE BORD : aucune réémission, aucun appel à FCM ni
 * à OAuth (#800 CA09). Un critère hors vocabulaire est REFUSÉ (400) avec son
 * code de diagnostic : jamais une liste vide présentée comme « aucun
 * résultat » (#800 CA07). Chaque consultation est journalisée
 * (`NOTIFICATION_DIAGNOSTIC_READ`) avec son périmètre et son volume, sans
 * donnée personnelle.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdminContext(request);
  if (!guard.ok) return guard.response;

  const sp = request.nextUrl.searchParams;
  const parsed = parseDiagnosticQuery(sp);
  if (!parsed.ok) {
    await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_READ', 'FAILURE', { code: parsed.code });
    // Le code de diagnostic est rendu au client : l'écran l'affiche tel quel.
    return NextResponse.json({ error: parsed.message, code: parsed.code }, { status: 400, headers: NO_STORE });
  }
  const q = parsed.value;
  const format = sp.get('format') === 'texte' ? 'texte' : 'json';

  try {
    const rapport = await lireRapportDiagnostic(q);
    await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_READ', 'SUCCESS', {
      format,
      diagnostic: rapport.perimetre.identifiantDiagnostic,
      perimetre: Object.fromEntries(queryVersParams(q).entries()),
      total: rapport.total,
      affichees: rapport.lignes.length,
    });

    if (format === 'texte') {
      const texte = formatDiagnosticTexte({
        perimetre: rapport.perimetre,
        synthese: rapport.synthese,
        agregats: rapport.agregats,
        lignes: rapport.lignes,
        sections: rapport.sections,
        champsNonEnregistres: rapport.champsNonEnregistres,
        configurationPush: rapport.configurationPush,
        file: rapport.file,
        partiel: rapport.lignes.length < rapport.total,
      });
      return new Response(texte, {
        status: 200,
        headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    return NextResponse.json(rapport, { headers: NO_STORE });
  } catch (e) {
    const code = (e as { code?: string })?.code === '57014' ? 'READ_TIMEOUT' : 'DIAGNOSTIC_FAILED';
    console.error('[admin/notifications/diagnostic] lecture :', (e as Error)?.message ?? e);
    await logNotificationAction(guard, 'NOTIFICATION_DIAGNOSTIC_READ', 'FAILURE', { code });
    return NextResponse.json(
      { error: 'Diagnostic impossible (voir le journal du serveur).', code },
      { status: 500, headers: NO_STORE },
    );
  }
}
