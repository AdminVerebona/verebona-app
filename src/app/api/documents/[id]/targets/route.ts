/**
 * Lot 111I — rattachements MULTIPLES d'un document (biens, pièces, équipements).
 *
 *   GET   sélection actuelle (provenance, principal, implications) ;
 *   PUT   remplace la sélection (tiroir) : `{ assetIds, substructureIds, equipmentIds }`
 *         — niveau absent : inchangé ; retrait = dissociation (jamais de suppression) ;
 *   POST  AJOUTE des cibles (dépôt, « Informations complémentaires ») : rien n'est retiré,
 *         aucune marque de décision utilisateur (l'analyse peut encore compléter).
 *
 * Bornée au compte actif ; écriture refusée en lecture seule (lot 85D).
 * Le PUT de `/api/documents/[id]` accepte les mêmes listes (avec les autres champs).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { getSession } from '@/lib/auth-guards';
import { refuserSiLectureSeule } from '@/lib/write-access-guard';
import { applyDocumentTargets, readDocumentTargets, type TargetsExecutor } from '@/services/documents/document-targets/service';
import { selectionFromBody, TargetSelectionError } from '@/services/documents/document-targets/plan';
import { documentTargetsErrorResponse } from '@/services/documents/document-targets/route-support';

type Ctx = { params: Promise<{ id: string }> };

async function documentId(ctx: Ctx): Promise<number | null> {
  const { id } = await ctx.params;
  return /^\d{1,10}$/.test(id) ? Number(id) : null;
}

export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    const session = await getSession(request);
    if (!session.currentAccountId) return NextResponse.json({ error: 'NO_ACCOUNT', message: 'Aucun compte sélectionné' }, { status: 400 });
    const id = await documentId(ctx);
    if (id === null) return NextResponse.json({ error: 'INVALID_INPUT', message: 'ID de document invalide' }, { status: 400 });
    const targets = await readDocumentTargets(db as unknown as TargetsExecutor, session.currentAccountId, id);
    if (!targets) return NextResponse.json({ error: 'NOT_FOUND', message: 'Document non trouvé' }, { status: 404 });
    return NextResponse.json({ targets });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/documents/[id]/targets error:', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' }, { status: 500 });
  }
}

async function write(request: NextRequest, ctx: Ctx, mode: 'replace' | 'add') {
  const label = `${mode === 'replace' ? 'PUT' : 'POST'} /api/documents/[id]/targets`;
  try {
    const session = await getSession(request);
    if (!session.currentAccountId) return NextResponse.json({ error: 'NO_ACCOUNT', message: 'Aucun compte sélectionné' }, { status: 400 });
    const refus = await refuserSiLectureSeule(session.currentAccountId);
    if (refus) return refus;
    const id = await documentId(ctx);
    if (id === null) return NextResponse.json({ error: 'INVALID_INPUT', message: 'ID de document invalide' }, { status: 400 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'INVALID_INPUT', message: 'Corps invalide' }, { status: 400 });
    const accountId = session.currentAccountId;
    const result = await db.transaction(async (tx) => {
      const x = tx as unknown as TargetsExecutor;
      const avant = await readDocumentTargets(x, accountId, id);
      if (!avant) throw new TargetSelectionError('NOT_FOUND', 'Document introuvable');
      const rien = { assetIds: [], roomIds: [], equipmentIds: [] };
      const actuelle = {
        assetIds: avant.assets.filter((a) => !a.implied).map((a) => a.id),
        roomIds: avant.rooms.filter((r) => !r.implied).map((r) => r.id),
        equipmentIds: avant.equipments.map((e) => e.id),
      };
      const selection = selectionFromBody(body, mode === 'add' ? rien : actuelle);
      if (!selection) throw new TargetSelectionError('INVALID_INPUT', 'Aucune liste de rattachement (assetIds, substructureIds, equipmentIds)');
      return applyDocumentTargets(x, { accountId, fileId: id, selection, mode });
    });
    if (result.columnsChanged || result.added || result.removed || result.promoted) {
      // « À traiter » et caches de l'assistant suivent la correction (ne lèvent jamais).
      const [{ onDocumentEditedByUser }, { emitBusinessEvent }] = await Promise.all([
        import('@/services/to-process/document-rule-bridge'),
        import('@/services/verebona-assistant/events/business-events'),
      ]);
      await onDocumentEditedByUser(accountId, id);
      await emitBusinessEvent({ type: 'DOCUMENT_UPDATED', accountId, entityId: id });
    }
    const targets = await readDocumentTargets(db as unknown as TargetsExecutor, accountId, id);
    return NextResponse.json({ targets, result: { added: result.added, removed: result.removed, promoted: result.promoted, columnsChanged: result.columnsChanged } });
  } catch (error) {
    const r = documentTargetsErrorResponse(error, (await getSession(request).catch(() => ({ currentAccountId: 0 }))).currentAccountId ?? 0, label);
    if (r) return r;
    if (error instanceof Response) return error;
    console.error(`${label} error:`, error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'INTERNAL_ERROR', message: 'Erreur serveur interne' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  return write(request, ctx, 'replace');
}

export async function POST(request: NextRequest, ctx: Ctx) {
  return write(request, ctx, 'add');
}
