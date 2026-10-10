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
import type { RenderedSuggestion } from '@/services/verebona-assistant/registries/capability-registry';

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

// ── Questions T2 (§12, annexe B) — catalogue UNIQUE (lot 34) ────────────────
//
// La mascotte n'a plus de catalogue propre (`T2_QUESTIONS` : « Que dois-je
// faire aujourd'hui ? » dès qu'un « À traiter » existait, « Que sais-tu sur
// X ? », pseudo-intentions sans contrat T2). Ses questions sont celles du
// catalogue validé de Verebona (`capability-registry` → `suggestionsForRoute`
// pour l'accueil), rendues côté serveur avec l'état du compte : intention T2
// canonique, préconditions explicites, 0 à 3 questions, jamais de
// remplissage. Le moteur ne fait ici que retirer celles qui répètent un sujet
// déjà affiché (SEC-004, T2-02).

/** Question du catalogue unique, telle que rendue pour l'accueil. */
export type CatalogQuestion = Pick<RenderedSuggestion, 'id' | 'label' | 'canonicalIntent' | 'topic' | 'assetId'>;

/** Sujet de catalogue équivalent à une famille de sujet de la mascotte. */
const TOPIC_OF_FAMILY: Readonly<Partial<Record<string, string>>> = { DATE: 'deadlines' };
/** Sujet de catalogue équivalent à un code source affiché. */
const TOPIC_OF_CODE: Readonly<Record<string, string>> = { 'PROC-DOC-ANALYSIS': 'analysis' };

function questionAction(q: CatalogQuestion): MascotSecondary {
  return {
    id: `Q:${q.id}`,
    kind: 'question',
    sourceCode: `Q:${q.id}`,
    occurrenceKey: `Q:${q.id}${q.assetId ? `:${q.assetId}` : ''}`,
    action: {
      actionId: `Q:${q.id}`,
      label: q.label,
      target: {
        kind: 'ask', question: q.label,
        // Intention T2 CANONIQUE (jamais une pseudo-intention) ; le bien est
        // revalidé côté serveur.
        context: { intent: q.canonicalIntent, ...(q.assetId ? { assetId: q.assetId } : {}) },
      },
    },
  };
}

/** Famille d'un code source (`DATE-NEXT…` → Date). */
function familyOfCode(code: string): MascotSubject['sourceFamily'] | null {
  if (code.startsWith('ATP-')) return 'TO_PROCESS';
  if (code === 'DATE-NEXT' || code === 'DATE-NEXT-2') return 'DATE';
  return null;
}

/**
 * Questions du catalogue unique, dans son ordre, sans celles qui répètent
 * un sujet OU une action déjà affichés (SEC-004, T2-02) : une date visible
 * exclut la question d'échéance, une analyse en cours affichée exclut la
 * question d'analyse. Les « À traiter » (niveau 2, MASC2) n'excluent rien :
 * « Ou demandez-moi » reste indépendant de la file.
 */
export function eligibleQuestions(
  catalog: readonly CatalogQuestion[],
  shown: MascotSubject[],
  visibleSecondaries: MascotSecondary[] = [],
): MascotSecondary[] {
  const sujets = new Set<string>();
  for (const s of shown) {
    const t = TOPIC_OF_FAMILY[s.sourceFamily] ?? TOPIC_OF_CODE[s.sourceCode];
    if (t) sujets.add(t);
  }
  for (const s of visibleSecondaries) {
    const f = familyOfCode(s.sourceCode);
    const t = (f && TOPIC_OF_FAMILY[f]) ?? TOPIC_OF_CODE[s.sourceCode];
    if (t) sujets.add(t);
  }
  return catalog.filter((q) => !sujets.has(q.topic)).map(questionAction);
}

// ── Éléments secondaires (§12) ───────────────────────────────────────────────

/**
 * SEC-001, SEC-002, SEL-006 :
 *   1. l'onboarding actif, s'il n'est pas déjà dans le discours (place réservée) ;
 *   2. les recommandations actionnables non retenues (À traiter, règles mascotte) ;
 *   3. les questions T2 du catalogue unique (`catalog`, rendu côté serveur).
 * Dans la limite de 5 actions au total et de 3 secondaires (UX-007). Rien
 * n'est ajouté pour « remplir » (UI-04).
 */
export function buildSecondaries(
  input: MascotCandidates,
  subjects: MascotSubject[],
  catalog: readonly CatalogQuestion[] = [],
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

  // SEC-004 : seules les recommandations qui seront réellement visibles
  // (dans la limite des places) excluent leur question équivalente.
  liste.push(...eligibleQuestions(catalog, subjects, liste.slice(0, places)));

  // L'onboarding garde sa place même si la file de recommandations est longue
  // (SEL-006) : il est en tête, et la troncature se fait par la fin.
  return liste.slice(0, places);
}
