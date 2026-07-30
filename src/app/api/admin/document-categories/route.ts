/**
 * Administration des catégories documentaires — CDC 5 §6.1.
 *
 * GET  : référentiel complet, avec applicabilité et types associés.
 * POST : création d'une catégorie.
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db, ensureMigrations } from '@/db';
import {
  assetTypes,
  documentCategories,
  documentCategoryAssetAssociations,
  documentCategoryTypeAssociations,
  documentTypes,
} from '@/db/schema';
import { asc, eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  try {
    await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();

  const categories = await db
    .select()
    .from(documentCategories)
    .orderBy(asc(documentCategories.displayOrder), asc(documentCategories.code));

  const assetLinks = await db
    .select({
      categoryId: documentCategoryAssetAssociations.categoryId,
      assetTypeId: documentCategoryAssetAssociations.assetTypeId,
      assetTypeCode: assetTypes.code,
      assetTypeLabel: assetTypes.label,
      contextualLabel: documentCategoryAssetAssociations.contextualLabel,
      displayOrder: documentCategoryAssetAssociations.displayOrder,
    })
    .from(documentCategoryAssetAssociations)
    .leftJoin(assetTypes, eq(documentCategoryAssetAssociations.assetTypeId, assetTypes.id));

  const typeLinks = await db
    .select({
      categoryId: documentCategoryTypeAssociations.categoryId,
      typeCode: documentTypes.code,
      typeLabel: documentTypes.label,
      isActive: documentCategoryTypeAssociations.isActive,
    })
    .from(documentCategoryTypeAssociations)
    .innerJoin(documentTypes, eq(documentCategoryTypeAssociations.documentTypeId, documentTypes.id));

  return NextResponse.json({
    categories: categories.map((c) => ({
      ...c,
      // `assetTypeCode` à null = applicable à toutes les familles (§3.2).
      assetScopes: assetLinks.filter((a) => a.categoryId === c.id),
      types: typeLinks.filter((t) => t.categoryId === c.id),
    })),
    assetTypes: await db.select({ id: assetTypes.id, code: assetTypes.code, label: assetTypes.label })
      .from(assetTypes).orderBy(asc(assetTypes.displayOrder)),
    documentTypes: await db.select({ id: documentTypes.id, code: documentTypes.code, label: documentTypes.label })
      .from(documentTypes).where(eq(documentTypes.isActive, true)).orderBy(asc(documentTypes.label)),
  });
}

export async function POST(req: NextRequest) {
  try {
    await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const genericLabel = typeof body.genericLabel === 'string' ? body.genericLabel.trim() : '';

  if (!/^[A-Z][A-Z0-9_]{2,49}$/.test(code)) {
    return NextResponse.json(
      { error: 'Code invalide : majuscules, chiffres et tirets bas, 3 à 50 caractères.', code: 'INVALID_CODE' },
      { status: 400 },
    );
  }
  if (!genericLabel) {
    return NextResponse.json(
      { error: 'Le libellé générique est obligatoire.', code: 'MISSING_LABEL' },
      { status: 400 },
    );
  }

  const [existing] = await db
    .select({ id: documentCategories.id })
    .from(documentCategories)
    .where(eq(documentCategories.code, code))
    .limit(1);

  if (existing) {
    return NextResponse.json(
      { error: `Le code ${code} existe déjà.`, code: 'CODE_TAKEN' },
      { status: 409 },
    );
  }

  const [created] = await db
    .insert(documentCategories)
    .values({
      code,
      genericLabel,
      description: typeof body.description === 'string' ? body.description : null,
      displayOrder: typeof body.displayOrder === 'number' ? body.displayOrder : 100,
      // Une catégorie créée n'est jamais système : seule AUTRES_DOCUMENTS
      // l'est, et elle est posée par le seed (§6.1).
      isSystemRequired: false,
      isActive: true,
    })
    .returning();

  return NextResponse.json({ category: created }, { status: 201 });
}
