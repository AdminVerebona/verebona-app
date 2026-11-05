/**
 * Mon compte › Sécurité › Clés d'accès — renommer (PATCH) / supprimer
 * (DELETE, réauthentification fraîche, jamais la dernière méthode forte) —
 * lot 110B. Une clé d'un autre compte est « introuvable » (isolation, Duo).
 */
import type { NextRequest } from 'next/server';
import { mfaJson, mfaError, bodyOf, withSession } from '@/lib/auth/mfa/http';
import { requireSecurityStepUp } from '@/lib/auth/mfa/account-ops';
import { removePasskey, renamePasskey } from '@/lib/auth/mfa/factor-ops';
import { auditMfa, notifyMfaEvent } from '@/lib/auth/mfa/notify';
import { MFA_MESSAGES } from '@/lib/auth/mfa/constants';

type Ctx = { params: Promise<{ id: string }> };
const idOf = (raw: string) => (/^\d{1,12}$/.test(raw) ? Number(raw) : null);

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const id = idOf((await params).id);
  return withSession(request, async (session) => {
    if (id == null) return mfaError(404, 'NOT_FOUND', 'Clé d’accès introuvable.');
    const body = await bodyOf(request);
    if (!(await renamePasskey(session.userId, id, body.name))) return mfaError(404, 'NOT_FOUND', 'Clé d’accès introuvable.');
    return mfaJson({ success: true });
  });
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const id = idOf((await params).id);
  const check = await requireSecurityStepUp(request, 'mfa_passkey_remove');
  if (!check.ok) return check.response;
  const { session } = check;
  if (id == null) return mfaError(404, 'NOT_FOUND', 'Clé d’accès introuvable.');
  const r = await removePasskey(session.userId, id);
  if (r === 'not_found') return mfaError(404, 'NOT_FOUND', 'Clé d’accès introuvable.');
  if (r === 'last_method') return mfaError(409, 'MFA_LAST_METHOD', MFA_MESSAGES.lastMethod);
  auditMfa(request, 'MFA_FACTOR_REMOVED', session.userId, { factor: 'passkey' });
  void notifyMfaEvent(session.userId, 'passkey_removed');
  return mfaJson({ success: true });
}
