/**
 * MascotSelector — CDC Mascotte §6 (hiérarchie), §12 (éléments secondaires),
 * annexe B (questions T2).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE HIÉRARCHIE, PAS UN SCORE
 *
 * Les candidats arrivent déjà rangés : famille par famille, dans l'ordre
 * Traitement → Onboarding → À traiter → Date → Recommandation, et dans
 * chaque famille selon la priorité de la source. Choisir revient donc à
 * prendre les deux premiers qui ne sont pas un doublon l'un de l'autre
 * (SEL-001 à SEL-003). Aucun bonus, aucun malus, aucun historique
 * d'affichage (SEL-007, SEL-009, GEN-004).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type {
  MascotAction, MascotSecondary, MascotSubject,
} from './types';
import { MAX_ACTIONS_TOTAL, MAX_SECONDARIES, MAX_SUBJECTS } from './types';
import type { MascotCandidates } from './signals';

/** SEL-001 à SEL-003 : au plus deux sujets distincts. */
export function selectSubjects(candidates: MascotSubject[]): MascotSubject[] {
  const retenus: MascotSubject[] = [];
  const cles = new Set<string>();
  for (const c of candidates) {
    if (retenus.length >= MAX_SUBJECTS) break;
    if (cles.has(c.occurrenceKey) || c.dedupeKeys.some((k) => cles.has(k))) continue;
    retenus.push(c);
    cles.add(c.occurrenceKey);
    c.dedupeKeys.forEach((k) => cles.add(k));
  }
  return retenus;
}

// ── Questions T2 (§12, annexe B) ─────────────────────────────────────────────

export interface QuestionDefinition {
  code: string;
  label: (ctx: { assetName?: string | null }) => string;
  intent: string;
}

/** Catalogue V1 — liste autorisée (Q-001). T6 n'en génère jamais (SEC-003). */
export const T2_QUESTIONS: Record<string, QuestionDefinition> = {
  'Q-EMPTY-ADD': { code: 'Q-EMPTY-ADD', label: () => 'Comment ajouter un bien ?', intent: 'help_add_asset' },
  'Q-EMPTY-SCOPE': { code: 'Q-EMPTY-SCOPE', label: () => 'Que puis-je suivre avec Verebona ?', intent: 'help_scope' },
  'Q-EMPTY-AI': { code: 'Q-EMPTY-AI', label: () => 'L’analyse automatique, c’est quoi ?', intent: 'help_analysis' },
  'Q-TODO': { code: 'Q-TODO', label: () => 'Que dois-je faire aujourd’hui ?', intent: 'account_next_actions' },
  'Q-NEXT-DATE': { code: 'Q-NEXT-DATE', label: () => 'Quelle est ma prochaine échéance ?', intent: 'next_deadline' },
  'Q-ANALYSIS': { code: 'Q-ANALYSIS', label: () => 'Où en est l’analyse de mes documents ?', intent: 'document_analysis_status' },
  'Q-ASSET': { code: 'Q-ASSET', label: ({ assetName }) => `Que sais-tu sur ${assetName} ?`, intent: 'asset_summary' },
};

function questionAction(code: string, assetId?: number | null, assetName?: string | null): MascotSecondary {
  const def = T2_QUESTIONS[code];
  const question = def.label({ assetName });
  return {
    id: `Q:${code}`,
    kind: 'question',
    sourceCode: code,
    occurrenceKey: `Q:${code}${assetId ? `:${assetId}` : ''}`,
    action: {
      actionId: `Q:${code}`,
      label: question,
      target: {
        kind: 'ask', question,
        context: { intent: def.intent, ...(assetId ? { assetId } : {}) },
      },
    },
  };
}

/**
 * Questions éligibles, dans l'ordre du catalogue, sans celles qui répètent un
 * sujet déjà affiché (SEC-004, T2-02).
 */
export function eligibleQuestions(
  input: MascotCandidates,
  shown: MascotSubject[],
  onboarding: 'ONB-ASSET' | 'ONB-DOC' | null,
): MascotSecondary[] {
  const codes = new Set(shown.map((s) => s.sourceCode));
  const familles = new Set(shown.map((s) => s.sourceFamily));
  const out: MascotSecondary[] = [];

  if (onboarding === 'ONB-ASSET') {
    out.push(questionAction('Q-EMPTY-ADD'), questionAction('Q-EMPTY-SCOPE'));
  }
  if (onboarding) out.push(questionAction('Q-EMPTY-AI'));
  if (input.hints.hasToProcess && !familles.has('TO_PROCESS')) out.push(questionAction('Q-TODO'));
  if (input.hints.hasFutureDate && !familles.has('DATE')) out.push(questionAction('Q-NEXT-DATE'));
  if ((input.hints.hasDocuments || input.hints.hasProcessing) && !codes.has('PROC-DOC-ANALYSIS')) {
    out.push(questionAction('Q-ANALYSIS'));
  }
  // Q-ASSET : un seul bien est clairement le contexte des sujets affichés.
  const biens = new Map(shown.filter((s) => s.assetId).map((s) => [s.assetId!, s.assetName ?? null]));
  if (shown.length > 0 && biens.size === 1 && shown.every((s) => s.assetId)) {
    const [[assetId, assetName]] = [...biens.entries()];
    if (assetName) out.push(questionAction('Q-ASSET', assetId, assetName));
  }
  return out;
}

// ── Éléments secondaires (§12) ───────────────────────────────────────────────

/**
 * SEC-001, SEC-002, SEL-006 :
 *   1. l'onboarding actif, s'il n'est pas déjà dans le discours (place réservée) ;
 *   2. les recommandations actionnables non retenues (À traiter, règles mascotte) ;
 *   3. les questions T2.
 * Dans la limite de 5 actions au total et de 3 secondaires (UX-007). Rien
 * n'est ajouté pour « remplir » (UI-04).
 */
export function buildSecondaries(
  input: MascotCandidates,
  subjects: MascotSubject[],
): MascotSecondary[] {
  const actionsSujets = subjects.reduce((n, s) => n + s.actions.length, 0);
  const places = Math.max(0, Math.min(MAX_SECONDARIES, MAX_ACTIONS_TOTAL - actionsSujets));

  const affiches = new Set<string>();
  subjects.forEach((s) => { affiches.add(s.occurrenceKey); s.dedupeKeys.forEach((k) => affiches.add(k)); });
  const dejaVu = (s: MascotSubject) => affiches.has(s.occurrenceKey) || s.dedupeKeys.some((k) => affiches.has(k));

  const asSecondary = (s: MascotSubject, kind: MascotSecondary['kind']): MascotSecondary => {
    const principale: MascotAction = s.actions[0];
    return {
      id: `SEC:${s.occurrenceKey}`,
      kind,
      sourceCode: s.sourceCode,
      occurrenceKey: s.occurrenceKey,
      action: { ...principale, actionId: `SEC:${principale.actionId}`, label: s.secondaryLabel },
    };
  };

  const liste: MascotSecondary[] = [];
  const onboarding = input.candidates.find((c) => c.sourceFamily === 'ONBOARDING') ?? null;
  if (onboarding && !dejaVu(onboarding)) {
    liste.push(asSecondary(onboarding, 'onboarding'));
    affiches.add(onboarding.occurrenceKey);
  }

  for (const c of input.candidates) {
    if (c.sourceFamily !== 'TO_PROCESS' && c.sourceFamily !== 'MASCOT_RULE') continue;
    if (dejaVu(c) || c.actions.length === 0) continue;
    liste.push(asSecondary(c, 'recommendation'));
    affiches.add(c.occurrenceKey);
    c.dedupeKeys.forEach((k) => affiches.add(k));
  }

  const step = onboarding ? (onboarding.sourceCode as 'ONB-ASSET' | 'ONB-DOC') : null;
  liste.push(...eligibleQuestions(input, subjects, step));

  // L'onboarding garde sa place même si la file de recommandations est longue
  // (SEL-006) : il est en tête, et la troncature se fait par la fin.
  return liste.slice(0, places);
}
