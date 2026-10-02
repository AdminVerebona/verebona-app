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

// ══════════════════════════════════════════════════════════════════════════
// PROMPT MAÎTRE T6 — CDC 15 §28, `t6_master_v1`, contrat `t6-output-v2`
//
// Le master est une branche unique, MODE=FORMULATE, imposée par le serveur.
// La sortie porte `schemaVersion: "t6-output-v2"` (strict). Le serveur
// applique, EN PLUS de `validateT6Output` (R1–R6, R10) :
//
//   · R8  (non-répétition entre sujets) : deux paragraphes qui s'ouvrent de
//         la même façon, ou quasi identiques, sont une répétition mécanique
//         → sortie rejetée (texte de secours) ;
//   · R9  (nuances act / inform / onboard / deadline, cohérentes avec la
//         pose graduée — nature de la tuile) : un sujet d'information
//         n'enjoint rien ; seul un sujet EN RETARD parle de retard ; jamais
//         de vocabulaire alarmiste (R7) ; une date confirmée n'est pas
//         présentée comme estimée ; jamais de boutons ni d'interface (R5) ;
//   · R11 (faits insuffisants → au plus près de `fallbackText`) : un
//         paragraphe qui perd la date absolue ou l'objet du sujet reprend
//         `fallbackText` pour CE sujet (les autres restent formulés).
// ══════════════════════════════════════════════════════════════════════════

export const T6_MASTER_PROMPT_CODE = 't6_master_v1';
export const T6_MASTER_MODE = 'FORMULATE';
export const T6_OUTPUT_SCHEMA_VERSION_V2 = 't6-output-v2';

/** Sortie du master (MODE=FORMULATE) : `schemaVersion` v2 obligatoire. */
export const T6FormulateOutput = z.object({
  schemaVersion: z.literal(T6_OUTPUT_SCHEMA_VERSION_V2),
  messages: z.array(z.object({
    subjectId: z.string(),
    text: z.string(),
    highlight: z.string().nullable().optional(),
  })),
});
export type T6FormulateOutput = z.infer<typeof T6FormulateOutput>;

/** Nature de la tuile d'un sujet (pose graduée) : `tileFor(...).kind`. */
export type T6SubjectKind = 'overdue' | 'verify' | 'action' | 'info';

const plainT6 = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’]/g, "'");

/** R7 : vocabulaire alarmiste, interdit quel que soit le sujet. */
const ALARME = /\b(urgent|urgente|urgence|alerte|danger|dangereux|catastroph\w*|grave|imperativement|immediatement|au plus vite|sans tarder)\b|!/;
/** R9 : retard — réservé à un sujet effectivement en retard. */
const RETARD = /\b(en retard|retard|depassee?s?|echue?s?|trop tard)\b/;
/** R9 : injonction — un sujet `inform` se contente d'informer. */
const INJONCTION = /\b(vous devez|il faut|il vous faut|pensez a|n'oubliez pas|n'attendez pas|veillez a|devez)\b/;
/** R9 / R4 : marque d'estimation — interdite sur une date confirmée. */
const ESTIMATION = /\b(estime\w*|previsionnel\w*|approximati\w*|environ|autour du|autour de)\b/;
/** R5 : interface et navigation. */
const INTERFACE = /\b(bouton|boutons|cliquez|cliquer|clic|menu|onglet|ecran|lien ci|ci-dessous|ci-dessus)\b/;

/** Mots d'ouverture normalisés (R8). */
function ouverture(text: string, n = 4): string {
  return plainT6(text).replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
}
function motsSignificatifs(text: string): Set<string> {
  return new Set(plainT6(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
}
/** Similarité de Jaccard sur les mots significatifs (R8). */
export function t6Similarity(a: string, b: string): number {
  const x = motsSignificatifs(a);
  const y = motsSignificatifs(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const w of x) if (y.has(w)) inter += 1;
  return inter / (x.size + y.size - inter);
}

/** R8 : deux paragraphes mécaniquement répétitifs (pure, testée). */
export function mechanicalRepetition(messages: Array<{ text: string }>): number | null {
  for (let i = 1; i < messages.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = messages[j].text;
      const b = messages[i].text;
      if (ouverture(a) && ouverture(a) === ouverture(b)) return i;
      if (t6Similarity(a, b) >= 0.8) return i;
    }
  }
  return null;
}

/** R11 : le paragraphe garde-t-il la date absolue et l'objet du sujet ? (pure, testée) */
export function keepsEssentialFacts(text: string, facts: MascotFacts): boolean {
  const t = plainT6(text);
  const dateLabel = typeof facts.dateLabel === 'string' ? facts.dateLabel : null;
  if (dateLabel && !t.includes(plainT6(dateLabel))) {
    const chiffres = dateLabel.match(/\d+/g) ?? [];
    const presents = new Set((text.match(/\d+/g) ?? []).map((n) => String(Number(n))));
    if (chiffres.length === 0 || !chiffres.every((c) => presents.has(String(Number(c))))) return false;
  }
  for (const k of ['title', 'firstTitle', 'secondTitle', 'documentTitle'] as const) {
    const v = facts[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    const mots = [...motsSignificatifs(v)];
    if (mots.length && !mots.some((w) => t.includes(w))) return false;
  }
  return true;
}

/** R9 : nuances par intention et nature de tuile. Rend le motif d'écart, ou null (pure, testée). */
export function nuanceViolation(text: string, s: T6InputSubject, kind: T6SubjectKind | undefined): string | null {
  const t = plainT6(text);
  // Un mot repris des faits (titre « Contrôle urgence gaz ») n'est pas un ajout.
  const faits = plainT6(`${JSON.stringify(s.facts)} ${s.fallbackText}`);
  const horsFaits = (re: RegExp) => [...t.matchAll(new RegExp(re.source, 'g'))].some((m) => !faits.includes(m[0]));
  if (horsFaits(ALARME)) return 'alarmist';
  if (horsFaits(INTERFACE)) return 'interface';
  if (kind !== 'overdue' && horsFaits(RETARD)) return 'overdue_wording';
  if (s.intent === 'inform' && horsFaits(INJONCTION)) return 'inform_injunction';
  if (s.intent === 'deadline' && s.facts.dateNature === 'confirmée' && horsFaits(ESTIMATION)) return 'confirmed_as_forecast';
  return null;
}

export interface T6MasterValidationOptions {
  /** Nature de tuile par sujet (même ordre), pour R9. */
  kinds?: Array<T6SubjectKind | undefined>;
  /**
   * R8 dans le temps : textes FIGÉS des sujets inchangés depuis la bulle
   * précédente (index du sujet → message). Recollés AVANT les contrôles
   * R9/R11/R8, qui s'appliquent donc à la bulle réellement affichée.
   */
  pinned?: ReadonlyMap<number, T6Message>;
}

export type T6MasterValidation =
  | { ok: true; messages: T6Message[]; adjustments: string[]; fallbackSubjects: number[] }
  | { ok: false; reason: string };

/** Paragraphe de secours d'un sujet (R11 : au plus près de `fallbackText`). */
function secours(s: T6InputSubject): T6Message {
  const hl = s.allowedHighlight && s.fallbackText.includes(s.allowedHighlight) ? s.allowedHighlight : null;
  return { subjectId: s.subjectId, text: s.fallbackText, highlight: hl };
}

/**
 * Validation de la sortie du master T6 (CDC 15 §28).
 *
 * REJET DE TOUTE LA BULLE (texte de secours complet) dans deux cas :
 *   · sortie structurellement invalide — contrat v2, nombre, ordre ou
 *     identifiants des sujets, et contrôles historiques de chaque paragraphe
 *     (longueur, emoji, date relative, tutoiement, nombre inventé,
 *     prévisionnel présenté comme certain) ;
 *   · violation R8, R9 ou R11 qui touche TOUS les sujets.
 * Sinon, REPLI SUJET PAR SUJET : seul le paragraphe fautif (R9 nuance, R11
 * faits perdus, R8 répétition d'un paragraphe précédent) reprend son
 * `fallbackText` ; les autres restent formulés. Les sujets figés (R8 dans le
 * temps) sont recollés avant ces contrôles.
 */
export function validateT6MasterOutput(input: T6Input, raw: unknown, opts: T6MasterValidationOptions = {}): T6MasterValidation {
  const v2 = T6FormulateOutput.safeParse(raw);
  if (!v2.success) return { ok: false, reason: 'schema_v2' };
  const base = validateT6Output(input, v2.data);
  if (!base.ok) return base;
  const adjustments: string[] = [];
  const fallbackSubjects: number[] = [];
  const motifs: string[] = [];
  const replier = (i: number, motif: string) => {
    fallbackSubjects.push(i);
    motifs.push(`${motif}:${i}`);
    adjustments.push(`${motif.split('_')[0]}_fallback:${i}`);
    return secours(input.subjects[i]);
  };

  // 1. Recollage des sujets figés, puis R9 et R11 par sujet.
  const messages = base.messages.map((m0, i) => {
    const s = input.subjects[i];
    const fige = opts.pinned?.get(i);
    const m = fige && fige.subjectId === s.subjectId ? fige : m0;
    if (m !== m0) adjustments.push(`r8_pinned:${i}`);
    const r9 = nuanceViolation(m.text, s, opts.kinds?.[i]);
    if (r9) return replier(i, `r9_${r9}`);
    if (!keepsEssentialFacts(m.text, s.facts)) return replier(i, 'r11_facts');
    return m;
  });

  // 2. R8 entre sujets : le paragraphe qui répète un paragraphe précédent
  //    reprend son texte de secours (un sujet figé l'emporte sur un nouveau).
  for (let i = 1; i < messages.length; i++) {
    if (fallbackSubjects.includes(i)) continue;
    for (let j = 0; j < i; j++) {
      if (mechanicalRepetition([messages[j], messages[i]]) === null) continue;
      const cible = opts.pinned?.has(i) && !opts.pinned?.has(j) && !fallbackSubjects.includes(j) ? j : i;
      messages[cible] = replier(cible, 'r8_repetition');
      break;
    }
  }

  // 3. Violation qui touche tous les sujets : rejet de la bulle.
  if (fallbackSubjects.length >= input.subjects.length) return { ok: false, reason: motifs[0] ?? 'all_subjects' };
  return { ok: true, messages, adjustments, fallbackSubjects: [...fallbackSubjects].sort((a, b) => a - b) };
}

/**
 * Taux de repli d'un ensemble de cas (pure, testée) : part des sujets qui
 * affichent leur texte de secours — bulle rejetée (tous ses sujets) ou repli
 * sujet par sujet.
 */
export function t6FallbackRate(results: Array<{ subjects: number; validation: T6MasterValidation }>): number {
  let total = 0;
  let replis = 0;
  for (const r of results) {
    total += r.subjects;
    replis += r.validation.ok ? r.validation.fallbackSubjects.length : r.subjects;
  }
  return total === 0 ? 0 : replis / total;
}

/**
 * Corpus P-T6-01 (CDC 15 §30) : aucun fait supplémentaire, mêmes subjectId
 * et même ordre — contrôle serveur complet sur une sortie enregistrée.
 * Rend la liste des écarts (vide si conforme). Destiné à l'évaluateur
 * `t6_formulate` du corpus rejoué (A).
 */
export function evaluateT6CorpusCase(
  context: { input: T6Input; kinds?: Array<T6SubjectKind | undefined> },
  output: unknown,
  expected: { valid?: boolean; subjectIds?: string[]; reason?: string; fallbackSubjects?: number[] } | null,
): string[] {
  const r = validateT6MasterOutput(context.input, output, { kinds: context.kinds });
  const errors: string[] = [];
  const attenduValide = expected?.valid ?? true;
  if (r.ok !== attenduValide) errors.push(`validation ${r.ok ? 'acceptée' : `rejetée (${(r as { reason: string }).reason})`}, attendu ${attenduValide ? 'acceptée' : 'rejetée'}`);
  if (r.ok && expected?.subjectIds && JSON.stringify(r.messages.map((m) => m.subjectId)) !== JSON.stringify(expected.subjectIds)) {
    errors.push('subjectId ou ordre différents');
  }
  if (!r.ok && expected?.reason && !r.reason.startsWith(expected.reason)) errors.push(`motif ${r.reason} ≠ ${expected.reason}`);
  if (r.ok && expected?.fallbackSubjects && JSON.stringify(r.fallbackSubjects) !== JSON.stringify(expected.fallbackSubjects)) {
    errors.push(`repli ${JSON.stringify(r.fallbackSubjects)} ≠ ${JSON.stringify(expected.fallbackSubjects)}`);
  }
  return errors;
}

/**
 * Déclaration de l'opération master T6 au registre (`ai/registry/operations.ts`) :
 * sortie master sans champ discriminant (§28 : `{schemaVersion, messages}`,
 * sans `mode`), délai 8 s, non facturée. Seule opération de T6 depuis le lot
 * 16b (`formulate_mascot` retirée). Un test vérifie la cohérence avec le registre.
 */
export const T6_MASTER_OPERATION_SPEC = {
  operationCode: 't6_formulate',
  useCaseCode: 'HOME_MASCOT',
  promptCode: T6_MASTER_PROMPT_CODE,
  masterPromptCode: T6_MASTER_PROMPT_CODE,
  task: T6_MASTER_MODE,
  taskField: 'none',
  promptVariables: ['INPUT_JSON'],
  outputSchema: 'T6FormulateOutput',
  timeoutMs: 8_000,
  jsonResponse: true,
  billable: false,
} as const;
