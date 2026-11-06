/**
 * Invitation « Autoriser les notifications » à la première connexion — lot 109G.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÈGLES
 *
 *   · Socle push INCHANGÉ (`lib/native/push`) : `nativePushPermission`,
 *     `requestNativePush` / `enableNativePush`, `syncNativePush`, feature flag
 *     serveur `push`. Aucun Web Push, aucune demande avant authentification.
 *   · Proposée UNE fois par compte ET par installation quand la permission du
 *     téléphone est encore indéterminée (`prompt`) : première session de ce
 *     compte sur l'installation, ou compte déjà connecté au déploiement du
 *     lot 109G. Un autre compte sur le même téléphone a sa propre décision.
 *   · Affichée seulement sur un écran utilisable de l'app (mêmes écrans que
 *     la proposition biométrique), jamais pendant la réacceptation des CGUV,
 *     le verrou, un écran bloquant (mise à jour, environnement, commerce) ni
 *     hors ligne.
 *   · UNE invitation à la fois, BIOMÉTRIE D'ABORD (lot 111T, remplace la
 *     priorité push du lot 109G) : tant que l'étape biométrique n'est pas
 *     terminée (`held`, voir `biometric-offer-flow`), l'invitation attend ;
 *     elle est présentée ensuite dans la MÊME session, sans relancement.
 *   · Notée une fois RÉELLEMENT affichée (`presented` → `offered`) : jamais de
 *     boucle, même si l'app est fermée sans réponse, mais une ouverture
 *     interrompue avant l'affichage ne fait pas perdre l'invitation ;
 *     « Plus tard » → `later` ; réponse → `answered`.
 *     La demande système n'est faite que sur « Autoriser les notifications ».
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
import {
  nativePushPermission, requestNativePush, type NativePushRequest, type NativePushState,
} from './push';
import type { NativePlatform } from './bridge';

// ── Textes (ticket 109G, exacts) ────────────────────────────────────────────

export const PUSH_ONBOARDING_TITLE = 'Autoriser les notifications ?';
export const PUSH_ONBOARDING_TEXT =
  'Recevez vos rappels d’échéances et les informations utiles de Verebona sur ce téléphone. Vous pourrez choisir les notifications reçues dans Mon compte.';
export const PUSH_ONBOARDING_ALLOW = 'Autoriser les notifications';
export const PUSH_ONBOARDING_LATER = 'Plus tard';

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

/** Faut-il inviter ce compte ? Seulement permission indéterminée ET jamais proposé ici. */
export function pushOnboardingDecision(i: { permission: NativePushState; record: PushOnboardingRecord | null }): 'offer' | 'none' {
  return i.permission === 'prompt' && !i.record ? 'offer' : 'none';
}

export interface PushOnboardingContext {
  /** Compte de la session AUTHENTIFIÉE, sinon null. */
  userId: number | null;
  /** Feature flag serveur `push` (configuration non lue : actif). */
  featureOn: boolean;
  pathname: string | null | undefined;
  /** CGUV à réaccepter (écran obligatoire). */
  legalRequired: boolean;
  /** Verrou, mise à jour requise, environnement, page commerciale. */
  blocked: boolean;
  offline: boolean;
  /** Lot 111T : l'étape biométrique n'est pas terminée (évaluation, fenêtre, transition). */
  held: boolean;
}

/** Écran utilisable pour une invitation (pur, testé). */
export function pushOnboardingScreenAllowed(c: Pick<PushOnboardingContext, 'pathname' | 'legalRequired' | 'blocked' | 'offline'>): boolean {
  return !c.legalRequired && !c.blocked && !c.offline && isBiometricOfferPath(c.pathname);
}

// ── Parcours (contrôleur sans React, utilisé par `usePushOnboarding`) ──────

type Decision = 'pending' | 'offer' | 'none';

export interface PushOnboardingSnapshot {
  decisions: Readonly<Record<number, Decision>>;
  /** Compte dont l'invitation est présentée, ou null. */
  shown: number | null;
  /** L'invitation de `shown` a été réellement affichée (et notée). */
  presented: boolean;
  busy: boolean;
}

export interface PushOnboardingView {
  visible: boolean;
  busy: boolean;
}

export interface PushOnboardingDeps {
  permission: () => Promise<NativePushState>;
  read: (userId: number) => Promise<PushOnboardingRecord | null>;
  record: (userId: number, s: PushOnboardingStored, r?: NativePushState) => Promise<boolean>;
  request: () => Promise<NativePushRequest>;
}

const defaultDeps: PushOnboardingDeps = {
  permission: nativePushPermission,
  read: readPushOnboarding,
  record: recordPushOnboarding,
  request: requestNativePush,
};

/** Vue dérivée (pure, testée). */
export function pushOnboardingView(s: PushOnboardingSnapshot, c: PushOnboardingContext): PushOnboardingView {
  const u = c.userId;
  if (u === null || !c.featureOn) return { visible: false, busy: s.busy };
  return { visible: s.shown === u && pushOnboardingScreenAllowed(c) && !c.held, busy: s.busy };
}

export function createPushOnboarding(deps: PushOnboardingDeps = defaultDeps) {
  let snap: PushOnboardingSnapshot = { decisions: {}, shown: null, presented: false, busy: false };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<PushOnboardingSnapshot>) => {
    snap = { ...snap, ...patch };
    listeners.forEach((l) => l());
  };
  const decide = (userId: number, d: Decision) => set({ decisions: { ...snap.decisions, [userId]: d } });

  return {
    getSnapshot: () => snap,
    subscribe(l: () => void): () => void {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },

    /** Lecture de la permission OS et de la décision du compte — une fois par compte et par lancement. */
    async evaluate(userId: number): Promise<Decision> {
      if (snap.decisions[userId] !== undefined) return snap.decisions[userId];
      decide(userId, 'pending');
      let d: Decision = 'none';
      try {
        const [permission, record] = await Promise.all([deps.permission(), deps.read(userId)]);
        d = pushOnboardingDecision({ permission, record });
      } catch {
        d = 'none';
      }
      decide(userId, d);
      return d;
    },

    /**
     * Présente l'invitation si tout le permet (étape biométrique terminée).
     * Retire l'invitation d'un autre compte (changement de compte) ; jamais
     * affichée, elle reste due à ce compte.
     */
    sync(c: PushOnboardingContext): void {
      // Session momentanément indisponible (userId null) : masquée seulement, pas perdue.
      const prev = snap.shown;
      if (prev !== null && c.userId !== null && prev !== c.userId && !snap.busy) {
        const wasPresented = snap.presented;
        set({ shown: null, presented: false });
        if (!wasPresented) decide(prev, 'offer');
      }
      const u = c.userId;
      if (u === null || !c.featureOn || snap.shown !== null) return;
      if (snap.decisions[u] !== 'offer' || c.held || !pushOnboardingScreenAllowed(c)) return;
      decide(u, 'none'); // jamais reproposée pendant ce lancement
      set({ shown: u, presented: false });
    },

    /** Fenêtre réellement affichée : invitation notée (une fois). */
    presented(userId: number): void {
      if (snap.shown !== userId || snap.presented) return;
      set({ presented: true });
      void deps.record(userId, 'offered');
    },

    /** « Autoriser les notifications » : une seule demande système, issue réelle. */
    async allow(): Promise<NativePushRequest | null> {
      const u = snap.shown;
      if (u === null || snap.busy) return null;
      set({ busy: true });
      let r: NativePushRequest = { state: 'unavailable', registered: false };
      try {
        r = await deps.request();
      } finally {
        await deps.record(u, 'answered', r.state).catch(() => false);
        set({ busy: false, shown: snap.shown === u ? null : snap.shown, presented: false });
      }
      return r;
    },

    /** « Plus tard » : aucune demande système, mémorisé pour ce compte sur cette installation. */
    later(): void {
      const u = snap.shown;
      if (u === null || snap.busy) return;
      set({ shown: null, presented: false });
      void deps.record(u, 'later');
    },
  };
}

export type PushOnboardingController = ReturnType<typeof createPushOnboarding>;

let shared: PushOnboardingController | null = null;

/** Contrôleur unique du lancement (l'hôte natif n'est monté qu'une fois). */
export function sharedPushOnboarding(): PushOnboardingController {
  if (!shared) shared = createPushOnboarding();
  return shared;
}
