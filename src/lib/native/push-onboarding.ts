/**
 * Notifications à la première connexion — lot 109G, revu au lot 113J.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LOT 113J (décision PO du 06/11/2026) : plus AUCUNE fenêtre Verebona
 * « Autoriser les notifications ? » (PushOnboardingCard et son contrôleur
 * supprimés, textes de la fenêtre retirés). La demande NATIVE du téléphone est
 * lancée directement, APRÈS l'étape biométrique : `native-permissions-flow`.
 * Ce module ne garde que :
 *
 *   · la MÉMORISATION par compte ET par installation (« proposé » noté au
 *     déclenchement natif, « répondu » avec l'issue système ; « Plus tard »
 *     n'est plus produit mais reste lu : décision antérieure respectée) ;
 *   · la DÉCISION pure : demande native seulement si la permission du
 *     téléphone est indéterminée (`prompt`) ET rien n'est noté ici ;
 *   · les textes de Mon compte › Notifications (état de ce téléphone,
 *     réactivation après refus, issue d'une demande volontaire).
 *
 * Socle push INCHANGÉ (`lib/native/push`). Aucun Web Push.
 *
 * STOCKAGE : stockage sécurisé de l'app (purgé à la réinstallation), lié à
 * l'identifiant d'installation ; repli `localStorage` si le stockage sécurisé
 * est indisponible. L'ancienne clé GLOBALE `verebona:native:push-prompt-dismissed`
 * (lot 95) n'est plus lue : non attribuable à un compte, elle est effacée.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { isBiometricOfferPath } from './biometric-consent';
import { initInstallationId } from './shell-info';
import { SECURE_KEYS, secureGet, secureSet } from './secure-store';
import type { NativePushRequest, NativePushState } from './push';
import type { NativePlatform } from './bridge';

// ── Textes (ticket 109G, exacts) ────────────────────────────────────────────
// Lot 113J : titre, texte et « Plus tard » de l'ancienne fenêtre supprimés ;
// seul le libellé du bouton de Mon compte › Notifications reste.

export const PUSH_ONBOARDING_ALLOW = 'Autoriser les notifications';

/** Comment réactiver après un refus, selon le système (pur, testé). */
export function pushReenableHelp(platform: NativePlatform | null): string {
  if (platform === 'android') {
    return 'Les notifications de Verebona sont bloquées sur ce téléphone. Pour les réactiver : ouvrez Paramètres › Applications › Verebona › Notifications, puis activez « Autoriser les notifications » (les intitulés peuvent varier selon le téléphone).';
  }
  return 'Les notifications de Verebona sont bloquées sur ce téléphone. Pour les réactiver : ouvrez Réglages › Verebona › Notifications, puis activez « Autoriser les notifications ».';
}

/** Message après la réponse à la demande (pur, testé). Jamais « activé » sans jeton enregistré. */
export function pushRequestOutcomeMessage(r: NativePushRequest, platform: NativePlatform | null): { kind: 'success' | 'info' | 'error'; text: string } {
  if (r.state === 'granted' && r.registered) return { kind: 'success', text: 'Notifications activées sur ce téléphone.' };
  if (r.state === 'granted') {
    return { kind: 'error', text: 'Autorisation accordée, mais ce téléphone n’a pas pu être enregistré. Réessayez depuis Mon compte › Notifications.' };
  }
  if (r.state === 'denied') return { kind: 'info', text: pushReenableHelp(platform) };
  if (r.state === 'prompt') return { kind: 'info', text: 'Rien n’a été activé. Vous pourrez le faire dans Mon compte › Notifications.' };
  return { kind: 'error', text: 'Les notifications ne sont pas disponibles dans cette version de l’application.' };
}

/** État de l'autorisation de CE téléphone (Mon compte › Notifications). */
export type DevicePushStatus =
  | { kind: 'loading' }
  | { kind: 'off' }
  | { kind: 'unavailable' }
  | { kind: 'prompt' }
  | { kind: 'denied' }
  | { kind: 'granted'; registered: boolean };

/** Texte d'état (pur, testé). */
export function devicePushStatusText(s: DevicePushStatus, platform: NativePlatform | null): string {
  switch (s.kind) {
    case 'loading': return 'Vérification de l’autorisation de ce téléphone…';
    case 'off': return 'Les notifications de l’application sont momentanément indisponibles. Vos préférences sont conservées.';
    case 'unavailable': return 'Les notifications ne sont pas disponibles dans cette version de l’application.';
    case 'prompt': return 'Les notifications ne sont pas encore autorisées sur ce téléphone.';
    case 'denied': return pushReenableHelp(platform);
    case 'granted': return s.registered
      ? 'Les notifications sont autorisées sur ce téléphone.'
      : 'Les notifications sont autorisées, mais ce téléphone n’a pas pu être enregistré.';
  }
}

// ── Stockage par compte × installation ─────────────────────────────────────

export type PushOnboardingStored = 'offered' | 'later' | 'answered';

export interface PushOnboardingRecord {
  s: PushOnboardingStored;
  at: string;
  /** Réponse du système, pour diagnostic local (`answered`). */
  r?: NativePushState;
}

interface PushOnboardingDoc { v: 1; inst: string | null; users: Record<string, PushOnboardingRecord> }

/** Ancienne clé globale du lot 95 (tous comptes confondus) — effacée, plus lue. */
export const LEGACY_PUSH_PROMPT_DISMISSED_KEY = 'verebona:native:push-prompt-dismissed';
/** Repli si le stockage sécurisé est indisponible. */
export const PUSH_ONBOARDING_LOCAL_KEY = 'verebona:native:push-onboarding';

function isRecord(v: unknown): v is PushOnboardingRecord {
  const r = v as PushOnboardingRecord | null;
  return !!r && typeof r === 'object' && (r.s === 'offered' || r.s === 'later' || r.s === 'answered');
}

/**
 * Lecture tolérante. Un document d'une AUTRE installation (identifiant
 * différent) est ignoré : rien n'est hérité. Pur, testé.
 */
export function parsePushOnboardingDoc(raw: string | null, installationId: string | null): PushOnboardingDoc {
  const empty: PushOnboardingDoc = { v: 1, inst: installationId, users: {} };
  if (!raw) return empty;
  try {
    const d = JSON.parse(raw) as Partial<PushOnboardingDoc>;
    if (!d || d.v !== 1 || typeof d.users !== 'object' || d.users === null) return empty;
    if (installationId && d.inst && d.inst !== installationId) return empty;
    const users: Record<string, PushOnboardingRecord> = {};
    for (const [k, r] of Object.entries(d.users)) if (/^\d+$/.test(k) && isRecord(r)) users[k] = r;
    return { v: 1, inst: installationId ?? d.inst ?? null, users };
  } catch {
    return empty;
  }
}

function localGet(key: string): string | null {
  try { return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null; } catch { return null; }
}
function localSet(key: string, v: string): boolean {
  try { if (typeof localStorage === 'undefined') return false; localStorage.setItem(key, v); return true; } catch { return false; }
}
function localRemove(key: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(key); } catch { /* sans stockage */ }
}

async function readDoc(): Promise<PushOnboardingDoc> {
  const inst = await initInstallationId();
  const raw = (await secureGet(SECURE_KEYS.pushOnboarding)) ?? localGet(PUSH_ONBOARDING_LOCAL_KEY);
  return parsePushOnboardingDoc(raw, inst);
}

let queue: Promise<unknown> = Promise.resolve();

function userKey(userId: number): string {
  return String(Math.trunc(userId));
}

/** Décision enregistrée de ce compte sur cette installation, ou null (jamais proposée). */
export async function readPushOnboarding(userId: number): Promise<PushOnboardingRecord | null> {
  await queue.catch(() => undefined);
  return (await readDoc()).users[userKey(userId)] ?? null;
}

/** Enregistre la décision (écritures en file, jamais d'écrasement concurrent). */
export function recordPushOnboarding(userId: number, s: PushOnboardingStored, r?: NativePushState): Promise<boolean> {
  const run = queue.then(async () => {
    const doc = await readDoc();
    const rec: PushOnboardingRecord = { s, at: new Date().toISOString(), ...(r ? { r } : {}) };
    const next: PushOnboardingDoc = { ...doc, users: { ...doc.users, [userKey(userId)]: rec } };
    const raw = JSON.stringify(next);
    if (await secureSet(SECURE_KEYS.pushOnboarding, raw)) return true;
    return localSet(PUSH_ONBOARDING_LOCAL_KEY, raw);
  });
  queue = run.catch(() => undefined);
  return run.catch(() => false);
}

/** Lot 109G : l'ancienne décision globale n'est plus lue (comptes existants repris). */
export function clearLegacyPushPromptKey(): void {
  localRemove(LEGACY_PUSH_PROMPT_DISMISSED_KEY);
}

// ── Décisions (pures, testées) ─────────────────────────────────────────────

/** Faut-il faire la demande native pour ce compte ? Seulement permission indéterminée ET rien de noté ici. */
export function pushOnboardingDecision(i: { permission: NativePushState; record: PushOnboardingRecord | null }): 'offer' | 'none' {
  return i.permission === 'prompt' && !i.record ? 'offer' : 'none';
}

/** Écran utilisable pour une demande native de notifications (pur, testé). */
export function pushOnboardingScreenAllowed(c: { pathname: string | null | undefined; legalRequired: boolean; blocked: boolean; offline: boolean }): boolean {
  return !c.legalRequired && !c.blocked && !c.offline && isBiometricOfferPath(c.pathname);
}
