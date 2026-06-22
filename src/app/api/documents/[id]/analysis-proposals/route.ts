/**
 * GET /api/documents/[id]/analysis-proposals
 * [id] = asset_files.id
 * Liste les propositions du run courant (is_current_reference = true).
 *
 * PATCH /api/documents/[id]/analysis-proposals
 * Actions : modify | reject | restore_original
 * JAMAIS : kept (posé uniquement au commit)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth-guards';
import { db } from '@/db';
import { documentAnalysisRuns, documentAnalysisProposals } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    const { id: rawId } = await params;
    const accountId = session.currentAccountId;

    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    const assetFileId = parseInt(rawId);
    if (isNaN(assetFileId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    // Find the current reference run
    const [currentRun] = await db
      .select({ id: documentAnalysisRuns.id })
      .from(documentAnalysisRuns)
      .where(and(
        eq(documentAnalysisRuns.assetFileId, assetFileId),
        eq(documentAnalysisRuns.accountId, accountId),
        eq(documentAnalysisRuns.isCurrentReference, true)
      ))
      .limit(1);

    if (!currentRun) {
      return NextResponse.json({ proposals: [], currentRunId: null });
    }

    const proposals = await db
      .select()
      .from(documentAnalysisProposals)
      .where(and(
        eq(documentAnalysisProposals.runId, currentRun.id),
        eq(documentAnalysisProposals.accountId, accountId)
      ));

    return NextResponse.json({ proposals, currentRunId: currentRun.id });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('GET /api/documents/[id]/analysis-proposals error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request);
    const { id: rawId } = await params;
    const accountId = session.currentAccountId;

    if (!accountId) return NextResponse.json({ error: 'NO_ACCOUNT' }, { status: 400 });

    const assetFileId = parseInt(rawId);
    if (isNaN(assetFileId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const body = await request.json();
    const { proposalId, action, value } = body;

    if (!proposalId || !action) {
      return NextResponse.json({ error: 'MISSING_FIELDS' }, { status: 400 });
    }

    // Validate action — kept is NEVER allowed via PATCH
    if (!['modify', 'reject', 'restore_original'].includes(action)) {
      return NextResponse.json(
        { error: 'INVALID_ACTION', message: 'Actions autorisées : modify, reject, restore_original. kept est posé uniquement au commit.' },
        { status: 400 }
      );
    }

    const [proposal] = await db
      .select()
      .from(documentAnalysisProposals)
      .where(and(
        eq(documentAnalysisProposals.id, parseInt(proposalId)),
        eq(documentAnalysisProposals.assetFileId, assetFileId),
        eq(documentAnalysisProposals.accountId, accountId)
      ))
      .limit(1);

    if (!proposal) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    let updateData: { status: string; finalValueJson: string | null };

    switch (action) {
      case 'modify':
        if (value === undefined) return NextResponse.json({ error: 'MISSING_VALUE' }, { status: 400 });
        updateData = { status: 'modified', finalValueJson: JSON.stringify(value) };
        break;
      case 'reject':
        updateData = { status: 'rejected', finalValueJson: null };
        break;
      case 'restore_original':
        updateData = { status: 'pending', finalValueJson: null };
        break;
      default:
        return NextResponse.json({ error: 'INVALID_ACTION' }, { status: 400 });
    }

    const [updated] = await db
      .update(documentAnalysisProposals)
      .set(updateData)
      .where(eq(documentAnalysisProposals.id, proposal.id))
      .returning();

    return NextResponse.json({ proposal: updated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('PATCH /api/documents/[id]/analysis-proposals error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
