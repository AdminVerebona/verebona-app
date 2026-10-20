/**
 * Assemblage de la prise de parole — pur (CDC Mascotte §4, §14, §20).
 *
 * Même sortie que T6 ait parlé ou non : les paragraphes et les actions sont
 * ceux des sujets choisis, seuls les textes changent (RUN-012).
 */
import { canonicalJson, sha256 } from './hash';
import type { T6Message } from './t6-contract';
import type {
  MascotDegradedSource, MascotDuoInvite, MascotParagraph, MascotPresentation, MascotSecondary, MascotSubject, MascotTodoBlock,
} from './types';
import { CLEAR_TEXT, DEGRADED_NOTICE } from './types';
import { parisDay, presentationState, tileFor, type TileOptions } from './bubble';
import { hasCountingIntro, stripCountingIntro } from './counting-intro';

/**
 * Empreinte du contexte métier affiché : sujets, faits, actions, secondaires
 * et — lot 32 (MASC2) — éléments « À traiter » : une action résolue change
 * l'empreinte, et la bulle se met à jour (le client garde une présentation
 * de même empreinte, RUN-001).
 */
export function contextHashOf(
  subjects: MascotSubject[], secondaries: MascotSecondary[], degraded: boolean, todo?: MascotTodoBlock | null,
  /** Lot 49A (ticket 13) : l'invitation envoyée fait disparaître l'action. */
  duoInvite?: MascotDuoInvite | null,
  /**
   * Lot 61 : état de l'évaluation des échéances proches (`PENDING`,
   * `UNAVAILABLE`) — la bulle change quand l'évaluation aboutit. Le compteur
   * des échéances dépassées n'entre plus dans l'empreinte (supervision seule).
   */
  evaluation?: 'OK' | 'PENDING' | 'UNAVAILABLE' | null,
  /** Lot 72A : lecture de la décision T6 en panne — la bulle change quand elle est rétablie. */
  deadlinesDegraded?: boolean,
): string {
  return sha256(canonicalJson({
    subjects: subjects.map((s) => ({ id: s.subjectId, facts: s.facts, actions: s.actions, text: s.fallbackText })),
    secondaries: secondaries.map((s) => ({ id: s.id, action: s.action })),
    degraded,
    ...(todo !== undefined
      ? { todo: todo ? { total: todo.total, items: todo.items.map((i) => ({ id: i.todoId, t: i.actionType, c: i.availableChoices ?? null, q: i.card.question })) } : null }
      : {}),
    ...(duoInvite ? { duoInvite: duoInvite.href } : {}),
    ...(evaluation && evaluation !== 'OK' ? { evaluation } : {}),
    ...(deadlinesDegraded ? { deadlinesDegraded: true } : {}),
  })).slice(0, 32);
}

export function buildPresentation(p: {
  subjects: MascotSubject[];
  secondaries: MascotSecondary[];
  degraded: boolean;
  messages: T6Message[] | null;
  now?: Date;
  /** AAAA-MM-JJ (Europe/Paris) : calcul des retards des tuiles. */
  today?: string;
  /** Options des tuiles (CDC 15 T4-12) — voir `tileFor`. */
  tiles?: TileOptions;
  /** « À traiter » de la bulle (lot 32, MASC2) ; absent : non transmis. */
  todo?: MascotTodoBlock | null;
  /** « Inviter quelqu'un » (lot 49A, ticket 13) — première action. */
  duoInvite?: MascotDuoInvite | null;
  /** Lot 53 (D25) : échéances dépassées encore ouvertes — supervision seulement (lot 61). */
  overdueDeadlines?: number | null;
  /** Lot 61 : état de l'évaluation des échéances proches (`T6Preparation.evaluation`). */
  evaluation?: 'OK' | 'PENDING' | 'UNAVAILABLE';
  /**
   * Lot 72A (AC03) : lecture de la décision T6 en panne (`T6Preparation.degraded`),
   * INDÉPENDANTE de `degraded` (sources métier du collecteur).
   */
  deadlinesDegraded?: boolean;
}): MascotPresentation {
  const evaluation = p.evaluation ?? 'OK';
  const deadlinesDegraded = p.deadlinesDegraded === true;
  const degradedSources: MascotDegradedSource[] = [...(p.degraded ? ['business' as const] : []), ...(deadlinesDegraded ? ['deadlines' as const] : [])];
  const contextHash = contextHashOf(p.subjects, p.secondaries, p.degraded, p.todo, p.duoInvite, evaluation, deadlinesDegraded);
  const computedAt = (p.now ?? new Date()).toISOString();
  const base = {
    schemaVersion: 'mascot-presentation-v1' as const,
    contextHash,
    secondaries: p.secondaries,
    degradedNotice: degradedSources.length > 0 ? DEGRADED_NOTICE : null,
    computedAt,
    ...(p.todo !== undefined ? { todo: p.todo } : {}),
    ...(p.duoInvite ? { duoInvite: p.duoInvite } : {}),
    ...(p.overdueDeadlines !== undefined ? { overdueDeadlines: p.overdueDeadlines } : {}),
  };

  // Lot 61 : l'état de présentation est calculé ICI, à partir des décisions
  // retenues (sujets), des statuts métier fiables (« À traiter », Duo,
  // sources lues) et de l'état de l'évaluation — jamais du compteur brut des
  // échéances dépassées ni d'un état « clear » pris pour une preuve.
  const withState = (x: Omit<MascotPresentation, 'state'>): MascotPresentation => {
    const draft = { ...x, state: { schemaVersion: 'mascot-state-v1' as const, kind: 'NOTHING_TO_REPORT' as const, actions: 0, information: 0, openNotPriority: false, evaluation, degraded: degradedSources.length > 0, degradedSources } };
    return { ...x, state: presentationState(draft) };
  };

  if (p.subjects.length === 0) {
    // RUN-013 : rien à dire, pas de T6. Mais une source en panne n'autorise
    // jamais « rien à signaler » (§20, ERR-01).
    if (p.degraded) return withState({ ...base, status: 'degraded', source: 'deterministic', paragraphs: [] });
    // Lot 32 (MASC2) : des actions « À traiter » sont présentes — le niveau 1
    // les compte (client) ; jamais « rien à signaler ».
    if (p.todo && p.todo.total > 0) return withState({ ...base, status: 'ok', source: 'deterministic', paragraphs: [] });
    // Lot 49A (ticket 13) : « Inviter quelqu'un » proposé.
    if (p.duoInvite) return withState({ ...base, status: 'ok', source: 'deterministic', paragraphs: [] });
    // Lot 61 : échéances proches non encore (ou pas) évaluées — état
    // explicite, jamais « rien à signaler ». Le compteur des échéances
    // dépassées (D25) ne joue plus : une date passée n'est pas une action.
    if (evaluation !== 'OK') return withState({ ...base, status: 'ok', source: 'deterministic', paragraphs: [] });
    // Lot 72A (AC03) : décision T6 illisible — l'examen n'a pas pu se faire :
    // jamais « rien à signaler ».
    if (deadlinesDegraded) return withState({ ...base, status: 'ok', source: 'deterministic', paragraphs: [] });
    return withState({
      ...base,
      status: 'clear',
      source: 'deterministic',
      paragraphs: [{
        subjectId: 'CLEAR', sourceCode: 'CLEAR', occurrenceKey: 'CLEAR',
        text: CLEAR_TEXT, highlight: null, actions: [],
      }],
    });
  }

  const paragraphs: MascotParagraph[] = p.subjects.map((s, i) => {
    // Lot 71F : un texte formulé qui porte une introduction de comptage
    // (« Un sujet mérite votre attention aujourd'hui : … »), quelle que soit
    // sa provenance, n'est jamais servi : le sujet reprend son texte de
    // secours (lui-même débarrassé de toute introduction).
    const m0 = p.messages?.[i];
    const m = m0 && !hasCountingIntro(m0.text) ? m0 : undefined;
    return {
      subjectId: s.subjectId,
      sourceCode: s.sourceCode,
      occurrenceKey: s.occurrenceKey,
      text: m ? m.text : stripCountingIntro(s.fallbackText),
      highlight: m ? m.highlight : (s.allowedHighlight && s.fallbackText.includes(s.allowedHighlight) ? s.allowedHighlight : null),
      actions: s.actions,
      tile: tileFor(s, p.today ?? parisDay(p.now), p.tiles),
      // Lot 60 : commandes de rappel de la carte (échéance précise).
      ...(s.reminder ? { reminder: s.reminder } : {}),
    };
  });
  return withState({
    ...base,
    status: p.degraded ? 'degraded' : 'ok',
    source: p.messages ? 't6' : 'fallback',
    paragraphs,
  });
}
