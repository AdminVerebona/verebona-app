/**
 * POST /api/admin/ai/provider/[id]/test — CDC BO IA SCR-10, WF-21.
 *
 * Teste une clé par un vrai appel minimal, sans donnée utilisateur. Le résultat
 * est conservé sur la ligne : c'est lui qui conditionne l'activation, et c'est
 * lui qui permet à l'écran d'expliquer un refus au lieu de dire « test échoué ».
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSecret, recordTest } from '@/services/ai/provider/credential.repository';
import { testProviderKey } from '@/services/ai/provider/provider-test.service';
import { AI_OPERATIONS } from '@/services/ai/registry/operations';
import { requireAdminContext, parseVersionId, invalidId, toErrorResponse } from '../../../config-versions/_shared';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdminContext(req);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const credentialId = parseVersionId(id);
  if (credentialId === null) return invalidId(id);

  const compte = Number(process.env.CORPUS_ACCOUNT_ID);
  if (!Number.isInteger(compte) || compte <= 0) {
    // Le test consomme un appel : il doit être imputé à un compte technique,
    // jamais à un compte client.
    return NextResponse.json(
      { error: 'NO_TECHNICAL_ACCOUNT', message: 'CORPUS_ACCOUNT_ID est absente.' },
      { status: 503 },
    );
  }

  try {
    const secret = await getSecret(credentialId);
    if (!secret) return NextResponse.json({ error: 'CREDENTIAL_NOT_FOUND' }, { status: 404 });

    // Testé sur un modèle réellement employé, pas sur un modèle arbitraire :
    // une clé peut servir un modèle et pas un autre — c'est ce qui est arrivé
    // le 18 septembre.
    const body = await req.json().catch(() => ({}));
    const model = typeof body.model === 'string'
      ? body.model
      : AI_OPERATIONS.generate_answer?.primaryModel ?? 'gemini-3.1-flash-lite';

    const result = await testProviderKey(secret, model, compte, guard.ctx.adminUserId);
    await recordTest(credentialId, result.ok, result.detail);

    return NextResponse.json(result);
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/provider/[id]/test');
  }
}
