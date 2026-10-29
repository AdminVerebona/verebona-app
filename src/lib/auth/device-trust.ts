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
 *   · lié au compte par une étiquette HMAC de l'identifiant utilisateur
 *     (intégration 96 ; avant : de l'adresse) — ni l'adresse ni
 *     l'identifiant en clair ; jusqu'à 5 comptes par appareil (foyer,
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
 * accepté par le CDC 18 §20.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 96B (décision PO P5, Q6, Q10) — PREUVE SERVEUR UNIQUEMENT
 *
 * L'identifiant d'appareil (`deviceId`) n'est jamais cru sur déclaration :
 *   · il n'est REPRIS d'un cookie présenté que si ce cookie porte au moins
 *     une entrée signée par le serveur et non expirée (`authenticDeviceId`) ;
 *     un cookie fabriqué (`d1.<identifiant choisi>.` sans entrée valable)
 *     reçoit un identifiant NEUF — avant ce lot, le serveur signait une
 *     entrée sur un identifiant choisi par le client ;
 *   · la règle A de D1 (`trustedDeviceFor`) exige une entrée signée POUR CE
 *     COMPTE ; aucun en-tête (`X-Verebona-Client`,
 *     `X-Verebona-Installation-Id`…) n'y intervient ;
 *   · le registre des sessions (`session-client.ts`, `device_key`) et
 *     l'alerte « nouvel appareil » (`new-device-alert.ts`) n'utilisent que
 *     cet identifiant authentifié. L'application mobile (WebView Capacitor)
 *     reçoit le même cookie HttpOnly ; l'identifiant d'installation natif ne
 *     sert qu'au libellé et au rattachement push (`mobile_push_installations`).
 * Correspondance complète : docs/exploitation/securite-sessions.md
 * (« Reconnaissance d'appareil »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * INTÉGRATION 96A + 96B — ENTRÉE LIÉE À L'IDENTIFIANT STABLE DU COMPTE
 *
 * Avant : l'entrée d'un compte était l'étiquette HMAC de son ADRESSE. Avec le
 * changement d'adresse (96A, Q8) cela posait deux problèmes : après le
 * changement, tous les appareils du titulaire redevenaient « inconnus »
 * (pénalité D1, fausse alerte Q6) ; et un appareil reconnu pour une adresse
 * qu'un AUTRE compte a portée avant (ancien titulaire qui a changé
 * d'adresse ou supprimé son compte) aurait été « reconnu » pour le nouveau
 * titulaire (usurpation).
 *
 * Désormais l'entrée est l'étiquette HMAC de l'IDENTIFIANT UTILISATEUR
 * (`uid:<id>`, jamais en clair), insensible à l'adresse. Transition sans
 * déconnexion ni fausse alerte au déploiement : une entrée HÉRITÉE (étiquette
 * d'adresse, émise avant ce lot) reste acceptée tant qu'elle n'a pas expiré,
 * SEULEMENT si elle porte l'adresse D'ORIGINE du compte (`legacyEmail` :
 * adresse avant tout changement 96A) et a été émise APRÈS la création du
 * compte (`legacyNotBeforeMs`) — donc pendant que ce compte détenait cette
 * adresse. Une entrée héritée est remplacée par l'entrée `uid` à la
 * connexion suivante ; aucune n'est plus jamais émise.
 * Résolution du compte : `device-account.ts`.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const DEVICE_TRUST_COOKIE = 'vb_device';
export const DEVICE_TRUST_COOKIE_PATH = '/api/auth';
export const DEVICE_TRUST_TTL_S = 180 * 24 * 60 * 60;
export const DEVICE_TRUST_MAX_ACCOUNTS = 5;

const VERSION = 'd1';

interface TrustEntry { tag: string; expS: number; sig: string }

function key(): string {
  return `verebona/device-trust/v1/${process.env.JWT_SECRET || 'dev'}`;
}

function hmac(data: string, len: number): string {
  return createHmac('sha256', key()).update(data).digest('base64url').slice(0, len);
}

/** Étiquette HÉRITÉE (avant l'intégration 96) : adresse normalisée — lecture seule, transition. */
function legacyEmailTag(normalizedEmail: string): string {
  return hmac(`acct:${normalizedEmail}`, 16);
}

/** Étiquette du compte : identifiant utilisateur stable — jamais en clair. */
function userTag(userId: number): string {
  return hmac(`uid:${userId}`, 16);
}

/**
 * Compte pour lequel on reconnaît un appareil. `legacyEmail` /
 * `legacyNotBeforeMs` : uniquement pour accepter les entrées héritées (voir
 * l'en-tête) ; sans eux, seules les entrées `uid` comptent.
 */
export interface DeviceTrustAccount {
  userId: number;
  /** Adresse D'ORIGINE du compte (avant tout changement), normalisée. */
  legacyEmail?: string | null;
  /** Création du compte (ms) : une entrée héritée plus ancienne n'est pas de ce compte. */
  legacyNotBeforeMs?: number | null;
}

function validAccount(a: DeviceTrustAccount | null | undefined): a is DeviceTrustAccount {
  return !!a && Number.isInteger(a.userId) && a.userId > 0;
}

/** L'entrée appartient-elle à ce compte (étiquette `uid`, ou héritée sous conditions) ? */
function entryIsFor(e: TrustEntry, account: DeviceTrustAccount): boolean {
  if (e.tag === userTag(account.userId)) return true;
  if (!account.legacyEmail || account.legacyNotBeforeMs == null || !Number.isFinite(account.legacyNotBeforeMs)) return false;
  if (e.tag !== legacyEmailTag(account.legacyEmail)) return false;
  const issuedS = e.expS - DEVICE_TRUST_TTL_S;
  return issuedS >= Math.floor(account.legacyNotBeforeMs / 1000);
}

function entrySignature(deviceId: string, tag: string, expS: number): string {
  return hmac(`entry:${deviceId}:${tag}:${expS}`, 22);
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

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
export function trustedDeviceFor(raw: string | null | undefined, account: DeviceTrustAccount | null | undefined, nowMs = Date.now()): string | null {
  const parsed = parseDeviceCookie(raw);
  if (!parsed || !validAccount(account)) return null;
  const nowS = Math.floor(nowMs / 1000);
  for (const e of parsed.entries) {
    if (e.expS <= nowS || !entryIsFor(e, account)) continue;
    if (safeEqual(e.sig, entrySignature(parsed.deviceId, e.tag, e.expS))) return parsed.deviceId;
  }
  return null;
}

/**
 * Identifiant d'appareil PROUVÉ par le serveur : le cookie porte au moins une
 * entrée signée (pour n'importe quel compte de cet appareil) et non expirée.
 * Un identifiant seul, sans entrée valable, est une simple déclaration du
 * client : `null`.
 */
export function authenticDeviceId(raw: string | null | undefined, nowMs = Date.now()): string | null {
  const parsed = parseDeviceCookie(raw);
  if (!parsed) return null;
  const nowS = Math.floor(nowMs / 1000);
  return parsed.entries.some((e) => e.expS > nowS && safeEqual(e.sig, entrySignature(parsed.deviceId, e.tag, e.expS)))
    ? parsed.deviceId
    : null;
}

/**
 * Nouvelle valeur du cookie après une preuve réussie pour `account` :
 * identifiant d'appareil conservé s'il est PROUVÉ (`authenticDeviceId`),
 * sinon créé ; entrée `uid` du compte renouvelée (son entrée héritée
 * éventuelle retirée), entrées expirées ou invalides retirées, 5 comptes au
 * plus (les plus récents).
 */
export function buildDeviceCookieValue(raw: string | null | undefined, account: DeviceTrustAccount, nowMs = Date.now()): { value: string; deviceId: string } {
  if (!validAccount(account)) throw new Error('device-trust: compte invalide');
  const parsed = parseDeviceCookie(raw);
  const deviceId = authenticDeviceId(raw, nowMs) ?? randomBytes(16).toString('base64url');
  const nowS = Math.floor(nowMs / 1000);
  const tag = userTag(account.userId);
  const legacy = account.legacyEmail ? legacyEmailTag(account.legacyEmail) : null;
  const kept = (parsed?.entries ?? []).filter((e) =>
    e.tag !== tag && e.tag !== legacy && e.expS > nowS && safeEqual(e.sig, entrySignature(deviceId, e.tag, e.expS)));
  const expS = nowS + DEVICE_TRUST_TTL_S;
  const fresh: TrustEntry = { tag, expS, sig: entrySignature(deviceId, tag, expS) };
  const entries = [fresh, ...kept.sort((a, b) => b.expS - a.expS)].slice(0, DEVICE_TRUST_MAX_ACCOUNTS);
  return { value: `${VERSION}.${deviceId}.${entries.map((e) => `${e.tag}:${e.expS}:${e.sig}`).join('~')}`, deviceId };
}

/**
 * TESTS / TRANSITION SEULEMENT : valeur de cookie au format HÉRITÉ (entrée
 * liée à l'adresse), telle qu'émise avant l'intégration 96. Jamais appelée
 * par le code de production.
 */
export function __legacyDeviceCookieValueForTests(normalizedEmail: string, nowMs = Date.now(), deviceId = randomBytes(16).toString('base64url')): { value: string; deviceId: string } {
  const tag = legacyEmailTag(normalizedEmail);
  const expS = Math.floor(nowMs / 1000) + DEVICE_TRUST_TTL_S;
  return { value: `${VERSION}.${deviceId}.${tag}:${expS}:${entrySignature(deviceId, tag, expS)}`, deviceId };
}

/** Accès minimal aux cookies d'une requête / réponse Next (testable sans Next). */
interface CookieReader { cookies: { get(name: string): { value: string } | undefined } }
interface CookieWriter { cookies: { set(name: string, value: string, opts: Record<string, unknown>): unknown } }

export function readDeviceCookie(request: CookieReader): string | null {
  return request.cookies.get(DEVICE_TRUST_COOKIE)?.value ?? null;
}

/** Reconnaît ce navigateur pour ce compte (après preuve) ; renvoie l'identifiant d'appareil. */
export function rememberTrustedDevice(request: CookieReader, response: CookieWriter, account: DeviceTrustAccount): string | null {
  if (!validAccount(account)) return null;
  const { value, deviceId } = buildDeviceCookieValue(readDeviceCookie(request), account);
  response.cookies.set(DEVICE_TRUST_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: DEVICE_TRUST_TTL_S,
    path: DEVICE_TRUST_COOKIE_PATH,
  });
  return deviceId;
}
