/**
 * GET /api/admin/ai/log-archives — CDC BO IA LOG-UI-09, WF-25.
 *
 * Statut des archives S3 des logs IA de plus de 90 jours : objets, période,
 * volume, empreinte. L'archive n'est pas interrogeable depuis le BO en V1 —
 * la restauration est une opération technique.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listAiLogArchives } from '@/services/ai/telemetry/log-archive.job';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;
  const raw = new URL(req.url).searchParams.get('limit');
  try {
    return NextResponse.json(await listAiLogArchives(raw && /^\d+$/.test(raw) ? Number(raw) : 60));
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/log-archives');
  }
}
