/**
 * T6 — contrat d'entrée et de sortie, validation (CDC Mascotte §13, annexe C).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T6 FORMULE, IL NE DÉCIDE RIEN
 *
 * Il reçoit les sujets déjà choisis, dans l'ordre, et rend un paragraphe par
 * sujet. Tout ce qui ne respecte pas ce contrat est rejeté et remplacé par le
 * texte déterministe (T6-011) :
 *   · autant de messages que de sujets, mêmes identifiants, même ordre ;
 *   · un paragraphe, longueur bornée, vouvoiement, aucun emoji ;
 *   · aucune date relative (DAT-005, T6-008) ;
 *   · aucun nombre absent des faits transmis (T6-003) ;
 *   · une date prévisionnelle reste présentée comme telle (DAT-003) ;
 *   · la mise en valeur est une sous-chaîne exacte du texte, sinon elle est
 *     abandonnée (JSON-002) — le paragraphe reste valable sans elle.
 * Les actions ne transitent pas par T6 : un champ en trop est ignoré et ne
 * peut jamais créer de bouton (JSON-003, T6-005).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import type { MascotFacts, MascotIntent, MascotSubject } from './types';

export const T6_INPUT_SCHEMA_VERSION = 't6-input-v1';
export const T6_OUTPUT_SCHEMA_VERSION = 't6-output-v1';

export interface T6InputSubject {
  subjectId: string;
  sourceCode: string;
  intent: MascotIntent;
  facts: MascotFacts;
  fallbackText: string;
  allowedHighlight: string | null;
}

export interface T6Input {
  schemaVersion: typeof T6_INPUT_SCHEMA_VERSION;
  language: 'fr';
  subjects: T6InputSubject[];
}

/** Contexte minimal (T6-001, SEC-007) : ni actions, ni identifiants de cible. */
export function buildT6Input(subjects: MascotSubject[]): T6Input {
  return {
    schemaVersion: T6_INPUT_SCHEMA_VERSION,
    language: 'fr',
    subjects: subjects.map((s) => ({
      subjectId: s.subjectId,
      sourceCode: s.sourceCode,
      intent: s.intent,
      facts: s.facts,
      fallbackText: s.fallbackText,
      allowedHighlight: s.allowedHighlight,
    })),
  };
}

/** Schéma structurel de la sortie. Les champs en trop sont retirés. */
export const T6OutputSchema = z.object({
  schemaVersion: z.string().optional(),
  messages: z.array(z.object({
    subjectId: z.string(),
    text: z.string(),
    highlight: z.string().nullable().optional(),
  })),
});
export type T6Output = z.infer<typeof T6OutputSchema>;

export interface T6Message { subjectId: string; text: string; highlight: string | null }

export type T6Validation =
  | { ok: true; messages: T6Message[] }
  | { ok: false; reason: string };

export const T6_TEXT_MIN = 15;
export const T6_TEXT_MAX = 420;

/** Formulations relatives interdites en V1 (DAT-005). */
const RELATIVE = /\b(aujourd['’]hui|demain|hier|apr[eè]s-demain|avant-hier|ce soir|ce matin|cette semaine|la semaine (prochaine|derni[eè]re)|ce week-end|le mois (prochain|dernier)|l['’]ann[ée]e (prochaine|derni[eè]re)|dans (\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|quelques) (jours?|semaines?|mois|ans?)|il y a (\d+|un|une|deux|trois|quelques) (jours?|semaines?|mois|ans?))\b/i;
/** Tutoiement : le vouvoiement est obligatoire (T6-007). */
const TUTOIEMENT = /(^|[\s,;:(«"'’])(tu|toi|ton|ta|tes|te|t['’])(?=[\s,.;:!?»")]|$)/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const PREVISIONNEL = /(pr[ée]vu|pr[ée]vue|pr[ée]vues|pr[ée]vus|estim[ée]|pr[ée]visionnel|autour d[ue]|environ|approximativ)/i;

function nombres(texte: string): string[] {
  return (texte.match(/\d+/g) ?? []).map((n) => String(Number(n)));
}

/** Validation stricte de la sortie T6 contre les sujets envoyés. */
export function validateT6Output(input: T6Input, raw: unknown): T6Validation {
  const parsed = T6OutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'schema' };
  const { messages } = parsed.data;

  if (messages.length !== input.subjects.length) return { ok: false, reason: 'count' };

  const out: T6Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const s = input.subjects[i];
    if (m.subjectId !== s.subjectId) return { ok: false, reason: `order:${i}` };

    const text = m.text.trim().replace(/\s+/g, ' ');
    if (text.length < T6_TEXT_MIN || text.length > T6_TEXT_MAX) return { ok: false, reason: `length:${i}` };
    if (/\n\s*\n/.test(m.text)) return { ok: false, reason: `paragraphs:${i}` };
    if (EMOJI.test(text)) return { ok: false, reason: `emoji:${i}` };
    if (RELATIVE.test(text)) return { ok: false, reason: `relative_date:${i}` };
    if (TUTOIEMENT.test(text)) return { ok: false, reason: `tutoiement:${i}` };

    // T6-003 : aucun nombre — date, montant, compte — absent des faits.
    const autorises = new Set(nombres(`${JSON.stringify(s.facts)} ${s.fallbackText}`));
    if (nombres(text).some((n) => !autorises.has(n))) return { ok: false, reason: `invented_number:${i}` };

    if (s.facts.dateNature === 'prévisionnelle' && !PREVISIONNEL.test(text)) {
      return { ok: false, reason: `forecast_as_certain:${i}` };
    }

    // Mise en valeur facultative (T6-010) : vide, ou introuvable dans le texte,
    // elle est simplement abandonnée — le texte reste valable sans elle.
    let highlight: string | null = (m.highlight ?? '').trim().replace(/\s+/g, ' ') || null;
    if (highlight !== null && !text.includes(highlight)) highlight = null;
    out.push({ subjectId: s.subjectId, text, highlight });
  }
  return { ok: true, messages: out };
}
