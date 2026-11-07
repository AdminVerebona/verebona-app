/**
 * Lancement d'une analyse depuis le tiroir du document — lot 113U (carte
 * Trello #720 « Analyse T1 ko »). Module PUR (navigateur et serveur, aucun
 * import serveur) : catégories des refus de lancement et référence
 * d'incident.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN CODE, UNE CATÉGORIE, UN TEXTE
 *
 * Chaque code connu (flux SSE de `POST /api/documents/[id]/analyze`, corps
 * JSON d'un refus HTTP du middleware ou d'un proxy, échec réseau côté
 * client) appartient à UNE catégorie ; le tiroir en tire un texte du
 * référentiel fermé (lot 34C, `document-analysis-feedback.ts`). Seule la
 * catégorie `UNKNOWN` garde le texte générique « Impossible de lancer
 * l'analyse. Veuillez réessayer. », toujours suivi d'une référence courte
 * qui retrouve l'événement au BO (BO › File d'attente IA › Refus de
 * lancement d'analyse).
 * ══════════════════════════════════════════════════════════════════════════
 */

export type LaunchCategory =
  | 'SESSION' | 'MFA' | 'CGUV' | 'APP_UPDATE' | 'ACCESS' | 'PLAN' | 'NOT_FOUND'
  | 'IN_PROGRESS' | 'UNAVAILABLE' | 'NETWORK' | 'ANALYSIS' | 'UNKNOWN';

export const LAUNCH_CATEGORIES: readonly LaunchCategory[] = [
  'SESSION', 'MFA', 'CGUV', 'APP_UPDATE', 'ACCESS', 'PLAN', 'NOT_FOUND',
  'IN_PROGRESS', 'UNAVAILABLE', 'NETWORK', 'ANALYSIS', 'UNKNOWN',
];

/** Codes connus → catégorie. Tout autre code est `UNKNOWN` (sauf statut HTTP explicite). */
export const LAUNCH_CODE_CATEGORY: Readonly<Record<string, LaunchCategory>> = {
  // Session (flux, middleware, gardes de session)
  UNAUTHORIZED: 'SESSION', AUTH_REQUIRED: 'SESSION', INVALID_TOKEN: 'SESSION', MISSING_TOKEN: 'SESSION',
  SESSION_EXPIRED: 'SESSION', SESSION_REVOKED: 'SESSION', AUTH_ERROR: 'SESSION',
  MFA_REQUIRED: 'MFA',
  CGUV_REACCEPTANCE_REQUIRED: 'CGUV',
  APP_UPDATE_REQUIRED: 'APP_UPDATE',
  // Accès au compte
  NO_ACCOUNT: 'ACCESS', ACCOUNT_SUSPENDED: 'ACCESS', ACCOUNT_PENDING_DELETION: 'ACCESS', ACCESS_DENIED: 'ACCESS',
  INSUFFICIENT_PERMISSIONS: 'ACCESS', FORBIDDEN: 'ACCESS', CSRF_ORIGIN_REJECTED: 'ACCESS', NOT_AVAILABLE_IN_APP: 'ACCESS',
  // Offre / droits d'analyse
  PLAN_UPGRADE_REQUIRED: 'PLAN', PLAN_NOT_SUBSCRIBABLE: 'PLAN', TRIAL_EXPIRED: 'PLAN', SUBSCRIPTION_REQUIRED: 'PLAN',
  ANALYSIS_QUOTA_REACHED: 'PLAN',
  // Document
  NOT_FOUND: 'NOT_FOUND', INVALID_ID: 'NOT_FOUND',
  // Déjà pris en charge (job vivant, report daté)
  ALREADY_ANALYZING: 'IN_PROGRESS', ANALYSIS_COST_CAP_REACHED: 'IN_PROGRESS', ANALYSIS_WAITING_TECHNICAL: 'IN_PROGRESS',
  // Indisponibilité momentanée
  SESSION_UNAVAILABLE: 'UNAVAILABLE', CGUV_CHECK_UNAVAILABLE: 'UNAVAILABLE', SERVICE_UNAVAILABLE: 'UNAVAILABLE',
  RATE_LIMITED: 'UNAVAILABLE', HTTP_429: 'UNAVAILABLE', HTTP_502: 'UNAVAILABLE', HTTP_503: 'UNAVAILABLE', HTTP_504: 'UNAVAILABLE',
  // Réseau (côté client)
  NETWORK_ERROR: 'NETWORK', STREAM_INTERRUPTED: 'NETWORK',
  // Analyse lancée puis non aboutie (référentiel 34C existant)
  ANALYSIS_FAILED: 'ANALYSIS', ANALYSIS_INTERRUPTED: 'ANALYSIS',
  // Panne inattendue
  INTERNAL_ERROR: 'UNKNOWN',
};

/** Catégorie d'un statut HTTP de refus quand le corps ne porte aucun code connu. */
function categoryOfStatus(status: number | null | undefined): LaunchCategory {
  if (status === 401) return 'SESSION';
  if (status === 426) return 'APP_UPDATE';
  if (status === 403) return 'ACCESS';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) return 'UNAVAILABLE';
  return 'UNKNOWN';
}

/** Code normalisé : chaîne MAJUSCULE_SOULIGNÉE bornée, sinon vide (jamais un texte libre). */
export function normalizeLaunchCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const c = raw.trim();
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(c) ? c : '';
}

/**
 * Catégorie d'un refus : le code d'abord (s'il est connu), puis le statut
 * HTTP. Un code inconnu avec un statut connu suit le statut (un 401 reste une
 * session expirée même si un proxy a changé le corps).
 */
export function launchCategoryOf(code: unknown, httpStatus?: number | null): LaunchCategory {
  const c = normalizeLaunchCode(code);
  if (c && Object.prototype.hasOwnProperty.call(LAUNCH_CODE_CATEGORY, c)) return LAUNCH_CODE_CATEGORY[c];
  return categoryOfStatus(httpStatus ?? null);
}

/** Le refus est-il une information (rien à faire) plutôt qu'une erreur ? */
export function isInformativeLaunchCategory(c: LaunchCategory): boolean {
  return c === 'IN_PROGRESS';
}

// ── Référence d'incident ────────────────────────────────────────────────────

/** Alphabet de Crockford (sans I, L, O, U) : lisible au téléphone, sans ambiguïté. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const INCIDENT_REF_PATTERN = /^AN-[0-9A-HJKMNP-TV-Z]{8}$/;

/** Référence courte d'un refus (`AN-7K3Q9XM2`), aléatoire, sans donnée. */
export function newIncidentRef(): string {
  const bytes = new Uint8Array(8);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = 'AN-';
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
}

/** Référence reçue valide, sinon null (jamais une valeur arbitraire affichée). */
export function parseIncidentRef(raw: unknown): string | null {
  return typeof raw === 'string' && INCIDENT_REF_PATTERN.test(raw.trim().toUpperCase()) ? raw.trim().toUpperCase() : null;
}

// ── Origine du client ───────────────────────────────────────────────────────

export type LaunchOrigin = 'WEB' | 'PWA' | 'IOS' | 'ANDROID';

/**
 * Origine d'une requête : en-tête déclaratif `X-Verebona-Client` (posé par
 * le client de l'application), sinon marqueur `VerebonaApp/` de l'agent
 * utilisateur de la vue mobile (plateforme lue dans l'agent), sinon Web.
 * Observabilité seulement : jamais une base de droits.
 */
export function launchOriginOf(declaredClient: string | null | undefined, userAgent: string | null | undefined): LaunchOrigin {
  const d = (declaredClient ?? '').toUpperCase();
  if (d === 'IOS' || d === 'ANDROID' || d === 'PWA') return d;
  const ua = userAgent ?? '';
  if (/VerebonaApp\//.test(ua)) {
    if (/Android/i.test(ua)) return 'ANDROID';
    if (/iPhone|iPad|iPod|iOS|Macintosh/i.test(ua)) return 'IOS';
  }
  return 'WEB';
}

/** Version de l'application lue dans le marqueur `VerebonaApp/x.y.z (build; env)` de l'agent utilisateur, ou null. */
export function appVersionFromUserAgent(userAgent: string | null | undefined): string | null {
  const m = /\bVerebonaApp\/(\d{1,4}\.\d{1,4}\.\d{1,4}) \((\d{1,9});/.exec(userAgent ?? '');
  return m ? `${m[1]} (${m[2]})` : null;
}
