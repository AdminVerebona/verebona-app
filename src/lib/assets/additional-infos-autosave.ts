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
 *   - Listes structurées : une liste part en bloc, avec la `version` connue
 *     (contrôle optimiste). Un 409 est résolu par `rebaseAfterConflict` :
 *     liste inchangée côté serveur → rejouée sur la nouvelle version ; liste
 *     modifiée ailleurs → la version serveur est adoptée et signalée.
 *
 * États (indicateur IC-GEN-004) : idle → pending → saving → saved | error.
 * Module pur : minuterie injectable, testé avec de faux temporisateurs.
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  findField, sameList,
  type AdditionalInfoSectionKey, type AdditionalInfoValue, type AdditionalInfosData, type AdditionalInfosPatch, type ListItem,
} from './additional-infos';

export const AUTOSAVE_DEBOUNCE_MS = 700;

export type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/**
 * Échec d'enregistrement dont seule une partie du lot doit revenir en file
 * (après résolution d'un conflit, seul le correctif rejoué est à renvoyer).
 */
export interface PartialSaveError { requeue: AdditionalInfosPatch }

export function withRequeue<E>(err: E, requeue: AdditionalInfosPatch): E & PartialSaveError {
  return Object.assign((err ?? new Error('Échec de l’enregistrement')) as object, { requeue }) as E & PartialSaveError;
}

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
  /**
   * Conflit (409) : le champ est retiré de la file et n'y revient plus, même
   * après un échec du lot, tant que l'utilisateur ne l'a pas modifié à nouveau
   * (`set`). Évite de réécrire une liste modifiée ailleurs avec la copie locale.
   */
  block(section: AdditionalInfoSectionKey, key: string): void;
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
  /** Champs en conflit : jamais renvoyés tant que l'utilisateur ne les a pas modifiés. */
  const blocked = new Set<string>();
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
        // Le lot perdu revient (ou seulement la partie désignée par l'appelant),
        // sans écraser une saisie plus récente ni un champ en conflit.
        const requeue = (err as Partial<PartialSaveError> | null)?.requeue;
        const back: Pending = requeue ? new Map() : batch;
        if (requeue) {
          for (const [section, values] of Object.entries(requeue) as Array<[AdditionalInfoSectionKey, Record<string, AdditionalInfoValue | null>]>) {
            for (const [key, value] of Object.entries(values ?? {})) back.set(id(section, key), { section, key, value });
          }
        }
        for (const [k, v] of back) if (!pending.has(k) && !blocked.has(k)) pending.set(k, v);
        setState('error', err);
      }
    })();
    await inFlight;
  };

  const discard = (section: AdditionalInfoSectionKey, key: string) => {
    pending.delete(id(section, key));
    if (pending.size === 0 && !inFlight && current === 'pending') {
      clearTimer();
      setState('idle');
    }
  };

  return {
    set(section, key, value) {
      if (disposed) return;
      blocked.delete(id(section, key));
      pending.set(id(section, key), { section, key, value });
      if (!inFlight) setState('pending');
      clearTimer();
      timer = setTimeout(() => { void run(); }, debounceMs);
    },
    discard,
    block(section, key) {
      blocked.add(id(section, key));
      discard(section, key);
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

// ── Conflits sur les listes (409) ───────────────────────────────────────────

/** Chemins `section.clé` des listes d'un correctif client. */
export function patchListPaths(patch: AdditionalInfosPatch): string[] {
  const out: string[] = [];
  for (const [section, values] of Object.entries(patch) as Array<[AdditionalInfoSectionKey, Record<string, unknown>]>) {
    for (const key of Object.keys(values ?? {})) if (findField(section, key)?.type === 'list') out.push(`${section}.${key}`);
  }
  return out;
}

export interface RebaseResult {
  /** Correctif à rejouer sur la version courante (vide : rien à rejouer). */
  retry: AdditionalInfosPatch;
  /** Listes modifiées ailleurs : la version serveur l'emporte, la saisie locale est abandonnée. */
  conflicts: string[];
}

/**
 * Résolution d'un 409. `base` : listes telles que le client les avait lues
 * (dernier état serveur connu) ; `current` : état serveur renvoyé avec le 409.
 *
 *   - Champs simples : toujours rejoués (dernier écrit gagne, §4.3).
 *   - Liste identique entre `base` et `current` : la version a changé pour
 *     une autre raison — la liste locale est rejouée.
 *   - Liste différente : quelqu'un l'a modifiée — la liste serveur est
 *     conservée, la saisie locale abandonnée et signalée.
 */
export function rebaseAfterConflict(
  patch: AdditionalInfosPatch,
  base: Record<string, ListItem[] | undefined>,
  current: Pick<AdditionalInfosData, AdditionalInfoSectionKey> | Partial<AdditionalInfosData>,
): RebaseResult {
  const retry: AdditionalInfosPatch = {};
  const conflicts: string[] = [];
  for (const [section, values] of Object.entries(patch) as Array<[AdditionalInfoSectionKey, Record<string, AdditionalInfoValue | null>]>) {
    for (const [key, value] of Object.entries(values ?? {})) {
      const path = `${section}.${key}`;
      if (findField(section, key)?.type === 'list') {
        const server = (current as Partial<AdditionalInfosData>)[section]?.[key];
        if (!sameList(base[path], Array.isArray(server) ? (server as ListItem[]) : [])) { conflicts.push(path); continue; }
      }
      (retry[section] ??= {})[key] = value;
    }
  }
  return { retry, conflicts };
}
