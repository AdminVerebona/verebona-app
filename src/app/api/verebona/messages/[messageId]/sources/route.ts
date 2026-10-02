/**
 * GET /api/verebona/messages/[messageId]/sources — CDC §19 / §27.6.
 * Renvoie les sources résolues d'un message, paginées par 5 (`?offset=&limit=`,
 * §27.8), avec type lisible, bien lié, date utile, statut, disponibilité et
 * lien d'ouverture (§19.5).
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
import { httpRequestId, parseWith, readRateLimited, withRequestId, queryObject } from '@/lib/verebona/api-guard';
import { MessageParamsSchema, SourcesQuerySchema } from '@/lib/verebona/api-schemas';
import { marquerDisponibilite } from '@/services/verebona-assistant/core/source-availability.service';
import type { ResolvedSource, SourceType } from '@/services/verebona-assistant/types/sources';
import { TYPE_LABELS } from '@/services/verebona-assistant/core/source-resolver.service';
import { isAssistantFlagOn } from '@/services/verebona-assistant/config/assistant-flags.server';

/** Sources par page (§19.3 : 5 affichées directement, §27.8 : pagination au-delà). */
const PAGE_SIZE = 5;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ messageId: string }> },
) {
  // §27 : requestId journalisé et renvoyé (x-request-id) sur toute réponse.
  const httpId = httpRequestId(req);
  return withRequestId(await lire(req, ctx, httpId), httpId);
}

async function lire(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
  httpId: string,
): Promise<NextResponse> {
  let session;
  try { session = await SessionService.getSession(req); }
  catch (e) { return SessionService.handleSessionError(e); }
  const accountId = session.currentAccountId;
  if (!accountId) return NextResponse.json({ error: 'NO_ACTIVE_ACCOUNT' }, { status: 400 });
  // §27 : lectures limitées elles aussi (limiteur dédié de l'assistant).
  const limite = await readRateLimited(session.userId, accountId, httpId, req);
  if (limite) return limite;

  await ensureMigrations();
  // §27 : identifiant validé par schéma (entier positif) avant toute requête.
  const p = parseWith(MessageParamsSchema, await params, httpId);
  if (!p.ok) return p.response;
  const { messageId } = p.data;
  // Flag §39 `verebona_assistant_sources` coupé : aucune source exposée.
  if (!isAssistantFlagOn('sources')) return NextResponse.json({ sources: [], total: 0, nextOffset: null });

  // Pagination au-delà de cinq sources (§27.8) : 5 par page par défaut,
  // « Voir toutes les sources » demande la page suivante.
  const q = parseWith(SourcesQuerySchema, queryObject(req), httpId);
  if (!q.ok) return q.response;
  const limit = q.data.limit ?? PAGE_SIZE;
  const offset = q.data.offset ?? 0;

  // Propriété : le message doit appartenir à une conversation active de
  // L'UTILISATEUR dans le compte (§29.1) — en Duo, B ne lit pas les sources
  // des réponses faites à A.
  const rows = await pgClient.unsafe(
    `SELECT s.source_type, s.source_id, s.title_snapshot, s.excerpt_snapshot, s.is_available, s.rank,
            s.linked_asset_label, s.useful_date, s.status_label,
            count(*) OVER ()::int AS total
       FROM verebona_message_sources s
       JOIN verebona_messages m ON m.id = s.message_id
      WHERE s.message_id = $1 AND m.account_id = $2
        AND ${MESSAGE_OWNED_BY_USER('m', '$2', '$3')}
      ORDER BY s.rank ASC NULLS LAST
      LIMIT $4 OFFSET $5`,
    [messageId, accountId, session.userId, limit, offset],
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
    const { total: _total, ...reste } = r;
    return {
      ...reste,
      // Type lisible (§19.5).
      type_label: TYPE_LABELS[String(r.source_type) as SourceType] ?? 'Source',
      is_available: disponible,
      // Une source indisponible (§19.10) ne reçoit pas de lien : l'objet a
      // été supprimé ou n'est plus accessible.
      href: disponible ? hrefSource(String(r.source_id ?? '')) : null,
    };
  });

  const total = Number(lignes[0]?.total ?? 0);
  return NextResponse.json({
    sources,
    total,
    nextOffset: offset + lignes.length < total ? offset + lignes.length : null,
  });
}
