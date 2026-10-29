/**
 * Verrouillage local de l'application — lot 95 (CDC 12 AUTH-05, AUTH-06, AUTH-09,
 * ACC-06, REC-007/008/056/057 ; aperçu multitâche masqué AUTH-15 par le plugin
 * natif `PrivacyScreen`, activé dans capacitor.config.ts).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES
 *   · Après 5 minutes passées en arrière-plan (seuil inclus), l'app se
 *     verrouille au retour (REC-056 : 4 min → pas de verrou ; REC-057 :
 *     6 min → verrou). Le moment du passage en arrière-plan est conservé
 *     localement (valeur non sensible) : un redémarrage à froid après un
 *     arrêt par le système applique la même règle.
 *   · Déverrouillage : Face ID / Touch ID / empreinte si l'utilisateur l'a
 *     activé (opt-in, AUTH-05) ; sinon `UNLOCK_WITHOUT_BIOMETRICS`.
 *   · La biométrie ne fait que déverrouiller LOCALEMENT une session encore
 *     valide (AUTH-06) : aucun secret biométrique, aucun mot de passe stocké ;
 *     si la session serveur a expiré, la connexion complète est demandée
 *     (comportement habituel de l'interface).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NATIVE_PLUGINS, nativePlugin } from './bridge';
import { SECURE_KEYS, secureGet, secureRemove, secureSet } from './secure-store';

/** Seuil du verrouillage (AUTH-09). */
export const LOCK_AFTER_BACKGROUND_MS = 5 * 60 * 1000;

/**
 * Déverrouillage quand la biométrie N'EST PAS activée — CHOIX PAR DÉFAUT À
 * CONFIRMER PAR LE PO (point unique) :
 *   'device_credential' : code du téléphone (ou biométrie du système) ;
 *                         si le téléphone n'a aucun code, connexion complète ;
 *   'password'          : toujours une connexion complète (e-mail / mot de
 *                         passe, Google ou Apple).
 */
export const UNLOCK_WITHOUT_BIOMETRICS: 'device_credential' | 'password' = 'device_credential';

/** Clé locale (non sensible) : instant du passage en arrière-plan. */
export const BACKGROUND_AT_KEY = 'verebona:native:background-at';

/** Verrouiller au retour ? (pur, testé) */
export function shouldLockOnResume(backgroundAt: number | null, now: number, threshold = LOCK_AFTER_BACKGROUND_MS): boolean {
  return backgroundAt !== null && Number.isFinite(backgroundAt) && now - backgroundAt >= threshold;
}

export function rememberBackgroundAt(now: number = Date.now()): void {
  try { globalThis.localStorage?.setItem(BACKGROUND_AT_KEY, String(now)); } catch { /* sans stockage : pas de verrou au démarrage à froid */ }
}

export function readBackgroundAt(): number | null {
  try {
    const v = Number(globalThis.localStorage?.getItem(BACKGROUND_AT_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function clearBackgroundAt(): void {
  try { globalThis.localStorage?.removeItem(BACKGROUND_AT_KEY); } catch { /* rien */ }
}

// ── Biométrie ──────────────────────────────────────────────────────────────

interface BiometricPlugin {
  checkBiometry(): Promise<{ isAvailable: boolean; deviceIsSecure: boolean; biometryType: number }>;
  internalAuthenticate(o: Record<string, unknown>): Promise<void>;
}

function biometric(): BiometricPlugin | null {
  return nativePlugin<BiometricPlugin>(NATIVE_PLUGINS.biometric);
}

export interface BiometryAvailability { available: boolean; deviceSecure: boolean }

export async function biometryAvailability(): Promise<BiometryAvailability> {
  const b = biometric();
  if (!b) return { available: false, deviceSecure: false };
  try {
    const r = await b.checkBiometry();
    return { available: !!r.isAvailable, deviceSecure: !!r.deviceIsSecure };
  } catch {
    return { available: false, deviceSecure: false };
  }
}

export async function biometricsEnabled(): Promise<boolean> {
  return (await secureGet(SECURE_KEYS.biometricsEnabled)) === '1';
}

/**
 * Activation explicite (Mon compte › Sécurité, ACC-06) : une vérification
 * réussie est exigée avant d'enregistrer le choix. Refus : rien ne change.
 */
export async function setBiometricsEnabled(enabled: boolean): Promise<boolean> {
  if (!enabled) { await secureRemove(SECURE_KEYS.biometricsEnabled); return true; }
  const ok = await verifyUser({ biometryOnly: true, reason: 'Activer le déverrouillage de Verebona' });
  if (ok !== 'ok') return false;
  return secureSet(SECURE_KEYS.biometricsEnabled, '1');
}

export type VerifyOutcome = 'ok' | 'cancelled' | 'unavailable';

/** Vérification locale de l'utilisateur (biométrie, ou code du téléphone si autorisé). */
export async function verifyUser(o: { biometryOnly: boolean; reason: string }): Promise<VerifyOutcome> {
  const b = biometric();
  if (!b) return 'unavailable';
  const { available, deviceSecure } = await biometryAvailability();
  if (o.biometryOnly ? !available : !(available || deviceSecure)) return 'unavailable';
  try {
    await b.internalAuthenticate({
      reason: o.reason,
      cancelTitle: 'Annuler',
      allowDeviceCredential: !o.biometryOnly,
      iosFallbackTitle: o.biometryOnly ? '' : 'Utiliser le code',
      androidTitle: 'Verebona',
      androidSubtitle: o.reason,
      androidConfirmationRequired: false,
    });
    return 'ok';
  } catch {
    return 'cancelled';
  }
}

export type UnlockPath = 'biometry' | 'device_credential' | 'full_sign_in';

/** Moyen de déverrouillage applicable (pur, testé). */
export function unlockPath(input: { biometricsEnabled: boolean; biometryAvailable: boolean; deviceSecure: boolean }): UnlockPath {
  if (input.biometricsEnabled && input.biometryAvailable) return 'biometry';
  if (UNLOCK_WITHOUT_BIOMETRICS === 'device_credential' && (input.deviceSecure || input.biometryAvailable)) return 'device_credential';
  return 'full_sign_in';
}
