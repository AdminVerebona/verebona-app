import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { assetTypes, assetTypeSubcategories } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { requireAdmin } from '@/lib/auth-guards';

export async function GET(request: NextRequest) {
  try {
    // Auth check
    await requireAdmin(request);

    // 1. Check if OBJECT exists
    const existingType = await db.select()
      .from(assetTypes)
      .where(eq(assetTypes.code, 'OBJECT'))
      .limit(1);

    let assetTypeId: number;

    if (existingType.length === 0) {
      const now = new Date();
      const [newType] = await db.insert(assetTypes).values({
        code: 'OBJECT',
        label: 'Objet',
        icon: 'Package',
        isEnabled: true,
        displayOrder: 4,
        createdAt: now,
        updatedAt: now,
      }).returning();
      assetTypeId = newType.id;
    } else {
      assetTypeId = existingType[0].id;
    }

    // 2. Add subcategories if they don't exist
    const subcategories = [
      { code: 'OBJECT_CATEGORY_TECH', label: 'Tech / IT / Électronique', icon: 'Laptop', displayOrder: 1 },
      { code: 'OBJECT_CATEGORY_SPORT', label: 'Loisir / Sport', icon: 'Dumbbell', displayOrder: 2 },
      { code: 'OBJECT_CATEGORY_HOME', label: 'Maison & équipement', icon: 'Microwave', displayOrder: 3 },
    ];

    const results = [];
    for (const sub of subcategories) {
      const existingSub = await db.select()
        .from(assetTypeSubcategories)
        .where(eq(assetTypeSubcategories.code, sub.code))
        .limit(1);

      if (existingSub.length === 0) {
        const now = new Date();
        const [newSub] = await db.insert(assetTypeSubcategories).values({
          assetTypeId,
          code: sub.code,
          label: sub.label,
          icon: sub.icon,
          isEnabled: true,
          displayOrder: sub.displayOrder,
          createdAt: now,
          updatedAt: now,
        }).returning();
        results.push({ code: sub.code, action: 'created' });
      } else {
        results.push({ code: sub.code, action: 'exists' });
      }
    }

    return NextResponse.json({
      message: 'Migration completed',
      assetType: existingType.length === 0 ? 'created' : 'exists',
      subcategories: results,
    });

  } catch (error) {
    if (error instanceof Response) return error;
    console.error('Migration error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
