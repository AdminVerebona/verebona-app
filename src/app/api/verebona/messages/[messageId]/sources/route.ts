/**
 * GET /api/verebona/messages/[messageId]/sources — CDC §19 / §27.6.
 * Renvoie les sources résolues d'un message (≤ 5 affichées), avec disponibilité
 * et lien d'ouverture.
 *
 * Le href est construit ICI, côté serveur, à partir de l'identifiant de source
 * conservé en base (§22.1 : le client ne reconstruit jamais une URL). Une
 * source dont l'entité n'a pas de destination dans l'application reste
 * affichée, sans lien : mieux vaut une source non cliquable qu'un lien mort.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations, pgClient } from '@/db';
import { hrefSource } from '@/services/verebona-assistant/core/entity-ref';
import { MESSAGE_OWNED_BY_USER } from '@/services/verebona-assistant/core/conversation.service';
import { marquerDisponibilite } from '@/services/verebona-assistant/core/source-availability.service';
import type { ResolvedSource } from '@/services/verebona-assistant/types/sources';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });

  await ensureMigrations();
  const { messageId } = await params;
  // Propriété : le message doit appartenir à une conversation active de
  // L'UTILISATEUR dans le compte (§29.1) — en Duo, B ne lit pas les sources
  // des réponses faites à A.
  const rows = await pgClient.unsafe(
    `SELECT s.source_type, s.source_id, s.title_snapshot, s.excerpt_snapshot, s.is_available, s.rank
       FROM verebona_message_sources s
       JOIN verebona_messages m ON m.id = s.message_id
      WHERE s.message_id = $1 AND m.account_id = $2
        AND ${MESSAGE_OWNED_BY_USER('m', '$2', '$3')}
      ORDER BY s.rank ASC NULLS LAST
      LIMIT 5`,
    [messageId, accountId, session.userId],
  );

  const lignes = rows as unknown as Array<Record<string, unknown>>;
  // §19.10, §30.5, 37.14 : la disponibilité est REVÉRIFIÉE à la relecture.
  // Un document supprimé APRÈS la réponse gardait son lien (is_available
  // figé au moment de la réponse). Vérification impossible : l'état
  // enregistré fait foi.
  const verifiees = await marquerDisponibilite(
    lignes.map((r) => ({ id: String(r.source_id ?? ''), type: r.source_type, isAvailable: r.is_available !== false }) as unknown as ResolvedSource),
    accountId,
  ).catch(() => null);
  const sources = lignes.map((r, i) => {
    const disponible = r.is_available !== false && (verifiees ? verifiees[i]?.isAvailable !== false : true);
    return {
      ...r,
      is_available: disponible,
      // Une source indisponible (§19.10) ne reçoit pas de lien : l'objet a
      // été supprimé ou n'est plus accessible.
      href: disponible ? hrefSource(String(r.source_id ?? '')) : null,
    };
  });

  return NextResponse.json({ sources });
}
