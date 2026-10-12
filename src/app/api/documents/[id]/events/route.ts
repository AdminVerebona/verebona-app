/**
 * Événements (domaine historique « events ») liés à un document — lot 49,
 * SEC-02 : autorisation par le COMPTE ACTIF (et non plus par l'utilisateur
 * seul) ; document, événements et associations bornés au compte dans le SQL.
 * Un identifiant étranger fait refuser la demande entière ; une association
 * incorrecte déjà en base n'expose jamais un événement d'un autre compte.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { eventDocuments, events, assetFiles } from '@/db/schema';
import { eq, and, isNull, inArray, sql } from 'drizzle-orm';
import { SessionService } from '@/lib/session-service';
import { cleanIds, findRejectedRefs, logCrossAccountRefusal } from '@/services/security/account-ownership';

type Ctx = { params: Promise<{ id: string }> };

const err = (status: number, error: string, message: string) => NextResponse.json({ error, message }, { status });

/** Compte actif et document du compte (non supprimé), ou réponse d'erreur. */
async function documentOfAccount(request: NextRequest, ctx: Ctx) {
  let session;
  try {
    session = await SessionService.getSession(request);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }
  if (!session?.currentAccountId) return err(401, 'UNAUTHORIZED', 'Authentification requise');
  const { id } = await ctx.params;
  const documentId = parseInt(id);
  if (isNaN(documentId)) return err(400, 'INVALID_INPUT', 'ID de document invalide');
  const [document] = await db
    .select({ id: assetFiles.id, assetId: assetFiles.assetId })
    .from(assetFiles)
    .where(and(eq(assetFiles.id, documentId), eq(assetFiles.accountId, session.currentAccountId), isNull(assetFiles.deletedAt)))
    .limit(1);
  if (!document) return err(404, 'NOT_FOUND', 'Document non trouvé');
  return { accountId: session.currentAccountId, documentId, documentAssetId: document.assetId };
}

/**
 * GET /api/documents/[id]/events — événements liés au document (du compte).
 */
export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    const d = await documentOfAccount(request, ctx);
    if (d instanceof NextResponse) return d;

    const linkedEvents = await db
      .select({
        id: events.id,
        title: events.title,
        date: events.date,
        eventType: events.categorie, // alias from categorie
        provider: events.provider,
        costCents: events.costCents,
        notes: events.notes,
        assetId: events.assetId,
        createdAt: events.createdAt,
        associationDate: eventDocuments.createdAt,
      })
      .from(eventDocuments)
      .innerJoin(events, and(eq(eventDocuments.eventId, events.id), eq(events.accountId, d.accountId)))
      .where(eq(eventDocuments.fileId, d.documentId))
      .orderBy(events.date);

    return NextResponse.json({
      documentId: d.documentId,
      events: linkedEvents,
      total: linkedEvents.length,
    }, { status: 200 });
  } catch (error) {
    console.error('GET /api/documents/[id]/events error:', error);
    return err(500, 'INTERNAL_ERROR', 'Erreur serveur interne');
  }
}

/**
 * POST /api/documents/[id]/events — associe le document à des événements
 * du compte, portés par le même bien que le document.
 */
export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const d = await documentOfAccount(request, ctx);
    if (d instanceof NextResponse) return d;

    const body = await request.json().catch(() => ({}));
    const { eventIds } = body as { eventIds?: unknown };
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return err(400, 'INVALID_INPUT', 'eventIds doit être un tableau non vide');
    }
    const ids = cleanIds(eventIds as number[]);
    if (ids.length !== new Set(eventIds).size) return err(400, 'INVALID_INPUT', 'eventIds invalides');

    // Appartenance au compte : refus ENTIER au premier identifiant étranger.
    const rejected = await findRejectedRefs(d.accountId, { event: ids });
    if (rejected.length) {
      logCrossAccountRefusal('POST /api/documents/[id]/events', { accountId: d.accountId, rejected });
      return err(404, 'NOT_FOUND', 'Événement non trouvé');
    }

    // Même bien que le document (règle historique), lu dans le compte.
    const eventsToLink = await db
      .select({ id: events.id, assetId: events.assetId })
      .from(events)
      .where(and(eq(events.accountId, d.accountId), inArray(events.id, ids)));
    if (eventsToLink.length !== ids.length || eventsToLink.some((e) => e.assetId !== d.documentAssetId)) {
      return err(400, 'INVALID_INPUT', `Les événements doivent appartenir au même bien que le document (bien #${d.documentAssetId})`);
    }

    const existingLinks = await db
      .select({ eventId: eventDocuments.eventId })
      .from(eventDocuments)
      .where(eq(eventDocuments.fileId, d.documentId));
    const existingEventIds = new Set(existingLinks.map((link) => link.eventId));
    const newEventIds = ids.filter((id) => !existingEventIds.has(id));

    // Insertion bornée au compte dans son propre SQL (événement ET document).
    let createdCount = 0;
    if (newEventIds.length > 0) {
      const rows = (await db.execute(sql`
        INSERT INTO event_documents (event_id, file_id, created_at)
        SELECT e.id, f.id, now()
          FROM events e JOIN asset_files f ON f.id = ${d.documentId} AND f.account_id = ${d.accountId}
         WHERE e.id = ANY(${`{${newEventIds.join(',')}}`}::int[]) AND e.account_id = ${d.accountId}
        ON CONFLICT DO NOTHING
        RETURNING id`)) as unknown as unknown[];
      createdCount = rows.length;
    }

    return NextResponse.json({
      message: 'Événements associés avec succès',
      created: createdCount,
      alreadyLinked: existingEventIds.size,
      total: ids.length,
    }, { status: 201 });
  } catch (error) {
    console.error('POST /api/documents/[id]/events error:', error);
    return err(500, 'INTERNAL_ERROR', 'Erreur serveur interne');
  }
}

/**
 * DELETE /api/documents/[id]/events?eventId= — retire l'association
 * (document ET événement du compte ; une relation d'un autre compte n'est
 * jamais supprimée).
 */
export async function DELETE(request: NextRequest, ctx: Ctx) {
  try {
    const d = await documentOfAccount(request, ctx);
    if (d instanceof NextResponse) return d;

    const { searchParams } = new URL(request.url);
    const eventId = parseInt(searchParams.get('eventId') ?? '');
    if (isNaN(eventId)) return err(400, 'INVALID_INPUT', 'eventId requis');

    const deleted = await db
      .delete(eventDocuments)
      .where(and(
        eq(eventDocuments.fileId, d.documentId),
        eq(eventDocuments.eventId, eventId),
        inArray(eventDocuments.eventId, db.select({ id: events.id }).from(events).where(and(eq(events.id, eventId), eq(events.accountId, d.accountId)))),
      ))
      .returning();

    if (deleted.length === 0) return err(404, 'NOT_FOUND', 'Association non trouvée');

    return NextResponse.json({
      message: 'Association supprimée avec succès',
      documentId: d.documentId,
      eventId,
    }, { status: 200 });
  } catch (error) {
    console.error('DELETE /api/documents/[id]/events error:', error);
    return err(500, 'INTERNAL_ERROR', 'Erreur serveur interne');
  }
}
