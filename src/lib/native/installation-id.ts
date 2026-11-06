/**
 * Identifiant d'installation de l'app native — lot 112E (suite du constat
 * 111D : « `initInstallationId` lit aussi le Keychain ; si la vue est
 * rechargée téléphone verrouillé, il peut tirer un nouvel identifiant »).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLE : UN IDENTIFIANT N'EST JAMAIS RÉGÉNÉRÉ PARCE QUE LE STOCKAGE SÉCURISÉ
 * EST MOMENTANÉMENT ILLISIBLE.
 *
 * Avant 112E, une lecture « vide » suffisait pour tirer un nouvel identifiant
 * (et, marqueur local absent, pour PURGER tout le stockage sécurisé). Or :
 *   · iOS, téléphone verrouillé : le Keychain (classe
 *     `whenUnlockedThisDeviceOnly`) répond `errSecInteractionNotAllowed`
 *     (-25308) ; le plugin npm le rend comme « absent » ;
 *   · Android : une erreur passagère du Keystore rejette la lecture ; l'ancien
 *     `secureGet` la rendait aussi comme « absent ».
 * La vue peut être (re)chargée app en arrière-plan, téléphone verrouillé
 * (vue recréée par iOS après fermeture du processus web, réveil par une
 * notification…) : d'où un nouvel identifiant, donc un « nouvel appareil »
 * côté serveur (ligne `mobile_push_installations` de plus, invitation push
 * reproposée, jetons d'import 110A rattachés à l'ancien identifiant).
 *
 * DÉCISION (pure, `decideInstallationId`) :
 *   use     valeur lue et valide, installation déjà initialisée ;
 *   create  certitude que la valeur n'existe pas (ou réinstallation, AUTH-13 :
 *           marqueur local absent → purge puis nouvel identifiant) ;
 *   defer   illisible POUR L'INSTANT : rien n'est créé, rien n'est purgé, le
 *           marqueur n'est pas posé ; nouvelle tentative au retour au premier
 *           plan / au déverrouillage (`shell-info.ts`).
 *
 * CERTITUDE « ABSENT » :
 *   · binaire 112E+ sur iOS : sonde native `VerebonaSecureStoreStatus` (code
 *     du Keychain + `isProtectedDataAvailable`) ;
 *   · Android : le plugin rejette toute erreur du Keystore (`ok: false`) ;
 *     une réponse « vide » est donc un vrai « absent » ;
 *   · binaire iOS antérieur (pas de sonde) : seulement app AU PREMIER PLAN
 *     (`App.getState().isActive` — un appareil verrouillé n'a pas d'app au
 *     premier plan), et seconde lecture de confirmation avant de créer.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { SecureProbe, SecureReadFailure } from './secure-store';

/** Format accepté (identique au serveur, `lib/mobile/client-context.ts`). */
export const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Binaire sans sonde : délai avant la seconde lecture qui confirme « absent ». */
export const INSTALLATION_CONFIRM_REREAD_MS = 1_500;

/** Erreur passagère du stockage au premier plan : nouvelle tentative différée. */
export const INSTALLATION_RETRY_AFTER_ERROR_MS = 30_000;

export interface InstallationRead {
  ok: boolean;
  value: string | null;
  failure?: SecureReadFailure;
  probe?: SecureProbe | null;
}

export type InstallationDeferReason = 'locked' | 'storage_error' | 'background';

export type InstallationDecision =
  | { action: 'use'; id: string }
  | { action: 'create'; purge: boolean; confirm: boolean; persist: boolean }
  | { action: 'defer'; reason: InstallationDeferReason };

export interface InstallationDecisionInput {
  /** Marqueur local « installation initialisée » (AUTH-13). */
  marker: boolean;
  read: InstallationRead;
  /** App au premier plan (`App.getState`), ou null si inconnu (plugin absent). */
  foreground: boolean | null;
}

/** Décision pure (testée) : jamais `create` sur une lecture incertaine. */
export function decideInstallationId(input: InstallationDecisionInput): InstallationDecision {
  const { marker, read, foreground } = input;
  // Aucun stockage sécurisé embarqué (cas théorique, tous les binaires depuis
  // le lot 95 l'ont) : identifiant de session de l'app, rien à protéger.
  if (read.failure === 'no_plugin') return { action: 'create', purge: false, confirm: false, persist: false };
  if (!read.ok) return { action: 'defer', reason: read.failure === 'locked' ? 'locked' : 'storage_error' };
  const valid = read.value !== null && INSTALLATION_ID_PATTERN.test(read.value);
  if (marker && valid) return { action: 'use', id: read.value as string };
  // Lecture probante : une valeur a été lue (stockage déverrouillé), ou la
  // sonde native a confirmé « absent » appareil déverrouillé.
  const proven = read.value !== null || read.probe?.status === 'absent';
  if (!proven && foreground === false) return { action: 'defer', reason: 'background' };
  if (!marker) return { action: 'create', purge: true, confirm: false, persist: true };
  // Marqueur présent, valeur absente ou abîmée : seconde lecture si rien ne
  // l'a prouvé (binaire iOS sans sonde).
  return { action: 'create', purge: false, confirm: !proven, persist: true };
}

export type InstallationOutcome =
  | { kind: 'ready'; id: string; created: boolean; purged: boolean; persisted: boolean }
  | { kind: 'deferred'; reason: InstallationDeferReason };

export interface InstallationDeps {
  readMarker(): boolean;
  writeMarker(): void;
  read(): Promise<InstallationRead>;
  foreground(): Promise<boolean | null>;
  clearAll(): Promise<void>;
  write(id: string): Promise<boolean>;
  newId(): string;
  sleep(ms: number): Promise<void>;
  journal?(outcome: string, detail: Record<string, unknown>): void;
}

function probeDetail(read: InstallationRead): Record<string, unknown> {
  return {
    osStatus: read.probe?.osStatus ?? null,
    protectedData: read.probe?.protectedDataAvailable ?? null,
    readError: read.failure ?? null,
  };
}

/**
 * Charge, crée ou DIFFÈRE l'identifiant (dépendances injectées, testé).
 * Ne lève jamais.
 */
export async function resolveInstallationId(deps: InstallationDeps): Promise<InstallationOutcome> {
  const marker = deps.readMarker();
  let read = await deps.read();
  let foreground = await deps.foreground();
  let decision = decideInstallationId({ marker, read, foreground });

  if (decision.action === 'create' && decision.confirm) {
    await deps.sleep(INSTALLATION_CONFIRM_REREAD_MS);
    read = await deps.read();
    foreground = await deps.foreground();
    const again = decideInstallationId({ marker, read, foreground });
    // Seconde lecture toujours vide, toujours au premier plan : on crée.
    decision = again.action === 'create' ? { ...again, confirm: false } : again;
  }

  if (decision.action === 'defer') {
    deps.journal?.('deferred', { reason: decision.reason, foreground, ...probeDetail(read) });
    return { kind: 'deferred', reason: decision.reason };
  }
  if (decision.action === 'use') {
    deps.writeMarker();
    deps.journal?.('loaded', { foreground });
    return { kind: 'ready', id: decision.id, created: false, purged: false, persisted: true };
  }
  // Première ouverture après (ré)installation : rien n'est hérité (AUTH-13).
  if (decision.purge) await deps.clearAll();
  const id = deps.newId();
  const persisted = decision.persist ? await deps.write(id) : false;
  deps.writeMarker();
  deps.journal?.(decision.purge ? 'created_reinstall' : 'created', {
    foreground, reason: persisted ? null : 'write_failed', ...probeDetail(read),
  });
  return { kind: 'ready', id, created: true, purged: decision.purge, persisted };
}
