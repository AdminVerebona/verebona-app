/**
 * GET /api/admin/ai/config-packages — CDC BO IA WF-04, SCR-01.
 *
 * Liste les packages préparés, avec leur trace d'import. C'est la réponse à
 * « quel package est importé en Production ? », l'une des questions que le §24
 * pose comme résultat attendu de la V1.
 */
import { NextRequest, NextResponse } from 'next/server';
import { listPackages } from '@/services/ai/config/config-package.service';
import { requireAdminContext, toErrorResponse } from '../config-versions/_shared';

export async function GET(req: NextRequest) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  try {
    return NextResponse.json({ packages: await listPackages() });
  } catch (e) {
    return toErrorResponse(e, 'GET /api/admin/ai/config-packages');
  }
}
