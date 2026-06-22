/**
 * PATCH /api/admin/document-ai/mappings/[id] — Met à jour un mapping (status, labels…)
 * DELETE /api/admin/document-ai/mappings/[id] — Désactive un mapping (soft disable)
 * CDC §19 : "Chaque mapping peut être activé ou désactivé sans être supprimé."
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { documentTaxonomyMappings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(req);
    const { id: rawId } = await params;
    const id = parseInt(rawId);
    if (isNaN(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const body = await req.json();
    const { status, canonicalCode, canonicalLabel, rawLabel, confidenceThreshold } = body;

    const updateData: Partial<typeof documentTaxonomyMappings.$inferInsert> = {};
    if (status !== undefined) {
      if (!['active', 'inactive'].includes(status)) {
        return NextResponse.json({ error: 'INVALID_STATUS' }, { status: 400 });
      }
      updateData.status = status;
      if (status === 'inactive') {
        updateData.disabledAt = new Date();
      } else {
        updateData.disabledAt = null;
      }
    }
    if (canonicalCode !== undefined) updateData.canonicalCode = canonicalCode;
    if (canonicalLabel !== undefined) updateData.canonicalLabel = canonicalLabel;
    if (rawLabel !== undefined) updateData.rawLabel = rawLabel;
    if (confidenceThreshold !== undefined) updateData.confidenceThreshold = String(confidenceThreshold);

    const [updated] = await db
      .update(documentTaxonomyMappings)
      .set(updateData)
      .where(eq(documentTaxonomyMappings.id, id))
      .returning();

    if (!updated) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

    return NextResponse.json({ mapping: updated });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('PATCH /api/admin/document-ai/mappings/[id] error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdmin(req);
    const { id: rawId } = await params;
    const id = parseInt(rawId);
    if (isNaN(id)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    // CDC: "Chaque mapping peut être activé ou désactivé sans être supprimé."
    // Soft disable rather than physical delete.
    const [updated] = await db
      .update(documentTaxonomyMappings)
      .set({ status: 'inactive', disabledAt: new Date() })
      .where(eq(documentTaxonomyMappings.id, id))
      .returning({ id: documentTaxonomyMappings.id });

    if (!updated) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('DELETE /api/admin/document-ai/mappings/[id] error:', error);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
