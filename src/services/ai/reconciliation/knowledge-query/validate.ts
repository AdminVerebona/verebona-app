/**
 * Lot 85F — VALIDATION SERVEUR de la sortie KNOWLEDGE_QUERY (ticket §7, §8).
 * Partie PURE : le modèle ne fait jamais foi.
 *
 * Pour chaque constat :
 *   1. cible demandée (la donnée, ou un rôle de constituant offert) ;
 *   2. MONDE FERMÉ : chaque référence citée appartient au contexte de l'appel ;
 *   3. chaque segment de l'extrait est RECOPIÉ d'un élément cité (casse,
 *      accents, espaces et apostrophes normalisés) ;
 *   4. la valeur écrite (`rawValue`) figure dans l'extrait et se NORMALISE
 *      selon son type par les analyseurs EXISTANTS (date non ambiguë, durée en
 *      mois) — jamais par une reconnaissance de vocabulaire ; une valeur
 *      normalisée fournie par le modèle et incohérente est refusée ;
 * puis, sur les constats retenus : deux valeurs différentes pour une même
 * cible = CONTRADICTION (aucune écriture), quelle que soit l'issue déclarée.
 * Une abstention déclarée (AMBIGUOUS) n'est jamais transformée en valeur.
 */
import type { DateParseStatus } from '@/services/to-process/document-field-evidence';
import {
  CONSTITUENT_VALUE_TYPES, FIELD_TARGET,
  type ConstituentRole, type KnowledgeConfidence, type KnowledgeElement, type KnowledgeQuestion, type T3KnowledgeFinding, type T3KnowledgeQueryOutput,
} from './contract';
import { EXCERPT_SEGMENT_SEPARATOR, normalizeForComparison } from './context';

export type RejectionCode =
  | 'UNKNOWN_TARGET' | 'UNKNOWN_EVIDENCE_REF' | 'EXCERPT_NOT_IN_EVIDENCE' | 'VALUE_NOT_IN_EXCERPT' | 'VALUE_NOT_NORMALIZABLE' | 'VALUE_MISMATCH';

export interface ValidatedFinding {
  /** `FIELD` ou rôle de constituant. */
  target: string;
  rawValue: string;
  /** Valeur normalisée par le code (ISO, mois, texte), null pour un indice. */
  normalized: string | null;
  /** Statut de normalisation d'une date (ORDER_AMBIGUOUS : jamais « certaine »). */
  dateStatus?: DateParseStatus | null;
  evidenceRefs: string[];
  excerpt: string;
  /** Confiance déclarée par le modèle. */
  modelConfidence: KnowledgeConfidence;
  /** Fiabilité la plus faible des éléments cités (côté T1). */
  evidenceConfidence: KnowledgeConfidence;
  meaning: string;
  /** Documents (identifiants) des éléments cités. */
  fileIds: number[];
}

export interface Rejection { target: string; rawValue: string; code: RejectionCode; refs: string[] }

export type EffectiveOutcome = 'FOUND' | 'CONSTITUENTS' | 'CONTRADICTION' | 'AMBIGUOUS' | 'NOT_FOUND' | 'REJECTED';

interface PageValidation {
  outcome: EffectiveOutcome;
  declared: T3KnowledgeQueryOutput['outcome'];
  findings: ValidatedFinding[];
  rejected: Rejection[];
}

/** Normaliseurs de VALEUR (injectés : analyseurs existants du moteur « À traiter »). */
export interface ValueNormalizers {
  date: (raw: string) => { iso: string | null; status: DateParseStatus };
  /** Durée → mois, null si non interprétable. */
  durationMonths: (raw: string) => number | null;
}

const ORDRE_CONFIANCE: Record<KnowledgeConfidence, number> = { certain: 2, probable: 1, conflictual: 0 };
const plusFaible = (xs: KnowledgeConfidence[]): KnowledgeConfidence =>
  xs.reduce<KnowledgeConfidence>((a, b) => (ORDRE_CONFIANCE[b] < ORDRE_CONFIANCE[a] ? b : a), 'certain');

/** Texte d'un élément tel que transmis (libellé, valeur, texte). Pure. */
const elementText = (e: Pick<KnowledgeElement, 'label' | 'value' | 'text'>): string =>
  [e.label, e.value, e.text].filter((x): x is string => !!x).join(' \n ');

/** Type attendu d'une cible (donnée ou rôle offert), null si la cible n'a pas été demandée. Pure. */
function targetType(q: Pick<KnowledgeQuestion, 'valueType' | 'constituents'>, target: string): string | null {
  if (target === FIELD_TARGET) return q.valueType;
  const c = q.constituents.find((x) => x.role === target);
  return c ? CONSTITUENT_VALUE_TYPES[c.role as ConstituentRole] : null;
}

/** Valide UN constat (pur). */
export function validateFinding(
  f: T3KnowledgeFinding, q: Pick<KnowledgeQuestion, 'valueType' | 'constituents'>, elements: ReadonlyMap<string, KnowledgeElement>, norm: ValueNormalizers,
): { ok: true; finding: ValidatedFinding } | { ok: false; rejection: Rejection } {
  const refuse = (code: RejectionCode) => ({ ok: false as const, rejection: { target: f.target, rawValue: f.rawValue.slice(0, 120), code, refs: f.evidenceRefs.slice(0, 5) } });
  const type = targetType(q, f.target);
  if (!type) return refuse('UNKNOWN_TARGET');
  const cites = f.evidenceRefs.map((r) => elements.get(r));
  if (cites.some((e) => !e)) return refuse('UNKNOWN_EVIDENCE_REF');
  const textes = (cites as KnowledgeElement[]).map((e) => normalizeForComparison(elementText(e)));
  const segments = f.excerpt.split(EXCERPT_SEGMENT_SEPARATOR).map((s) => normalizeForComparison(s)).filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => !textes.some((t) => t.includes(s)))) return refuse('EXCERPT_NOT_IN_EVIDENCE');
  const brut = normalizeForComparison(f.rawValue);
  if (!brut || !segments.some((s) => s.includes(brut))) return refuse('VALUE_NOT_IN_EXCERPT');

  let normalized: string | null = null;
  let dateStatus: DateParseStatus | null = null;
  const fourni = f.value === null || f.value === undefined || String(f.value).trim() === '' ? null : String(f.value).trim();
  switch (type) {
    case 'date': {
      const d = norm.date(f.rawValue);
      if (!d.iso) return refuse('VALUE_NOT_NORMALIZABLE');
      if (fourni !== null && norm.date(fourni).iso !== d.iso) return refuse('VALUE_MISMATCH');
      normalized = d.iso;
      dateStatus = d.status;
      break;
    }
    case 'duration': {
      const m = norm.durationMonths(f.rawValue);
      if (m === null) return refuse('VALUE_NOT_NORMALIZABLE');
      if (fourni !== null && Number(fourni) !== m) return refuse('VALUE_MISMATCH');
      normalized = String(m);
      break;
    }
    case 'number':
    case 'count':
    case 'periodicity':
    case 'text':
      // Interprétées plus loin par les analyseurs existants (nombre d'échéances, périodicité)
      // ou reprises telles qu'écrites (texte) : la valeur écrite fait foi, jamais la valeur du modèle.
      normalized = f.rawValue.trim();
      break;
    case 'indicator':
      normalized = null;
      break;
    default:
      return refuse('UNKNOWN_TARGET');
  }
  return {
    ok: true,
    finding: {
      target: f.target, rawValue: f.rawValue.trim(), normalized, dateStatus, evidenceRefs: [...new Set(f.evidenceRefs)], excerpt: f.excerpt.trim(),
      modelConfidence: f.confidence, evidenceConfidence: plusFaible((cites as KnowledgeElement[]).map((e) => e.confidence)), meaning: f.meaning.trim(),
      fileIds: [...new Set((cites as KnowledgeElement[]).map((e) => e.fileId))],
    },
  };
}

/** Cibles en contradiction (au moins deux valeurs normalisées distinctes, indices exclus). Pure. */
export function contradictoryTargets(findings: readonly ValidatedFinding[]): string[] {
  const parCible = new Map<string, Set<string>>();
  for (const f of findings) {
    if (f.normalized === null) continue;
    (parCible.get(f.target) ?? parCible.set(f.target, new Set()).get(f.target)!).add(f.normalized);
  }
  return [...parCible.entries()].filter(([, v]) => v.size >= 2).map(([k]) => k).sort();
}

/** Issue EFFECTIVE d'un ensemble de constats validés et d'issues déclarées (pure). */
export function effectiveOutcome(findings: readonly ValidatedFinding[], declared: ReadonlyArray<T3KnowledgeQueryOutput['outcome']>, rejectedCount: number): EffectiveOutcome {
  if (contradictoryTargets(findings).length) return 'CONTRADICTION';
  if (findings.some((f) => f.target === FIELD_TARGET)) return 'FOUND';
  if (findings.length) return 'CONSTITUENTS';
  if (declared.some((d) => d === 'AMBIGUOUS' || d === 'CONTRADICTION')) return 'AMBIGUOUS';
  if (rejectedCount > 0 || declared.some((d) => d === 'FOUND' || d === 'CONSTITUENTS')) return 'REJECTED';
  return 'NOT_FOUND';
}

/** Valide la sortie d'UNE page de contexte (pure). */
export function validateKnowledgeAnswer(
  out: T3KnowledgeQueryOutput, q: Pick<KnowledgeQuestion, 'valueType' | 'constituents'>, elements: readonly KnowledgeElement[], norm: ValueNormalizers,
): PageValidation {
  const parRef = new Map(elements.map((e) => [e.ref, e]));
  const findings: ValidatedFinding[] = [];
  const rejected: Rejection[] = [];
  // Abstention déclarée : les constats éventuels ne sont qu'un diagnostic, jamais une valeur.
  if (out.outcome !== 'AMBIGUOUS') {
    for (const f of out.findings ?? []) {
      const r = validateFinding(f, q, parRef, norm);
      if (r.ok) findings.push(r.finding); else rejected.push(r.rejection);
    }
  }
  return { outcome: effectiveOutcome(findings, [out.outcome], rejected.length), declared: out.outcome, findings, rejected };
}

/** Constats de plusieurs pages réunis (doublons de même cible, valeur et preuves retirés). Pure. */
export function mergeFindings(lots: ReadonlyArray<readonly ValidatedFinding[]>): ValidatedFinding[] {
  const vus = new Map<string, ValidatedFinding>();
  for (const f of lots.flat()) {
    const k = JSON.stringify([f.target, f.normalized ?? normalizeForComparison(f.rawValue), [...f.evidenceRefs].sort()]);
    if (!vus.has(k)) vus.set(k, f);
  }
  return [...vus.values()];
}
