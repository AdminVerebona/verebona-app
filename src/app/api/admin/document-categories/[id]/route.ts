/**
 * PATCH /api/admin/document-categories/{id} — CDC 5 §6.1 et §6.3.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * DÉSACTIVER UNE CATÉGORIE N'EST PAS UN CHANGEMENT D'AFFICHAGE
 *
 * Le §6.3 le classe parmi les correctifs de référentiel, avec ses garde-fous :
 *
 *   « Avant confirmation, le back-office affiche le nombre de documents
 *     impactés [...] Un correctif publié ne peut pas être annulé par un
 *     bouton de rollback. »
 *
 * D'où deux temps. Sans `confirm`, la route retourne l'APERÇU : combien de
 * documents portent cette catégorie, et ce qu'ils deviendront. Avec `confirm`,
 * elle applique et consigne le correctif dans une table en ajout seul.
 *
 * L'absence de retour arrière est ce qui rend l'aperçu indispensable : un
 * correctif mal ciblé est irréparable, il ne doit pas être déclenché par
 * inadvertance.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { db, ensureMigrations } from '@/db';
import {
  assetFiles,
  documentCategories,
  documentReferenceCorrections,
} from '@/db/schema';
import { eq, sql } from 'drizzle-orm';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let adminId: number;
  try {
    adminId = await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  const categoryId = Number((await params).id);
  if (!Number.isInteger(categoryId)) {
    return NextResponse.json({ error: 'Identifiant invalide.', code: 'INVALID_ID' }, { status: 400 });
  }

  await ensureMigrations();

  const [category] = await db
    .select()
    .from(documentCategories)
    .where(eq(documentCategories.id, categoryId))
    .limit(1);

  if (!category) {
    return NextResponse.json({ error: 'Catégorie introuvable.', code: 'NOT_FOUND' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Corps de requête invalide.', code: 'BAD_REQUEST' }, { status: 400 });
  }

  const wantsDeactivation = body.isActive === false;
  const confirmed = body.confirm === true;

  // ── AUTRES_DOCUMENTS n'est pas désactivable (§6.1) ──────────────────────
  if (wantsDeactivation && category.isSystemRequired) {
    return NextResponse.json(
      {
        error:
          `${category.code} est la catégorie de dernier recours : elle ne peut pas être désactivée. ` +
          "Sans elle, un document sans catégorie métier n'aurait nulle part où aller.",
        code: 'SYSTEM_CATEGORY',
      },
      { status: 409 },
    );
  }

  // ── Correctif de référentiel : aperçu obligatoire (§6.3) ────────────────
  if (wantsDeactivation) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(assetFiles)
      .where(eq(assetFiles.documentCategoryId, categoryId));

    if (!confirmed) {
      return NextResponse.json({
        preview: true,
        impactCount: count,
        // §6.3, étape 3 : « les cas sans correspondance sont signalés avant
        // validation ». Ici, tous les documents concernés repassent « à
        // classer » — c'est le seul devenir possible pour une catégorie
        // retirée sans remplaçante.
        effect:
          count === 0
            ? 'Aucun document n’utilise cette catégorie.'
            : `${count} document(s) repasseront à l’état « À classer » et perdront leur catégorie.`,
        irreversible: true,
        message: 'Aucun retour arrière n’est prévu. Confirmez pour appliquer.',
      });
    }

    // §6.3, étapes 4 et 5 : application immédiate, y compris aux documents
    // déjà classés.
    const updated = await db
      .update(assetFiles)
      .set({
        documentCategoryId: null,
        classificationState: 'TO_CLASSIFY',
        categorySource: 'REFERENCE_CORRECTION',
        categoryUserLocked: false,
        classificationUpdatedAt: new Date(),
      })
      .where(eq(assetFiles.documentCategoryId, categoryId))
      .returning({ id: assetFiles.id });

    await db.update(documentCategories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(documentCategories.id, categoryId));

    await db.insert(documentReferenceCorrections).values({
      executedBy: adminId,
      correctionType: 'CATEGORY_DEACTIVATED',
      description: `Catégorie ${category.code} désactivée.`,
      mappingJson: JSON.stringify({ from: category.code, to: null, newState: 'TO_CLASSIFY' }),
      impactCount: count,
      appliedCount: updated.length,
      // Un écart entre l'aperçu et l'application signale que la base a bougé
      // entre les deux : information utile, jamais bloquante.
      unmatchedCount: Math.max(0, count - updated.length),
    });

    return NextResponse.json({
      applied: true,
      impactCount: count,
      appliedCount: updated.length,
    });
  }

  // ── Modifications sans effet sur les documents ──────────────────────────
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.genericLabel === 'string' && body.genericLabel.trim()) {
    patch.genericLabel = body.genericLabel.trim();
  }
  if (typeof body.description === 'string') patch.description = body.description;
  if (typeof body.displayOrder === 'number') patch.displayOrder = body.displayOrder;
  if (body.isActive === true) patch.isActive = true;

  const [updated] = await db
    .update(documentCategories)
    .set(patch)
    .where(eq(documentCategories.id, categoryId))
    .returning();

  // Un renommage est un correctif au sens du §6.3, même s'il ne déplace aucun
  // document : il change ce que voient tous les utilisateurs.
  if (patch.genericLabel && patch.genericLabel !== category.genericLabel) {
    await db.insert(documentReferenceCorrections).values({
      executedBy: adminId,
      correctionType: 'CATEGORY_RENAMED',
      description: `Catégorie ${category.code} renommée.`,
      mappingJson: JSON.stringify({ from: category.genericLabel, to: patch.genericLabel }),
    });
  }

  return NextResponse.json({ category: updated });
}
