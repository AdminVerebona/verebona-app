/**
 * Mascotte d'accueil — orchestration (CDC Mascotte §5, §14, §15).
 *
 *   Collecter → ordonner → retenir 1 ou 2 sujets → T6 formule → afficher.
 *
 * Le moteur décide QUOI, T6 décide COMMENT le dire, le front COMMENT
 * l'afficher, les parcours existants COMMENT modifier les données (§5).
 */
import { collectMascotData } from './collector';
import { buildCandidates } from './signals';
import { buildSecondaries, selectSubjects } from './selector';
import { buildPresentation, contextHashOf } from './presentation';
import { buildT6Input } from './t6-contract';
import { formulateWithT6, logT6, type T6Mode } from './t6-runner';
import type { MascotPresentation } from './types';

export async function getMascotPresentation(
  accountId: number,
  mode: T6Mode = 'display',
): Promise<MascotPresentation> {
  let raw;
  try {
    raw = await collectMascotData(accountId);
  } catch (e) {
    // Erreur globale : état dégradé explicite, jamais « Tout est à jour » (§20).
    console.error('[mascotte] calcul des signaux impossible :', (e as Error).message);
    return buildPresentation({ subjects: [], secondaries: [], degraded: true, messages: null });
  }

  const candidates = buildCandidates(raw);
  const subjects = selectSubjects(candidates.candidates);
  const secondaries = buildSecondaries(candidates, subjects);
  const contextHash = contextHashOf(subjects, secondaries, candidates.degraded);

  if (subjects.length === 0) {
    return buildPresentation({ subjects, secondaries, degraded: candidates.degraded, messages: null });
  }

  const input = buildT6Input(subjects);
  const outcome = await formulateWithT6({ accountId, input, contextHash, mode });
  // Le drapeau de recette coupé n'est pas un appel T6 : rien à journaliser.
  if (outcome.status !== 'skipped') {
    void logT6({ accountId, contextHash, mode, outcome, input });
  }
  return buildPresentation({
    subjects, secondaries, degraded: candidates.degraded, messages: outcome.messages,
  });
}

// ── Pré-génération (RUN-007 à RUN-011) ────────────────────────────────────────

/** Temporisation : une rafale de changements ne produit qu'une génération (RUN-009). */
export const PREGEN_DEBOUNCE_MS = 3_000;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Programme une pré-génération pour le compte, après 3 s sans nouvel
 * événement. Best effort, jamais bloquante ; elle ne compte pas comme une
 * exposition (RUN-011) — elle n'écrit aucune télémétrie produit.
 */
export function scheduleMascotPregeneration(accountId: number, delayMs = PREGEN_DEBOUNCE_MS): void {
  const prev = timers.get(accountId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(accountId);
    getMascotPresentation(accountId, 'pregen').catch((e) =>
      console.error('[mascotte] pré-génération en échec :', (e as Error).message));
  }, delayMs);
  // Ne retient pas le processus à l'arrêt.
  (t as unknown as { unref?: () => void }).unref?.();
  timers.set(accountId, t);
}

/** Réservé aux tests. */
export function pendingPregenerations(): number { return timers.size; }
