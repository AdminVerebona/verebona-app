/**
 * ÉMISSION D'UNE SESSION — fonction UNIQUE (lot 92, CDC 18 §19, §20, §35-49
 * « service d'authentification commun produisant une session »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `issueSession(request, response, options)` est le SEUL chemin qui produit
 * des jetons de session (accès 15 min + renouvellement 30 j, même `sid`),
 * les dépose en cookies HttpOnly (`setSessionCookies`) ET inscrit la session
 * dans le registre (`user_sessions`). Toute ouverture de session l'appelle :
 *
 *   kind 'open'    — nouvelle session, nouveau `sid` : connexion par mot de
 *                    passe (`method: 'password'`), lien d'activation
 *                    (`'email_link'`), session rouverte après un changement
 *                    de mot de passe ou une clôture (`replaceCurrent`), et
 *                    DEMAIN Google / Apple (sous-lot 93 : `method: 'google'`
 *                    | `'apple'`, même appel, après vérification du
 *                    fournisseur et des règles de rattachement) ;
 *   kind 'rotate'  — renouvellement (`/api/auth/refresh`) : même `sid`,
 *                    APRÈS la consommation atomique de l'ancien jeton
 *                    (lot 37, inchangé). Une session ouverte avant le
 *                    registre y est inscrite à cette occasion (Q5) ;
 *   kind 'reissue' — même session réémise sur un autre espace (changement
 *                    d'espace, Duo rejoint / quitté, espace personnel créé) :
 *                    `sid` courant conservé.
 *
 * Règles :
 *   · une nouvelle connexion n'éjecte JAMAIS un autre appareil (CDC 12
 *     AUTH-14) ; seules les sessions du MÊME appareil (même empreinte
 *     first-party, ou la session présentée par cette requête) sont
 *     remplacées — `scope: 'replaced'`, l'appareil reste connecté ;
 *   · l'appareil est décrit par `readSessionClient` : libellés et type de
 *     client DÉCLARATIFS (`X-Verebona-Client`, `X-Verebona-App-Version`,
 *     User-Agent) pour l'affichage ; empreinte `device_key` issue du SEUL
 *     cookie signé `vb_device` prouvé par le serveur (lot 96B, P5 — l'en-tête
 *     `X-Verebona-Installation-Id` n'y entre plus) — jamais une base de
 *     droits ;
 *   · le registre ne bloque jamais l'émission (échec journalisé, inscription
 *     au renouvellement suivant) ;
 *   · lot 96B (Q6) : alerte « connexion depuis un nouvel appareil »
 *     (`new-device-alert.ts`) évaluée ICI pour toute ouverture — une seule
 *     fois par appareil, jamais en rotation ni réémission ;
 *   · journal SESSION_CREATED (méthode, type de client, appareil connu,
 *     issue de l'alerte).
 *
 * APPLICATION MOBILE (CDC 12, hors de ce sous-lot) : la coque Capacitor
 * utilise les mêmes cookies HttpOnly. Un futur échange de jeton mobile
 * (credential opaque stocké en Keychain / Keystore) se brancherait ICI, comme
 * une variante de dépôt (`setSessionCookies` → corps de réponse réservé à
 * l'application) — l'émission, le `sid` et le registre restant communs.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { NextRequest, NextResponse } from 'next/server';
import { generateSessionTokens, newSessionId, verifyAccessToken, verifyRefreshToken } from '@/lib/jwt';
import { hashToken } from '@/db';
import { logUserActivity } from '@/lib/audit-logger';
import { setSessionCookies, type SessionSubject } from './session-tokens';
import { REFRESH_TOKEN_TTL_S } from './token-lifetimes';
import { readSessionClient } from './session-client';
import {
  getSessionRecord, recordSession, replaceSessions,
  type SessionRegisteredVia, type SessionUpsertOutcome,
} from './session-registry';
import { processNewDeviceAlert } from './new-device-alert';

/** Méthode d'authentification qui ouvre la session (journal, registre). */
export type SessionAuthMethod = 'password' | 'email_link' | 'google' | 'apple' | (string & {});

export interface IssueSessionOptions {
  subject: SessionSubject;
  kind: 'open' | 'rotate' | 'reissue';
  /** `open` : méthode d'authentification. */
  method?: SessionAuthMethod;
  /** `rotate` (obligatoire) / `reissue` : famille conservée. */
  sid?: string | null;
  /** `open` : la session présentée par cette requête (même appareil) est remplacée. */
  replaceCurrent?: boolean;
  /** Identifiant `vb_device` qui vient d'être déposé sur cette réponse (connexion). */
  deviceId?: string | null;
}

export interface IssuedSession {
  sid: string;
  accessToken: string;
  refreshToken: string;
  registry: SessionUpsertOutcome | null;
}

/** `sid` de la session présentée par la requête (accès, sinon renouvellement), pour cet utilisateur. */
export async function currentSidFromRequest(request: Pick<NextRequest, 'headers' | 'cookies'>, userId: number): Promise<string | null> {
  const bearer = request.headers.get('authorization');
  const access = bearer?.startsWith('Bearer ') ? bearer.slice(7) : request.cookies.get('access_token')?.value;
  const a = access ? await verifyAccessToken(access).catch(() => null) : null;
  if (a?.userId === userId && typeof a.sid === 'string' && a.sid) return a.sid;
  const refresh = request.cookies.get('refresh_token')?.value;
  const r = refresh ? await verifyRefreshToken(refresh).catch(() => null) : null;
  if (r?.userId === userId && typeof r.sid === 'string' && r.sid) return r.sid;
  return null;
}

export async function issueSession(
  request: NextRequest,
  response: NextResponse,
  opts: IssueSessionOptions,
): Promise<IssuedSession> {
  const userId = opts.subject.id;
  const continued = opts.kind === 'open' ? null : (typeof opts.sid === 'string' && opts.sid ? opts.sid : null);
  if (opts.kind === 'rotate' && !continued) throw new Error('issueSession: rotation sans sid');
  const sid = continued ?? newSessionId();

  const { accessToken, refreshToken } = await generateSessionTokens(opts.subject, sid);
  setSessionCookies(response, { accessToken, refreshToken });

  const now = new Date();
  let client = readSessionClient(request, { deviceId: opts.deviceId });
  const previousSid = opts.kind === 'open' && opts.replaceCurrent ? await currentSidFromRequest(request, userId) : null;
  if (!client.deviceKey && previousSid) {
    // Routes hors `/api/auth` (le cookie d'appareil n'y est pas envoyé) : la
    // session remplacée porte l'appareil.
    const prev = await getSessionRecord(previousSid).catch(() => null);
    if (prev?.userId === userId && prev.deviceKey) client = { ...client, deviceKey: prev.deviceKey, deviceSource: prev.deviceSource };
  }

  const registeredVia: SessionRegisteredVia = opts.kind === 'open' ? 'LOGIN' : opts.kind === 'rotate' ? 'REFRESH' : 'REISSUE';
  const outcome = await recordSession({
    sid,
    userId,
    client,
    authMethod: opts.kind === 'open' ? (opts.method ?? null) : null,
    registeredVia,
    refreshTokenHash: await hashToken(refreshToken),
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_S * 1000),
    now,
  });

  if (opts.kind === 'open') {
    // Même appareil seulement (AUTH-14 : jamais un autre appareil).
    if (previousSid && previousSid !== sid) await replaceSessions({ userId, sid: previousSid, exceptSid: sid });
    if (client.deviceKey) await replaceSessions({ userId, deviceKey: client.deviceKey, exceptSid: sid });
    // Q6 : alerte « nouvel appareil » (preuve serveur seulement, une fois).
    const newDeviceAlert = await processNewDeviceAlert(request, {
      userId, sid, method: opts.method, client,
    });
    void logUserActivity({
      activityType: 'SESSION_CREATED',
      userId,
      userEmail: opts.subject.email,
      details: {
        sid,
        method: opts.method ?? null,
        clientType: client.clientType,
        appVersion: client.appVersion,
        // Appareil déjà connu pour ce compte (CDC §20.4) et issue de l'alerte (Q6).
        knownDevice: newDeviceAlert === 'not_a_login' || newDeviceAlert === 'error' ? null : newDeviceAlert === 'known_device',
        newDeviceAlert,
        registry: outcome ?? 'unavailable',
      },
      request,
    });
  }

  return { sid, accessToken, refreshToken, registry: outcome };
}
