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

  // Le test consomme un appel : il doit être imputé au compte technique, jamais à un compte client. Lot 103G :
  // compte VÉRIFIÉ (marqueur en base, identité dédiée) — plus la seule variable CORPUS_ACCOUNT_ID, qui pouvait
  // désigner un compte client.
  const { checkCorpusAccount } = await import('@/services/ai/qualification/technical-account');
  const corpus = await checkCorpusAccount({ report: true, impact: { source: 'BO test de clé fournisseur' } });
  if (!corpus.ok || !corpus.accountId) {
    return NextResponse.json(
      { error: 'NO_TECHNICAL_ACCOUNT', code: corpus.code, message: `${corpus.label}. ${corpus.nextAction ?? ''}`.trim() },
      { status: 503 },
    );
  }
  const compte = corpus.accountId;

  try {
    const secret = await getSecret(credentialId);
    if (!secret) return NextResponse.json({ error: 'CREDENTIAL_NOT_FOUND' }, { status: 404 });

    // Testé sur un modèle réellement employé, pas sur un modèle arbitraire :
    // une clé peut servir un modèle et pas un autre — c'est ce qui est arrivé
    // le 18 septembre.
    const body = await req.json().catch(() => ({}));
    const model = typeof body.model === 'string'
      ? body.model
      : AI_OPERATIONS.t2_answer?.primaryModel ?? 'gemini-3.1-flash-lite';

    const result = await testProviderKey(secret, model, compte, guard.ctx.adminUserId);
    await recordTest(credentialId, result.ok, result.detail);

    return NextResponse.json(result);
  } catch (e) {
    return toErrorResponse(e, 'POST /api/admin/ai/provider/[id]/test');
  }
}
