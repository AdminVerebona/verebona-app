/**
 * @deprecated LEGACY — Gel du domaine Deadlines
 *
 * ⚠️  GEL ACTIF — Aucune nouvelle dépendance à cette route n'est autorisée.
 *
 * L'objet canonique des données datées est désormais `agenda_items`.
 * Cette route est gelée en tant que source legacy ; elle sera supprimée une
 * fois la migration complète des données et la suppression des derniers
 * consommateurs confirmées.
 *
 * Critères de suppression (tous requis) :
 *  - aucun fetch ou apiClient n'appelle /api/deadlines
 *  - aucun composant métier n'importe create-deadline-dialog / edit-deadline-dialog
 *  - les données deadlines restantes sont migrées vers agenda_items
 *    (originType = 'legacy_deadline_migration')
 *
 * Voir : src/db/migrations/0051_backfill_legacy_to_agenda.ts
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { parsePaginationParams, buildPaginationResponse, getCursorId } from '@/lib/pagination';
import { apiError } from '@/lib/api-errors';
import { SessionService } from '@/lib/session-service';

const VALID_DEADLINE_TYPES = ['ENTRETIEN', 'CONTROLE_TECHNIQUE', 'ASSURANCE', 'GARANTIE', 'ADMINISTRATIF', 'AUTRE'] as const;

export async function GET(request: NextRequest) {
  try {
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'No account selected');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (id) {
      if (!id || isNaN(parseInt(id))) {
        return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
      }

      const deadlineRows = await db.$client<{ id: number; account_id: number; asset_id: number | null; label: string; deadline_date: string; deadline_type: string; is_done: boolean; done_date: string | null; notes: string | null; substructure_id: number | null; equipment_id: number | null; created_at: string; updated_at: string }[]>`
        SELECT id, account_id, asset_id, label, deadline_date, deadline_type, is_done, done_date, notes, substructure_id, equipment_id, created_at, updated_at
        FROM deadlines WHERE id = ${parseInt(id)} AND account_id = ${session.currentAccountId} LIMIT 1
      `;

      if (deadlineRows.length === 0) {
        return apiError(404, 'NOT_FOUND', 'Deadline not found');
      }

      const additionRows = await db.$client<{ last_added_at: string | null; dismissed_at: string | null }[]>`
        SELECT last_added_at, dismissed_at FROM calendar_additions
        WHERE deadline_id = ${parseInt(id)} AND user_id = ${session.userId} LIMIT 1
      `;

      let needsCalendarUpdate = false;
      if (additionRows.length > 0) {
        const { last_added_at, dismissed_at } = additionRows[0];
        const updatedAt = deadlineRows[0].updated_at;
        if (updatedAt && last_added_at) {
          const lastAdded = new Date(last_added_at).getTime();
          const updated = new Date(updatedAt).getTime();
          if (updated > lastAdded) {
            if (!dismissed_at || updated > new Date(dismissed_at).getTime()) {
              needsCalendarUpdate = true;
            }
          }
        }
      }

      const d = deadlineRows[0];
      return NextResponse.json({
        id: d.id, accountId: d.account_id, assetId: d.asset_id, label: d.label,
        deadlineDate: d.deadline_date, deadlineType: d.deadline_type, isDone: d.is_done,
        doneDate: d.done_date, notes: d.notes, substructureId: d.substructure_id,
        equipmentId: d.equipment_id, createdAt: d.created_at, updatedAt: d.updated_at,
        needsCalendarUpdate,
      }, { status: 200 });
    }

    const { limit, cursor } = parsePaginationParams(searchParams);
    const search = searchParams.get('search');
    const assetId = searchParams.get('assetId');
    const deadlineType = searchParams.get('deadlineType');
    const isDoneParam = searchParams.get('isDone');
    const cursorId = getCursorId(cursor);

    // Build raw SQL to avoid Drizzle schema mismatch
    const whereClauses: string[] = [`d.account_id = ${session.currentAccountId}`];
    if (cursorId !== null) whereClauses.push(`d.id < ${cursorId}`);
    if (search) whereClauses.push(`d.label ILIKE '%${search.replace(/'/g, "''")}%'`);
    if (assetId && !isNaN(parseInt(assetId))) whereClauses.push(`d.asset_id = ${parseInt(assetId)}`);
    if (deadlineType && VALID_DEADLINE_TYPES.includes(deadlineType as any)) whereClauses.push(`d.deadline_type = '${deadlineType}'`);
    if (isDoneParam !== null) whereClauses.push(`d.is_done = ${isDoneParam === 'true'}`);

    const where = whereClauses.join(' AND ');
    const rows = await db.$client<{
      id: number; account_id: number; asset_id: number | null;
      label: string; deadline_date: string; deadline_type: string;
      is_done: boolean; done_date: string | null; notes: string | null;
      substructure_id: number | null; equipment_id: number | null;
      created_at: string; updated_at: string;
      asset_id_join: number | null; asset_name: string | null;
    }[]>`
      SELECT d.id, d.account_id, d.asset_id, d.label, d.deadline_date, d.deadline_type,
             d.is_done, d.done_date, d.notes, d.substructure_id, d.equipment_id,
             d.created_at, d.updated_at,
             a.id AS asset_id_join, a.name AS asset_name
      FROM deadlines d
      LEFT JOIN assets a ON d.asset_id = a.id
      WHERE ${db.$client.unsafe(where)}
      ORDER BY d.id DESC
      LIMIT ${limit + 1}
    `;

    const mapped = rows.map(r => ({
      id: r.id,
      accountId: r.account_id,
      assetId: r.asset_id,
      label: r.label,
      deadlineDate: r.deadline_date,
      deadlineType: r.deadline_type,
      isDone: r.is_done,
      doneDate: r.done_date,
      notes: r.notes,
      substructureId: r.substructure_id,
      equipmentId: r.equipment_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      asset: r.asset_id_join ? { id: r.asset_id_join, name: r.asset_name } : null,
    }));

    const paginatedResponse = buildPaginationResponse(mapped, limit);

    return NextResponse.json(paginatedResponse, { status: 200 });

  } catch (error: any) {
    console.error('GET error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + error.message);
  }
}

export async function POST(request: NextRequest) {
  try {
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'No account selected');
    }

    const body = await request.json();
    const { assetId, label, deadlineDate, deadlineType, isDone, doneDate, notes, substructureId, equipmentId } = body;

    if (!label || typeof label !== 'string' || label.trim() === '') {
      return apiError(400, 'MISSING_FIELD', 'label is required');
    }

    if (deadlineType && !VALID_DEADLINE_TYPES.includes(deadlineType)) {
      return apiError(400, 'INVALID_INPUT', `deadlineType must be one of: ${VALID_DEADLINE_TYPES.join(', ')}`);
    }

    if (assetId && isNaN(parseInt(assetId))) {
      return apiError(400, 'INVALID_INPUT', 'assetId must be a valid integer');
    }

    if (assetId) {
      const assetExists = await db.$client`
        SELECT id FROM assets WHERE id = ${parseInt(assetId)} AND account_id = ${session.currentAccountId} LIMIT 1
      `;
      if (assetExists.length === 0) {
        return apiError(404, 'NOT_FOUND', 'Asset not found or does not belong to your account');
      }
    }

    if (!session.userId) {
      return apiError(400, 'MISSING_FIELD', 'User ID is missing from session');
    }

    const [newDeadline] = await db.$client`
      INSERT INTO deadlines (
        account_id, user_id, asset_id, substructure_id, equipment_id,
        label, deadline_date, deadline_type, is_done, done_date, notes,
        created_at, updated_at
      ) VALUES (
        ${session.currentAccountId},
        ${session.userId},
        ${assetId ? parseInt(assetId) : null},
        ${substructureId || null},
        ${equipmentId || null},
        ${label.trim()},
        ${deadlineDate || null},
        ${(deadlineType && deadlineType !== 'none') ? deadlineType : null},
        ${isDone ?? false},
        ${doneDate || null},
        ${notes || null},
        NOW(), NOW()
      )
      RETURNING *
    `;

    return NextResponse.json(newDeadline, { status: 201 });

  } catch (error: any) {
    console.error('POST error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + error.message);
  }
}

export async function PUT(request: NextRequest) {
  try {
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'No account selected');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    const existingRows = await db.$client`
      SELECT id FROM deadlines WHERE id = ${parseInt(id)} AND account_id = ${session.currentAccountId} LIMIT 1
    `;
    if (existingRows.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Deadline not found or does not belong to your account');
    }

    const body = await request.json();
    const { label, deadlineDate, deadlineType, isDone, doneDate, notes, substructureId, equipmentId } = body;

    if (deadlineType && !VALID_DEADLINE_TYPES.includes(deadlineType)) {
      return apiError(400, 'INVALID_INPUT', `deadlineType must be one of: ${VALID_DEADLINE_TYPES.join(', ')}`);
    }

    if (label !== undefined && (typeof label !== 'string' || label.trim() === '')) {
      return apiError(400, 'INVALID_INPUT', 'label cannot be empty');
    }

    const setClauses: string[] = [`updated_at = NOW()`];
    if (label !== undefined) setClauses.push(`label = '${String(label).trim().replace(/'/g, "''")}'`);
    if (deadlineDate !== undefined) setClauses.push(`deadline_date = ${deadlineDate ? `'${deadlineDate}'` : 'NULL'}`);
    if (deadlineType !== undefined) setClauses.push(`deadline_type = ${deadlineType ? `'${deadlineType}'` : 'NULL'}`);
    if (isDone !== undefined) setClauses.push(`is_done = ${isDone ? 'true' : 'false'}`);
    if (doneDate !== undefined) setClauses.push(`done_date = ${doneDate ? `'${doneDate}'` : 'NULL'}`);
    if (notes !== undefined) setClauses.push(`notes = ${notes ? `'${String(notes).replace(/'/g, "''")}'` : 'NULL'}`);
    if (substructureId !== undefined) setClauses.push(`substructure_id = ${substructureId ?? 'NULL'}`);
    if (equipmentId !== undefined) setClauses.push(`equipment_id = ${equipmentId ?? 'NULL'}`);

    const [updatedRow] = await db.$client`
      UPDATE deadlines SET ${db.$client.unsafe(setClauses.join(', '))}
      WHERE id = ${parseInt(id)}
      RETURNING id, account_id, asset_id, label, deadline_date, deadline_type, is_done, done_date, notes, substructure_id, equipment_id, created_at, updated_at
    `;

    return NextResponse.json(updatedRow, { status: 200 });

  } catch (error: any) {
    console.error('PUT error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + error.message);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    let session: Awaited<ReturnType<typeof SessionService.tryGetSession>>;
    try {
      session = await SessionService.getSession(request);
    } catch (authError) {
      return SessionService.handleSessionError(authError);
    }

    if (!session) {
      return apiError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    if (!session.currentAccountId) {
      return apiError(401, 'UNAUTHORIZED', 'No account selected');
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id || isNaN(parseInt(id))) {
      return apiError(400, 'INVALID_INPUT', 'Valid ID is required');
    }

    const existingRows = await db.$client`
      SELECT id FROM deadlines WHERE id = ${parseInt(id)} AND account_id = ${session.currentAccountId} LIMIT 1
    `;
    if (existingRows.length === 0) {
      return apiError(404, 'NOT_FOUND', 'Deadline not found or does not belong to your account');
    }

    await db.$client`DELETE FROM deadlines WHERE id = ${parseInt(id)}`;

    return NextResponse.json({ message: 'Deadline deleted successfully' }, { status: 200 });

  } catch (error: any) {
    console.error('DELETE error:', error);
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error: ' + error.message);
  }
}
