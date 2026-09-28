/**
 * Enregistrement automatique des informations complémentaires —
 * CDC Exports V12 §4.3 (autosave, debounce 700 ms), IC-GEN-003, IC-GEN-004.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * FILE D'ENREGISTREMENT, SANS REACT
 *
 *   - Chaque saisie met à jour une file de champs en attente (dernière valeur
 *     par champ) et relance un délai de 700 ms.
 *   - À échéance, UN SEUL PATCH part avec tous les champs en attente. Pendant
 *     qu'il est en vol, les nouvelles saisies s'accumulent ; elles partent au
 *     retour, jamais en parallèle (pas d'écriture plus ancienne qui arriverait
 *     après une plus récente).
 *   - Échec : les champs du PATCH perdu reviennent dans la file SANS écraser
 *     une saisie plus récente du même champ ; l'état passe à « Échec
 *     d'enregistrement » et `retry()` relance immédiatement.
 *   - `flush()` force l'envoi (fermeture du formulaire, changement d'onglet).
 *
 * États (indicateur IC-GEN-004) : idle → pending → saving → saved | error.
 * Module pur : minuterie injectable, testé avec de faux temporisateurs.
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { AdditionalInfoSectionKey, AdditionalInfoValue, AdditionalInfosPatch } from './additional-infos';

export const AUTOSAVE_DEBOUNCE_MS = 700;

export type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface AutosaveOptions {
  save: (patch: AdditionalInfosPatch) => Promise<void>;
  onStateChange?: (state: AutosaveState, error?: unknown) => void;
  debounceMs?: number;
}

export interface AutosaveQueue {
  /** Enregistre (après délai) une valeur ; `null` retire le champ. */
  set(section: AdditionalInfoSectionKey, key: string, value: AdditionalInfoValue | null): void;
  /** Retire un champ de la file sans l'envoyer (valeur redevenue invalide…). */
  discard(section: AdditionalInfoSectionKey, key: string): void;
  /** Envoie tout de suite ce qui attend ; résout quand la file est vide ou en échec. */
  flush(): Promise<void>;
  /** Après un échec : relance immédiate. */
  retry(): Promise<void>;
  hasPending(): boolean;
  state(): AutosaveState;
  dispose(): void;
}

type Pending = Map<string, { section: AdditionalInfoSectionKey; key: string; value: AdditionalInfoValue | null }>;

const id = (section: string, key: string) => `${section}.${key}`;

function toPatch(entries: Pending): AdditionalInfosPatch {
  const patch: AdditionalInfosPatch = {};
  for (const { section, key, value } of entries.values()) {
    (patch[section] ??= {})[key] = value;
  }
  return patch;
}

export function createAutosaveQueue(opts: AutosaveOptions): AutosaveQueue {
  const debounceMs = opts.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  let pending: Pending = new Map();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let current: AutosaveState = 'idle';
  let disposed = false;

  const setState = (s: AutosaveState, err?: unknown) => {
    current = s;
    if (!disposed) opts.onStateChange?.(s, err);
  };

  const clearTimer = () => {
    if (timer) { clearTimeout(timer); timer = null; }
  };

  const run = async (): Promise<void> => {
    clearTimer();
    if (inFlight) {
      // Un envoi est en cours : la suite partira à son retour.
      await inFlight;
      return;
    }
    if (pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    setState('saving');
    inFlight = (async () => {
      try {
        await opts.save(toPatch(batch));
        inFlight = null;
        if (pending.size > 0) {
          // Saisies arrivées pendant l'envoi : elles partent maintenant.
          await run();
        } else {
          setState('saved');
        }
      } catch (err) {
        inFlight = null;
        // Le lot perdu revient, sans écraser une saisie plus récente.
        for (const [k, v] of batch) if (!pending.has(k)) pending.set(k, v);
        setState('error', err);
      }
    })();
    await inFlight;
  };

  return {
    set(section, key, value) {
      if (disposed) return;
      pending.set(id(section, key), { section, key, value });
      if (!inFlight) setState('pending');
      clearTimer();
      timer = setTimeout(() => { void run(); }, debounceMs);
    },
    discard(section, key) {
      pending.delete(id(section, key));
      if (pending.size === 0 && !inFlight && current === 'pending') {
        clearTimer();
        setState('idle');
      }
    },
    flush: run,
    retry: run,
    hasPending: () => pending.size > 0 || inFlight !== null,
    state: () => current,
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
