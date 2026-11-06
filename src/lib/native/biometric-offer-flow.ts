/**
 * Parcours de la proposition d'activation biométrique — lot 107A (#640),
 * orchestration revue au lot 111T (sans React, utilisé par `useBiometricOffer`).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ORDRE DE PREMIÈRE CONNEXION MOBILE (décision PO du 05/11/2026)
 *
 *   1. Biométrie D'ABORD : évaluée dès que la session est authentifiée sur un
 *      écran utilisable de l'app (jamais connexion, CGUV, verrou, écran
 *      bloquant), si la fonction est active et le choix jamais fait pour ce
 *      compte sur ce téléphone (`shouldOfferBiometrics`, inchangé).
 *   2. Notifications ENSUITE, dans la même session : `holdsPush` reste vrai
 *      tant que l'étape biométrique n'est pas terminée (évaluation en cours,
 *      fenêtre affichée — y compris pendant la fenêtre native Face ID —, puis
 *      un court temps de transition après sa fermeture). Étape sans objet
 *      (biométrie absente, choix déjà fait, fonction coupée, lecture en
 *      échec) : terminée aussitôt, les notifications ne sont jamais bloquées.
 *
 * MÉMORISATION (états existants de `biometric-consent`, aucun stockage neuf)
 *   · « proposé » (`deferBiometrics(…, 'offered')`) n'est noté qu'une fois la
 *     fenêtre RÉELLEMENT affichée (`presented`, appelé après le rendu) : une
 *     ouverture interrompue avant (redirection, changement de compte, vue
 *     rechargée) ne fait pas perdre la proposition.
 *   · « Plus tard » → `later` ; « Activer » → vérification native, « actif »
 *     seulement après succès (`changeBiometrics`, inchangé).
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  changeBiometrics, deferBiometrics, isBiometricOfferPath, readBiometricSetting, shouldOfferBiometrics,
  type BiometricSetting, type BiometricsChange, type DeferReason,
} from './biometric-consent';
import { nativePlatform } from './bridge';
import { presentationBiometryType, readBiometryTypes } from './biometric-offer-presentation';

/** Pause entre la fermeture de la fenêtre biométrique (ou native) et l'invitation suivante. */
export const OFFER_TRANSITION_MS = 400;
/** Lecture du capteur / du choix trop longue : l'étape est abandonnée pour ce lancement (rien n'est noté). */
export const BIOMETRIC_EVALUATION_TIMEOUT_MS = 8000;

export interface BiometricOfferContext {
  /** Compte de la session AUTHENTIFIÉE, sinon null. */
  userId: number | null;
  /** Feature flag serveur `biometrics` (configuration non lue : actif). */
  featureOn: boolean;
  pathname: string | null | undefined;
  /** CGUV à réaccepter (écran obligatoire). */
  legalRequired: boolean;
  /** Verrou, mise à jour requise, environnement, page commerciale. */
  blocked: boolean;
}

/**
 * Étape biométrique d'un compte pendant ce lancement :
 *   evaluating  lecture du capteur et du choix en cours ;
 *   offer       fenêtre à présenter / présentée ;
 *   closing     fenêtre refermée, transition avant l'invitation suivante ;
 *   none        terminée ou sans objet (jamais reproposée pendant ce lancement).
 * Absente : pas encore évaluée.
 */
export type BiometricStep = 'evaluating' | 'offer' | 'closing' | 'none';

export interface BiometricOfferState {
  userId: number;
  type: number | null;
  /** Libellé court (« Face ID », « la biométrie »…) pour le message après activation. */
  label: string;
}

export interface BiometricOfferSnapshot {
  steps: Readonly<Record<number, BiometricStep>>;
  offer: BiometricOfferState | null;
  /** La fenêtre de `offer` a été réellement affichée (et notée). */
  presented: boolean;
  busy: boolean;
}

export interface BiometricOfferView {
  visible: boolean;
  type: number | null;
  busy: boolean;
  /** L'invitation aux notifications doit attendre (étape biométrique non terminée). */
  holdsPush: boolean;
}

export interface BiometricOfferDeps {
  readSetting: (userId: number, featureOn: boolean) => Promise<BiometricSetting>;
  /** `BiometryType` à présenter (lot 111G). */
  presentationType: (setting: BiometricSetting) => Promise<number | null>;
  defer: (userId: number, why: DeferReason) => Promise<void>;
  activate: (userId: number) => Promise<BiometricsChange>;
  delay: (ms: number) => Promise<void>;
}

const defaultDeps: BiometricOfferDeps = {
  readSetting: (userId, featureOn) => readBiometricSetting(nativePlatform(), userId, featureOn),
  presentationType: async (setting) => {
    // Lot 111G : Android → capteur précis seulement s'il est le seul.
    const platform = nativePlatform();
    const types = platform === 'android' ? await readBiometryTypes() : null;
    return presentationBiometryType(platform, setting.type, types);
  },
  defer: deferBiometrics,
  activate: (userId) => changeBiometrics(true, userId),
  delay: (ms) => new Promise((r) => { setTimeout(r, ms); }),
};

/** Écran et session permettant l'étape biométrique (pur, testé). */
export function biometricOfferScreenAllowed(c: BiometricOfferContext): boolean {
  return c.userId !== null && c.featureOn && !c.blocked && !c.legalRequired && isBiometricOfferPath(c.pathname);
}

/** Vue dérivée (pure, testée). */
export function biometricOfferView(s: BiometricOfferSnapshot, c: BiometricOfferContext): BiometricOfferView {
  const u = c.userId;
  const mine = !!s.offer && u !== null && s.offer.userId === u;
  const visible = mine && !c.blocked;
  // Fonction coupée ou pas de session : rien à attendre.
  const holdsPush = u !== null && c.featureOn && s.steps[u] !== 'none';
  return { visible, type: mine ? s.offer!.type : null, busy: s.busy, holdsPush };
}

export function createBiometricOffer(deps: BiometricOfferDeps = defaultDeps) {
  let snap: BiometricOfferSnapshot = { steps: {}, offer: null, presented: false, busy: false };
  let current: number | null = null;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<BiometricOfferSnapshot>) => {
    snap = { ...snap, ...patch };
    listeners.forEach((l) => l());
  };
  const step = (userId: number, st: BiometricStep | undefined) => {
    const steps = { ...snap.steps };
    if (st === undefined) delete steps[userId]; else steps[userId] = st;
    set({ steps });
  };

  async function evaluate(c: BiometricOfferContext & { userId: number }): Promise<void> {
    const u = c.userId;
    step(u, 'evaluating');
    let timedOut = false;
    const timer = deps.delay(BIOMETRIC_EVALUATION_TIMEOUT_MS).then(() => { timedOut = true; });
    try {
      const run = (async () => {
        const setting = await deps.readSetting(u, c.featureOn);
        const offer = shouldOfferBiometrics({ ...c, sessionStatus: 'authenticated', setting });
        return { setting, offer, type: offer ? await deps.presentationType(setting) : null };
      })();
      const r = await Promise.race([run, timer.then(() => null)]);
      if (timedOut || r === null) { step(u, 'none'); return; }
      // Compte changé / session perdue pendant la lecture : rien n'est perdu,
      // l'étape sera réévaluée quand ce compte reviendra.
      if (current !== u) { step(u, undefined); return; }
      if (!r.offer) { step(u, 'none'); return; }
      set({ offer: { userId: u, type: r.type, label: r.setting.shortLabel }, presented: false });
      step(u, 'offer');
    } catch {
      step(u, 'none'); // lecture en échec : jamais bloquant pour la suite
    }
  }

  async function close(u: number): Promise<void> {
    set({ offer: snap.offer?.userId === u ? null : snap.offer, busy: false, presented: false });
    step(u, 'closing');
    await deps.delay(OFFER_TRANSITION_MS);
    if (snap.steps[u] === 'closing') step(u, 'none');
  }

  return {
    getSnapshot: () => snap,
    subscribe(l: () => void): () => void {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },

    /** À chaque changement d'écran / de session : retrait d'un autre compte, évaluation unique par compte. */
    sync(c: BiometricOfferContext): void {
      current = c.userId;
      const o = snap.offer;
      // Session momentanément indisponible (userId null) : masquée seulement, pas perdue.
      if (o && c.userId !== null && o.userId !== c.userId && !snap.busy) {
        const wasPresented = snap.presented;
        set({ offer: null, presented: false });
        step(o.userId, wasPresented ? 'none' : undefined);
      }
      if (c.userId === null || !biometricOfferScreenAllowed(c)) return;
      if (snap.steps[c.userId] !== undefined) return;
      void evaluate({ ...c, userId: c.userId });
    },

    /** Fenêtre réellement affichée : proposition notée (une fois). */
    presented(userId: number): void {
      if (snap.offer?.userId !== userId || snap.presented) return;
      set({ presented: true });
      void deps.defer(userId, 'offered').catch(() => undefined);
    },

    /** « Activer » : une seule vérification native ; l'étape suivante attend sa fin. */
    async activate(): Promise<{ result: BiometricsChange; label: string } | null> {
      const o = snap.offer;
      if (!o || snap.busy) return null;
      set({ busy: true });
      let result: BiometricsChange = 'refused';
      try {
        result = await deps.activate(o.userId);
      } catch {
        result = 'refused';
      }
      void close(o.userId);
      return { result, label: o.label };
    },

    /** « Plus tard » : rien n'est activé, mémorisé pour ce compte sur ce téléphone. */
    later(): void {
      const o = snap.offer;
      if (!o || snap.busy) return;
      void deps.defer(o.userId, 'later').catch(() => undefined);
      void close(o.userId);
    },
  };
}

export type BiometricOfferController = ReturnType<typeof createBiometricOffer>;

let shared: BiometricOfferController | null = null;

/** Contrôleur unique du lancement (l'hôte natif n'est monté qu'une fois). */
export function sharedBiometricOffer(): BiometricOfferController {
  if (!shared) shared = createBiometricOffer();
  return shared;
}
