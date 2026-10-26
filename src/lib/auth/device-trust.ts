/**
 * Appareil reconnu (« device cookie ») — lot 53A, retour PO D1 ; CDC 18
 * §4 (« Nouvel appareil » : identifiant first-party opaque, sans
 * fingerprinting), §20.4, §33.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * À QUOI IL SERT
 *
 * Le limiteur de connexion (`login-throttle.ts`) doit ralentir une attaque
 * sur un compte — y compris distribuée sur de nombreuses IP — SANS qu'un
 * tiers puisse bloquer le titulaire. Le titulaire se distingue de
 * l'attaquant par un fait que l'attaquant ne peut pas produire : ce
 * navigateur (ou cette application) s'est DÉJÀ connecté avec succès à CE
 * compte. Ce fait est porté par un cookie signé :
 *
 *   · émis après une connexion réussie, une activation d'adresse (lien reçu
 *     par e-mail) ou une réinitialisation de mot de passe (preuve de
 *     contrôle de la boîte) ;
 *   · lié au compte par une étiquette HMAC de l'adresse (ni l'adresse ni
 *     l'identifiant en clair) ; jusqu'à 5 comptes par appareil (foyer,
 *     Duo sur un même ordinateur) ;
 *   · signé (HMAC-SHA256, clé dérivée de JWT_SECRET) : un attaquant ne peut
 *     ni le fabriquer pour un autre compte ni le modifier ;
 *   · HttpOnly, Secure en production, SameSite=Lax, Path=/api/auth (envoyé
 *     aux seules routes d'authentification), 180 jours, renouvelé à chaque
 *     connexion réussie.
 *
 * Il NE DONNE AUCUN ACCÈS : le mot de passe reste exigé. Il ne sert qu'à
 * choisir la règle de limitation (voir `login-throttle.ts`).
 *
 * Il ne révèle pas l'existence d'un compte : il n'est déposé qu'à celui qui
 * vient de prouver le mot de passe ou le contrôle de la boîte e-mail.
 *
 * Un navigateur qui efface ses cookies redevient « non reconnu » : c'est
 * accepté par le CDC 18 §20.4. L'identifiant d'appareil pourra servir au
 * registre des sessions et à l'e-mail « nouvel appareil » (SESS-05/SESS-11)
 * quand ils seront réalisés.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEVICE_TRUST_COOKIE = 'vb_device';
export const DEVICE_TRUST_COOKIE_PATH = '/api/auth';
const DEVICE_TRUST_TTL_S = 180 * 24 * 60 * 60;
export const DEVICE_TRUST_MAX_ACCOUNTS = 5;

const VERSION = 'd1';

function key(): string {
  return `verebona/device-trust/v1/${process.env.JWT_SECRET || 'dev'}`;
}

function hmac(data: string, len: number): string {
  return createHmac('sha256', key()).update(data).digest('base64url').slice(0, len);
}

/** Étiquette du compte (adresse normalisée) — jamais l'adresse en clair. */
function accountTag(normalizedEmail: string): string {
  return hmac(`acct:${normalizedEmail}`, 16);
}

function entrySignature(deviceId: string, tag: string, expS: number): string {
  return hmac(`entry:${deviceId}:${tag}:${expS}`, 22);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface TrustEntry { tag: string; expS: number; sig: string }
interface ParsedDeviceCookie { deviceId: string; entries: TrustEntry[] }

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const TAG_RE = /^[A-Za-z0-9_-]{16}$/;
const SIG_RE = /^[A-Za-z0-9_-]{22}$/;

/** Lecture tolérante : toute valeur mal formée vaut « aucun cookie ». */
export function parseDeviceCookie(raw: string | null | undefined): ParsedDeviceCookie | null {
  if (!raw || raw.length > 1024) return null;
  const [version, deviceId, list] = raw.split('.');
  if (version !== VERSION || !deviceId || !DEVICE_ID_RE.test(deviceId)) return null;
  const entries: TrustEntry[] = [];
  for (const part of (list ?? '').split('~').filter(Boolean)) {
    const [tag, exp, sig] = part.split(':');
    const expS = Number(exp);
    if (!TAG_RE.test(tag ?? '') || !SIG_RE.test(sig ?? '') || !Number.isInteger(expS)) continue;
    entries.push({ tag, expS, sig });
  }
  return { deviceId, entries };
}

/**
 * Identifiant d'appareil si CE navigateur est reconnu pour CE compte
 * (entrée présente, signée, non expirée) ; `null` sinon.
 */
export function trustedDeviceFor(raw: string | null | undefined, normalizedEmail: string, nowMs = Date.now()): string | null {
  const parsed = parseDeviceCookie(raw);
  if (!parsed || !normalizedEmail) return null;
  const tag = accountTag(normalizedEmail);
  const nowS = Math.floor(nowMs / 1000);
  for (const e of parsed.entries) {
    if (e.tag !== tag || e.expS <= nowS) continue;
    if (safeEqual(e.sig, entrySignature(parsed.deviceId, e.tag, e.expS))) return parsed.deviceId;
  }
  return null;
}

/**
 * Nouvelle valeur du cookie après une preuve réussie pour `normalizedEmail` :
 * identifiant d'appareil conservé (ou créé), entrée du compte renouvelée,
 * entrées expirées ou invalides retirées, 5 comptes au plus (les plus
 * récents).
 */
export function buildDeviceCookieValue(raw: string | null | undefined, normalizedEmail: string, nowMs = Date.now()): { value: string; deviceId: string } {
  const parsed = parseDeviceCookie(raw);
  const deviceId = parsed?.deviceId ?? randomBytes(16).toString('base64url');
  const nowS = Math.floor(nowMs / 1000);
  const tag = accountTag(normalizedEmail);
  const kept = (parsed?.entries ?? []).filter((e) =>
    e.tag !== tag && e.expS > nowS && safeEqual(e.sig, entrySignature(deviceId, e.tag, e.expS)));
  const expS = nowS + DEVICE_TRUST_TTL_S;
  const fresh: TrustEntry = { tag, expS, sig: entrySignature(deviceId, tag, expS) };
  const entries = [fresh, ...kept.sort((a, b) => b.expS - a.expS)].slice(0, DEVICE_TRUST_MAX_ACCOUNTS);
  return { value: `${VERSION}.${deviceId}.${entries.map((e) => `${e.tag}:${e.expS}:${e.sig}`).join('~')}`, deviceId };
}

/** Accès minimal aux cookies d'une requête / réponse Next (testable sans Next). */
interface CookieReader { cookies: { get(name: string): { value: string } | undefined } }
interface CookieWriter { cookies: { set(name: string, value: string, opts: Record<string, unknown>): unknown } }

export function readDeviceCookie(request: CookieReader): string | null {
  return request.cookies.get(DEVICE_TRUST_COOKIE)?.value ?? null;
}

/** Reconnaît ce navigateur pour ce compte (après preuve) ; renvoie l'identifiant d'appareil. */
export function rememberTrustedDevice(request: CookieReader, response: CookieWriter, normalizedEmail: string): string | null {
  if (!normalizedEmail) return null;
  const { value, deviceId } = buildDeviceCookieValue(readDeviceCookie(request), normalizedEmail);
  response.cookies.set(DEVICE_TRUST_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: DEVICE_TRUST_TTL_S,
    path: DEVICE_TRUST_COOKIE_PATH,
  });
  return deviceId;
}
