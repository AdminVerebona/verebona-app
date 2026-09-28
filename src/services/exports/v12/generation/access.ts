/**
 * Accès à une génération par son identifiant public (§17 :
 * `/api/export-generations/{publicId}`…). Les droits sont ceux du BIEN,
 * revérifiés à chaque appel (DRH-001/002/010) : compte courant de la session,
 * bien non supprimé. Une génération d'un autre compte est introuvable (404,
 * sans révéler son existence).
 */

import { db } from '@/db';
import { exportGenerations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { findAccessibleAssetForExport, type ExportAccessSession, type AccessibleAsset } from '@/services/exports/export-access';
import type { GenerationRow } from './repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findAccessibleGeneration(session: ExportAccessSession, publicId: string): Promise<{ row: GenerationRow; asset: AccessibleAsset } | null> {
  if (!UUID.test(publicId)) return null;
  const [row] = await db.select().from(exportGenerations).where(eq(exportGenerations.publicId, publicId)).limit(1);
  if (!row) return null;
  const asset = await findAccessibleAssetForExport(session, row.assetId);
  return asset ? { row, asset } : null;
}
