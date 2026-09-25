/**
 * Assemblage de la prise de parole — pur (CDC Mascotte §4, §14, §20).
 *
 * Même sortie que T6 ait parlé ou non : les paragraphes et les actions sont
 * ceux des sujets choisis, seuls les textes changent (RUN-012).
 */
import { canonicalJson, sha256 } from './hash';
import type { T6Message } from './t6-contract';
import type {
  MascotParagraph, MascotPresentation, MascotSecondary, MascotSubject,
} from './types';
import { CLEAR_TEXT, DEGRADED_NOTICE } from './types';

/** Empreinte du contexte métier affiché : sujets, faits, actions, secondaires. */
export function contextHashOf(subjects: MascotSubject[], secondaries: MascotSecondary[], degraded: boolean): string {
  return sha256(canonicalJson({
    subjects: subjects.map((s) => ({ id: s.subjectId, facts: s.facts, actions: s.actions, text: s.fallbackText })),
    secondaries: secondaries.map((s) => ({ id: s.id, action: s.action })),
    degraded,
  })).slice(0, 32);
}

export function buildPresentation(p: {
  subjects: MascotSubject[];
  secondaries: MascotSecondary[];
  degraded: boolean;
  messages: T6Message[] | null;
  now?: Date;
}): MascotPresentation {
  const contextHash = contextHashOf(p.subjects, p.secondaries, p.degraded);
  const computedAt = (p.now ?? new Date()).toISOString();
  const base = {
    schemaVersion: 'mascot-presentation-v1' as const,
    contextHash,
    secondaries: p.secondaries,
    degradedNotice: p.degraded ? DEGRADED_NOTICE : null,
    computedAt,
  };

  if (p.subjects.length === 0) {
    // RUN-013 : rien à dire, pas de T6. Mais une source en panne n'autorise
    // jamais « Tout est à jour » (§20, ERR-01).
    if (p.degraded) return { ...base, status: 'degraded', source: 'deterministic', paragraphs: [] };
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
    };
  });
  return {
    ...base,
    status: p.degraded ? 'degraded' : 'ok',
    source: p.messages ? 't6' : 'fallback',
    paragraphs,
  };
}
