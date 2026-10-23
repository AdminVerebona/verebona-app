/**
 * Documents liés à un événement (domaine historique « events ») — lot 49,
 * SEC-01 : compte actif de la session, événement ET documents du compte,
 * conditions de compte dans le SQL de chaque lecture et écriture. Un
 * identifiant étranger fait refuser la demande ENTIÈRE (rien n'est écrit) ;
 * une association incorrecte déjà en base n'expose jamais le document d'un
 * autre compte. Endpoint conservé (encore appelé par l'interface).
 *
 * Lot 84A (CDC v5 O-10, E25) : seul POST reste (rattachement des documents
 * déposés par « Ajouter un document ») ; GET et DELETE, sans appelant, sont
 * retirés.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { eventDocuments, events } from '@/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';
import { findRejectedRefs, logCrossAccountRefusal, cleanIds } from '@/services/security/account-ownership';

type Ctx = { params: Promise<{ eventId: string }> };

/** Compte actif et événement du compte, ou réponse d'erreur. */
async function eventOfAccount(request: NextRequest, context: Ctx): Promise<{ accountId: number; eventId: number } | NextResponse> {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return apiError(401, 'UNAUTHORIZED', 'Authentication required');
  const { eventId: raw } = await context.params;
  const eventId = parseInt(raw);
  if (isNaN(eventId)) return apiError(400, 'INVALID_ID', 'Valid event ID is required');
  const [ev] = await db.select({ id: events.id }).from(events)
    .where(and(eq(events.id, eventId), eq(events.accountId, session.currentAccountId))).limit(1);
  // Événement d'un autre compte ou inexistant : même réponse (rien n'est révélé).
  if (!ev) return apiError(404, 'NOT_FOUND', 'Event not found');
  return { accountId: session.currentAccountId, eventId };
}

export async function POST(request: NextRequest, context: Ctx) {
  try {
    const r = await eventOfAccount(request, context);
    if (r instanceof NextResponse) return r;

    const body = await request.json().catch(() => ({}));
    const { fileIds } = body as { fileIds?: unknown };
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return apiError(400, 'INVALID_INPUT', 'fileIds array is required');
    }
    const ids = cleanIds(fileIds as number[]);
    if (ids.length !== new Set(fileIds).size) return apiError(400, 'INVALID_INPUT', 'fileIds must be valid ids');

    // Tous les documents doivent appartenir au compte : sinon refus ENTIER.
    const rejected = await findRejectedRefs(r.accountId, { file: ids });
    if (rejected.length) {
      logCrossAccountRefusal('POST /api/events/[eventId]/documents', { accountId: r.accountId, rejected });
      return apiError(404, 'NOT_FOUND', 'One or more files not found');
    }

    // Une seule transaction ; chaque insertion porte la condition de compte
    // (événement ET document) dans son propre SQL.
    const created = await db.transaction(async (tx) => {
      const out: Array<typeof eventDocuments.$inferSelect> = [];
      for (const fileId of ids) {
        const rows = (await tx.execute(sqlInsertLink(r.eventId, fileId, r.accountId))) as unknown as Array<typeof eventDocuments.$inferSelect>;
        if (rows.length) out.push(...rows);
        else {
          const existing = await tx.select().from(eventDocuments)
            .where(and(eq(eventDocuments.eventId, r.eventId), eq(eventDocuments.fileId, fileId))).limit(1);
          if (!existing.length) throw new Error('LINK_REFUSED');
          out.push(existing[0]);
        }
      }
      return out;
    });

    return NextResponse.json({
      message: 'Documents linked successfully',
      data: created,
      count: created.length,
    }, { status: 201 });
  } catch (error) {
    if ((error as Error)?.message === 'LINK_REFUSED') return apiError(404, 'NOT_FOUND', 'One or more files not found');
    console.error('POST /api/events/[eventId]/documents error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

/** INSERT borné au compte : rien n'est écrit si l'événement ou le document n'est pas du compte. */
function sqlInsertLink(eventId: number, fileId: number, accountId: number) {
  return sql`
    INSERT INTO event_documents (event_id, file_id, created_at)
    SELECT e.id, f.id, now()
      FROM events e, asset_files f
     WHERE e.id = ${eventId} AND e.account_id = ${accountId}
       AND f.id = ${fileId} AND f.account_id = ${accountId}
    ON CONFLICT DO NOTHING
    RETURNING id, event_id AS "eventId", file_id AS "fileId", created_at AS "createdAt"`;
}
