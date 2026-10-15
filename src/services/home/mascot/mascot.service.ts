/**
 * Mascotte d'accueil — orchestration (CDC Mascotte §5, §14, §15).
 *
 *   Collecter → ordonner → retenir 1 ou 2 sujets → T6 formule → afficher.
 *
 * Le moteur décide QUOI, T6 décide COMMENT le dire, le front COMMENT
 * l'afficher, les parcours existants COMMENT modifier les données (§5).
 */
import { collectMascotData } from './collector';
import { buildCandidates, openOverdueCount } from './signals';
import { buildSecondaries, selectSubjects, withSuggestedQuestions } from './selector';
import { buildPresentation, contextHashOf } from './presentation';
import { buildT6Input } from './t6-contract';
import { formulateWithT6, logT6, t6SuggestionsAvailable, type T6Mode } from './t6-runner';
import type { MascotPresentation } from './types';
import { composeSpeech, parisDay, tileFor } from './bubble';
import { MAX_TODO_ITEMS, buildTodoBlock } from './todo-items';
import { readDuoInvite } from './duo-invite';
import { loadT6SuggestionContext, suggestionSecondaries, type T6SuggestionBundle } from './t6-suggestions';
import { prepareT6Interpellation, t6ThresholdDays, writeT6InterpellationReport, type T6Preparation } from './t6-interpellation.service';
import { t6InterpellationAvailable } from './t6-runner';

/**
 * Lot 60 : `userId` — utilisateur qui regarde l'accueil. Ses préférences de
 * rappel (« plus tard », « ne plus me rappeler ») s'appliquent à SA bulle
 * seulement (Duo : jamais à celle de l'autre membre). Absent
 * (pré-génération) : décision du compte, sans préférence personnelle.
 */
export async function getMascotPresentation(
  accountId: number,
  mode: T6Mode = 'display',
  userId: number | null = null,
): Promise<MascotPresentation> {
  let raw;
  // Lot 49A (ticket 13) : « Inviter quelqu'un » (Premium Duo, personne
  // invitée), lu à côté du collecteur ; en échec : rien à proposer.
  const duoInviteP = readDuoInvite(accountId).catch((e) => {
    console.error('[mascotte] source « invitation Duo » indisponible :', (e as Error).message);
    return null;
  });
  // Lot 55A : le prompt T6 en service sait-il rédiger les questions (R12) ?
  const questionsP = t6SuggestionsAvailable();
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
  // Lot 60 : décision d'interpellation T6 de chaque échéance candidate, AVANT
  // la composition : phrase et cartes reposent sur les MÊMES décisions.
  const interpellation: T6Preparation = await prepareT6Interpellation({ accountId, userId, raw }, {
    aiCapable: t6InterpellationAvailable,
    thresholdDays: t6ThresholdDays,
    // Nouvelles évaluations : l'accueil suivant est préparé avec elles.
    onAssessed: () => scheduleMascotPregeneration(accountId, PREGEN_DEBOUNCE_MS, 't6-assessment'),
  });
  void writeT6InterpellationReport({ accountId, userId, mode, prep: interpellation });
  const candidates = buildCandidates(raw, { interpellation: { shown: interpellation.shown } });
  const subjects = selectSubjects(candidates.candidates);
  // Lot 55A : actions secondaires seulement (onboarding, recommandations) —
  // les questions « Ou demandez-moi » ne viennent plus du catalogue
  // déterministe, mais de T6 (même appel que la bulle, ci-dessous).
  const baseSecondaries = buildSecondaries(candidates, subjects, []);
  // Lot 32 (MASC2) : « À traiter » = niveau 2 de la bulle, depuis la file.
  // Lot 49A (ticket 13) : « Inviter quelqu'un » passe EN PREMIER et compte
  // dans les deux actions « À faire en premier » (MASC3).
  const duoInvite = await duoInviteP;
  const todo = buildTodoBlock(raw.toProcess, raw.toProcessTotal, duoInvite ? MAX_TODO_ITEMS - 1 : MAX_TODO_ITEMS);
  // Empreinte T6 : sujets et secondaires seulement — un « À traiter » résolu
  // ne relance pas la formulation des autres sujets.
  const contextHash = contextHashOf(subjects, baseSecondaries, candidates.degraded);

  // Lot 53 (D25) : échéances dépassées encore ouvertes (au-delà des sujets).
  // Lot 60 : sans les échéances écartées ou différées par la décision T6.
  const overdueDeadlines = openOverdueCount(raw, interpellation.notInterpellated);
  const commun = { degraded: candidates.degraded, today: raw.today, tiles, todo, duoInvite, overdueDeadlines };
  // Bulle telle qu'affichée sans reformulation (texte déterministe).
  const secours = buildPresentation({ subjects, secondaries: baseSecondaries, messages: null, ...commun });

  // Lot 55A : contexte des questions suggérées — le MESSAGE AFFICHÉ, l'état
  // canonique du compte, ses biens et ses échéances. Données partielles
  // (source en panne) : aucune question plutôt qu'une question trompeuse.
  let questions: T6SuggestionBundle | null = null;
  if (!candidates.degraded && await questionsP) {
    const speech = composeSpeech({ presentation: secours, empty: false }).text;
    const attentionToday = (todo?.items.length ?? 0) > 0 || !!duoInvite
      || secours.paragraphs.some((x) => x.tile?.attention ?? false);
    // Lot 60 : une échéance que l'utilisateur a reportée ou refusée n'est pas
    // proposée en question non plus.
    const agenda = raw.agenda?.filter((r) => !interpellation.userSilenced.has(r.id)) ?? null;
    questions = await loadT6SuggestionContext(accountId, { speech, attentionToday, agenda, today: raw.today ?? parisDay() });
  }

  // RUN-013 : rien à formuler, à suggérer ni à évaluer — pas de T6.
  const evaluation = interpellation.bundle;
  if (subjects.length === 0 && !questions && !evaluation) return secours;

  const input = buildT6Input(subjects);
  // Nature de la tuile de chaque sujet (pose graduée) : nuances R9 du master T6.
  const kinds = subjects.map((s) => tileFor(s, raw.today ?? parisDay(), tiles).kind);
  const outcome = await formulateWithT6({ accountId, input, contextHash, mode, kinds, suggestions: questions, interpellation: evaluation });
  void logT6({ accountId, contextHash, mode, outcome, input, suggestionContext: questions?.context, interpellationContext: evaluation?.context });
  // Questions de la MÊME sortie que les textes : indisponibles → aucune.
  const secondaries = withSuggestedQuestions(baseSecondaries, subjects, suggestionSecondaries(outcome.suggestions ?? []));
  return buildPresentation({ subjects, secondaries, messages: outcome.messages, ...commun });
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
