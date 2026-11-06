/**
 * Stockage sécurisé de l'application (Keychain iOS / Keystore Android) — lot 95
 * (CDC 12 AUTH-07, AUTH-08, SEC-03, §26 ; G0-08).
 *
 * Accès direct aux méthodes natives du plugin `@aparajita/capacitor-secure-storage`
 * (`internalGetItem` / `internalSetItem` / `internalRemoveItem` /
 * `internalClearItemsWithPrefix`) : aucun paquet côté site.
 *
 *   · iOS : Keychain, classe `whenUnlockedThisDeviceOnly` — jamais synchronisé
 *     iCloud, jamais restauré sur un autre appareil ;
 *   · Android : valeur chiffrée par une clé du Keystore matériel.
 *
 * Ne contient JAMAIS de mot de passe (AUTH-07). Sur le Web : aucune écriture
 * (toutes les fonctions répondent « absent »).
 *
 * Lot 112E — CLASSE D'ACCESSIBILITÉ CONSERVÉE (`whenUnlockedThisDeviceOnly`).
 * Conséquence connue : téléphone verrouillé, iOS refuse la lecture
 * (`errSecInteractionNotAllowed`, -25308) et le plugin npm la rend comme
 * « absent ». On ne baisse PAS la classe (`afterFirstUnlock…`) : l'identifiant
 * d'installation rattache les jetons d'import du partage (110A) et le choix
 * biométrique (107A) doit rester illisible appareil verrouillé. À la place,
 * `secureProbe` (plugin local `VerebonaSecureStoreStatus`, binaire 112E et
 * suivants) rend le code natif, et les lecteurs DIFFÈRENT au lieu de conclure
 * « absent » (docs/exploitation/recette-112e-identifiant-installation.md).
 */
import { NATIVE_PLUGINS, nativePlugin } from './bridge';

/** Préfixe de toutes les clés de l'app (purge en bloc à la réinstallation). */
export const SECURE_PREFIX = 'verebona.';

/** Clés utilisées (inventaire AUTH-08 / §26). */
export const SECURE_KEYS = {
  /** Identifiant d'installation (X-Verebona-Installation-Id) — non secret, lié à l'appareil. */
  installationId: 'installation-id',
  /**
   * Ancienne préférence « Déverrouiller avec Face ID / empreinte » (lot 97B,
   * unique pour l'appareil). Lot 107A : reprise une fois dans
   * `biometricsState` puis effacée.
   */
  biometricsEnabled: 'biometrics-enabled',
  /**
   * Lot 107A : déverrouillage biométrique PAR COMPTE sur cet appareil
   * (jamais proposé / reporté / actif / à réactiver), avec l'empreinte NON
   * biométrique de l'enrôlement (`biometric-consent.ts`). Aucun secret.
   */
  biometricsState: 'biometrics-state',
  /**
   * Lot 109G : invitation « Autoriser les notifications » PAR COMPTE sur cette
   * installation (proposée / « Plus tard » / répondue). Aucun secret, aucun jeton.
   */
  pushOnboarding: 'push-onboarding',
  /** Vérificateur PKCE d'un parcours Google / Apple en cours (10 min max). */
  oauthVerifier: 'oauth-verifier',
} as const;

/** `KeychainAccess.whenUnlockedThisDeviceOnly` du plugin. */
const KEYCHAIN_WHEN_UNLOCKED_THIS_DEVICE_ONLY = 1;

interface SecureStoragePlugin {
  internalGetItem(o: { prefixedKey: string; sync: boolean }): Promise<{ data: string | null }>;
  internalSetItem(o: { prefixedKey: string; data: string; sync: boolean; access: number }): Promise<void>;
  internalRemoveItem(o: { prefixedKey: string; sync: boolean }): Promise<{ success: boolean }>;
  internalClearItemsWithPrefix(o: { prefix: string; sync: boolean }): Promise<void>;
}

function plugin(): SecureStoragePlugin | null {
  return nativePlugin<SecureStoragePlugin>(NATIVE_PLUGINS.secureStorage);
}

export async function secureGet(key: string): Promise<string | null> {
  const p = plugin();
  if (!p) return null;
  try {
    const { data } = await p.internalGetItem({ prefixedKey: SECURE_PREFIX + key, sync: false });
    return typeof data === 'string' && data !== '' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Lot 112E : état d'une valeur du Keychain tel que le rend iOS (code natif),
 * sans jamais lire la valeur elle-même.
 *   present  la valeur existe et est lisible ;
 *   absent   aucune valeur ET données protégées disponibles (appareil déverrouillé) ;
 *   locked   `errSecInteractionNotAllowed`, ou « introuvable » alors que les
 *            données protégées sont indisponibles (on ne conclut pas « absent ») ;
 *   error    autre code du Keychain.
 */
export type SecureProbeStatus = 'present' | 'absent' | 'locked' | 'error';

export interface SecureProbe {
  status: SecureProbeStatus;
  /** OSStatus natif (0, -25300 introuvable, -25308 interaction interdite…), ou null. */
  osStatus: number | null;
  /** `UIApplication.isProtectedDataAvailable`, ou null si inconnu. */
  protectedDataAvailable: boolean | null;
}

interface SecureStoreStatusPlugin {
  probe(o: { prefixedKey: string }): Promise<{ status?: unknown; osStatus?: unknown; protectedDataAvailable?: unknown }>;
}

/** Plugin local iOS du lot 112E, ou null (Android, Web, binaire antérieur). */
export function secureStatusPlugin(): (SecureStoreStatusPlugin & { addListener?: (e: string, cb: (d: unknown) => void) => unknown }) | null {
  return nativePlugin<SecureStoreStatusPlugin>(NATIVE_PLUGINS.secureStoreStatus);
}

const PROBE_STATUSES: ReadonlySet<string> = new Set(['present', 'absent', 'locked', 'error']);

/** Normalise la réponse native (pur, testé). Réponse inattendue → `error`. */
export function parseSecureProbe(raw: unknown): SecureProbe {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { status?: unknown; osStatus?: unknown; protectedDataAvailable?: unknown };
  const status = typeof r.status === 'string' && PROBE_STATUSES.has(r.status) ? r.status as SecureProbeStatus : 'error';
  const osStatus = typeof r.osStatus === 'number' && Number.isFinite(r.osStatus) ? Math.trunc(r.osStatus) : null;
  const protectedDataAvailable = typeof r.protectedDataAvailable === 'boolean' ? r.protectedDataAvailable : null;
  // Données protégées indisponibles : jamais « absent » (iOS peut répondre « introuvable »).
  if (status === 'absent' && protectedDataAvailable === false) return { status: 'locked', osStatus, protectedDataAvailable };
  return { status, osStatus, protectedDataAvailable };
}

/**
 * Lot 112E : sonde native d'une clé (code d'erreur du Keychain). Null quand
 * le plugin local n'est pas embarqué (Android, binaire antérieur au lot 112E) :
 * l'appelant se rabat alors sur le premier plan (`App.getState`).
 */
export async function secureProbe(key: string): Promise<SecureProbe | null> {
  const p = secureStatusPlugin();
  if (!p || typeof p.probe !== 'function') return null;
  try {
    return parseSecureProbe(await p.probe({ prefixedKey: SECURE_PREFIX + key }));
  } catch {
    return { status: 'error', osStatus: null, protectedDataAvailable: null };
  }
}

/** Raison d'une lecture impossible (lot 112E). */
export type SecureReadFailure = 'no_plugin' | 'storage_error' | 'locked';

/**
 * Lot 111D : lecture qui DISTINGUE « absent » (`ok: true, value: null`) d'un
 * échec de lecture (`ok: false` : Keystore Android en erreur, plugin absent).
 * Sur iOS, le plugin rend « absent » pour toute erreur du Keychain : la
 * machine de déverrouillage ne lit donc le moyen qu'au premier plan.
 *
 * Lot 112E : quand le plugin rend « absent » et que la sonde native existe
 * (binaire 112E+), elle tranche : Keychain verrouillé ou en erreur →
 * `ok: false, failure: 'locked' | 'storage_error'` (jamais « absent »).
 */
export async function secureRead(key: string): Promise<{ ok: boolean; value: string | null; failure?: SecureReadFailure; probe?: SecureProbe | null }> {
  const p = plugin();
  if (!p) return { ok: false, value: null, failure: 'no_plugin' };
  let value: string | null;
  try {
    const { data } = await p.internalGetItem({ prefixedKey: SECURE_PREFIX + key, sync: false });
    value = typeof data === 'string' && data !== '' ? data : null;
  } catch {
    return { ok: false, value: null, failure: 'storage_error' };
  }
  if (value !== null) return { ok: true, value };
  const probe = await secureProbe(key);
  if (probe?.status === 'locked') return { ok: false, value: null, failure: 'locked', probe };
  if (probe?.status === 'error') return { ok: false, value: null, failure: 'storage_error', probe };
  // `present` juste après un « absent » : écriture concurrente ou déverrouillage
  // entre les deux appels — on ne conclut rien, l'appelant relira.
  if (probe?.status === 'present') return { ok: false, value: null, failure: 'storage_error', probe };
  return probe ? { ok: true, value: null, probe } : { ok: true, value: null };
}

export async function secureSet(key: string, value: string): Promise<boolean> {
  const p = plugin();
  if (!p) return false;
  try {
    await p.internalSetItem({
      prefixedKey: SECURE_PREFIX + key, data: value, sync: false, access: KEYCHAIN_WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return true;
  } catch {
    return false;
  }
}

export async function secureRemove(key: string): Promise<void> {
  const p = plugin();
  if (!p) return;
  try { await p.internalRemoveItem({ prefixedKey: SECURE_PREFIX + key, sync: false }); } catch { /* absent */ }
}

/** Efface toutes les valeurs de l'app (réinstallation détectée, AUTH-13). */
export async function secureClearAll(): Promise<void> {
  const p = plugin();
  if (!p) return;
  try { await p.internalClearItemsWithPrefix({ prefix: SECURE_PREFIX, sync: false }); } catch { /* rien à effacer */ }
}
