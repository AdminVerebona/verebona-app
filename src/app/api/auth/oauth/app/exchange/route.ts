/**
 * POST /api/auth/oauth/app/exchange — lot 93, CDC 18 §21.3 (OAuth sur
 * mobile). L'application ouvre le parcours dans le NAVIGATEUR SYSTÈME
 * (`/api/auth/oauth/<fournisseur>/start?client=app&app_challenge=<S256>`),
 * reçoit au retour (APP_OAUTH_RETURN_URL, Universal Link / App Link) un code
 * d'échange à usage unique (2 min), puis l'échange ici avec son vérificateur
 * PKCE : la session (cookies HttpOnly) est émise dans la vue de l'application.
 *
 * Corps : { handoff, verifier }. Refus identique pour tout code invalide,
 * expiré, déjà utilisé ou vérificateur faux.
 *
 * Lot 97B : même échange pour « Associer » / « Confirmer avec » Google ou
 * Apple depuis Mon compte › Sécurité de l'app — aucune nouvelle session :
 * l'association ou la preuve de 5 min s'applique à la session de la vue,
 * qui doit être celle qui a démarré le parcours.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { enabledProviders } from '@/lib/auth/oauth/config';
import { completeAppAccountExchange, notFound } from '@/lib/auth/oauth/flow';
import { consumeHandoff } from '@/lib/auth/oauth/transactions';
import { pkceChallenge, safeEqual } from '@/lib/auth/oauth/crypto';
import { checkSessionEligibility, landingPath, openSocialSession } from '@/lib/auth/oauth/session-bridge';
import { safeInternalPath } from '@/lib/safe-redirect';

const refused = () => NextResponse.json({ error: 'Lien de connexion invalide ou expiré.', code: 'OAUTH_STATE_INVALID' }, { status: 400 });

export async function POST(request: NextRequest) {
  const e = enabledProviders();
  if (!e.google && !e.apple) return notFound();
  const body = (await request.json().catch(() => ({}))) as { handoff?: unknown; verifier?: unknown };
  if (typeof body.handoff !== 'string' || typeof body.verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.verifier)) return refused();
  const tx = await consumeHandoff(body.handoff);
  if (!tx || !tx.userId || !tx.context.appChallenge || !safeEqual(pkceChallenge(body.verifier), tx.context.appChallenge)) return refused();
  // Lot 97B : association / confirmation démarrée dans Mon compte de l'app —
  // appliquée à la session de CETTE vue (celle qui a démarré le parcours).
  if (tx.intent === 'link' || tx.intent === 'reauth') return completeAppAccountExchange(request, tx);
  const eligibility = await checkSessionEligibility(tx.userId);
  if (!eligibility.ok) return NextResponse.json({ error: eligibility.code, code: eligibility.code }, { status: 403 });
  const res = NextResponse.json({ success: true, redirectTo: safeInternalPath(landingPath(eligibility.user, tx.context.returnUrl)) });
  await openSocialSession(request, res, eligibility.user, tx.provider, { client: 'app', authTransactionId: tx.id });
  return res;
}
