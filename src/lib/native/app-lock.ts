/**
 * Verrouillage local de l'application — lot 95 (CDC 12 AUTH-05, AUTH-06, AUTH-09,
 * ACC-06, REC-007/008/056/057 ; aperçu multitâche masqué AUTH-15 par le plugin
 * natif `PrivacyScreen`, activé dans capacitor.config.ts), revu au lot 107A
 * (déverrouillage AUTOMATIQUE, voir `unlock-machine.ts`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES
 *   · Après 5 minutes passées en ARRIÈRE-PLAN (seuil inclus), l'app se
 *     verrouille au retour (REC-056 : 4 min → pas de verrou ; REC-057 :
 *     6 min → verrou). La lecture au premier plan sans toucher l'écran ne
 *     verrouille JAMAIS (aucun minuteur d'inactivité). Le moment du passage
 *     en arrière-plan est conservé localement (valeur non sensible) : un
 *     redémarrage à froid après un arrêt par le système applique la même
 *     règle. Horloge du téléphone reculée : verrou (prudence).
 *   · Déverrouillage : Face ID / Touch ID / biométrie Android lancé
 *     automatiquement si l'utilisateur l'a activé pour CE compte sur CET
 *     appareil (`biometric-consent.ts`) ; sinon `UNLOCK_WITHOUT_BIOMETRICS`.
 *   · La biométrie ne fait que déverrouiller LOCALEMENT une session encore
 *     valide (AUTH-06) : aucun secret biométrique, aucun mot de passe, aucun
 *     jeton stocké ; la session serveur est relue avant d'afficher l'app ;
 *     si elle a expiré ou a été révoquée, la connexion complète est demandée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NATIVE_PLUGINS, nativePlugin } from './bridge';

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

/**
 * Verrouiller au retour ? (pur, testé) — 5 min passées en arrière-plan.
 * Lot 107A : horloge reculée depuis le passage en arrière-plan (réglage
 * manuel de l'heure) → verrou, pour qu'on ne puisse pas contourner la règle.
 */
export function shouldLockOnResume(backgroundAt: number | null, now: number, threshold = LOCK_AFTER_BACKGROUND_MS): boolean {
  if (backgroundAt === null || !Number.isFinite(backgroundAt)) return false;
  const elapsed = now - backgroundAt;
  return elapsed < 0 || elapsed >= threshold;
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

// ── Biométrie (plugin @aparajita/capacitor-biometric-auth) ─────────────────

export interface BiometricPlugin {
  checkBiometry(): Promise<{ isAvailable: boolean; deviceIsSecure: boolean; biometryType: number; code?: string }>;
  internalAuthenticate(o: Record<string, unknown>): Promise<void>;
}

export function biometric(): BiometricPlugin | null {
  return nativePlugin<BiometricPlugin>(NATIVE_PLUGINS.biometric);
}

export interface BiometryAvailability {
  available: boolean;
  deviceSecure: boolean;
  type: number | null;
  /** Lot 113J : raison d'indisponibilité du plugin (`biometryNotAvailable`, `biometryNotEnrolled`…), sinon null. */
  code?: string | null;
}

export async function biometryAvailability(): Promise<BiometryAvailability> {
  const b = biometric();
  if (!b) return { available: false, deviceSecure: false, type: null };
  try {
    const r = await b.checkBiometry();
    return {
      available: !!r.isAvailable,
      deviceSecure: !!r.deviceIsSecure,
      type: typeof r.biometryType === 'number' ? r.biometryType : null,
      code: typeof r.code === 'string' && r.code !== '' ? r.code : null,
    };
  } catch {
    return { available: false, deviceSecure: false, type: null };
  }
}

/** Nom affiché du capteur (`BiometryType` du plugin : 1 Touch ID, 2 Face ID, 3 empreinte, 4 visage, 5 iris). */
export function biometryLabel(type: number | null | undefined, platform: 'ios' | 'android' | null): string {
  switch (type) {
    case 1: return 'Touch ID';
    case 2: return 'Face ID';
    case 3: return 'l’empreinte digitale';
    case 4: return 'la reconnaissance du visage';
    case 5: return 'la reconnaissance de l’iris';
    default: return platform === 'ios' ? 'Face ID ou Touch ID' : 'la biométrie du téléphone';
  }
}

/**
 * Lot 107A — libellés courts des boutons et de la proposition :
 * « Face ID » / « Touch ID » sur iPhone, « la biométrie » sur Android (le
 * système choisit lui-même empreinte ou visage).
 */
export function biometryShortLabel(type: number | null | undefined, platform: 'ios' | 'android' | null): string {
  if (type === 2) return 'Face ID';
  if (type === 1) return 'Touch ID';
  return platform === 'ios' ? 'Face ID' : 'la biométrie';
}

/** Libellé du bouton de nouvelle tentative (pur, testé). */
export function retryLabel(type: number | null | undefined, platform: 'ios' | 'android' | null): string {
  const short = biometryShortLabel(type, platform);
  return short === 'la biométrie' ? 'Réessayer avec la biométrie' : `Réessayer ${short}`;
}

/**
 * Résultat détaillé d'une vérification locale (lot 107A) :
 *   ok           vérification réussie ;
 *   cancelled    annulée par l'utilisateur (« Annuler », bouton de repli) ;
 *   failed       visage / doigt non reconnu ;
 *   lockout      biométrie bloquée par le système après trop d'échecs ;
 *   interrupted  fenêtre fermée par le système (app quittée, appel…) ;
 *   unavailable  aucun moyen utilisable (biométrie / code absents).
 */
export type PromptOutcome = 'ok' | 'cancelled' | 'failed' | 'lockout' | 'interrupted' | 'unavailable';

/** Code d'erreur du plugin → résultat (pur, testé). Jamais de boucle : tout échec est final pour la tentative. */
export function promptOutcomeFromError(err: unknown): Exclude<PromptOutcome, 'ok'> {
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case 'userCancel':
    case 'userFallback':
      return 'cancelled';
    case 'biometryLockout':
      return 'lockout';
    case 'systemCancel':
    case 'appCancel':
    case 'notInteractive':
    case 'invalidContext':
      return 'interrupted';
    case 'biometryNotAvailable':
    case 'biometryNotEnrolled':
    case 'passcodeNotSet':
    case 'noDeviceCredential':
      return 'unavailable';
    default:
      return 'failed';
  }
}

/** Vérification locale détaillée (biométrie seule, ou biométrie / code du téléphone). */
export async function verifyUserDetailed(o: { biometryOnly: boolean; reason: string }): Promise<PromptOutcome> {
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
  } catch (err) {
    return promptOutcomeFromError(err);
  }
}

export type VerifyOutcome = 'ok' | 'cancelled' | 'unavailable';

/** Vérification locale de l'utilisateur (forme simple, lot 95). */
export async function verifyUser(o: { biometryOnly: boolean; reason: string }): Promise<VerifyOutcome> {
  const r = await verifyUserDetailed(o);
  return r === 'ok' || r === 'unavailable' ? r : 'cancelled';
}

export type UnlockPath = 'biometry' | 'device_credential' | 'full_sign_in';

/** Moyen de déverrouillage applicable (pur, testé). */
export function unlockPath(input: { biometricsEnabled: boolean; biometryAvailable: boolean; deviceSecure: boolean }): UnlockPath {
  if (input.biometricsEnabled && input.biometryAvailable) return 'biometry';
  if (UNLOCK_WITHOUT_BIOMETRICS === 'device_credential' && (input.deviceSecure || input.biometryAvailable)) return 'device_credential';
  return 'full_sign_in';
}
