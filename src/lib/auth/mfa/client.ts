/**
 * Double authentification — aides NAVIGATEUR (lot 110B). Jamais importé par
 * le serveur. WebAuthn via @simplewebauthn/browser (version exacte dans
 * package.json) ; préférence LOCALE de la dernière méthode employée sur cet
 * appareil (ordre d'affichage seulement — n'accorde jamais aucun privilège,
 * ticket §3).
 */
import {
  browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startAuthentication, startRegistration,
} from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export type LocalMethod = 'passkey' | 'totp' | 'password' | 'google' | 'apple';
const KEY = 'vb_last_auth_method';

export function rememberLocalMethod(m: LocalMethod): void {
  try { window.localStorage.setItem(KEY, m); } catch { /* stockage indisponible : sans effet */ }
}

export function lastLocalMethod(): LocalMethod | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'passkey' || v === 'totp' || v === 'password' || v === 'google' || v === 'apple' ? v : null;
  } catch {
    return null;
  }
}

/** Les clés d'accès sont-elles utilisables dans cette vue (navigateur, WKWebView, WebView Android) ? */
export async function passkeysUsableHere(): Promise<boolean> {
  try {
    if (!browserSupportsWebAuthn()) return false;
    // Une clé synchronisée ou sur un autre appareil (QR) reste possible sans
    // authentificateur local : seul le support WebAuthn est exigé.
    return true;
  } catch {
    return false;
  }
}

export async function platformPasskeyAvailable(): Promise<boolean> {
  try { return await platformAuthenticatorIsAvailable(); } catch { return false; }
}

export type PasskeyCeremonyError = 'cancelled' | 'unsupported' | 'failed';

function classify(e: unknown): PasskeyCeremonyError {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
  if (name === 'NotSupportedError' || name === 'SecurityError') return 'unsupported';
  return 'failed';
}

export async function createPasskey(options: unknown): Promise<{ ok: true; response: unknown } | { ok: false; error: PasskeyCeremonyError }> {
  try {
    const response = await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON });
    return { ok: true, response };
  } catch (e) {
    return { ok: false, error: classify(e) };
  }
}

export async function getPasskeyAssertion(options: unknown): Promise<{ ok: true; response: unknown } | { ok: false; error: PasskeyCeremonyError }> {
  try {
    const response = await startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON });
    return { ok: true, response };
  } catch (e) {
    return { ok: false, error: classify(e) };
  }
}

export const PASSKEY_ERROR_TEXT: Record<PasskeyCeremonyError, string> = {
  cancelled: 'La clé d’accès n’a pas été utilisée. Réessayez ou choisissez une autre méthode.',
  unsupported: 'Les clés d’accès ne sont pas disponibles sur cet appareil. Choisissez une autre méthode.',
  failed: 'La clé d’accès n’a pas pu être utilisée. Réessayez ou choisissez une autre méthode.',
};

/** Requête JSON vers une route MFA (cookies inclus), sans renouvellement de session. */
export async function mfaPost<T = Record<string, unknown>>(url: string, body: unknown = {}): Promise<{ ok: boolean; status: number; data: T & { code?: string; message?: string } }> {
  const res = await fetch(url, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({})) as T & { code?: string; message?: string };
  return { ok: res.ok, status: res.status, data };
}
