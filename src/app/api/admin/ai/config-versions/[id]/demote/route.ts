/**
 * POST /api/admin/ai/config-versions/[id]/demote — CDC BO IA VER-012 (§26),
 * TST-01, VER-005.
 *
 * Renvoie une version « À tester » en Brouillon : la préproduction revient sur
 * sa dernière Active, et la version redevient modifiable.
 *
 * ── POURQUOI CETTE ROUTE ÉTAIT INDISPENSABLE ───────────────────────────────
 * Le service `backToDraft()` existait, mais rien ne l'appelait. La machine à
 * états interdit d'archiver une version À tester ; une version À tester
 * erronée ne pouvait donc sortir que par la validation — c'est-à-dire en
 * devenant Active. Et il ne peut exister qu'une À tester par environnement :
 * une seule erreur bloquait tout le cycle de test.
 *
 * Les caches de configuration sont vidés par le service : le retour prend
 * effet dès l'appel suivant. Un statut incompatible (Brouillon, Active…) est
 * refusé par la machine à états et rend 409.
 */
import { NextRequest, NextResponse } from 'next/server';
import { backToDraft } from '@/services/ai/config/config-version.service';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const versionId = parseVersionId(id);
  if (versionId === null) return invalidId(id);

  try {
    await backToDraft(versionId);
    return NextResponse.json({ demoted: true, status: 'DRAFT' });
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/config-versions/[id]/demote');
  }
}
