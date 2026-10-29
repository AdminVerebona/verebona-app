/**
 * Mon compte › Sécurité, bloc 1 « Méthodes de connexion » — lot 93, CDC 18
 * §10.2, §12.3, §18, §25, §27.1, §29.
 *
 * Toutes les actions sensibles exigent la preuve de réauthentification
 * fraîche du lot 92 (< 5 min, même session — `requireFreshReauth`) ou, à
 * défaut, le mot de passe actuel saisi dans la même demande (clients non mis
 * à jour) : il est vérifié par la méthode « mot de passe » du lot 92 (même
 * limiteur partagé) et émet alors la preuve 92 pour les 5 minutes suivantes.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { runDetached } from '@/lib/auth/anti-enumeration';
import { SessionService } from '@/lib/session-service';
import {
  getReauthMethod, issueReauthProof, listReauthMethodsFor, logReauthFailure, requireFreshReauth, ReauthError,
} from '@/lib/auth/reauth';
import { getProviderConfig, OAUTH_PROVIDERS, type OAuthProvider } from './config';
import { decryptProviderToken } from './crypto';
import { appleRefreshTokensOf, canUnlink, clearAppleRefreshTokens, listIdentities, loadLoginMethods } from './identities';
import { revokeAppleRefreshToken } from './providers';
import { readReauthState } from './reauth-bridge';

export type ReauthCheck =
  | { ok: true; userId: number; sid: string; email: string; proofId: string | null }
  | { ok: false; response: NextResponse };

/**
 * Preuve 92 fraîche de cette session, ou mot de passe actuel valide dans le
 * corps (`currentPassword`). `action` : libellé de consommation / journal.
 */
export async function requireReauth(request: NextRequest, body: Record<string, unknown>, action: string): Promise<ReauthCheck> {
  if (typeof body.currentPassword === 'string' && body.currentPassword) {
    let session;
    try {
      session = await SessionService.getSession(request);
    } catch (error) {
      return { ok: false, response: SessionService.handleSessionError(error) };
    }
    const method = getReauthMethod('password');
    if (!session.sid || !method?.verify) {
      return { ok: false, response: NextResponse.json({ error: 'SESSION_REVOKED', code: 'SESSION_REVOKED', message: 'Votre session doit être renouvelée : reconnectez-vous.' }, { status: 401 }) };
    }
    if (!(await method.isAvailableFor(session.userId))) {
      const message = 'Votre compte n’a pas de mot de passe : confirmez avec Google ou Apple.';
      return { ok: false, response: NextResponse.json({ error: message, code: 'NO_PASSWORD', message }, { status: 409 }) };
    }
    const r = await method.verify({ request, userId: session.userId, input: { password: body.currentPassword } });
    if (r.status === 'blocked') {
      logReauthFailure(request, session.userId, 'password', 'RATE_LIMITED');
      return { ok: false, response: r.response };
    }
    if (r.status === 'failed') {
      logReauthFailure(request, session.userId, 'password', r.code);
      return { ok: false, response: NextResponse.json({ error: r.message, code: r.code, message: r.message }, { status: r.httpStatus }) };
    }
    try {
      await issueReauthProof(session.userId, session.sid, 'password', { request });
    } catch (e) {
      if (!(e instanceof ReauthError)) throw e;
      return { ok: false, response: NextResponse.json({ error: 'SESSION_REVOKED', code: 'SESSION_REVOKED', message: 'Votre session a été fermée : reconnectez-vous.' }, { status: 401 }) };
    }
    return { ok: true, userId: session.userId, sid: session.sid, email: session.email, proofId: null };
  }
  const r = await requireFreshReauth(request, { action });
  if (!r.ok) return r;
  return { ok: true, userId: r.session.userId, sid: r.session.sid, email: r.session.email, proofId: r.proof.id };
}

/** Vue consolidée (GET /api/users/me/auth-identities, §29 « vue consolidée méthodes login »). */
export async function securitySummary(userId: number, sid: string | null | undefined) {
  const methods = await loadLoginMethods(userId);
  const identities = await listIdentities(userId);
  const proof = await readReauthState(userId, sid);
  const providers = Object.fromEntries(OAUTH_PROVIDERS.map((p) => {
    const id = identities.find((i) => i.provider === p);
    return [p, {
      available: !!getProviderConfig(p),
      linked: !!id,
      linkedAt: id?.linkedAt.toISOString() ?? null,
      lastUsedAt: id?.lastUsedAt?.toISOString() ?? null,
      // Adresse vue chez le fournisseur : informative, celle de l'utilisateur lui-même.
      providerEmail: id?.lastProviderEmail ?? id?.emailAtLinkTime ?? null,
      isPrivateRelay: id?.isPrivateRelay ?? false,
      canUnlink: !!methods && !!id && canUnlink(methods, p),
    }];
  })) as Record<OAuthProvider, {
    available: boolean; linked: boolean; linkedAt: string | null; lastUsedAt: string | null;
    providerEmail: string | null; isPrivateRelay: boolean; canUnlink: boolean;
  }>;
  // Méthodes de confirmation : registre UNIQUE du lot 92 (mot de passe, Google, Apple).
  const reauthMethods = (await listReauthMethodsFor(userId)).map((m) => m.id);
  return {
    email: methods?.email ?? null,
    password: { configured: !!methods?.password },
    providers,
    reauth: { ...proof, methods: reauthMethods },
  };
}

/**
 * Révocation Apple (CDC 18 §25 ; exigence Apple pour la suppression de compte
 * et recommandée à la dissociation). Après la réponse, au mieux : un échec
 * est journalisé, l'action de l'utilisateur reste acquise. Le jeton conservé
 * est effacé dans tous les cas.
 */
export function revokeAppleTokensLater(userId: number, ciphertexts: string[], label: string): void {
  const cfg = getProviderConfig('apple');
  if (ciphertexts.length === 0) return;
  runDetached(`révocation Apple (${label})`, async () => {
    if (!cfg || cfg.provider !== 'apple') {
      console.warn(`[oauth] révocation Apple impossible (${label}) : Apple n’est pas configuré.`);
      return;
    }
    for (const c of ciphertexts) {
      const token = decryptProviderToken(c);
      if (!token) { console.warn(`[oauth] révocation Apple (${label}) : jeton illisible (clé changée).`); continue; }
      const ok = await revokeAppleRefreshToken(cfg, token);
      if (!ok) console.warn(`[oauth] révocation Apple (${label}) refusée ou injoignable (utilisateur ${userId}).`);
    }
  });
}

/** Clôture du compte (suppression demandée) : révoque l'autorisation Apple de l'utilisateur. */
export async function revokeAppleAuthorizationsForUser(userId: number): Promise<void> {
  const tokens = await appleRefreshTokensOf(userId);
  if (tokens.length === 0) return;
  await clearAppleRefreshTokens(userId);
  revokeAppleTokensLater(userId, tokens, 'suppression du compte');
}
