/**
 * GET /api/admin/legal/cgvu/versions — CDC 7 §15 (administration).
 *
 * Historique des versions, avec le journal d'audit associé (§19).
 */
import { NextRequest, NextResponse } from 'next/server';
import { SessionService } from '@/lib/session-service';
import { ensureMigrations } from '@/db';
import { listVersions, listLegalAudit } from '@/services/legal';

export async function GET(req: NextRequest) {
  try {
    await SessionService.requireAdmin(req);
  } catch (e) {
    return SessionService.handleSessionError(e);
  }

  await ensureMigrations();
  const [versions, audit] = await Promise.all([listVersions(), listLegalAudit({ limit: 100 })]);

  return NextResponse.json({
    versions: versions.map(({ htmlContent, ...rest }) => ({
      ...rest,
      contentLength: htmlContent?.length ?? 0,
    })),
    audit,
  });
}
