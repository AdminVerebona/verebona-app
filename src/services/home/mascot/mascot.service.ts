/**
 * Mascotte d'accueil — orchestration (CDC Mascotte §5, §14, §15).
 *
 *   Collecter → ordonner → retenir 1 ou 2 sujets → T6 formule → afficher.
 *
 * Lot 61 — chaîne cible :
 *   1. collecter les sujets candidats ;
 *   2. exclusions déterministes et préférences de rappel (lot 60) ;
 *   3. évaluation IA des échéances éligibles (MODE=EVALUATE), AVANT la
 *      limitation aux deux sujets — décisions valides réutilisées (cache
 *      `t6_interpellation_assessments`) ; à l'affichage, une évaluation
 *      manquante part en arrière-plan (jamais deux appels IA synchrones) ;
 *      en pré-génération, elle est attendue ;
 *   4. validation des décisions IA (Zod + contrôles métier) ;
 *   5. décision backend (`decideT6Interpellation`) ;
 *   6. sélection des sujets autorisés ;
 *   7. formulation des SEULS sujets retenus (MODE=FORMULATE) ;
 *   8. résumé, cartes, pose et questions T2 construits sur cette même
 *      sélection, via l'état de présentation explicite.
 *
 * Le moteur décide QUOI, T6 décide COMMENT le dire, le front COMMENT
 * l'afficher, les parcours existants COMMENT modifier les données (§5).
 */
import { isAccountProcessingEligible } from '@/services/account/processing-eligibility';
import { collectMascotData } from './collector';
import { buildCandidates, openOverdueCount } from './signals';
import { buildSecondaries, selectSubjects } from './selector';
import { buildPresentation, contextHashOf } from './presentation';
import { buildT6Input } from './t6-contract';
import {
  evaluateWithT6, formulateWithT6, logT6, t6EvaluationConfig, t6EvaluationDefaultDeps, t6EvaluationRecentlyFailed,
  type T6Mode,
} from './t6-runner';
import type { MascotPresentation } from './types';
import { documentsInAnalysis, parisDay, tileFor } from './bubble';
import { MAX_TODO_ITEMS, buildTodoBlock } from './todo-items';
import { readDuoInvite } from './duo-invite';
import {
  T6_RUN_LOADERS, prepareT6Interpellation, t6EvaluationTraceOf, t6ThresholdDays, writeT6EvaluationReport, writeT6InterpellationReport,
  type T6EvaluationProgress, type T6Preparation,
} from './t6-interpellation.service';
import type { MascotRawData } from './signals';
import { t6InterpellationAvailable, t6ReminderAvailable } from './t6-runner';
import { deterministicKeyOf, planT6Formulation, recomposeT6Messages, type T6FormulationPlan } from './t6-wording-need';
import { t6ReservationDbStore } from './t6-formulate-reservation';
import { currentT6Trigger, inT6Execution } from './t6-execution-scope';

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
  /**
   * Lot 71G (T6-03) : pré-génération — appelé quand des candidats restent à
   * évaluer après ce passage (reprise durable demandée) : la formulation est
   * alors différée au passage qui achève l'évaluation (situation stable).
   */
  opts: {
    onResume?: () => void;
    /**
     * Lot 78C : avancement RÉEL des évaluations éligibles à l'issue du passage
     * (pré-génération : une demande n'est jamais close sur une analyse
     * incomplète). `null` : état durable inconnu (table non déployée).
     */
    onEvaluation?: (progress: T6EvaluationProgress | null) => void;
    /**
     * Lot 81B (A) : `false` — pré-génération au plafond quotidien de
     * FORMULATION : le cycle EVALUATE s'exécute, la formulation est omise
     * (texte déterministe, aucun appel FORMULATE).
     */
    formulate?: boolean;
  } = {},
): Promise<MascotPresentation> {
  let raw;
  // Lot 49A (ticket 13) : « Inviter quelqu'un » (Premium Duo, personne
  // invitée), lu à côté du collecteur ; en échec : rien à proposer.
  const duoInviteP = readDuoInvite(accountId).catch((e) => {
    console.error('[mascotte] source « invitation Duo » indisponible :', (e as Error).message);
    return null;
  });
  // Lot 108J : T6 formule la bulle SEULEMENT. Les suggestions (accueil et
  // « Demander à Verebona ») viennent du service unique
  // `src/services/suggestions/shared` : plus aucun contexte de questions ni
  // d'invitations transmis à T6, aucun appel IA de génération de suggestions.
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
  // Lot 60 / 61 : décision d'interpellation de chaque échéance candidate, AVANT
  // la composition : phrase, cartes, pose et questions reposent sur les MÊMES
  // décisions.
  let interpellation = await prepare(accountId, userId, raw, mode);
  let reprise = false;
  // Lot 82A (C-Q10, §3.3) : compte non actif, suspendu ou en lecture seule —
  // aucun traitement T6 (ni évaluation ni formulation, ni pré-génération) :
  // l'accueil reste consultable avec son texte déterministe. Lecture
  // impossible : prudence, pas d'appel T6.
  const t6Permis = await isAccountProcessingEligible(accountId, { maxAgeMs: 5_000 }).catch(() => false);
  if (interpellation.bundle && t6Permis) {
    const bundle = interpellation.bundle;
    const evaluation = evaluateWithT6({ accountId, bundle, mode }, {
      ...t6EvaluationDefaultDeps,
      // Lot 72A (AC08) : trace RÉELLE (statut, décisions enregistrées, mode d'appel).
      report: (o) => writeT6EvaluationReport({ accountId, mode, bundle, trace: t6EvaluationTraceOf(o) }),
    });
    if (mode === 'pregen') {
      // Pré-génération : l'évaluation est attendue, puis les décisions sont
      // recalculées avec elle — la bulle préparée repose sur les décisions
      // VALIDÉES (aucune nouvelle pré-génération demandée par ce passage).
      // Décisions conservées, rejetées ou échec : l'état est relu (décision
      // validée, ou état « indisponible » explicite après un échec).
      const o = await evaluation;
      const examines = interpellation.examined ?? 0;
      // Lot 81B (B) : relu aussi après une indisponibilité (état UNAVAILABLE
      // enregistré entre-temps) — l'avancement rendu est l'état RÉEL.
      interpellation = await prepare(accountId, userId, raw, mode);
      // Lot 71G (T6-03) : candidats restés hors de ce passage (8 par appel) —
      // REPRIS par une nouvelle demande durable, tant que l'évaluation progresse
      // (jamais de relance en boucle sur un échec : plafonds de coût inchangés).
      // Lot 75E (B) : file d'examen plus longue que la lecture — reprise aussi
      // tant que des examens s'achèvent (curseur persistant).
      const progres = o.persisted > 0 || examines + (interpellation.examined ?? 0) > 0;
      // Lot 78C : le passage RELU porte encore un lot à évaluer (au-delà des 8
      // de ce passage) — reprise immédiate, jamais une clôture « rien à dire ».
      if (progres && (interpellation.pendingAssessments > 0 || interpellation.bundle != null || interpellation.selectionBacklog)) {
        await (await import('./pregen-queue')).requestMascotPregeneration(accountId, 't6-resume');
        reprise = true;
        opts.onResume?.();
      }
    } else {
      // Affichage : JAMAIS attendue. Les décisions valides déjà conservées
      // servent tout de suite ; une évaluation aboutie programme une
      // pré-génération (l'accueil suivant en profite).
      // Lot 78C : une pré-génération DURABLE est demandée dès le lancement —
      // une évaluation interrompue (redémarrage, instance arrêtée) est reprise
      // par la tâche planifiée, sans attendre une nouvelle visite.
      void (async () => (await import('./pregen-queue')).requestMascotPregeneration(accountId, 't6-evaluation'))().catch(() => {});
      void evaluation.then((o) => { if (o.persisted > 0) scheduleMascotPregeneration(accountId, PREGEN_DEBOUNCE_MS, 't6-assessment'); });
    }
  }
  // Lot 81B (B) : T6 indisponible — évaluations éligibles enregistrées
  // UNAVAILABLE ; une demande DURABLE garantit leur reprise au rétablissement
  // sans nouvelle visite (une demande déjà en attente n'est pas avancée).
  if (mode !== 'pregen' && interpellation.evaluationProgress?.t6Unavailable && interpellation.evaluationProgress.eligible > 0) {
    void import('./pregen-queue').then((q) => q.ensureMascotPregeneration(accountId, 't6-unavailable')).catch(() => {});
  }
  // Lot 78C : évaluations prenables au-delà du plafond par appel, à l'affichage —
  // la pré-génération durable du compte les prend en charge (sans visite).
  if (mode !== 'pregen' && interpellation.pendingAssessments > 0) scheduleMascotPregeneration(accountId, PREGEN_DEBOUNCE_MS, 't6-pending');
  // Lot 109E (AC05) : décisions à empreinte antérieure en attente du budget de
  // reprise — pré-génération DIFFÉRÉE à sa libération (jamais une reprise
  // immédiate en boucle ; une demande plus tardive n'est pas avancée).
  if ((interpellation.upgradeDeferred ?? 0) > 0 && t6Permis && !reprise) {
    const delai = (interpellation.upgradeRetryInMs ?? 60_000) + Math.floor(Math.random() * 15_000);
    void import('./pregen-queue').then((q) => q.requestMascotPregenerationAt(accountId, 't6-upgrade', delai)).catch(() => {});
  }
  // Lot 78C : attente anormalement longue constatée à l'affichage — supervision
  // du compte (anomalie BO), même si la tâche planifiée ne tourne plus.
  if ((interpellation.evaluationProgress?.stale ?? 0) > 0) superviseAccountSoon(accountId);
  opts.onEvaluation?.(interpellation.evaluationProgress ?? null);
  // Lot 75E (B) : pré-génération sans évaluation à demander, mais file d'examen
  // plus longue que la lecture — reprise tant que des examens s'achèvent.
  if (mode === 'pregen' && !interpellation.bundle && interpellation.selectionBacklog && (interpellation.examined ?? 0) > 0) {
    await (await import('./pregen-queue')).requestMascotPregeneration(accountId, 't6-resume');
    reprise = true;
    opts.onResume?.();
  }
  // Lot 75E (B) : affichage d'un compte dont la file d'examen dépasse la
  // lecture — la pré-génération du compte (seule à faire avancer le curseur
  // persistant) est demandée, durable et temporisée (jamais attendue).
  if (mode !== 'pregen' && interpellation.selectionBacklog) scheduleMascotPregeneration(accountId, PREGEN_DEBOUNCE_MS, 't6-selection');
  const candidates = buildCandidates(raw, { interpellation: { shown: interpellation.shown } });
  const subjects = selectSubjects(candidates.candidates);
  // Lot 55A : actions secondaires seulement (onboarding, recommandations).
  // Lot 108J : aucune question — les suggestions viennent du service unique.
  const baseSecondaries = buildSecondaries(candidates, subjects, []);
  // Lot 32 (MASC2) : « À traiter » = niveau 2 de la bulle, depuis la file.
  // Lot 49A (ticket 13) : « Inviter quelqu'un » passe EN PREMIER et compte
  // dans les deux actions « À faire en premier » (MASC3).
  const duoInvite = await duoInviteP;
  const todo = buildTodoBlock(raw.toProcess, raw.toProcessTotal, duoInvite ? MAX_TODO_ITEMS - 1 : MAX_TODO_ITEMS);
  // Empreinte T6 : sujets et secondaires seulement — un « À traiter » résolu
  // ne relance pas la formulation des autres sujets.
  const contextHash = contextHashOf(subjects, baseSecondaries, candidates.degraded);

  // Lot 53 (D25) : échéances dépassées encore ouvertes — lot 61 : SUPERVISION
  // seulement (aucune phrase, aucune pose), sans les échéances écartées.
  const overdueDeadlines = openOverdueCount(raw, interpellation.notInterpellated);
  const commun = {
    degraded: candidates.degraded, today: raw.today, tiles, todo, duoInvite, overdueDeadlines,
    // Lot 61 : évaluation des échéances proches en cours ou indisponible —
    // dit explicitement par la bulle, jamais « rien à signaler ».
    evaluation: interpellation.evaluation,
    // Lot 72A (AC03) : lecture T6 en panne (préférences, évaluations, preuves,
    // « À traiter »…), propagée INDÉPENDAMMENT des sources métier.
    deadlinesDegraded: interpellation.degraded,
  };
  // Bulle telle qu'affichée sans reformulation (texte déterministe).
  const secours = buildPresentation({ subjects, secondaries: baseSecondaries, messages: null, ...commun });
  const today = raw.today ?? parisDay();
  const rapport = (p: MascotPresentation, status: string | null, promptVersion: string | null, plan?: T6FormulationPlan) =>
    void writeT6InterpellationReport({
      accountId, userId, mode, prep: interpellation,
      formulate: {
        promptVersion, contract: 't6-output-v2',
        // Lot 113AO (A) : seuls les sujets réellement confiés à FORMULATE sont « transmis ».
        transmitted: (plan ? plan.formulate.map((i) => subjects[i]) : subjects).map((x) => x.subjectId),
        ...(plan?.deterministic.length ? { deterministicSubjects: plan.deterministic.map((i) => subjects[i].subjectId) } : {}),
        displayed: p.paragraphs.filter((x) => x.sourceCode !== 'CLEAR').map((x) => x.subjectId),
        source: p.source, status, presentation: p.state?.kind ?? null, suggestions: null, homeSuggestions: null,
      },
    });

  // Lot 81B (A) : formulation plafonnée — pas de FORMULATE.
  const formuler = opts.formulate !== false && t6Permis;
  // RUN-013 : rien à formuler — pas de FORMULATE. Lot 71G : évaluation en
  // cours de reprise (pré-génération) — la situation n'est pas stable, la
  // formulation attend le passage qui l'achève (aucun appel inutile).
  if (subjects.length === 0 || reprise || !formuler) {
    rapport(secours, null, null);
    return withRefreshHint(secours, interpellation);
  }

  // Nature de la tuile de chaque sujet (pose graduée) : nuances R9 du master T6.
  const kinds = subjects.map((s) => tileFor(s, today, tiles).kind);
  // Lot 113AO (#748, A) : besoin rédactionnel qualifié PAR LE SERVEUR, en amont de
  // la passerelle — un sujet dont le texte fiable est entièrement calculable est
  // servi tel quel (aucun appel, aucun jeton) ; seuls les autres partent à FORMULATE.
  const plan = planT6Formulation(subjects, kinds);
  if (plan.deterministic.length > 0) {
    const det = plan.deterministic.map((i) => subjects[i]);
    void t6ReservationDbStore.noteDeterministic({
      accountId, cacheKey: deterministicKeyOf(accountId, det), sourceCodes: det.map((x) => x.sourceCode), subjects: det.length,
    }).catch(() => {});
  }
  if (plan.formulate.length === 0) {
    const deterministe = buildPresentation({ subjects, secondaries: baseSecondaries, messages: null, deterministic: true, ...commun });
    rapport(deterministe, 'deterministic', null, plan);
    return withRefreshHint(deterministe, interpellation);
  }
  const cibles = plan.formulate.map((i) => subjects[i]);
  const input = buildT6Input(cibles);
  const outcome = await formulateWithT6({ accountId, input, contextHash, mode, kinds: plan.formulate.map((i) => kinds[i]) });
  void logT6({ accountId, contextHash, mode, outcome, input });
  // Bulle recomposée dans l'ordre de la sélection (1 ou 2 sujets, ancrages conservés).
  const messages = plan.deterministic.length > 0 ? recomposeT6Messages(subjects, plan, outcome.messages) : outcome.messages;
  const finale = buildPresentation({ subjects, secondaries: baseSecondaries, messages, ...commun });
  rapport(finale, outcome.status, outcome.promptVersion, plan);
  return withRefreshHint(finale, interpellation);
}

/** Bornes de l'actualisation ciblée. */
const MASCOT_REFRESH_HINT_MIN_MS = 15_000;
const MASCOT_REFRESH_HINT_MAX_MS = 10 * 60_000;
/** Documents en cours d'analyse : relecture ciblée (la fin d'analyse est aussi signalée par événement). */
const MASCOT_ANALYSIS_REFRESH_MS = 60_000;

/**
 * Lot 78C — actualisation ciblée suggérée (pure, testée) : examen réellement
 * en cours → peu après la fin attendue (fin de bail) ou 30 s ; nouvel essai
 * planifié bientôt (≤ 10 min) → juste après ; documents en analyse → 60 s.
 * Rien sinon (FAILED, indisponibilité durable, rien en cours).
 */
export function mascotRefreshHintMs(p: {
  evaluation: 'OK' | 'PENDING' | 'UNAVAILABLE'; progress: T6EvaluationProgress | null | undefined; analysing: boolean; now: Date;
}): number | null {
  const borne = (ms: number) => Math.min(MASCOT_REFRESH_HINT_MAX_MS, Math.max(MASCOT_REFRESH_HINT_MIN_MS, Math.round(ms)));
  const candidats: number[] = [];
  const attente = p.progress?.waitingUntil ? new Date(p.progress.waitingUntil).getTime() - p.now.getTime() : null;
  if (p.evaluation === 'PENDING') candidats.push(borne(attente != null && attente > 0 ? attente + 5_000 : 30_000));
  else if (p.evaluation === 'UNAVAILABLE' && attente != null && attente > 0 && attente <= MASCOT_REFRESH_HINT_MAX_MS && (p.progress?.waiting ?? 0) > 0) {
    // Essai planifié : la tâche planifiée (1 min) ou cette relecture le lancent.
    candidats.push(borne(attente + 60_000));
  }
  if (p.analysing) candidats.push(MASCOT_ANALYSIS_REFRESH_MS);
  return candidats.length ? Math.min(...candidats) : null;
}

function withRefreshHint(p: MascotPresentation, prep: T6Preparation): MascotPresentation {
  const ms = mascotRefreshHintMs({ evaluation: prep.evaluation, progress: prep.evaluationProgress, analysing: documentsInAnalysis(p), now: new Date() });
  return ms == null ? p : { ...p, refreshAfterMs: ms };
}

/** Supervision ciblée d'un compte (au plus une fois par 15 min et par instance). */
const supervises = new Map<number, number>();
function superviseAccountSoon(accountId: number): void {
  const t = supervises.get(accountId);
  if (t != null && Date.now() - t < 15 * 60_000) return;
  supervises.set(accountId, Date.now());
  if (supervises.size > 5_000) supervises.clear();
  void import('./t6-evaluation-runs').then((m) => m.superviseT6Evaluations({ onlyAccountId: accountId })).catch(() => {});
}

/** Décision d'interpellation du passage (lot 60), état d'évaluation compris (lot 61). */
async function prepare(accountId: number, userId: number | null, raw: MascotRawData, mode: T6Mode): Promise<T6Preparation> {
  void mode;
  return prepareT6Interpellation({ accountId, userId, raw }, {
    aiCapable: t6InterpellationAvailable,
    // Lot 68 : renouvellement ciblé des évaluations quand le prompt effectif connaît le rappel informatif.
    reminderCapable: t6ReminderAvailable,
    thresholdDays: t6ThresholdDays,
    recentEvaluationFailure: (id) => t6EvaluationRecentlyFailed(id),
    // Lot 72A (AC02) : version effective du prompt EVALUATE et configuration déterminante.
    evaluationConfig: t6EvaluationConfig,
    // Lot 78C : état réel et durable des évaluations (0616).
    runs: T6_RUN_LOADERS,
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
  // Lot 113AO (#748, B) : déclencheur métier (fin d'analyse T1…) mémorisé comme
  // lien de causalité ; la pré-génération s'exécute dans SA portée T6 (jamais
  // dans le contexte du travail qui l'a demandée).
  const causedBy = currentT6Trigger();
  const enregistree = import('./pregen-queue')
    .then((q) => q.requestMascotPregeneration(accountId, reason, { causedBy }))
    .catch(() => {});
  const prev = timers.get(accountId);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(accountId);
    void inT6Execution(() => enregistree
      .then(() => import('./pregen-queue'))
      .then((q) => q.processMascotPregenerationFor(accountId)), { causedBy })
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
