/**
 * T6 — contrat d'entrée et de sortie, validation (CDC Mascotte §13, annexe C).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * T6 FORMULE (MODE=FORMULATE), IL NE DÉCIDE RIEN DANS CE MODE
 *
 * Lot 61 : la pertinence d'interpeller est jugée dans un mode DISTINCT
 * (MODE=EVALUATE, contrat `t6-evaluation-v1`, fin de ce fichier) ; le
 * serveur applique ensuite sa décision (`decideT6Interpellation`) et ne
 * transmet à FORMULATE que les sujets retenus.
 *
 * En FORMULATE, il reçoit les sujets déjà choisis, dans l'ordre, et rend un paragraphe par
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
import { hasCountingIntro } from './counting-intro';

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
export const TUTOIEMENT = /(^|[\s,;:(«"'’])(tu|toi|ton|ta|tes|te|t['’])(?=[\s,.;:!?»")]|$)/i;
export const EMOJI = /\p{Extended_Pictographic}/u;
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
// Le master porte deux branches imposées par le serveur (lot 61) : EVALUATE
// (`t6_evaluate`, plus bas) et FORMULATE (`t6_formulate`, ci-dessous).
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
  /**
   * Lot 55A (T6 / T2) : questions suggérées, FACULTATIVES (R12 du master,
   * `{{SUGGESTION_CONTEXT}}`). Volontairement non typées ici : une liste mal
   * formée ne doit jamais rejeter la bulle — elle est validée à part, élément
   * par élément (`validateT6Suggestions`), et abandonnée au moindre doute.
   */
  suggestions: z.unknown().optional(),
  // Lot 61 : plus d'`assessments` (R13 du lot 60) — l'évaluation est un MODE
  // distinct (`t6_evaluate`, contrat `t6-evaluation-v1`). Un champ en trop
  // d'une version BO antérieure est retiré par le schéma, jamais lu.
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
/**
 * Lot 50 : vocabulaire d'un événement ORGANISÉ — interdit pour une date à
 * respecter (`dateRole` DEADLINE) : une échéance certaine n'est pas un
 * rendez-vous pris. « Prévu » reste admis (prévision, date estimée).
 */
const ORGANISE = /\b(rendez-vous|rdv|reserve|reservee|reserves|reservees|organise|organisee|planifie|planifiee|programme|programmee|rendez vous)\b/;
/**
 * Lot 53 (retour PO D27) : aucune donnée de Verebona ne prouve une
 * réservation effective — un sujet daté (échéance OU événement saisi par
 * l'utilisateur) n'est jamais dit « confirmé », « réservé » ou « pris »,
 * sauf si le mot vient des faits (titre saisi). La nature de la date
 * (« confirmée » = certaine, par opposition à estimée) n'est pas une
 * confirmation de rendez-vous et ne compte pas comme fait ici.
 */
const CONFIRMATION = /\b(confirme|confirmee|confirmes|confirmees|reserve|reservee|reserves|reservees|rendez-vous pris|rdv pris|rendez vous pris|cale|calee)\b/;
/** R5 : interface et navigation. */
const INTERFACE = /\b(bouton|boutons|cliquez|cliquer|clic|menu|onglet|ecran|lien ci|ci-dessous|ci-dessus)\b/;

/**
 * Lot 68 : formules MÉCANIQUES retirées de la bulle — introductions de
 * comptage (« Un sujet mérite votre attention aujourd'hui », « Deux sujets
 * méritent… », « … nécessitent votre attention ») et préfixe « À prévoir : »
 * concaténé au texte. Un message IA, de secours ou EN CACHE qui les porte
 * n'est jamais affiché tel quel (texte de secours du sujet, entrée de cache
 * ignorée puis renouvelée).
 */
const MECANIQUE = /(^|[\s.;:])(a prevoir\s*:|(un|une|deux|trois|quatre|\d+|plusieurs)\s+sujets?\s+(merite|meritent|necessite|necessitent)\s+votre attention)/;
/**
 * Lot 68 : le texte porte-t-il une formule mécanique de la bulle ? (pure, testée T6-RAP)
 * Lot 71F : toute introduction de comptage (`hasCountingIntro` : nombres,
 * « points », « éléments », « demandent / requièrent… », « Voici deux
 * sujets »), accents, apostrophes et pluriel indifférents — sans dépendre
 * du prompt T6 en service.
 */
export function mechanicalWording(text: string): boolean {
  return MECANIQUE.test(plainT6(text)) || hasCountingIntro(text);
}

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

/** Lot 50 : toutes les dates du sujet sont des dates à respecter (aucun événement planifié). */
function onlyDeadlines(s: T6InputSubject): boolean {
  const roles = [s.facts.dateRole, s.facts.firstDateRole, s.facts.secondDateRole].filter((r) => r != null);
  return roles.length > 0 && roles.every((r) => r === 'DEADLINE');
}

/** Lot 53 (D27) : le sujet porte au moins une date d'agenda (échéance ou événement). */
function hasDateRole(s: T6InputSubject): boolean {
  return [s.facts.dateRole, s.facts.firstDateRole, s.facts.secondDateRole].some((r) => r != null);
}

/** R9 : nuances par intention et nature de tuile. Rend le motif d'écart, ou null (pure, testée). */
export function nuanceViolation(text: string, s: T6InputSubject, kind: T6SubjectKind | undefined): string | null {
  const t = plainT6(text);
  // Un mot repris des faits (titre « Contrôle urgence gaz ») n'est pas un ajout.
  const faits = plainT6(`${JSON.stringify(s.facts)} ${s.fallbackText}`);
  const horsFaits = (re: RegExp) => [...t.matchAll(new RegExp(re.source, 'g'))].some((m) => !faits.includes(m[0]));
  if (mechanicalWording(text)) return 'mechanical_wording';
  if (horsFaits(ALARME)) return 'alarmist';
  if (horsFaits(INTERFACE)) return 'interface';
  if (kind !== 'overdue' && horsFaits(RETARD)) return 'overdue_wording';
  if (s.intent === 'inform' && horsFaits(INJONCTION)) return 'inform_injunction';
  // Lot 68 : un rappel informatif (`inform`, daté) garde aussi la nature de sa date.
  if ((s.intent === 'deadline' || s.intent === 'inform') && s.facts.dateNature === 'confirmée' && horsFaits(ESTIMATION)) return 'confirmed_as_forecast';
  if (onlyDeadlines(s) && horsFaits(ORGANISE)) return 'deadline_as_appointment';
  if (hasDateRole(s)) {
    const { dateNature: _n, ...sansNature } = s.facts as Record<string, unknown>;
    void _n;
    const faitsSansNature = plainT6(`${JSON.stringify(sansNature)} ${s.fallbackText}`);
    if ([...t.matchAll(new RegExp(CONFIRMATION.source, 'g'))].some((m) => !faitsSansNature.includes(m[0]))) return 'unproven_confirmation';
  }
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

  // 3. Violation qui touche tous les sujets : rejet de la bulle. Lot 55A :
  //    une bulle SANS sujet (questions suggérées seules) n'a rien à rejeter.
  if (input.subjects.length > 0 && fallbackSubjects.length >= input.subjects.length) return { ok: false, reason: motifs[0] ?? 'all_subjects' };
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
 * sans `mode`), délai 8 s, non facturée (`formulate_mascot` retirée au lot
 * 16b ; lot 61 : `t6_evaluate` à côté). Un test vérifie la cohérence avec le registre.
 */
export const T6_MASTER_OPERATION_SPEC = {
  operationCode: 't6_formulate',
  useCaseCode: 'HOME_MASCOT',
  promptCode: T6_MASTER_PROMPT_CODE,
  masterPromptCode: T6_MASTER_PROMPT_CODE,
  task: T6_MASTER_MODE,
  taskField: 'none',
  // Lot 55A : `SUGGESTION_CONTEXT` FACULTATIF (`OPTIONAL_MASTER_VARIABLES`) —
  // une version BO antérieure qui ne le porte pas reste valable (aucune question).
  // `INTERPELLATION_CONTEXT` FACULTATIF de même : toujours null en FORMULATE
  // (lot 61) — fourni pour qu'une version BO du lot 60 qui le porte se rende.
  promptVariables: ['INPUT_JSON', 'SUGGESTION_CONTEXT', 'INTERPELLATION_CONTEXT'],
  outputSchema: 'T6FormulateOutput',
  timeoutMs: 8_000,
  jsonResponse: true,
  billable: false,
} as const;

// ══════════════════════════════════════════════════════════════════════════
// MODE EVALUATE — lot 61 (ticket « [P2] T6 — Implémenter le nouveau contrat
// de décision IA et fiabiliser la composition de la bulle d'accueil »)
//
// Deux contrats COEXISTENT sur le même prompt maître :
//   · `t6_evaluate` (MODE=EVALUATE) : entrée `t6-evaluation-input-v1`,
//     sortie `t6-evaluation-v1` — l'IA juge la PERTINENCE d'interpeller sur
//     chaque candidat (décision, catégorie, motif fermé, preuves) ;
//   · `t6_formulate` (MODE=FORMULATE) : `t6-output-v2`, INCHANGÉ — l'IA
//     rédige seulement les sujets retenus par le serveur.
//
// La sortie EVALUATE est contrôlée en deux temps :
//   1. Zod strict (`T6EvaluateOutput`) : schéma, énumérations, dates ISO
//      réelles — un écart rejette TOUTE la sortie ;
//   2. contrôles métier (`validateT6Evaluation`) : exactement une décision
//      par candidat, mêmes identifiants, même ordre (sinon rejet complet) ;
//      puis, décision par décision, motif compatible avec la décision,
//      justification, action identifiable et preuve pour SHOW_NOW, preuves
//      connues, dates cohérentes.
//      Lot 68 : SHOW_NOW + INFORMATION est admis pour un RAPPEL INFORMATIF
//      (motif `INFORMATIVE_REMINDER`, `expectedAction` et `actionDeadline`
//      null, preuve citée, événement à venir) ; SHOW_NOW + ACTION_NOW /
//      TO_ANTICIPATE exige toujours son action (aucune conversion). Une décision fautive est REJETÉE (motif
//      tracé) : son candidat reste « en attente », jamais affiché d'office.
// Jamais d'acceptation silencieuse : chaque rejet porte son motif.
// ══════════════════════════════════════════════════════════════════════════

export const T6_EVALUATE_MODE = 'EVALUATE';
export const T6_EVALUATION_INPUT_SCHEMA_VERSION = 't6-evaluation-input-v1';
export const T6_EVALUATION_OUTPUT_SCHEMA_VERSION = 't6-evaluation-v1';

export const T6_EVAL_DECISIONS = ['SHOW_NOW', 'DEFER', 'SUPPRESS'] as const;
export const T6_EVAL_CATEGORIES = ['ACTION_NOW', 'TO_ANTICIPATE', 'INFORMATION'] as const;
export const T6_EVAL_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type T6EvalDecision = (typeof T6_EVAL_DECISIONS)[number];
export type T6EvalCategory = (typeof T6_EVAL_CATEGORIES)[number];
export type T6EvalPriority = (typeof T6_EVAL_PRIORITIES)[number];

/**
 * Référentiel FERMÉ des motifs (`reasonCode`), recopié dans le prompt maître
 * (section EVALUATE) — chaque motif n'est admis qu'avec sa décision.
 */
export const T6_REASON_CODES = {
  // SHOW_NOW — une action ou une vérification identifiable justifie d'interpeller.
  ACTION_REQUIRED_SOON: 'SHOW_NOW',
  PREPARATION_NEEDED_NOW: 'SHOW_NOW',
  NOTICE_PERIOD_RUNNING: 'SHOW_NOW',
  OVERDUE_ACTION_PENDING: 'SHOW_NOW',
  VERIFICATION_REQUIRED: 'SHOW_NOW',
  QUALIFICATION_REQUIRED: 'SHOW_NOW',
  // Lot 68 : SHOW_NOW + INFORMATION — rappel PERTINENT d'un événement à venir,
  // sans action attendue (`expectedAction` null). Jamais déduit de l'absence
  // d'action : l'IA doit l'évaluer et le justifier (preuve obligatoire).
  INFORMATIVE_REMINDER: 'SHOW_NOW',
  // DEFER — démarche utile plus tard, solliciter maintenant serait prématuré.
  TOO_EARLY: 'DEFER',
  AWAITING_INFORMATION: 'DEFER',
  // SUPPRESS — aucune interpellation (l'information reste dans l'agenda).
  NO_ACTION_REQUIRED: 'SUPPRESS',
  ALREADY_HANDLED: 'SUPPRESS',
  OVERDUE_NO_ACTION_IDENTIFIED: 'SUPPRESS',
  INSUFFICIENT_CONTEXT: 'SUPPRESS',
  RECENTLY_SHOWN_NO_CHANGE: 'SUPPRESS',
} as const satisfies Record<string, T6EvalDecision>;
export type T6ReasonCode = keyof typeof T6_REASON_CODES;
export const T6_REASON_CODE_LIST = Object.keys(T6_REASON_CODES) as T6ReasonCode[];
/** Lot 68 : motif dédié du rappel informatif (SHOW_NOW + INFORMATION, sans action). */
export const T6_INFORMATIVE_REMINDER_CODE = 'INFORMATIVE_REMINDER' as const satisfies T6ReasonCode;

/**
 * Nature d'une référence justificative transmise (suffixe de `evidence[].ref`).
 * Lot 71G (T6-04) : `DOCUMENT_FACT` — fait réellement extrait d'un document
 * (T1/T3 : préavis, renouvellement, obligation, intervention…), `Cn.factN`.
 */
export type T6EvidenceKind = 'TITLE' | 'DUE_DATE' | 'DESCRIPTION' | 'DOCUMENT' | 'DOCUMENT_FACT' | 'ASSET' | 'SERIES' | 'HISTORY';

/**
 * Lot 71G (T6-04) — fait documentaire transmis à EVALUATE : extrait
 * justificatif, document source (`Cn.docM`), provenance et statut —
 * `PROVEN` (information prouvée par l'extrait), `DEDUCED` (déduction de
 * l'extraction), `UNCERTAIN` (sources en conflit). Ajout de contexte
 * COMPATIBLE avec `t6-evaluation-input-v1` : une version du prompt qui ne le
 * mentionne pas le reçoit comme une preuve référencée parmi d'autres.
 */
export interface T6EvaluationFact {
  ref: string;
  /** Référence du document source (`Cn.docM`), ou null. */
  document: string | null;
  label: string;
  value: string | null;
  excerpt: string | null;
  status: 'PROVEN' | 'DEDUCED' | 'UNCERTAIN';
  provenance: string;
}

export interface T6EvidenceRef { ref: string; kind: T6EvidenceKind }

/** Candidat transmis à EVALUATE (`subjectId` opaque C1…Cn : aucun identifiant de base). */
export interface T6EvaluationCandidate {
  subjectId: string;
  title: string;
  description: string | null;
  assetName: string | null;
  assetCategory: string | null;
  dueDate: string | null;
  dateLabel: string | null;
  daysUntilDue: number | null;
  dateNature: 'confirmée' | 'prévisionnelle';
  dateRole: string | null;
  overdue: boolean;
  requiresQualification: boolean;
  recurring: boolean;
  /**
   * Titres des documents liés — lot 71G : choisis selon leur pertinence
   * métier (document d'origine, documents porteurs de faits), 5 au plus ;
   * l'intitulé seul ne fonde jamais une obligation.
   */
  documents: string[];
  /** Lot 71G (T6-04) : faits documentaires pertinents (8 au plus), absents s'il n'y en a pas. */
  facts?: T6EvaluationFact[];
  /** Jours où ce sujet a déjà été présenté récemment. */
  recentlyShownDays: number;
  /** Références justificatives AUTORISÉES pour ce candidat (`evidenceRefs` ⊆). */
  evidence: T6EvidenceRef[];
}

/** Contrat d'entrée `t6-evaluation-input-v1`. */
export interface T6EvaluationInput {
  schemaVersion: typeof T6_EVALUATION_INPUT_SCHEMA_VERSION;
  today: string;
  thresholdDays: number;
  candidates: T6EvaluationCandidate[];
}

/** Date ISO RÉELLE (AAAA-MM-JJ, jour existant). */
export function isIsoDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}
const isoDay = z.string().refine(isIsoDay, { message: 'date ISO AAAA-MM-JJ réelle attendue' });

/** Contrat de sortie `t6-evaluation-v1` (Zod strict : énumérations et dates contrôlées). */
export const T6EvaluateOutput = z.object({
  schemaVersion: z.literal(T6_EVALUATION_OUTPUT_SCHEMA_VERSION),
  decisions: z.array(z.object({
    subjectId: z.string().min(1),
    decision: z.enum(T6_EVAL_DECISIONS),
    category: z.enum(T6_EVAL_CATEGORIES),
    reasonCode: z.enum(T6_REASON_CODE_LIST as [T6ReasonCode, ...T6ReasonCode[]]),
    reason: z.string(),
    expectedAction: z.string().nullable(),
    actionDeadline: isoDay.nullable(),
    suggestedReviewAt: isoDay.nullable(),
    priorityHint: z.enum(T6_EVAL_PRIORITIES).nullable(),
    evidenceRefs: z.array(z.string()),
    uncertainties: z.array(z.string()),
  })),
});
export type T6EvaluateOutput = z.infer<typeof T6EvaluateOutput>;

/** Décision validée (contrôles métier passés), prête à être conservée. */
export interface T6ValidatedDecision {
  subjectId: string;
  decision: T6EvalDecision;
  category: T6EvalCategory;
  reasonCode: T6ReasonCode;
  reason: string;
  expectedAction: string | null;
  actionDeadline: string | null;
  suggestedReviewAt: string | null;
  priorityHint: T6EvalPriority | null;
  evidenceRefs: string[];
  uncertainties: string[];
}

export interface T6EvaluationRejection { subjectId: string; index: number; reason: string }

export type T6EvaluationValidation =
  | { ok: true; accepted: T6ValidatedDecision[]; rejected: T6EvaluationRejection[] }
  | { ok: false; reason: string };

export const T6_EVAL_REASON_MIN = 10;
export const T6_EVAL_REASON_MAX = 400;
export const T6_EVAL_ACTION_MAX = 160;
export const T6_EVAL_REVIEW_MAX_DAYS = 366;
const UNCERTAINTIES_MAX = 5;

const clean = (v: string | null | undefined, max: number): string | null => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};
const jours = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Contrôles métier d'UNE décision (pure) : motif du rejet, ou null. */
export function evaluationDecisionViolation(d: T6EvaluateOutput['decisions'][number], c: T6EvaluationCandidate, today: string): string | null {
  if (T6_REASON_CODES[d.reasonCode] !== d.decision) return 'reason_code_mismatch';
  const reason = clean(d.reason, T6_EVAL_REASON_MAX);
  if (!reason || reason.length < T6_EVAL_REASON_MIN) return 'reason_missing';
  const autorisees = new Set(c.evidence.map((e) => e.ref));
  if (d.evidenceRefs.some((r) => !autorisees.has(r.trim()))) return 'unknown_evidence';
  const action = clean(d.expectedAction, T6_EVAL_ACTION_MAX);
  if (action && (EMOJI.test(action) || TUTOIEMENT.test(action))) return 'action_wording';
  if (d.decision === 'SHOW_NOW' && d.category === 'INFORMATION') {
    // Lot 68 — rappel informatif : motif dédié, aucune action ni date pour
    // agir, preuve citée, événement À VENIR (jamais une échéance passée ou du
    // jour réintroduite comme « information »).
    if (d.reasonCode !== T6_INFORMATIVE_REMINDER_CODE) return 'show_now_information';
    if (action || d.actionDeadline) return 'information_with_action';
    if (d.evidenceRefs.length === 0) return 'show_now_without_evidence';
    if (!c.dueDate || c.dueDate <= today || c.requiresQualification) return 'information_not_upcoming';
  } else if (d.decision === 'SHOW_NOW') {
    // ACTION_NOW / TO_ANTICIPATE : action concrète TOUJOURS obligatoire — son
    // absence rejette la décision, jamais convertie en rappel informatif.
    if (d.reasonCode === T6_INFORMATIVE_REMINDER_CODE) return 'reminder_category_mismatch';
    if (!action) return 'show_now_without_action';
    if (d.evidenceRefs.length === 0) return 'show_now_without_evidence';
  }
  if (d.actionDeadline) {
    if (d.actionDeadline < today) return 'action_deadline_past';
    if (c.dueDate && c.dueDate > today && d.actionDeadline > c.dueDate) return 'action_deadline_after_due';
  }
  if (d.suggestedReviewAt) {
    if (d.suggestedReviewAt <= today) return 'review_not_future';
    if (jours(today, d.suggestedReviewAt) > T6_EVAL_REVIEW_MAX_DAYS) return 'review_too_far';
  }
  return null;
}

/**
 * Validation de la sortie EVALUATE contre l'entrée transmise (pure, testée
 * T6-EV-01 à T6-EV-05). Structure, nombre, identifiants ou ordre faux :
 * rejet COMPLET. Sinon, décision par décision : acceptée ou rejetée (motif).
 */
export function validateT6Evaluation(input: T6EvaluationInput, raw: unknown): T6EvaluationValidation {
  const parsed = T6EvaluateOutput.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, reason: `schema:${i ? i.path.join('.') || '$' : '$'}` };
  }
  const { decisions } = parsed.data;
  if (decisions.length !== input.candidates.length) return { ok: false, reason: 'count' };
  for (let i = 0; i < decisions.length; i++) {
    if (decisions[i].subjectId !== input.candidates[i].subjectId) return { ok: false, reason: `order:${i}` };
  }
  const accepted: T6ValidatedDecision[] = [];
  const rejected: T6EvaluationRejection[] = [];
  decisions.forEach((d, i) => {
    const c = input.candidates[i];
    const motif = evaluationDecisionViolation(d, c, input.today);
    if (motif) { rejected.push({ subjectId: c.subjectId, index: i, reason: motif }); return; }
    accepted.push({
      subjectId: c.subjectId, decision: d.decision, category: d.category, reasonCode: d.reasonCode,
      reason: clean(d.reason, T6_EVAL_REASON_MAX)!,
      expectedAction: clean(d.expectedAction, T6_EVAL_ACTION_MAX),
      actionDeadline: d.actionDeadline, suggestedReviewAt: d.suggestedReviewAt, priorityHint: d.priorityHint,
      evidenceRefs: [...new Set(d.evidenceRefs.map((r) => r.trim()))],
      uncertainties: d.uncertainties.map((u) => clean(u, 200)).filter((u): u is string => !!u).slice(0, UNCERTAINTIES_MAX),
    });
  });
  return { ok: true, accepted, rejected };
}

/**
 * Corpus P-T6-EV (CDC 15 §30) : contrôle serveur complet d'une sortie
 * EVALUATE enregistrée. Rend la liste des écarts (vide si conforme).
 */
export function evaluateT6EvaluationCorpusCase(
  context: { input: T6EvaluationInput },
  output: unknown,
  expected: { valid?: boolean; reason?: string; accepted?: string[]; rejected?: Array<{ subjectId: string; reason: string }> } | null,
): string[] {
  const r = validateT6Evaluation(context.input, output);
  const errors: string[] = [];
  const attendu = expected?.valid ?? true;
  if (r.ok !== attendu) errors.push(`validation ${r.ok ? 'acceptée' : `rejetée (${(r as { reason: string }).reason})`}, attendu ${attendu ? 'acceptée' : 'rejetée'}`);
  if (!r.ok && expected?.reason && !r.reason.startsWith(expected.reason)) errors.push(`motif ${r.reason} ≠ ${expected.reason}`);
  if (r.ok && expected?.accepted && JSON.stringify(r.accepted.map((d) => d.subjectId)) !== JSON.stringify(expected.accepted)) {
    errors.push(`décisions acceptées ${JSON.stringify(r.accepted.map((d) => d.subjectId))} ≠ ${JSON.stringify(expected.accepted)}`);
  }
  if (r.ok && expected?.rejected && JSON.stringify(r.rejected.map((x) => ({ subjectId: x.subjectId, reason: x.reason }))) !== JSON.stringify(expected.rejected)) {
    errors.push(`rejets ${JSON.stringify(r.rejected)} ≠ ${JSON.stringify(expected.rejected)}`);
  }
  return errors;
}

/** Déclaration de l'opération EVALUATE au registre (cohérence testée). */
export const T6_EVALUATE_OPERATION_SPEC = {
  operationCode: 't6_evaluate',
  useCaseCode: 'HOME_MASCOT',
  promptCode: T6_MASTER_PROMPT_CODE,
  masterPromptCode: T6_MASTER_PROMPT_CODE,
  task: T6_EVALUATE_MODE,
  taskField: 'none',
  // Mêmes emplacements que FORMULATE : en EVALUATE, les candidats passent par
  // `{{INTERPELLATION_CONTEXT}}` (contrat t6-evaluation-input-v1), les deux
  // autres valent null.
  promptVariables: ['INPUT_JSON', 'SUGGESTION_CONTEXT', 'INTERPELLATION_CONTEXT'],
  outputSchema: 'T6EvaluateOutput',
  timeoutMs: 15_000,
  jsonResponse: true,
  billable: false,
} as const;
