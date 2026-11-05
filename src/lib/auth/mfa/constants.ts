/**
 * Double authentification (MFA) — constantes et listes FERMÉES (lot 110B).
 * Module PUR (aucune dépendance Node ni base) : lu par le middleware Edge,
 * les gardes serveur, l'interface et les tests d'architecture.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MODÈLE (ticket MFA §1, §6)
 *
 *   · une session COMPLÈTE porte un niveau de preuve `aal` dans ses jetons
 *     (accès + renouvellement, `lib/jwt.ts`) : 2 = authentification forte
 *     prouvée, 1 = authentification primaire seule (mot de passe, Google,
 *     Apple, lien d'activation) ou session antérieure au lot ;
 *   · l'obligation s'applique à un utilisateur quand il a DÉJÀ enrôlé un
 *     facteur (jamais levée par un retour arrière) OU quand l'obligation
 *     globale de sa population est en vigueur (réglages BO « utilisateurs »
 *     et « administrateurs », `policy.ts`) ;
 *   · obligation applicable + session de niveau 1 → toute requête métier est
 *     refusée (403 `MFA_REQUIRED`), sauf la liste fermée
 *     `AAL1_ALLOWED_WHEN_MFA_REQUIRED` (déconnexion, résiliation) ;
 *   · entre la preuve primaire et la preuve forte, seul un JETON PROVISOIRE
 *     distinct (cookie `vb_mfa`, 10 min, `kid` propre) existe : il n'ouvre
 *     que les routes `/api/auth/mfa/*` (liste `MFA_PENDING_ROUTES`).
 * ══════════════════════════════════════════════════════════════════════════
 */

/** Code public du refus d'une session sans preuve forte (403). */
export const MFA_REQUIRED_CODE = 'MFA_REQUIRED';
export const MFA_REQUIRED_MESSAGE =
  'Pour continuer, reconnectez-vous puis confirmez votre identité avec votre méthode de sécurité.';

/** Step-up : preuve forte exigée pour une opération de sécurité du compte. */
export const MFA_STEP_UP_REQUIRED_CODE = 'MFA_STEP_UP_REQUIRED';

/** Cookie du jeton provisoire (HttpOnly, limité aux routes MFA). */
export const MFA_PENDING_COOKIE = 'vb_mfa';
export const MFA_PENDING_COOKIE_PATH = '/api/auth/mfa';

/** Lien navigateur ↔ défi de connexion par clé d'accès sans mot de passe (cookie aléatoire). */
export const MFA_PASSKEY_LOGIN_BINDING_COOKIE = 'vb_mfa_wa';
/** Lien navigateur ↔ code e-mail de récupération (cookie aléatoire). */
export const MFA_RECOVERY_BINDING_COOKIE = 'vb_mfa_rc';

/** Durée du jeton provisoire et de son contexte (preuve primaire « fraîche »). */
export const MFA_PENDING_TTL_S = 10 * 60;

/** Durée d'un défi WebAuthn (options → réponse). */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Code reçu par e-mail pour la récupération (possession de l'adresse). */
export const RECOVERY_EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
export const RECOVERY_EMAIL_CODE_MAX_ATTEMPTS = 5;

/** TOTP (RFC 6238) : SHA-1, 6 chiffres, 30 s — interopérable avec toutes les applications. */
export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
/** Fenêtre d'horloge tolérée : ±1 intervalle (30 s). */
export const TOTP_WINDOW = 1;
/** Taille du secret (octets) : 160 bits (recommandation RFC 4226). */
export const TOTP_SECRET_BYTES = 20;
/** Un secret en attente de confirmation expire. */
export const TOTP_PENDING_TTL_MS = 15 * 60 * 1000;
export const TOTP_ISSUER = 'Verebona';

/** Codes de récupération : nombre, longueur (base32, 16 caractères = 80 bits). */
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 16;

/** Nombre maximal de clés d'accès par utilisateur (garde-fou). */
export const MAX_PASSKEYS_PER_USER = 20;
export const PASSKEY_NAME_MAX = 60;

/** Niveaux de preuve. */
export const AAL_PRIMARY = 1 as const;
export const AAL_MFA = 2 as const;

/**
 * Méthodes de réauthentification qui produisent une preuve FORTE (step-up).
 * Mot de passe, Google et Apple seuls produisent une preuve de niveau 1.
 */
export const STRONG_REAUTH_METHODS: ReadonlySet<string> = new Set(['passkey', 'totp']);

/**
 * Routes ouvertes au jeton PROVISOIRE (préfixe `/api/auth/mfa/`) — liste
 * FERMÉE, vérifiée par le test d'architecture `l110b-mfa-architecture`.
 * Aucune n'expose un bien, un document ou une donnée métier.
 */
export const MFA_PENDING_ROUTES: readonly string[] = [
  '/api/auth/mfa/state',
  '/api/auth/mfa/cancel',
  '/api/auth/mfa/totp/verify',
  '/api/auth/mfa/totp/enroll',
  '/api/auth/mfa/passkey/options',
  '/api/auth/mfa/passkey/verify',
  '/api/auth/mfa/passkey/register',
  '/api/auth/mfa/recovery/start',
  '/api/auth/mfa/recovery/verify',
  '/api/auth/mfa/recovery-codes/confirm',
];

/**
 * Session COMPLÈTE de niveau 1 alors que la MFA est obligatoire pour son
 * utilisateur (ancienne session après l'activation, session d'un autre
 * appareil après un premier enrôlement) : seules ces API restent permises.
 * Déconnexion ; résiliation (démarche administrative, aucun accès
 * documentaire — ticket §6). Tout le reste : 403 MFA_REQUIRED, y compris
 * `/api/auth/me` (l'interface renvoie alors à la connexion).
 */
const AAL1_ALLOWED: ReadonlyArray<{ path: string; methods: ReadonlyArray<string> }> = [
  { path: '/api/auth/logout', methods: ['POST', 'GET'] },
  { path: '/api/billing/cancel-subscription', methods: ['POST'] },
  { path: '/api/billing/stop-renewal', methods: ['POST'] },
];

export function isAllowedWithoutMfa(pathname: string, method: string): boolean {
  const p = (pathname || '').replace(/\/+$/, '') || '/';
  const m = (method || 'GET').toUpperCase();
  return AAL1_ALLOWED.some((a) => a.path === p && (a.methods.includes(m) || m === 'HEAD' || m === 'OPTIONS'));
}

/** Pour le test d'architecture et la documentation. */
export const AAL1_ALLOWED_WHEN_MFA_REQUIRED = AAL1_ALLOWED;

/** Populations de l'obligation globale (réglages BO distincts). */
export type MfaEnforcementScope = 'users' | 'admins';
export const MFA_ENFORCEMENT_SCOPES: readonly MfaEnforcementScope[] = ['users', 'admins'];

export function isAdminRole(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

/** Messages non énumérants (jamais « compte inconnu », « aucun facteur »…). */
export const MFA_MESSAGES = {
  invalidCode: 'Code incorrect ou expiré. Vérifiez l’heure de votre appareil et réessayez.',
  invalidRecovery: 'Vérification impossible. Vérifiez les codes saisis et réessayez.',
  expired: 'Votre étape de connexion a expiré. Recommencez la connexion.',
  passkeyFailed: 'La clé d’accès n’a pas pu être vérifiée. Réessayez ou choisissez une autre méthode.',
  passkeyUnknown: 'Cette clé d’accès n’est pas reconnue. Choisissez une autre méthode.',
  rateLimited: 'Trop de tentatives. Patientez quelques minutes avant de réessayer.',
  lastMethod: 'Vous ne pouvez pas retirer votre dernière méthode de sécurité. Ajoutez-en une autre d’abord.',
  stepUp: 'Pour votre sécurité, confirmez votre identité avec votre clé d’accès ou votre code de sécurité.',
} as const;
