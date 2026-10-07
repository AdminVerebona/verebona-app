/**
 * Assemblage de la prise de parole — pur (CDC Mascotte §4, §14, §20).
 *
 * Même sortie que T6 ait parlé ou non : les paragraphes et les actions sont
 * ceux des sujets choisis, seuls les textes changent (RUN-012).
 */
import { canonicalJson, sha256 } from './hash';
import type { T6Message } from './t6-contract';
import type {
  MascotParagraph, MascotPresentation, MascotSecondary, MascotSubject, MascotTodoBlock,
} from './types';
import { CLEAR_TEXT, DEGRADED_NOTICE } from './types';
import { parisDay, tileFor, type TileOptions } from './bubble';

/**
 * Empreinte du contexte métier affiché : sujets, faits, actions, secondaires
 * et — lot 32 (MASC2) — éléments « À traiter » : une action résolue change
 * l'empreinte, et la bulle se met à jour (le client garde une présentation
 * de même empreinte, RUN-001).
 */
export function contextHashOf(
  subjects: MascotSubject[], secondaries: MascotSecondary[], degraded: boolean, todo?: MascotTodoBlock | null,
): string {
  return sha256(canonicalJson({
    subjects: subjects.map((s) => ({ id: s.subjectId, facts: s.facts, actions: s.actions, text: s.fallbackText })),
    secondaries: secondaries.map((s) => ({ id: s.id, action: s.action })),
    degraded,
    ...(todo !== undefined
      ? { todo: todo ? { total: todo.total, items: todo.items.map((i) => ({ id: i.todoId, t: i.actionType, c: i.availableChoices ?? null, q: i.card.question })) } : null }
      : {}),
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
}): MascotPresentation {
  const contextHash = contextHashOf(p.subjects, p.secondaries, p.degraded, p.todo);
  const computedAt = (p.now ?? new Date()).toISOString();
  const base = {
    schemaVersion: 'mascot-presentation-v1' as const,
    contextHash,
    secondaries: p.secondaries,
    degradedNotice: p.degraded ? DEGRADED_NOTICE : null,
    computedAt,
    ...(p.todo !== undefined ? { todo: p.todo } : {}),
  };

  if (p.subjects.length === 0) {
    // RUN-013 : rien à dire, pas de T6. Mais une source en panne n'autorise
    // jamais « Tout est à jour » (§20, ERR-01).
    if (p.degraded) return { ...base, status: 'degraded', source: 'deterministic', paragraphs: [] };
    // Lot 32 (MASC2) : des actions « À traiter » sont présentes — le niveau 1
    // les compte (client) ; jamais « Tout est à jour ».
    if (p.todo && p.todo.total > 0) return { ...base, status: 'ok', source: 'deterministic', paragraphs: [] };
    return {
      ...base,
      status: 'clear',
      source: 'deterministic',
      paragraphs: [{
        subjectId: 'CLEAR', sourceCode: 'CLEAR', occurrenceKey: 'CLEAR',
        text: CLEAR_TEXT, highlight: null, actions: [],
      }],
    };
  }

  const paragraphs: MascotParagraph[] = p.subjects.map((s, i) => {
    const m = p.messages?.[i];
    return {
      subjectId: s.subjectId,
      sourceCode: s.sourceCode,
      occurrenceKey: s.occurrenceKey,
      text: m ? m.text : s.fallbackText,
      highlight: m ? m.highlight : (s.allowedHighlight && s.fallbackText.includes(s.allowedHighlight) ? s.allowedHighlight : null),
      actions: s.actions,
      tile: tileFor(s, p.today ?? parisDay(p.now), p.tiles),
    };
  });
  return {
    ...base,
    status: p.degraded ? 'degraded' : 'ok',
    source: p.messages ? 't6' : 'fallback',
    paragraphs,
  };
}
