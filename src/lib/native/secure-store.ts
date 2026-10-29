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
 */
import { NATIVE_PLUGINS, nativePlugin } from './bridge';

/** Préfixe de toutes les clés de l'app (purge en bloc à la réinstallation). */
export const SECURE_PREFIX = 'verebona.';

/** Clés utilisées (inventaire AUTH-08 / §26). */
export const SECURE_KEYS = {
  /** Identifiant d'installation (X-Verebona-Installation-Id) — non secret, lié à l'appareil. */
  installationId: 'installation-id',
  /** Préférence « Déverrouiller avec Face ID / empreinte » (AUTH-05, ACC-06). */
  biometricsEnabled: 'biometrics-enabled',
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
