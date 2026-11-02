/**
 * Propagation des suppressions de production vers les copies en préproduction
 * — protocole et cryptographie (lot 104A, P1-F). Module PUR : aucune base,
 * aucun réseau.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * PRINCIPE (aucune donnée personnelle, aucun secret dans les échanges)
 *
 *   · Une clé partagée `PRODUCTION_DELETION_SIGNAL_KEY` (≥ 32 caractères) est
 *     posée À L'IDENTIQUE en production et en préproduction. Elle ne voyage
 *     JAMAIS : elle sert à dériver deux sous-clés (HMAC-SHA256) —
 *       - « subject » : empreintes NON RÉVERSIBLES des identifiants
 *         (`uid:<id>`, `acc:<id>`, `email:<adresse normalisée>`) ;
 *       - « auth » : signature des requêtes et des réponses.
 *   · La production publie, depuis le registre minimal des suppressions
 *     (`account_deletion_registry`, lot 102A), pour chaque suppression
 *     exécutée : une référence opaque, la date, la portée, et les SEULES
 *     empreintes. Ni adresse, ni nom, ni identifiant en clair.
 *   · La préproduction, à l'import d'une copie, a calculé les mêmes
 *     empreintes pour chaque compte et utilisateur copiés (correspondance
 *     source → cible enregistrée, jamais présumée ensuite) ; elle retrouve
 *     ainsi les comptes copiés et les purge par le moteur existant.
 *   · Requête signée (horodatage ± 5 min, méthode, chemin, requête) ; réponse
 *     signée (horodatage + corps) : une réponse altérée ou rejouée est rejetée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHmac, timingSafeEqual } from 'crypto';

type Env = Record<string, string | undefined>;

export const DELETION_SIGNAL_SCHEMA = 'verebona-deletion-signals-v1';
/** Chemin servi par la production (route serveur à serveur). */
export const DELETION_SIGNAL_PATH = '/api/internal/production-deletion-signals';
export const DELETION_SIGNAL_HEADERS = Object.freeze({
  timestamp: 'x-verebona-signal-timestamp',
  signature: 'x-verebona-signal-signature',
});

/** Réglages centralisés (aucune durée en dur ailleurs). */
export const DELETION_SIGNAL_DEFAULTS = Object.freeze({
  /** Longueur minimale de la clé partagée. */
  minKeyLength: 32,
  /** Écart d'horloge toléré entre les deux environnements. */
  maxSkewMs: 5 * 60_000,
  /** Entrées par page servie. */
  pageSize: 500,
  /** Nombre maximal d'entrées lues en une synchronisation (garde-fou). */
  maxEntries: 50_000,
  /** Délai maximal d'une requête. */
  timeoutMs: 15_000,
  /** Âge maximal du dernier échange réussi pour considérer la propagation « vérifiée » (heures). */
  readinessMaxAgeHours: 3,
  /** Échecs consécutifs avant alerte Supervision (1 si une copie est présente). */
  alertAfterFailures: 3,
});

/* ── Configuration ───────────────────────────────────────────────────────── */

export type SignalKeyStatus = 'missing' | 'too_short' | 'ok';

export function signalKeyStatus(env: Env = process.env): SignalKeyStatus {
  const k = (env.PRODUCTION_DELETION_SIGNAL_KEY ?? '').trim();
  if (!k) return 'missing';
  return k.length >= DELETION_SIGNAL_DEFAULTS.minKeyLength ? 'ok' : 'too_short';
}

/** Clé partagée, ou null si absente / trop courte. Jamais journalisée. */
export function signalKey(env: Env = process.env): string | null {
  return signalKeyStatus(env) === 'ok' ? (env.PRODUCTION_DELETION_SIGNAL_KEY ?? '').trim() : null;
}

/**
 * Adresse de la source (production) lue par la préproduction :
 * `PRODUCTION_DELETION_SIGNAL_URL` = base de l'application de production
 * (le chemin du protocole est ajouté) ou adresse complète. HTTPS exigé
 * (http admis pour localhost seulement). null si absente ou invalide.
 */
export function signalSourceUrl(env: Env = process.env): string | null {
  const raw = (env.PRODUCTION_DELETION_SIGNAL_URL ?? '').trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  const local = u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !local) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname === '/' || u.pathname === '') u.pathname = DELETION_SIGNAL_PATH;
  return u.toString();
}

/** Intervalle de fraîcheur exigé (heures, `PRODUCTION_DELETION_SIGNAL_MAX_AGE_HOURS`, 1..48). */
export function readinessMaxAgeHours(env: Env = process.env): number {
  const n = Number(env.PRODUCTION_DELETION_SIGNAL_MAX_AGE_HOURS);
  return Number.isInteger(n) && n >= 1 && n <= 48 ? n : DELETION_SIGNAL_DEFAULTS.readinessMaxAgeHours;
}

/* ── Empreintes ──────────────────────────────────────────────────────────── */

function subKey(key: string, purpose: 'subject' | 'auth'): Buffer {
  return createHmac('sha256', key).update(`verebona:deletion-signal:${purpose}:v1`).digest();
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = (email ?? '').trim().toLowerCase();
  return e.includes('@') ? e : null;
}

/** Empreinte non réversible d'un identifiant (64 hexadécimaux). */
export function subjectFingerprint(key: string, kind: 'uid' | 'acc' | 'email', value: string | number): string {
  return createHmac('sha256', subKey(key, 'subject')).update(`${kind}:${value}`).digest('hex');
}

export const userIdFingerprint = (key: string, userId: number) => subjectFingerprint(key, 'uid', userId);
export const accountIdFingerprint = (key: string, accountId: number) => subjectFingerprint(key, 'acc', accountId);
export function emailFingerprint(key: string, email: string | null | undefined): string | null {
  const n = normalizeEmail(email);
  return n ? subjectFingerprint(key, 'email', n) : null;
}

/* ── Signatures ──────────────────────────────────────────────────────────── */

function hmacHex(key: string, payload: string): string {
  return createHmac('sha256', subKey(key, 'auth')).update(payload).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Chaîne canonique d'une requête : paramètres triés, valeurs encodées. */
export function canonicalRequest(method: string, pathname: string, params: URLSearchParams | Record<string, string>, timestamp: string): string {
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const q = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `REQ\n${method.toUpperCase()}\n${pathname}\n${q}\n${timestamp}`;
}

export function signRequest(key: string, method: string, pathname: string, params: URLSearchParams | Record<string, string>, timestamp: string): string {
  return hmacHex(key, canonicalRequest(method, pathname, params, timestamp));
}

export type SignatureCheck = { ok: true } | { ok: false; reason: 'MISSING' | 'STALE' | 'INVALID' };

function freshTimestamp(timestamp: string | null, now: number): boolean {
  if (!timestamp || !/^\d{10,16}$/.test(timestamp)) return false;
  return Math.abs(now - Number(timestamp)) <= DELETION_SIGNAL_DEFAULTS.maxSkewMs;
}

export function verifyRequestSignature(
  key: string,
  input: { method: string; pathname: string; params: URLSearchParams; timestamp: string | null; signature: string | null },
  now: number = Date.now(),
): SignatureCheck {
  if (!input.timestamp || !input.signature) return { ok: false, reason: 'MISSING' };
  if (!freshTimestamp(input.timestamp, now)) return { ok: false, reason: 'STALE' };
  const expected = signRequest(key, input.method, input.pathname, input.params, input.timestamp);
  return safeEqualHex(input.signature.toLowerCase(), expected) ? { ok: true } : { ok: false, reason: 'INVALID' };
}

export function signResponse(key: string, body: string, timestamp: string): string {
  return hmacHex(key, `RES\n${timestamp}\n${body}`);
}

export function verifyResponseSignature(key: string, body: string, timestamp: string | null, signature: string | null, now: number = Date.now()): SignatureCheck {
  if (!timestamp || !signature) return { ok: false, reason: 'MISSING' };
  if (!freshTimestamp(timestamp, now)) return { ok: false, reason: 'STALE' };
  return safeEqualHex(signature.toLowerCase(), signResponse(key, body, timestamp)) ? { ok: true } : { ok: false, reason: 'INVALID' };
}

/* ── Charge utile ────────────────────────────────────────────────────────── */

export interface DeletionSignalEntry {
  /** Référence opaque (ordre croissant, sert de curseur). */
  ref: string;
  executedAt: string;
  scope: 'account' | 'user';
  /** Empreintes des identifiants supprimés (`uid:`, `acc:`). */
  subjects: string[];
  /** Empreintes des adresses des utilisateurs supprimés, calculées à la suppression. */
  contacts: string[];
}

export interface DeletionSignalPage {
  schema: typeof DELETION_SIGNAL_SCHEMA;
  environment: string;
  generatedAt: string;
  /** Suppressions garanties présentes depuis cette date (rotation du registre). */
  coversSince: string;
  entries: DeletionSignalEntry[];
  /** Curseur de la page suivante, null si dernière page. */
  next: string | null;
}

const FP = /^[0-9a-f]{64}$/;

/** Valide une page reçue (tout ou rien). */
export function parseSignalPage(raw: unknown): { ok: true; page: DeletionSignalPage } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'objet JSON attendu' };
  const o = raw as Record<string, unknown>;
  if (o.schema !== DELETION_SIGNAL_SCHEMA) return { ok: false, error: `schema « ${DELETION_SIGNAL_SCHEMA} » attendu` };
  if (typeof o.environment !== 'string' || !o.environment) return { ok: false, error: 'environment attendu' };
  if (typeof o.coversSince !== 'string' || Number.isNaN(Date.parse(o.coversSince))) return { ok: false, error: 'coversSince attendu' };
  if (!Array.isArray(o.entries)) return { ok: false, error: 'entries attendu' };
  if (o.next !== null && typeof o.next !== 'string') return { ok: false, error: 'next invalide' };
  const entries: DeletionSignalEntry[] = [];
  for (const [i, e] of o.entries.entries()) {
    const x = (e ?? {}) as Record<string, unknown>;
    const fps = (v: unknown) => Array.isArray(v) && v.length <= 50 && v.every((s) => typeof s === 'string' && FP.test(s));
    if (typeof x.ref !== 'string' || !/^r\d{1,18}$/.test(x.ref)
      || typeof x.executedAt !== 'string' || Number.isNaN(Date.parse(x.executedAt))
      || (x.scope !== 'account' && x.scope !== 'user') || !fps(x.subjects) || !fps(x.contacts)) {
      return { ok: false, error: `entrée ${i + 1} invalide` };
    }
    entries.push({ ref: x.ref, executedAt: new Date(x.executedAt).toISOString(), scope: x.scope, subjects: x.subjects as string[], contacts: x.contacts as string[] });
  }
  return {
    ok: true,
    page: {
      schema: DELETION_SIGNAL_SCHEMA, environment: o.environment, generatedAt: String(o.generatedAt ?? ''),
      coversSince: new Date(o.coversSince).toISOString(), entries, next: (o.next as string | null) ?? null,
    },
  };
}

/** Curseur `r<id>` → id (0 si absent / invalide). */
export function cursorId(after: string | null | undefined): number {
  const m = /^r(\d{1,18})$/.exec(after ?? '');
  const n = m ? Number(m[1]) : 0;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/* ── Correspondance (pur) ────────────────────────────────────────────────── */

export interface CopySubject {
  id: number;
  copyId: number;
  kind: 'user' | 'account';
  targetId: number;
  idFingerprints: string[];
  contactFingerprints: string[];
  /** Date à partir de laquelle une suppression par adresse vaut pour cette copie (instantané source). */
  copySnapshotAt: Date | null;
}

/**
 * Suppression de production correspondant à ce sujet copié, ou null.
 *   · identifiant (`uid`, `acc`) : toujours (un identifiant n'est jamais réutilisé) ;
 *   · adresse : seulement pour une suppression POSTÉRIEURE à l'instantané de la
 *     copie (une adresse peut être réutilisée par une nouvelle inscription).
 */
export function matchSubject(
  subject: Pick<CopySubject, 'idFingerprints' | 'contactFingerprints' | 'copySnapshotAt'>,
  index: { bySubject: Map<string, DeletionSignalEntry>; byContact: Map<string, DeletionSignalEntry[]> },
): DeletionSignalEntry | null {
  for (const fp of subject.idFingerprints) {
    const e = index.bySubject.get(fp);
    if (e) return e;
  }
  const since = subject.copySnapshotAt?.getTime() ?? null;
  for (const fp of subject.contactFingerprints) {
    for (const e of index.byContact.get(fp) ?? []) {
      if (since !== null && Date.parse(e.executedAt) >= since) return e;
    }
  }
  return null;
}

export function buildSignalIndex(entries: DeletionSignalEntry[]): { bySubject: Map<string, DeletionSignalEntry>; byContact: Map<string, DeletionSignalEntry[]> } {
  const bySubject = new Map<string, DeletionSignalEntry>();
  const byContact = new Map<string, DeletionSignalEntry[]>();
  for (const e of entries) {
    for (const fp of e.subjects) if (!bySubject.has(fp)) bySubject.set(fp, e);
    for (const fp of e.contacts) byContact.set(fp, [...(byContact.get(fp) ?? []), e]);
  }
  return { bySubject, byContact };
}
