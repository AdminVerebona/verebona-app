/**
 * Envoi des notifications push natives — lot 97 (CDC 12 §18 PUSH-01,
 * PUSH-05, PUSH-07 ; §27 « Push APNs/FCM » par environnement).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE ABSTRACTION, UN FOURNISSEUR : FCM HTTP v1 (APNs PASSE PAR FCM)
 *
 * Firebase Cloud Messaging distribue vers Android ET vers iOS (clé APNs
 * déposée dans le projet Firebase) : une seule intégration serveur. Le
 * fournisseur est derrière `MobilePushProvider` ; un envoi APNs direct
 * pourrait s'y ajouter sans toucher au dispatcher.
 *
 * INACTIF SANS CONFIGURATION — variables Scalingo (une paire par
 * environnement : projet Firebase préprod ≠ prod) :
 *   FIREBASE_PROJECT_ID             identifiant du projet (facultatif si
 *                                   présent dans le compte de service) ;
 *   FIREBASE_SERVICE_ACCOUNT_JSON   compte de service (JSON brut ou encodé
 *                                   en base64), rôle « Firebase Cloud
 *                                   Messaging API Admin ». Jamais journalisé.
 * Absentes : aucun envoi, livraison `skipped_unavailable`
 * (`mobile_push_not_configured`), rien d'autre ne change.
 *
 * Erreurs : jeton invalide (UNREGISTERED, SENDER_ID_MISMATCH, jeton
 * mal formé) → `invalid_token` (l'installation est nettoyée, les autres
 * appareils ne sont pas touchés) ; quota / indisponibilité → `transient` ;
 * authentification du compte de service / APNs → `config`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createSign } from 'node:crypto';

export interface MobilePushMessage {
  token: string;
  platform: 'ios' | 'android';
  title: string;
  body: string;
  /** Données (chaînes uniquement) : lien profond HTTPS, catégorie, identifiants techniques. */
  data: Record<string, string>;
  /** Clé de regroupement : un même événement rejoué remplace la notification affichée. */
  collapseKey: string;
  priority: 'normal' | 'high';
}

export type MobilePushSendResult =
  | { ok: true; messageId: string | null }
  | { ok: false; kind: 'invalid_token' | 'transient' | 'config' | 'rejected'; code: string; statusCode?: number };

export interface MobilePushProvider {
  readonly name: string;
  send(message: MobilePushMessage): Promise<MobilePushSendResult>;
}

type Env = Record<string, string | undefined>;

interface ServiceAccount { project_id?: string; client_email: string; private_key: string; token_uri?: string }

function readServiceAccount(env: Env): ServiceAccount | null {
  const brut = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!brut) return null;
  const texte = brut.startsWith('{') ? brut : Buffer.from(brut, 'base64').toString('utf8');
  try {
    const sa = JSON.parse(texte) as ServiceAccount;
    if (typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string') return null;
    return sa;
  } catch {
    return null;
  }
}

/** État de configuration (BO, sans aucune valeur). */
export function fcmConfigStatus(env: Env = process.env): { configured: boolean; projectId: string | null; issue: string | null } {
  const raw = env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return { configured: false, projectId: null, issue: null };
  const sa = readServiceAccount(env);
  if (!sa) return { configured: false, projectId: null, issue: 'FIREBASE_SERVICE_ACCOUNT_JSON illisible (JSON ou base64 attendu, avec client_email et private_key)' };
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || sa.project_id || null;
  if (!projectId) return { configured: false, projectId: null, issue: 'FIREBASE_PROJECT_ID absent (et absent du compte de service)' };
  return { configured: true, projectId, issue: null };
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const HTTP_TIMEOUT_MS = 10_000;

/** Fournisseur FCM HTTP v1. */
class FcmProvider implements MobilePushProvider {
  readonly name = 'fcm';
  private access: { token: string; expiresAt: number } | null = null;

  constructor(private readonly sa: ServiceAccount, private readonly projectId: string) {}

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - 60_000 > Date.now()) return this.access.token;
    const iat = Math.floor(Date.now() / 1000);
    const aud = this.sa.token_uri || DEFAULT_TOKEN_URI;
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: this.sa.client_email, scope: FCM_SCOPE, aud, iat, exp: iat + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.sa.private_key).toString('base64url');
    const res = await fetch(aud, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw Object.assign(new Error(`oauth_${res.status}`), { config: true });
    const json = await res.json() as { access_token: string; expires_in?: number };
    this.access = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }

  async send(m: MobilePushMessage): Promise<MobilePushSendResult> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (e) {
      return { ok: false, kind: (e as { config?: boolean }).config ? 'config' : 'transient', code: (e as Error).message.slice(0, 60) || 'oauth_error' };
    }
    const collapse = m.collapseKey.slice(0, 64);
    const body = {
      message: {
        token: m.token,
        notification: { title: m.title, body: m.body },
        data: m.data,
        android: { priority: m.priority === 'high' ? 'HIGH' : 'NORMAL', collapse_key: collapse, notification: { tag: collapse } },
        apns: {
          headers: { 'apns-collapse-id': collapse, 'apns-priority': m.priority === 'high' ? '10' : '5' },
          payload: { aps: { 'thread-id': m.data.category ?? 'verebona', sound: 'default' } },
        },
      },
    };
    let res: Response;
    try {
      res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.projectId)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, kind: 'transient', code: (e as Error).name === 'TimeoutError' ? 'timeout' : 'network_error' };
    }
    if (res.ok) {
      const json = await res.json().catch(() => ({})) as { name?: string };
      return { ok: true, messageId: json.name ?? null };
    }
    if (res.status === 401) this.access = null;
    const err = await res.json().catch(() => ({})) as { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } };
    return classifyFcmError(res.status, err.error);
  }
}

/** Classement d'une erreur FCM v1 (pur, testé). */
export function classifyFcmError(
  statusCode: number,
  error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> },
): Extract<MobilePushSendResult, { ok: false }> {
  const fcmCode = error?.details?.find((d) => d?.errorCode)?.errorCode ?? error?.status ?? `http_${statusCode}`;
  const code = String(fcmCode).slice(0, 60);
  if (fcmCode === 'UNREGISTERED' || fcmCode === 'SENDER_ID_MISMATCH' || statusCode === 404) {
    return { ok: false, kind: 'invalid_token', code, statusCode };
  }
  if (fcmCode === 'INVALID_ARGUMENT' && /registration token/i.test(error?.message ?? '')) {
    return { ok: false, kind: 'invalid_token', code, statusCode };
  }
  if (fcmCode === 'THIRD_PARTY_AUTH_ERROR' || statusCode === 401 || statusCode === 403) {
    return { ok: false, kind: 'config', code, statusCode };
  }
  if (statusCode === 429 || statusCode >= 500 || fcmCode === 'QUOTA_EXCEEDED' || fcmCode === 'UNAVAILABLE' || fcmCode === 'INTERNAL') {
    return { ok: false, kind: 'transient', code, statusCode };
  }
  return { ok: false, kind: 'rejected', code, statusCode };
}

let override: MobilePushProvider | null | undefined;
let cached: { key: string; provider: FcmProvider } | null = null;

/** Fournisseur actif, ou null si aucun n'est configuré. */
export function getMobilePushProvider(env: Env = process.env): MobilePushProvider | null {
  if (override !== undefined) return override;
  const st = fcmConfigStatus(env);
  if (!st.configured || !st.projectId) return null;
  const sa = readServiceAccount(env)!;
  const key = `${st.projectId}:${sa.client_email}`;
  if (!cached || cached.key !== key) cached = { key, provider: new FcmProvider(sa, st.projectId) };
  return cached.provider;
}

/** Tests uniquement : remplace le fournisseur (`undefined` rétablit le comportement réel). */
export function setMobilePushProviderForTests(p: MobilePushProvider | null | undefined): void {
  override = p;
}
