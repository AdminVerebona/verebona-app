/**
 * Déverrouillage biométrique PAR APPAREIL ET PAR COMPTE — lot 107A (tickets
 * « Proposition d'activation biométrique » #640 et « Face ID automatique »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUE C'EST — ET CE QUE CE N'EST PAS
 *
 *   · Un CHOIX enregistré sur ce téléphone (Keychain iOS « cet appareil
 *     seulement » / valeur chiffrée par le Keystore Android), une entrée par
 *     identité Verebona (`user.id`) : aucun choix ne passe d'un compte à
 *     l'autre (Duo : deux identités, deux choix).
 *   · Il permet seulement de DÉVERROUILLER localement une session serveur
 *     encore valide. Il ne contient aucun mot de passe, aucun jeton, aucune
 *     donnée biométrique ; il ne crée ni ne prolonge jamais une session ; il
 *     ne remplace pas la confirmation d'identité de 5 minutes exigée par le
 *     serveur pour les opérations sensibles. Ce n'est PAS une double
 *     authentification et l'interface ne le présente jamais comme telle.
 *
 * ÉTATS (§ « Réglage et états à gérer » du ticket #640)
 *   never        jamais proposé sur cet appareil pour ce compte (aucune entrée) ;
 *   deferred     proposé puis « Plus tard », refusé, désactivé, ou après une
 *                déconnexion volontaire — jamais reproposé automatiquement ;
 *   active       activé après une vérification biométrique RÉUSSIE ;
 *   reactivate   suspendu : l'enrôlement du téléphone a changé (visage / doigt
 *                ajouté, biométrie réinitialisée) — à réactiver dans Mon compte ;
 *   unavailable  (calculé) biométrie absente, non configurée ou non prise en
 *                charge sur ce téléphone, ou fonction coupée par le serveur.
 *
 * INVALIDATION : à l'activation, l'app mémorise une empreinte opaque de
 * l'enrôlement biométrique (plugin local `VerebonaBiometricState` : condensé
 * de `evaluatedPolicyDomainState` sur iOS, génération d'une clé Keystore
 * invalidée à l'enrôlement sur Android). Si elle change, l'option passe à
 * « à réactiver ». Binaire antérieur sans ce plugin : contrôle non fait,
 * empreinte adoptée à la première lecture possible.
 * Réinstallation : tout le stockage sécurisé est purgé (shell-info, AUTH-13).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { NATIVE_PLUGINS, isNativeApp, nativePlugin } from './bridge';
import { SECURE_KEYS, secureGet, secureRead, secureRemove, secureSet } from './secure-store';
import { biometryAvailability, biometryLabel, biometryShortLabel, verifyUserDetailed, type PromptOutcome } from './app-lock';

export type BiometricStoredState = 'deferred' | 'active' | 'reactivate';
export type BiometricState = 'never' | BiometricStoredState | 'unavailable';
export type DeferReason = 'offered' | 'later' | 'refused' | 'disabled' | 'signed_out';

interface UserRecord {
  s: BiometricStoredState;
  /** Date ISO de la dernière modification (diagnostic local). */
  at: string;
  why?: DeferReason | 'enrollment_changed' | 'migrated';
  /** Empreinte opaque de l'enrôlement au moment de l'activation (aucune donnée biométrique). */
  tok?: string | null;
}

interface BiometricDoc { v: 1; users: Record<string, UserRecord> }

const EMPTY_DOC: BiometricDoc = { v: 1, users: {} };

function isRecord(v: unknown): v is UserRecord {
  const r = v as UserRecord | null;
  return !!r && typeof r === 'object' && (r.s === 'deferred' || r.s === 'active' || r.s === 'reactivate');
}

/** Lecture tolérante (valeur absente ou abîmée → document vide). Pur, testé. */
export function parseBiometricDoc(raw: string | null): BiometricDoc {
  if (!raw) return { v: 1, users: {} };
  try {
    const d = JSON.parse(raw) as Partial<BiometricDoc>;
    if (!d || d.v !== 1 || typeof d.users !== 'object' || d.users === null) return { v: 1, users: {} };
    const users: Record<string, UserRecord> = {};
    for (const [k, r] of Object.entries(d.users)) if (/^\d+$/.test(k) && isRecord(r)) users[k] = r;
    return { v: 1, users };
  } catch {
    return { ...EMPTY_DOC, users: {} };
  }
}

async function readDoc(): Promise<BiometricDoc> {
  return parseBiometricDoc(await secureGet(SECURE_KEYS.biometricsState));
}

/** Lot 111D : null si la lecture a ÉCHOUÉ (≠ document absent). */
async function readDocChecked(): Promise<BiometricDoc | null> {
  const r = await secureRead(SECURE_KEYS.biometricsState);
  return r.ok ? parseBiometricDoc(r.value) : null;
}

// Écritures en file : la proposition, le réglage et le verrou ne s'écrasent jamais.
let queue: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: (doc: BiometricDoc) => { doc: BiometricDoc | null; result: T }): Promise<{ ok: boolean; result: T }> {
  const run = queue.then(async () => {
    const current = await readDocChecked();
    // Lot 111D : lecture en échec → AUCUNE écriture (sinon les choix des autres
    // comptes, lus comme « vides », seraient écrasés).
    if (!current) return { ok: false, result: fn(parseBiometricDoc(null)).result };
    const { doc, result } = fn(current);
    if (!doc) return { ok: true, result };
    return { ok: await secureSet(SECURE_KEYS.biometricsState, JSON.stringify(doc)), result };
  });
  queue = run.catch(() => undefined);
  return run;
}

function key(userId: number): string {
  return String(Math.trunc(userId));
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Entrée du compte sur cet appareil. Reprise UNIQUE de l'ancienne préférence
 * d'appareil (lot 97B, déjà soumise à une vérification biométrique réussie)
 * au premier compte connecté qui la lit — choix documenté (biometrie-mobile.md).
 */
export async function readUserRecord(userId: number): Promise<UserRecord | null> {
  const legacy = await secureGet(SECURE_KEYS.biometricsEnabled);
  if (legacy !== null) {
    const { ok, result } = await mutate((doc) => {
      if (doc.users[key(userId)] || legacy !== '1') return { doc: null, result: doc.users[key(userId)] ?? null };
      const rec: UserRecord = { s: 'active', at: now(), why: 'migrated', tok: null };
      return { doc: { v: 1, users: { ...doc.users, [key(userId)]: rec } }, result: rec };
    });
    // Lot 111D : l'ancienne préférence n'est effacée qu'une fois reprise.
    if (ok) await secureRemove(SECURE_KEYS.biometricsEnabled);
    if (result) return result;
  }
  return (await readDoc()).users[key(userId)] ?? null;
}

interface EnrollmentPlugin { enrollmentToken(): Promise<{ token?: string | null }> }

/** Empreinte opaque de l'enrôlement, ou null (binaire sans plugin, biométrie forte absente). */
export async function enrollmentToken(): Promise<string | null> {
  const p = nativePlugin<EnrollmentPlugin>(NATIVE_PLUGINS.biometricState);
  if (!p || typeof p.enrollmentToken !== 'function') return null;
  try {
    const { token } = await p.enrollmentToken();
    return typeof token === 'string' && token !== '' ? token : null;
  } catch {
    return null;
  }
}

/** État affiché (pur, testé). */
export function effectiveBiometricState(
  record: Pick<UserRecord, 's'> | null,
  device: { supported: boolean; available: boolean },
  featureOn = true,
): BiometricState {
  if (!device.supported || !featureOn) return 'unavailable';
  if (record?.s === 'reactivate') return 'reactivate';
  if (!device.available) return 'unavailable';
  return record ? record.s : 'never';
}

export interface BiometricSetting {
  /** L'app peut-elle interroger le téléphone (plugin présent) ? */
  supported: boolean;
  /** Biométrie configurée et utilisable sur le téléphone, maintenant. */
  available: boolean;
  /** Code de verrouillage du téléphone défini. */
  deviceSecure: boolean;
  /** État de ce compte sur ce téléphone. */
  state: BiometricState;
  /** Choix enregistré (indépendamment de la disponibilité du capteur). */
  stored: BiometricStoredState | 'never';
  /** Raccourci : déverrouillage biométrique actif et utilisable. */
  enabled: boolean;
  /** Capteur, pour les phrases (« Face ID », « l’empreinte digitale »…). */
  label: string;
  /** Libellé court des boutons (« Face ID », « Touch ID », « la biométrie »). */
  shortLabel: string;
  /** `BiometryType` du plugin. */
  type: number | null;
}

/** État RÉEL : relu à chaque affichage (l'utilisateur a pu changer les réglages du téléphone). */
export async function readBiometricSetting(platform: 'ios' | 'android' | null, userId: number | null, featureOn = true): Promise<BiometricSetting> {
  const supported = nativePlugin(NATIVE_PLUGINS.biometric) !== null;
  const dev = await biometryAvailability();
  const record = supported && userId !== null ? await readUserRecord(userId) : null;
  const state = effectiveBiometricState(record, { supported, available: dev.available }, featureOn);
  return {
    supported,
    available: dev.available,
    deviceSecure: dev.deviceSecure,
    state,
    stored: record?.s ?? 'never',
    enabled: state === 'active',
    label: biometryLabel(dev.type, platform),
    shortLabel: biometryShortLabel(dev.type, platform),
    type: dev.type,
  };
}

export type BiometricsChange = 'enabled' | 'disabled' | 'refused' | 'unavailable' | 'storage_error';

/**
 * Active / désactive le déverrouillage biométrique du compte sur ce téléphone.
 * Activation : vérification biométrique RÉUSSIE exigée (refus / annulation →
 * rien ne change) ; le choix n'est enregistré qu'après ce succès.
 * Désactivation : immédiate, sans vérification. AUCUN appel serveur.
 */
export async function changeBiometrics(enabled: boolean, userId: number): Promise<BiometricsChange> {
  if (!enabled) {
    const { ok } = await mutate((doc) => ({
      doc: { v: 1, users: { ...doc.users, [key(userId)]: { s: 'deferred', at: now(), why: 'disabled' } } },
      result: null,
    }));
    return ok ? 'disabled' : 'storage_error';
  }
  const r: PromptOutcome = await verifyUserDetailed({ biometryOnly: true, reason: 'Activer le déverrouillage de Verebona' });
  if (r === 'unavailable') return 'unavailable';
  if (r !== 'ok') return 'refused';
  const tok = await enrollmentToken();
  const { ok } = await mutate((doc) => ({
    doc: { v: 1, users: { ...doc.users, [key(userId)]: { s: 'active', at: now(), tok } } },
    result: null,
  }));
  return ok ? 'enabled' : 'storage_error';
}

/**
 * Proposition affichée / « Plus tard » / refus : le compte passe à « reporté »
 * s'il n'avait encore aucun choix (jamais d'écrasement d'un choix actif).
 */
export async function deferBiometrics(userId: number, why: DeferReason): Promise<void> {
  await mutate((doc) => {
    const cur = doc.users[key(userId)];
    if (cur && (cur.s === 'active' || why === 'offered')) return { doc: null, result: null };
    return { doc: { v: 1, users: { ...doc.users, [key(userId)]: { s: cur?.s === 'reactivate' ? 'reactivate' : 'deferred', at: now(), why } } }, result: null };
  });
}

export interface UnlockBiometry {
  /** Déverrouillage biométrique actif ET utilisable maintenant pour ce compte. */
  active: boolean;
  /**
   * Lot 111D (journal technique) : choix enregistré tel que lu — jamais
   * proposé, reporté, actif, à réactiver, lecture en échec, compte inconnu.
   */
  stored?: BiometricStoredState | 'never' | 'read_failed' | 'no_user';
  /** Lot 111D : plugin local d'empreinte d'enrôlement présent dans ce binaire. */
  enrollmentPlugin?: boolean;
  /** Choix « actif » enregistré (même si le capteur est indisponible maintenant). */
  enabled: boolean;
  /** Suspendu parce que l'enrôlement a changé (persisté). */
  reactivate: boolean;
  available: boolean;
  deviceSecure: boolean;
  type: number | null;
}

/**
 * Moyen de déverrouillage du compte au moment du verrou : état enregistré,
 * capteur, et contrôle de l'enrôlement (changement → « à réactiver »).
 */
export async function resolveUnlockBiometry(userId: number | null, featureOn = true): Promise<UnlockBiometry> {
  const dev = await biometryAvailability();
  const enrollmentPlugin = nativePlugin(NATIVE_PLUGINS.biometricState) !== null;
  const base = { available: dev.available, deviceSecure: dev.deviceSecure, type: dev.type, enrollmentPlugin };
  if (userId === null) return { ...base, active: false, enabled: false, reactivate: false, stored: 'no_user' };
  // Lot 111D : un échec de lecture n'est pas « non activé » (jamais présenté comme un choix de l'utilisateur).
  if (!(await readDocChecked())) return { ...base, active: false, enabled: false, reactivate: false, stored: 'read_failed' };
  const record = await readUserRecord(userId);
  const stored = record?.s ?? 'never';
  const enabled = record?.s === 'active';
  if (record?.s === 'reactivate') return { ...base, active: false, enabled: false, reactivate: true, stored };
  if (!enabled || !dev.available || !featureOn) return { ...base, active: false, enabled, reactivate: false, stored };
  const cur = await enrollmentToken();
  if (cur && record.tok && cur !== record.tok) {
    await mutate((doc) => ({
      doc: { v: 1, users: { ...doc.users, [key(userId)]: { s: 'reactivate', at: now(), why: 'enrollment_changed' } } },
      result: null,
    }));
    return { ...base, active: false, enabled: false, reactivate: true, stored: 'reactivate' };
  }
  if (cur && !record.tok) {
    // Activé avec un binaire sans plugin d'empreinte : référence adoptée maintenant.
    await mutate((doc) => {
      const r = doc.users[key(userId)];
      if (r?.s !== 'active' || r.tok) return { doc: null, result: null };
      return { doc: { v: 1, users: { ...doc.users, [key(userId)]: { ...r, tok: cur } } }, result: null };
    });
  }
  return { ...base, active: true, enabled: true, reactivate: false, stored };
}

/**
 * Déconnexion VOLONTAIRE : plus aucune réouverture par biométrie sur cet
 * appareil — chaque choix actif repasse à « reporté » (jamais réactivé
 * automatiquement, jamais reproposé ; réactivation explicite dans Mon compte).
 */
export async function clearBiometricsOnSignOut(): Promise<void> {
  await secureRemove(SECURE_KEYS.biometricsEnabled);
  await mutate((doc) => {
    let changed = false;
    const users: Record<string, UserRecord> = {};
    for (const [k, r] of Object.entries(doc.users)) {
      if (r.s === 'active') { users[k] = { s: 'deferred', at: now(), why: 'signed_out' }; changed = true; } else users[k] = r;
    }
    return { doc: changed ? { v: 1, users } : null, result: null };
  });
}

/** Procédure de déconnexion (api-client) : nettoyage biométrique dans l'app seulement. */
export function nativeSignOutBiometrics(): (() => Promise<void>) | undefined {
  return isNativeApp() ? clearBiometricsOnSignOut : undefined;
}

// ── Proposition après la première connexion (#640) ─────────────────────────

/** Écrans où la proposition peut apparaître (jamais sur un écran de connexion, de consentement ou de suppression). */
export const BIOMETRIC_OFFER_PATH_PREFIXES: readonly string[] = [
  '/accueil', '/dashboard', '/assets', '/documents', '/agenda', '/fournisseurs', '/duos', '/mon-compte',
];

export function isBiometricOfferPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return BIOMETRIC_OFFER_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Proposer l'activation maintenant ? (pur, testé) */
export function shouldOfferBiometrics(i: {
  featureOn: boolean;
  sessionStatus: string;
  userId: number | null | undefined;
  pathname: string | null | undefined;
  /** CGUV à réaccepter (écran de consentement obligatoire). */
  legalRequired: boolean;
  /** Verrou affiché, ou écran bloquant (mise à jour requise, environnement, commerce). */
  blocked: boolean;
  setting: Pick<BiometricSetting, 'supported' | 'available' | 'state'> | null;
}): boolean {
  if (!i.featureOn || i.sessionStatus !== 'authenticated' || i.userId == null) return false;
  if (i.blocked || i.legalRequired || !isBiometricOfferPath(i.pathname)) return false;
  const s = i.setting;
  return !!s && s.supported && s.available && s.state === 'never';
}

/** Titre de la proposition, adapté au capteur (pur, testé). */
export function biometricOfferTitle(type: number | null | undefined): string {
  if (type === 2) return 'Activer Face ID pour les prochaines connexions ?';
  if (type === 1) return 'Activer Touch ID ?';
  return 'Activer la biométrie ?';
}

export const BIOMETRIC_OFFER_DESCRIPTION =
  'Déverrouillez Verebona plus rapidement sur cet appareil. Vous pourrez désactiver cette option dans Mon compte.';

/** Appareil partagé (#640) : la biométrie du téléphone ne prouve pas l'identité du titulaire du compte. */
export const BIOMETRIC_SHARED_DEVICE_NOTE =
  'Toute personne dont le visage ou l’empreinte est enregistré dans ce téléphone pourra ouvrir Verebona.';
