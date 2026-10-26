/**
 * Lot 88B — VALIDATION SERVEUR et DÉCISION par propriété (partie PURE).
 * Le modèle ne fait jamais foi ; le code ne connaît aucun vocabulaire.
 *
 * Pour chaque constat d'une réponse KNOWLEDGE_QUERY (schéma inchangé) :
 *   1. cible = clé d'une propriété DEMANDÉE (ancien format toléré : cible
 *      `FIELD` quand une seule propriété est demandée) ;
 *   2. validation 85F (`validateFinding`) : monde fermé (références du
 *      contexte de l'appel), extrait recopié des éléments cités, valeur
 *      écrite contenue dans l'extrait et normalisable par son type ;
 *   3. normalisation par le REGISTRE canonique (même normaliseur que le
 *      writer) : une valeur que la fiche n'accepterait pas est refusée.
 * Décision, propriété par propriété :
 *   · ESTABLISHED  une seule valeur canonique, au moins un constat
 *                  `certain` (modèle) fondé sur des éléments non
 *                  contradictoires, date sans ambiguïté d'ordre, au moins une
 *                  preuve INDÉPENDANTE de la fiche elle-même ;
 *   · ABSTAINED    sinon, avec une cause explicite — jamais de valeur
 *                  inventée, jamais « absente » sur un contexte tronqué.
 */
import type { DateParseStatus } from '@/services/to-process/document-field-evidence';
import { normalizeValue } from '@/services/canonical/registry';
import type { KnowledgeElement, T3KnowledgeQueryOutput } from '../knowledge-query/contract';
import { FIELD_TARGET } from '../knowledge-query/contract';
import { validateFinding, type Rejection, type ValidatedFinding, type ValueNormalizers } from '../knowledge-query/validate';
import type { PropertyContextElement, PropertyPage, PropertyQuestion } from './contract';

export type AbstentionCause =
  /** Contexte vide : rien à soumettre (aucun appel). */
  | 'NO_EVIDENCE'
  /** Aucun élément transmis ne porte la propriété (contexte complet). */
  | 'NOT_FOUND'
  /** Rien trouvé dans un contexte TRONQUÉ : jamais conclu « absente ». */
  | 'INCOMPLETE_CONTEXT'
  /** Abstention déclarée par T3 (ambiguïté). */
  | 'AMBIGUOUS'
  /** Au moins deux valeurs canoniques différentes. */
  | 'CONTRADICTION'
  /** Valeur trouvée mais non établie (aucun constat certain, élément contradictoire). */
  | 'INSUFFICIENT_CONFIDENCE'
  /** Date lisible dans deux ordres (JJ/MM ou MM/JJ). */
  | 'DATE_ORDER_AMBIGUOUS'
  /** Seules des données dérivées de la fiche elle-même la portent. */
  | 'CIRCULAR_EVIDENCE'
  /** Tous les constats refusés par la validation serveur. */
  | 'REJECTED_BY_VALIDATION'
  /** Valeur refusée par le normaliseur du registre. */
  | 'VALUE_NOT_NORMALIZABLE'
  // Causes posées à l'écriture (writer canonique) :
  | 'USER_PROTECTED' | 'CONCURRENT_CHANGE' | 'WRITE_REFUSED';

export interface PropertyFinding extends ValidatedFinding {
  /** Clé de la propriété (cible de la réponse). */
  key: string;
  /** Valeur canonique (normaliseur du registre), null si refusée. */
  canonical: unknown;
}

export type PropertyDecision =
  | { key: string; decision: 'ESTABLISHED'; value: unknown; findings: PropertyFinding[]; rejected: Rejection[] }
  | { key: string; decision: 'ABSTAINED'; cause: AbstentionCause; proposed: unknown; findings: PropertyFinding[]; rejected: Rejection[] }
  /** Réponse plafonnée (nombre maximal de constats atteint) : non décidée, redemandée. */
  | { key: string; decision: 'UNDECIDED'; findings: PropertyFinding[]; rejected: Rejection[] };

export interface PageAnswer {
  page: PropertyPage;
  output: T3KnowledgeQueryOutput;
}

/** Nombre maximal de constats d'une réponse (schéma 85F). */
export const MAX_FINDINGS_PER_ANSWER = 12;

const ORDRE_CONFIANCE = { certain: 2, probable: 1, conflictual: 0 } as const;
const AMBIGUITES_DATE: ReadonlySet<DateParseStatus> = new Set(['ORDER_AMBIGUOUS', 'REFUSED_AMBIGUOUS']);

/** Clé visée par un constat (ancien format : `FIELD` pour une question unique), null si non demandée. Pure. */
function findingKey(target: string, properties: readonly PropertyQuestion[]): string | null {
  if (properties.some((p) => p.key === target)) return target;
  if (target === FIELD_TARGET && properties.length === 1) return properties[0].key;
  return null;
}

const json = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Décisions d'un lot de propriétés à partir des réponses de TOUTES les pages
 * de contexte (pure). `complete` : contexte transmis sans troncature.
 */
export function decideProperties(p: {
  properties: readonly PropertyQuestion[];
  answers: readonly PageAnswer[];
  complete: boolean;
  norm: ValueNormalizers;
}): PropertyDecision[] {
  const valides = new Map<string, PropertyFinding[]>();
  const refus = new Map<string, Rejection[]>();
  const pousser = <T>(m: Map<string, T[]>, k: string, v: T) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  let abstentionDeclaree = false;
  let plafonne = false;
  const elementsCites = new Map<string, PropertyContextElement>();

  for (const a of p.answers) {
    const parRef = new Map(a.page.elements.map((e) => [e.ref, e]));
    for (const e of a.page.elements) elementsCites.set(e.ref, e);
    if (a.output.outcome === 'AMBIGUOUS' || a.output.outcome === 'CONTRADICTION') abstentionDeclaree = true;
    // Abstention déclarée : les constats éventuels ne sont qu'un diagnostic, jamais une valeur (85F).
    if (a.output.outcome === 'AMBIGUOUS') continue;
    const constats = a.output.findings ?? [];
    if (constats.length >= MAX_FINDINGS_PER_ANSWER) plafonne = true;
    for (const f of constats) {
      const key = findingKey(f.target, p.properties);
      if (!key) {
        pousser(refus, '*', { target: f.target, rawValue: f.rawValue.slice(0, 120), code: 'UNKNOWN_TARGET', refs: f.evidenceRefs.slice(0, 5) });
        continue;
      }
      const q = p.properties.find((x) => x.key === key)!;
      const r = validateFinding({ ...f, target: FIELD_TARGET }, { valueType: q.valueType, constituents: [] },
        parRef as unknown as ReadonlyMap<string, KnowledgeElement>, p.norm);
      if (!r.ok) { pousser(refus, key, { ...r.rejection, target: key }); continue; }
      const brut = q.valueType === 'date' ? r.finding.normalized : r.finding.rawValue;
      const n = normalizeValue(key, brut);
      if (!n.ok || n.value === null) {
        pousser(refus, key, { target: key, rawValue: f.rawValue.slice(0, 120), code: 'VALUE_NOT_NORMALIZABLE', refs: f.evidenceRefs.slice(0, 5) });
        continue;
      }
      pousser(valides, key, { ...r.finding, target: key, key, canonical: n.value });
    }
  }

  return p.properties.map((q): PropertyDecision => {
    // Doublons (même valeur, mêmes preuves) d'une page à l'autre retirés.
    const vus = new Set<string>();
    const fs = (valides.get(q.key) ?? []).filter((f) => {
      const k = json([f.canonical, [...f.evidenceRefs].sort()]);
      if (vus.has(k)) return false;
      vus.add(k);
      return true;
    });
    const rj = refus.get(q.key) ?? [];
    const abstenir = (cause: AbstentionCause, proposed: unknown = null): PropertyDecision =>
      ({ key: q.key, decision: 'ABSTAINED', cause, proposed, findings: fs, rejected: rj });
    const valeurs = [...new Set(fs.map((f) => json(f.canonical)))];
    if (valeurs.length > 1) return abstenir('CONTRADICTION');
    if (fs.length === 0) {
      if (rj.length) return abstenir('REJECTED_BY_VALIDATION');
      if (abstentionDeclaree) return abstenir('AMBIGUOUS');
      if (plafonne) return { key: q.key, decision: 'UNDECIDED', findings: fs, rejected: rj };
      return abstenir(p.complete ? 'NOT_FOUND' : 'INCOMPLETE_CONTEXT');
    }
    const valeur = fs[0].canonical;
    if (fs.some((f) => f.modelConfidence === 'conflictual')) return abstenir('INSUFFICIENT_CONFIDENCE', valeur);
    const certains = fs.filter((f) => f.modelConfidence === 'certain' && ORDRE_CONFIANCE[f.evidenceConfidence] > ORDRE_CONFIANCE.conflictual);
    if (!certains.length) return abstenir('INSUFFICIENT_CONFIDENCE', valeur);
    if (q.valueType === 'date' && certains.every((f) => f.dateStatus && AMBIGUITES_DATE.has(f.dateStatus))) return abstenir('DATE_ORDER_AMBIGUOUS', valeur);
    const independants = certains.filter((f) => f.evidenceRefs.some((r) => elementsCites.get(r)?.provenance?.derivedFromSubject !== true));
    if (!independants.length) return abstenir('CIRCULAR_EVIDENCE', valeur);
    return { key: q.key, decision: 'ESTABLISHED', value: valeur, findings: fs, rejected: rj };
  });
}

/** Refus non rattachables à une propriété demandée (cible inconnue) — diagnostic. Pure. */
export function unattachedRejections(answers: readonly PageAnswer[], properties: readonly PropertyQuestion[]): number {
  return answers.reduce((n, a) => n + (a.output.outcome === 'AMBIGUOUS' ? 0
    : (a.output.findings ?? []).filter((f) => !findingKey(f.target, properties)).length), 0);
}
