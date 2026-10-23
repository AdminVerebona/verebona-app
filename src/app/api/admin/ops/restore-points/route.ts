import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-guards';
import { guardAdmin, NO_STORE, opsError } from '../_shared';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/ops/restore-points — lot 82E (C-Q8, D13) : points de
 * restauration disponibles (sauvegardes nocturnes, cron et BO, conservées
 * 30 jours), du plus récent au plus ancien, avec pour chacun : instant de
 * cohérence, libellé, volumes, et RESTAURABLE ou non dans le schéma courant
 * (motif et écarts). Lecture seule ; la création et la restauration passent
 * par le moteur des rattrapages BO (`/api/admin/ops/backfills`,
 * script `database-restore-point`). Administrateurs seulement.
 */
export async function GET(request: NextRequest) {
  const g = await guardAdmin(() => requireAdmin(request));
  if (!g.ok) return g.response;
  try {
    const { isS3Configured } = await import('@/lib/s3-config');
    if (!isS3Configured()) {
      return NextResponse.json({ error: 'Stockage non configuré', code: 'STORAGE_UNAVAILABLE', message: 'Stockage OVH non configuré : aucune sauvegarde.' }, { status: 503, headers: NO_STORE });
    }
    const [{ listDatabaseBackups }, { readSchemaSignature, checkRestoreCompatibility }, { restoreAllowedInEnvironment }, { pgClient }] = await Promise.all([
      import('@/services/backup/database-backup.service'), import('@/services/backup/schema-signature'),
      import('@/services/backup/database-restore.service'), import('@/db'),
    ]);
    const current = await readSchemaSignature(async (sql, p = []) => (await pgClient.unsafe(sql, p as never[])) as unknown as Array<Record<string, unknown>>);
    const items = (await listDatabaseBackups(120)).map(({ manifest, ...b }) => {
      const c = manifest ? checkRestoreCompatibility(manifest as never, current) : null;
      return {
        ...b,
        restorable: !!c?.restorable,
        reason: c ? c.reason : 'Manifeste illisible.',
        differences: c?.differences.slice(0, 30) ?? [],
        differencesCount: c?.differences.length ?? 0,
      };
    });
    return NextResponse.json({ items, environment: restoreAllowedInEnvironment() }, { headers: NO_STORE });
  } catch (e) {
    return opsError(e, 'points de restauration (lecture)', 'RESTORE_POINTS_LIST_FAILED');
  }
}
