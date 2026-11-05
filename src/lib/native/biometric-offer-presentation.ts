/**
 * Présentation de la proposition d'activation biométrique — lot 111G.
 *
 * Uniquement l'ICÔNE et les LIBELLÉS de la modale existante (lot 107A, #640) :
 * conditions d'affichage, mémorisation du choix et activation restent dans
 * `biometric-consent.ts` / `useBiometricOffer.ts`, inchangés.
 *
 * Quelle biométrie montrer ? (plugin @aparajita/capacitor-biometric-auth,
 * `checkBiometry()`, déjà présent dans les binaires actuels)
 *   · iOS : `biometryType` = `LAContext.biometryType` (1 Touch ID, 2 Face ID)
 *     — c'est le capteur réel de l'iPhone, fiable.
 *   · Android : `biometryType` = PREMIER capteur matériel déclaré
 *     (empreinte, puis visage, puis iris) et `biometryTypes` = tous les
 *     capteurs matériels — PAS ce que l'utilisateur a enregistré. Un seul
 *     capteur + biométrie disponible ⇒ c'est forcément celui-là ; plusieurs
 *     capteurs (ou liste inconnue) ⇒ symbole et textes GÉNÉRIQUES.
 *   · Information absente ou inattendue ⇒ générique, jamais « Face ID ».
 * Aucun texte ne promet une connexion au serveur par la biométrie : elle
 * déverrouille seulement l'application sur cet appareil.
 */
import { NATIVE_PLUGINS, nativePlugin } from './bridge';

/** `BiometryType` du plugin. */
const BIOMETRY = { touchId: 1, faceId: 2, fingerprint: 3, face: 4, iris: 5 } as const;

export type BiometricOfferKind = 'face-id' | 'touch-id' | 'fingerprint' | 'face' | 'iris' | 'generic';

/**
 * Type à présenter (pur, testé) : `type` tel que lu par le réglage existant,
 * affiné par la liste des capteurs sur Android. `null` = générique.
 */
export function presentationBiometryType(
  platform: 'ios' | 'android' | null,
  type: number | null | undefined,
  types: readonly number[] | null | undefined,
): number | null {
  if (typeof type !== 'number') return null;
  if (platform === 'ios') return type === BIOMETRY.touchId || type === BIOMETRY.faceId ? type : null;
  if (platform === 'android') {
    if (type !== BIOMETRY.fingerprint && type !== BIOMETRY.face && type !== BIOMETRY.iris) return null;
    const distinct = types ? [...new Set(types.filter((t) => t > 0))] : null;
    return distinct && distinct.length === 1 && distinct[0] === type ? type : null;
  }
  return null;
}

/** Nature de l'icône et des libellés (pur, testé). */
export function biometricOfferKind(platform: 'ios' | 'android' | null, type: number | null | undefined): BiometricOfferKind {
  if (platform === 'ios') {
    if (type === BIOMETRY.faceId) return 'face-id';
    if (type === BIOMETRY.touchId) return 'touch-id';
    return 'generic';
  }
  if (platform === 'android') {
    if (type === BIOMETRY.fingerprint) return 'fingerprint';
    if (type === BIOMETRY.face) return 'face';
    if (type === BIOMETRY.iris) return 'iris';
  }
  return 'generic';
}

export interface BiometricOfferTexts {
  title: string;
  description: string;
  activate: string;
  later: string;
}

export const BIOMETRIC_OFFER_LEAD = 'Déverrouillez Verebona plus rapidement sur cet appareil.';
export const BIOMETRIC_OFFER_LATER = 'Plus tard';
/** Rappel discret : le choix reste modifiable (réglage existant). */
export const BIOMETRIC_OFFER_SETTINGS_NOTE = 'Vous pourrez changer ce choix dans Mon compte › Sécurité.';

/** Titres : espace insécable avant « ? » (jamais de « ? » seul en début de ligne). */
const TEXTS: Record<BiometricOfferKind, { title: string; activate: string }> = {
  'face-id': { title: 'Activer Face ID\u00a0?', activate: 'Activer Face ID' },
  'touch-id': { title: 'Activer Touch ID\u00a0?', activate: 'Activer Touch ID' },
  fingerprint: { title: 'Activer le déverrouillage par empreinte\u00a0?', activate: 'Activer l’empreinte digitale' },
  face: { title: 'Activer le déverrouillage par le visage\u00a0?', activate: 'Activer la reconnaissance du visage' },
  iris: { title: 'Activer le déverrouillage par l’iris\u00a0?', activate: 'Activer la reconnaissance de l’iris' },
  generic: { title: 'Activer le déverrouillage biométrique\u00a0?', activate: 'Activer la biométrie' },
};

/** Libellés de la modale (pur, testé). */
export function biometricOfferTexts(kind: BiometricOfferKind): BiometricOfferTexts {
  return { ...TEXTS[kind], description: BIOMETRIC_OFFER_LEAD, later: BIOMETRIC_OFFER_LATER };
}

interface TypesPlugin { checkBiometry(): Promise<{ biometryTypes?: unknown }> }

/**
 * Liste des capteurs matériels (`biometryTypes`), ou null (plugin absent,
 * erreur, réponse inattendue). Lecture seule, aucune invite système.
 */
export async function readBiometryTypes(): Promise<number[] | null> {
  const p = nativePlugin<TypesPlugin>(NATIVE_PLUGINS.biometric);
  if (!p || typeof p.checkBiometry !== 'function') return null;
  try {
    const { biometryTypes } = await p.checkBiometry();
    if (!Array.isArray(biometryTypes)) return null;
    return biometryTypes.filter((t): t is number => typeof t === 'number');
  } catch {
    return null;
  }
}
