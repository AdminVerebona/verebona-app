/**
 * Lot 113AO (Trello #748, A) — BESOIN RÉDACTIONNEL d'un sujet de la bulle :
 * qualification SERVEUR, en amont de la passerelle (aucun appel, aucun jeton).
 *
 * Constat (export 54dc3fd1…) : 12 réponses FORMULATE sur 12 identiques, texte
 * pour texte, au `fallbackText` transmis ; 9 appels sur 10 du 12/11 pour le
 * seul « Le document … est en cours d'analyse » (36 669 jetons d'entrée). Le
 * texte était entièrement calculé par Verebona ; T6 n'avait rien à y ajouter.
 *
 * RÈGLE TRANSVERSALE (par la NATURE du besoin, jamais par une liste de sources,
 * de documents, de biens, de fournisseurs ou de phrases) — un sujet est
 * DÉTERMINISTE quand il n'y a rien à articuler au-delà des faits :
 *   1. son intention est d'INFORMER d'un état ou d'une date (`inform`,
 *      `deadline`) — jamais une invitation à agir (`act`) ni un
 *      accompagnement (`onboard`), où la formulation porte le ton et l'enjeu ;
 *   2. il ne demande pas l'attention (`requiresAttention` faux) : aucune
 *      priorité, aucun jugement à nuancer — une interpellation décidée par
 *      EVALUATE (agir maintenant, anticiper) reste confiée à FORMULATE ; un
 *      rappel INFORMATIF (le fait seul, une fois) ne l'est pas ;
 *   3. aucune démarche attendue n'est portée par ses faits (`expectedAction`) ;
 *   4. son texte déterministe est FIABLE : il satisfait lui-même le contrat que
 *      la validation appliquerait à une formulation T6 (longueur, vouvoiement,
 *      aucune date relative, aucun nombre hors des faits, nature de la date,
 *      nuances R9, faits essentiels R11, aucune formule mécanique).
 * Tout autre sujet garde sa formulation T6 (cache, R8, validation inchangés).
 *
 * `MASCOT_T6_DETERMINISTIC_BYPASS=off` rétablit l'envoi de tous les sujets
 * (retour arrière sans livraison).
 */
import type { MascotSubject } from './types';
import { buildT6Input, keepsEssentialFacts, mechanicalRepetition, mechanicalWording, nuanceViolation, validateT6Output, type T6Message, type T6SubjectKind } from './t6-contract';
import { canonicalJson, sha256 } from './hash';

export type T6WordingNeed = 'DETERMINISTIC' | 'CONTEXTUAL';

export interface T6WordingQualification {
  need: T6WordingNeed;
  /** Motif stable (diagnostic, rapport) : nature du besoin, jamais un texte. */
  reason: 'state_information' | 'guidance_intent' | 'attention_required' | 'expected_action' | 'unreliable_fallback' | 'bypass_disabled';
}

/** Interrupteur d'exploitation (défaut : qualification active). */
export function t6DeterministicBypassEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.MASCOT_T6_DETERMINISTIC_BYPASS ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'non');
}

/** Qualification d'un sujet (pure, testée). `kind` : nature de la tuile (R9). */
export function t6WordingNeed(s: MascotSubject, kind?: T6SubjectKind, env: Record<string, string | undefined> = process.env): T6WordingQualification {
  if (!t6DeterministicBypassEnabled(env)) return { need: 'CONTEXTUAL', reason: 'bypass_disabled' };
  if (s.intent !== 'inform' && s.intent !== 'deadline') return { need: 'CONTEXTUAL', reason: 'guidance_intent' };
  if (s.requiresAttention) return { need: 'CONTEXTUAL', reason: 'attention_required' };
  if (s.facts.expectedAction != null && s.facts.expectedAction !== '') return { need: 'CONTEXTUAL', reason: 'expected_action' };
  if (!fallbackIsReliable(s, kind)) return { need: 'CONTEXTUAL', reason: 'unreliable_fallback' };
  return { need: 'DETERMINISTIC', reason: 'state_information' };
}

/** Le texte déterministe satisfait-il le contrat d'une formulation validée ? (pure) */
function fallbackIsReliable(s: MascotSubject, kind?: T6SubjectKind): boolean {
  const text = (s.fallbackText ?? '').trim();
  if (!text || mechanicalWording(text)) return false;
  const input = buildT6Input([s]);
  const v = validateT6Output(input, { messages: [{ subjectId: s.subjectId, text, highlight: s.allowedHighlight }] });
  if (!v.ok) return false;
  if (nuanceViolation(text, input.subjects[0], kind)) return false;
  return keepsEssentialFacts(text, s.facts);
}

/** Paragraphe déterministe d'un sujet (même forme que le repli R11 du contrat). */
export function deterministicMessage(s: MascotSubject): T6Message {
  const highlight = s.allowedHighlight && s.fallbackText.includes(s.allowedHighlight) ? s.allowedHighlight : null;
  return { subjectId: s.subjectId, text: s.fallbackText.trim().replace(/\s+/g, ' '), highlight };
}

export interface T6FormulationPlan {
  /** Index (dans la bulle) des sujets confiés à FORMULATE, dans l'ordre. */
  formulate: number[];
  /** Index des sujets servis par leur texte déterministe. */
  deterministic: number[];
  qualifications: T6WordingQualification[];
}

/** Répartition des sujets retenus (pure) : seuls les sujets qui le nécessitent partent à FORMULATE. */
export function planT6Formulation(subjects: readonly MascotSubject[], kinds: ReadonlyArray<T6SubjectKind | undefined>, env: Record<string, string | undefined> = process.env): T6FormulationPlan {
  const qualifications = subjects.map((s, i) => t6WordingNeed(s, kinds[i], env));
  const formulate: number[] = [];
  const deterministic: number[] = [];
  qualifications.forEach((q, i) => (q.need === 'CONTEXTUAL' ? formulate : deterministic).push(i));
  return { formulate, deterministic, qualifications };
}

/**
 * Recomposition de la bulle (pure, testée) : 1 ou 2 sujets, DANS L'ORDRE de la
 * sélection, chacun avec son ancrage (identifiant, mise en valeur) — textes T6
 * des sujets formulés, textes déterministes des autres. `formulated` null
 * (T6 n'a rien rendu) : `null` si aucun sujet déterministe (secours complet,
 * comportement antérieur), sinon la bulle déterministe complète. R8 entre
 * sujets : un texte T6 qui répète un texte déterministe reprend son secours.
 */
export function recomposeT6Messages(
  subjects: readonly MascotSubject[], plan: Pick<T6FormulationPlan, 'formulate'>, formulated: readonly T6Message[] | null,
): T6Message[] | null {
  if (formulated && formulated.length !== plan.formulate.length) return null;
  const parFormule = new Map<number, T6Message>();
  plan.formulate.forEach((idx, j) => { const m = formulated?.[j]; if (m && m.subjectId === subjects[idx].subjectId) parFormule.set(idx, m); });
  if (!formulated && plan.formulate.length > 0) return null;
  const out = subjects.map((s, i) => parFormule.get(i) ?? deterministicMessage(s));
  for (let i = 0; i < out.length; i++) {
    if (!parFormule.has(i)) continue;
    const autres = out.filter((_, j) => j !== i && !parFormule.has(j));
    if (autres.some((a) => mechanicalRepetition([a, out[i]]) !== null)) out[i] = deterministicMessage(subjects[i]);
  }
  return out;
}

/** Clé de mesure d'une bulle déterministe (compte + sujets et faits) — distincte des clés du cache T6. */
export function deterministicKeyOf(accountId: number, subjects: readonly MascotSubject[]): string {
  const input = buildT6Input([...subjects]);
  return `det:${sha256(canonicalJson({ accountId, subjects: input.subjects, schema: input.schemaVersion }))}`;
}
