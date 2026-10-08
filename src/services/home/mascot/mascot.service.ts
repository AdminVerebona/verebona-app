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
import { parisDay, tileFor } from './bubble';
import { buildTodoBlock } from './todo-items';

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

  // CDC 15 T4-12 : échéance passée sans statut = non prouvée (à confirmer),
  // jamais « non réalisée » (toujours depuis le lot 16b-2).
  const tiles = { unprovenOverdueIsQuestion: true };
  const candidates = buildCandidates(raw);
  const subjects = selectSubjects(candidates.candidates);
  const secondaries = buildSecondaries(candidates, subjects);
  // Lot 32 (MASC2) : « À traiter » = niveau 2 de la bulle, depuis la file.
  const todo = buildTodoBlock(raw.toProcess, raw.toProcessTotal);
  // Empreinte T6 : sujets et secondaires seulement — un « À traiter » résolu
  // ne relance pas la formulation des autres sujets.
  const contextHash = contextHashOf(subjects, secondaries, candidates.degraded);

  if (subjects.length === 0) {
    return buildPresentation({ subjects, secondaries, degraded: candidates.degraded, messages: null, today: raw.today, tiles, todo });
  }

  const input = buildT6Input(subjects);
  // Nature de la tuile de chaque sujet (pose graduée) : nuances R9 du master T6.
  const kinds = subjects.map((s) => tileFor(s, raw.today ?? parisDay(), tiles).kind);
  const outcome = await formulateWithT6({ accountId, input, contextHash, mode, kinds });
  void logT6({ accountId, contextHash, mode, outcome, input });
  return buildPresentation({
    subjects, secondaries, degraded: candidates.degraded, messages: outcome.messages, today: raw.today, tiles, todo,
  });
}

// ── Pré-génération (RUN-007 à RUN-011 ; durable depuis le lot 32, PO 6) ──────

/** Temporisation : une rafale de changements ne produit qu'une génération (RUN-009). */
export const PREGEN_DEBOUNCE_MS = 3_000;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Programme une pré-génération pour le compte. Lot 32 (décision PO 6) : la
 * demande est d'abord ENREGISTRÉE (`home_mascot_pregen_requests`) — elle
 * survit à un redémarrage et la tâche planifiée `mascot-pregeneration` la
 * traite à défaut ; puis le chemin rapide la prend en charge après 3 s sans
 * nouvel événement. Best effort, jamais bloquante ; elle ne compte pas comme
 * une exposition (RUN-011) — elle n'écrit aucune télémétrie produit.
 */
export function scheduleMascotPregeneration(accountId: number, delayMs = PREGEN_DEBOUNCE_MS, reason = 'change'): void {
  const enregistree = import('./pregen-queue')
    .then((q) => q.requestMascotPregeneration(accountId, reason))
    .catch(() => {});
  const prev = timers.get(accountId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(accountId);
    void enregistree
      .then(() => import('./pregen-queue'))
      .then((q) => q.processMascotPregenerationFor(accountId))
      .catch((e) => console.error('[mascotte] pré-génération en échec :', (e as Error).message));
  }, delayMs);
  // Ne retient pas le processus à l'arrêt.
  (t as unknown as { unref?: () => void }).unref?.();
  timers.set(accountId, t);
}

/** Réservé aux tests. */
export function pendingPregenerations(): number { return timers.size; }

/**
 * Réservé aux tests : annule les pré-générations rapides encore en attente
 * (les e2e partagent un processus ; un minuteur d'un fichier ne doit pas
 * s'exécuter pendant le suivant).
 */
export function cancelPendingPregenerations(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
