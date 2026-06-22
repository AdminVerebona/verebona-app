/**
 * GET    /api/assets/[id]/energy-materials  — Liste les matériaux énergétiques
 * POST   /api/assets/[id]/energy-materials  — Ajoute un matériau
 * DELETE /api/assets/[id]/energy-materials?materialId=X — Supprime un matériau
 */

import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db } from '@/db';
import { assets, energyMaterials } from '@/db/schema';
import { eq, and } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const materials = await db
      .select()
      .from(energyMaterials)
      .where(eq(energyMaterials.assetId, assetId));

    return NextResponse.json({ materials });
  } catch (err: any) {
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const body = await request.json();
    const { category, materialNature, brand, reference, thermalResistanceR, lambda, thicknessMm, surfaceSqm, interfaceTreatment } = body;

    if (!category) return NextResponse.json({ error: 'MISSING_CATEGORY' }, { status: 400 });

    const now = new Date();
    const [created] = await db.insert(energyMaterials).values({
      assetId,
      category,
      materialNature: materialNature ?? null,
      brand: brand ?? null,
      reference: reference ?? null,
      thermalResistanceR: thermalResistanceR ?? null,
      lambda: lambda ?? null,
      thicknessMm: thicknessMm ?? null,
      surfaceSqm: surfaceSqm ?? null,
      interfaceTreatment: interfaceTreatment ?? null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    return NextResponse.json({ material: created });
  } catch (err: any) {
    console.error('[energy-materials POST]', err);
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await SessionService.getSession(request);
    const { id } = await params;
    const assetId = parseInt(id);
    if (isNaN(assetId)) return NextResponse.json({ error: 'INVALID_ID' }, { status: 400 });

    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.userId, session.userId)))
      .limit(1);
    if (!asset) return NextResponse.json({ error: 'ASSET_NOT_FOUND' }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const materialId = parseInt(searchParams.get('materialId') ?? '');
    if (isNaN(materialId)) return NextResponse.json({ error: 'MISSING_MATERIAL_ID' }, { status: 400 });

    await db
      .delete(energyMaterials)
      .where(and(eq(energyMaterials.id, materialId), eq(energyMaterials.assetId, assetId)));

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
  }
}
