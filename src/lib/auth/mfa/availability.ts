/**
 * Disponibilité RÉELLE des méthodes de connexion et de double
 * authentification, et messages de repli — lot 111W. Module PUR (navigateur
 * et tests ; aucun import serveur, aucun import WebAuthn).
 *
 * Trois notions à ne jamais confondre :
 *   1. le SERVICE WebAuthn du serveur est configuré (statut global anonyme,
 *      `passkey` de GET /api/auth/oauth/providers — aucune donnée de compte) ;
 *   2. la VUE prend en charge WebAuthn (`passkeysUsableHere()`) ;
 *   3. une clé d'accès EXISTE pour ce compte sur cet appareil — inconnaissable
 *      avant la cérémonie, jamais demandée au serveur (anti-énumération).
 * Le bouton de connexion par clé d'accès exige 1 ET 2. Une coupure réseau
 * ponctuelle donne un état distinct avec « Réessayer » : jamais un blocage,
 * jamais un contournement de la double authentification (les validations
 * serveur restent seules juges).
 */

export interface LoginMethodsStatus { state: 'ready'; passkey: boolean; google: boolean; apple: boolean }
export type ServerLoginStatus = LoginMethodsStatus | { state: 'error' };

export const LOGIN_METHODS_STATUS_URL = '/api/auth/oauth/providers';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Statut global des méthodes de connexion (aucune donnée de compte). Erreur réseau / serveur : `{ state: 'error' }`. */
export async function fetchLoginMethodsStatus(fetchImpl: FetchLike = (u, i) => fetch(u, i)): Promise<ServerLoginStatus> {
  try {
    const r = await fetchImpl(LOGIN_METHODS_STATUS_URL, { credentials: 'include', cache: 'no-store' });
    if (!r.ok) return { state: 'error' };
    const d = await r.json() as Record<string, unknown> | null;
    return { state: 'ready', passkey: d?.passkey === true, google: d?.google === true, apple: d?.apple === true };
  } catch {
    return { state: 'error' };
  }
}

export type LoginPasskeyOffer = 'checking' | 'show' | 'hide' | 'retry';

/**
 * Proposer la connexion par clé d'accès ?
 *   · vue sans WebAuthn → jamais ;
 *   · vérifications en cours → rien (pas de bouton trompeur) ;
 *   · statut serveur illisible (réseau) → message distinct + Réessayer ;
 *   · service serveur indisponible → masqué.
 */
export function loginPasskeyOffer(clientUsable: boolean | null, server: ServerLoginStatus | null): LoginPasskeyOffer {
  if (clientUsable === false) return 'hide';
  if (clientUsable === null || server === null) return 'checking';
  if (server.state === 'error') return 'retry';
  return server.passkey ? 'show' : 'hide';
}

export const NETWORK_ERROR_TEXT = 'Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.';
export const SERVICE_TEMPORARY_TEXT = 'Le service est momentanément indisponible. Réessayez dans un instant.';
export const LOGIN_STATUS_RETRY_TEXT = 'Les clés d’accès n’ont pas pu être vérifiées : connexion au serveur impossible.';
const PASSKEY_UNAVAILABLE = 'Les clés d’accès ne sont pas disponibles pour le moment.';
const TOTP_UNAVAILABLE = 'L’application d’authentification n’est pas disponible pour le moment.';
const RECOVERY_HINT = 'utilisez un code de récupération (« Je n’ai plus accès à ma méthode de sécurité »)';

/** Connexion ANONYME : seules les autres méthodes de connexion (jamais un facteur supposé enrôlé). */
export function loginAlternativesText(p: { google?: boolean; apple?: boolean } = {}): string {
  const social = p.google && p.apple ? ', ou avec Google ou Apple' : p.google ? ', ou avec Google' : p.apple ? ', ou avec Apple' : '';
  return `Connectez-vous avec votre e-mail et votre mot de passe${social}.`;
}

export function loginPasskeyUnavailableText(p: { google?: boolean; apple?: boolean } = {}): string {
  return `${PASSKEY_UNAVAILABLE} ${loginAlternativesText(p)}`;
}

export type FailureKind = 'unavailable' | 'temporary' | 'other';

/** Réponse en échec d'une route MFA : configuration indisponible, panne passagère, ou refus ordinaire. */
export function classifyMfaFailure(status: number, code?: string | null): FailureKind {
  if (status === 503 && code === 'MFA_METHOD_UNAVAILABLE') return 'unavailable';
  if (status === 0 || status >= 500) return 'temporary';
  return 'other';
}

// ── Seconde étape (/verification) ──────────────────────────────────────────

export interface VerificationInputs {
  /** Facteurs ENRÔLÉS par ce compte (rendus par /api/auth/mfa/state). */
  methods: { passkey: boolean; totp: boolean };
  passkeysAvailable: boolean;
  /** Absent (serveur antérieur) = disponible. */
  totpAvailable?: boolean;
  webauthnHere: boolean;
}

export function verificationChoices(i: VerificationInputs): { passkey: boolean; totp: boolean; notice: string | null } {
  const totpServer = i.totpAvailable !== false;
  const passkey = i.methods.passkey && i.passkeysAvailable && i.webauthnHere;
  const totp = i.methods.totp && totpServer;
  if (passkey || totp) return { passkey, totp, notice: null };
  const pkDown = i.methods.passkey && !i.passkeysAvailable;
  const totpDown = i.methods.totp && !totpServer;
  let notice: string;
  if (pkDown && totpDown) notice = `Vos méthodes de sécurité sont momentanément indisponibles. Réessayez plus tard, ou ${RECOVERY_HINT}.`;
  else if (pkDown) notice = `Les clés d’accès sont momentanément indisponibles. Réessayez plus tard, ou ${RECOVERY_HINT}.`;
  else if (i.methods.passkey) notice = 'Votre clé d’accès ne peut pas être utilisée sur cet appareil. Utilisez un appareil où elle est disponible, ou un code de récupération.';
  else if (totpDown) notice = `L’application d’authentification est momentanément indisponible. Réessayez plus tard, ou ${RECOVERY_HINT}.`;
  else notice = 'Aucune méthode de sécurité n’est utilisable ici. Utilisez un code de récupération.';
  return { passkey, totp, notice };
}

/** Message après un 503 en seconde étape : seulement l'AUTRE facteur s'il est réellement utilisable, sinon la récupération. */
export function verificationUnavailableText(method: 'passkey' | 'totp', otherUsable: boolean): string {
  if (method === 'passkey') {
    return `${PASSKEY_UNAVAILABLE} ${otherUsable ? 'Utilisez le code de votre application d’authentification.' : `Réessayez plus tard, ou ${RECOVERY_HINT}.`}`;
  }
  return `${TOTP_UNAVAILABLE} ${otherUsable ? 'Utilisez votre clé d’accès.' : `Réessayez plus tard, ou ${RECOVERY_HINT}.`}`;
}

// ── Premier facteur (/securiser-mon-compte) ────────────────────────────────

export interface EnrollmentInputs { passkeysAvailable: boolean; totpAvailable?: boolean; webauthnHere: boolean }

export function enrollmentChoices(i: EnrollmentInputs): {
  passkey: boolean; passkeyNote: string | null; totp: boolean; totpNote: string | null; notice: string | null;
} {
  const totp = i.totpAvailable !== false;
  const passkey = i.passkeysAvailable && i.webauthnHere;
  const passkeyNote = passkey ? null
    : !i.passkeysAvailable ? (totp ? 'Momentanément indisponible : choisissez le code de sécurité.' : 'Momentanément indisponible.')
      : (totp ? 'Non disponible sur cet appareil : choisissez le code de sécurité.' : 'Non disponible sur cet appareil.');
  const totpNote = totp ? null : (passkey ? 'Momentanément indisponible : choisissez la clé d’accès.' : 'Momentanément indisponible.');
  const notice = passkey || totp ? null
    : 'Aucune méthode de sécurité ne peut être configurée pour le moment. Réessayez plus tard : vos biens et vos documents restent protégés.';
  return { passkey, passkeyNote, totp, totpNote, notice };
}
