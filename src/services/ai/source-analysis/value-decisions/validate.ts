/**
 * Lot 91D — validation SERVEUR des décisions de T1 sur les valeurs
 * significatives (fonctions PURES, testées sans base).
 *
 *   sortie T1 (`valueDecisions[]`, index de faits)
 *     → ANCRAGE   index → empreintes de faits (`t1FactRef`), comme les
 *                 candidats Opération, AVANT tout décalage d'index ;
 *     → VALIDATION unité source retrouvée (identifiant cité, sinon preuve :
 *                 extrait / page / cellule, sinon valeur présente dans une
 *                 seule unité), valeur RETROUVÉE dans cette unité et forme
 *                 normalisée RECALCULÉE (`significantValues`, même lecture
 *                 que COH-DOC-EXTRACT-CHAIN), rattachements existants, motif
 *                 présent, aucune décision contradictoire.
 *
 * Le code ne décide JAMAIS qu'une valeur est pertinente ou non : il vérifie
 * que la décision de T1 est TRAÇABLE (provenance, valeur, rattachements,
 * motif). Une décision non traçable est conservée comme INVALIDE (avec son
 * motif de rejet) : elle ne justifie rien et le contrôle continue de
 * signaler la valeur.
 */
import { createHash } from 'crypto';
import type { T1AnalyzeDocumentOutput, T1FactWithRef, T1ValueDecisionCode, T1ValueKind, T1Confidence, T1Evidence } from '../master/t1-contract';
import { T1_VALUE_DECISIONS, T1_VALUE_KINDS } from '../master/t1-contract';
import { SourceUnitLinker } from '../source-units/coverage';
import { unitOfCell } from '../source-units/build-units';
import { plat, significantValues } from '../source-units/text';
import type { SourceUnit } from '../source-units/types';

/** Origine d'une décision : passe principale, lot de pages, réexamen ciblé demandé par le contrôle. */
export type ValueDecisionOrigin = 'PASS_1' | 'CHUNK' | 'REVIEW';

/** Décision reçue, ancrée sur les empreintes des faits (jamais sur un index). */
export interface AnchoredValueDecision {
  value: string;
  kind: T1ValueKind | null;
  normalizedValue: string | null;
  decision: T1ValueDecisionCode | null;
  reason: string;
  sourceUnitId: string | null;
  evidence: T1Evidence;
  relatedFactRefs: string[];
  relatedCandidateKeys: string[];
  confidence: T1Confidence | null;
  origin: ValueDecisionOrigin;
  /** Élément mal formé écarté par la lecture tolérante (jamais une justification). */
  schemaInvalid?: boolean;
}

export const VALUE_DECISION_REJECTIONS = [
  'INVALID_SCHEMA', 'UNIT_NOT_FOUND', 'UNIT_AMBIGUOUS', 'VALUE_NOT_IN_UNIT', 'VALUE_AMBIGUOUS', 'NORMALIZED_MISMATCH',
  'REASON_MISSING', 'LINK_MISSING', 'LINK_UNKNOWN', 'CONFLICTING_DECISIONS',
] as const;
export type ValueDecisionRejection = (typeof VALUE_DECISION_REJECTIONS)[number];

/** Décision validée, prête à persister (une ligne par unité source). */
export interface PreparedValueDecision {
  origin: ValueDecisionOrigin;
  sourceUnitId: string | null;
  unitFingerprint: string | null;
  kind: T1ValueKind | null;
  rawValue: string;
  normalizedValue: string | null;
  decision: T1ValueDecisionCode | null;
  reason: string;
  confidence: T1Confidence | null;
  evidence: T1Evidence;
  relatedFactRefs: string[];
  relatedCandidateKeys: string[];
  validity: 'VALID' | 'INVALID';
  invalidReason: ValueDecisionRejection | null;
}

/** Unités dont le contrôle lit les valeurs (même liste que COH-DOC-EXTRACT-CHAIN). */
const UNITES_LUES = new Set(['TEXT_BLOCK', 'LABEL_VALUE', 'FORM_FIELD', 'TABLE_ROW']);
/** Motif : au moins quelques caractères, jamais la seule valeur recopiée. */
const MOTIF_MIN = 8;

/** Texte d'une unité tel que le lit le contrôle (`content_text`, sinon « libellé : valeur »). */
export function unitTextOf(u: { text?: string | null; label?: string | null; value?: string | null }): string | null {
  return u.text ?? (u.label || u.value ? `${u.label ?? ''} : ${u.value ?? ''}` : null);
}

/** Empreinte du texte d'une unité : une nouvelle extraction qui la modifie rend la décision obsolète. */
export function unitFingerprint(text: string | null | undefined): string | null {
  return text ? createHash('sha256').update(plat(text)).digest('hex').slice(0, 16) : null;
}

/** Clé d'une valeur dans une unité (unité, nature, forme normalisée). */
export const valueKey = (unitId: string, kind: string, normalized: string) => `${unitId}|${kind}|${normalized}`;

const dansListe = <T extends string>(l: readonly T[], v: unknown): T | null => (typeof v === 'string' && (l as readonly string[]).includes(v) ? v as T : null);

/**
 * Ancrage (pur) : index de faits → empreintes (`t1FactRef`, posées par
 * `anchorOperationCandidates`), éléments mal formés conservés comme
 * invalides. Rend `null` si la sortie ne porte pas le tableau (contrat non porté).
 */
export function anchorValueDecisions(
  out: Pick<T1AnalyzeDocumentOutput, 'facts' | 'valueDecisions'>, origin: ValueDecisionOrigin,
  invalid: ReadonlyArray<{ payload: unknown }> = [],
): AnchoredValueDecision[] | null {
  if (out.valueDecisions === undefined && invalid.length === 0) return null;
  const facts = out.facts as T1FactWithRef[];
  const refOf = (i: number): string | null => facts[i]?.t1FactRef ?? null;
  const ok = (out.valueDecisions ?? []).map((d): AnchoredValueDecision => ({
    value: d.value, kind: d.kind, normalizedValue: d.normalizedValue == null ? null : String(d.normalizedValue),
    decision: d.decision, reason: d.reason, sourceUnitId: d.sourceUnitId ?? null, evidence: d.evidence ?? {},
    relatedFactRefs: [...new Set(d.relatedFactIndexes.map(refOf).filter((r): r is string => r !== null))],
    relatedCandidateKeys: d.relatedCandidateKeys, confidence: d.confidence, origin,
  }));
  const ko = invalid.map(({ payload }): AnchoredValueDecision => {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    return {
      value: String(p.value ?? '').slice(0, 200), kind: dansListe(T1_VALUE_KINDS, p.kind), normalizedValue: null,
      decision: dansListe(T1_VALUE_DECISIONS, p.decision), reason: typeof p.reason === 'string' ? p.reason.slice(0, 400) : '',
      sourceUnitId: typeof p.sourceUnitId === 'string' ? p.sourceUnitId.slice(0, 120) : null, evidence: {},
      relatedFactRefs: [], relatedCandidateKeys: [], confidence: null, origin, schemaInvalid: true,
    };
  });
  return [...ok, ...ko];
}

/** Valeur de la décision retrouvée dans le texte d'une unité : forme normalisée, ou rejet. */
function retrouver(d: AnchoredValueDecision, text: string): { normalized: string } | { rejection: ValueDecisionRejection } {
  const kind = d.kind!;
  const dansUnite = significantValues(text, { identifiers: true }).filter((v) => v.kind === kind);
  if (dansUnite.length === 0) return { rejection: 'VALUE_NOT_IN_UNIT' };
  const propres = new Set(significantValues(d.value, { identifiers: true }).filter((v) => v.kind === kind).map((v) => v.normalized));
  let hits = dansUnite.filter((v) => propres.has(v.normalized));
  if (hits.length === 0) {
    const pv = plat(d.value);
    hits = dansUnite.filter((v) => plat(v.raw) === pv);
  }
  const formes = [...new Set(hits.map((h) => h.normalized))];
  if (formes.length === 0) return { rejection: 'VALUE_NOT_IN_UNIT' };
  if (formes.length > 1) return { rejection: 'VALUE_AMBIGUOUS' };
  if (d.normalizedValue !== null && d.normalizedValue.trim() !== '' && d.normalizedValue.trim().toUpperCase() !== formes[0].toUpperCase()) {
    return { rejection: 'NORMALIZED_MISMATCH' };
  }
  return { normalized: formes[0] };
}

export interface ValidationContext {
  /** Unités de la source (couche A) de l'analyse — ou les seules unités réexaminées. */
  units: readonly SourceUnit[];
  /** Empreintes des faits CONSERVÉS par l'analyse (preuve, capacités, projection). */
  keptFactRefs: ReadonlySet<string>;
  /** Clés des candidats Opération retenus par la barrière serveur. */
  candidateKeys: ReadonlySet<string>;
}

/** Validation (pure) — voir l'en-tête. Une ligne par unité ; doublons exacts retirés. */
export function validateValueDecisions(decisions: readonly AnchoredValueDecision[], ctx: ValidationContext): PreparedValueDecision[] {
  const lues = ctx.units.filter((u) => UNITES_LUES.has(u.kind) && unitTextOf(u));
  const parId = new Map(lues.map((u) => [u.sourceUnitId, u]));
  const linker = new SourceUnitLinker(ctx.units);
  const out: PreparedValueDecision[] = [];
  for (const d of decisions) {
    const base = {
      origin: d.origin, kind: d.kind, rawValue: d.value, decision: d.decision, reason: d.reason.trim(), confidence: d.confidence,
      evidence: d.evidence, relatedFactRefs: d.relatedFactRefs.filter((r) => ctx.keptFactRefs.has(r)),
      relatedCandidateKeys: d.relatedCandidateKeys.filter((k) => ctx.candidateKeys.has(k)),
    };
    const rejet = (code: ValueDecisionRejection, unit: SourceUnit | null = null, normalized: string | null = null): PreparedValueDecision => ({
      ...base, sourceUnitId: unit?.sourceUnitId ?? d.sourceUnitId ?? null, unitFingerprint: unit ? unitFingerprint(unitTextOf(unit)) : null,
      normalizedValue: normalized, validity: 'INVALID', invalidReason: code,
    });
    if (d.schemaInvalid || !d.kind || !d.decision || !d.value) { out.push(rejet('INVALID_SCHEMA')); continue; }
    // 1. Unités candidates : identifiant cité, sinon preuve, sinon valeur présente dans une seule unité.
    let unites: SourceUnit[] = [];
    if (d.sourceUnitId) {
      const u = parId.get(unitOfCell(d.sourceUnitId));
      if (u) unites = [u];
    }
    if (unites.length === 0 && (d.evidence.excerpt || d.evidence.table)) {
      unites = [...new Set(linker.link({ provenance: 'TEXT_EXTRACTION', excerpt: d.evidence.excerpt ?? null, page: d.evidence.page ?? null, table: d.evidence.table ?? null })
        .map(unitOfCell))].map((id) => parId.get(id)).filter((u): u is SourceUnit => u !== undefined);
    }
    // Valeur seule (aucune provenance citée) : retrouvée dans une seule unité. Une provenance CITÉE introuvable est un rejet.
    const citee = Boolean(d.sourceUnitId || d.evidence.excerpt || d.evidence.table);
    if (unites.length === 0 && !citee) {
      unites = lues.filter((u) => !('rejection' in retrouver(d, unitTextOf(u)!)));
      if (unites.length > 1) { out.push(rejet('UNIT_AMBIGUOUS')); continue; }
    }
    if (unites.length === 0) { out.push(rejet('UNIT_NOT_FOUND')); continue; }
    // 2. Valeur retrouvée dans chaque unité retenue (au moins une).
    const trouvees: Array<{ u: SourceUnit; normalized: string }> = [];
    let premierRejet: ValueDecisionRejection | null = null;
    for (const u of unites) {
      const r = retrouver(d, unitTextOf(u)!);
      if ('rejection' in r) premierRejet ??= r.rejection;
      else trouvees.push({ u, normalized: r.normalized });
    }
    if (trouvees.length === 0) { out.push(rejet(premierRejet ?? 'VALUE_NOT_IN_UNIT', unites[0])); continue; }
    // 3. Motif et rattachements (forme seulement — jamais la pertinence).
    let code: ValueDecisionRejection | null = null;
    const motif = base.reason;
    if (motif.length < MOTIF_MIN || plat(motif) === plat(d.value)) code = 'REASON_MISSING';
    else if (d.decision === 'STRUCTURED' && base.relatedFactRefs.length === 0) code = d.relatedFactRefs.length ? 'LINK_UNKNOWN' : 'LINK_MISSING';
    else if (d.decision === 'COMPONENT_OR_CONTEXT' && base.relatedFactRefs.length === 0 && base.relatedCandidateKeys.length === 0) {
      code = d.relatedFactRefs.length || d.relatedCandidateKeys.length ? 'LINK_UNKNOWN' : 'LINK_MISSING';
    }
    for (const t of trouvees) {
      out.push({
        ...base, sourceUnitId: t.u.sourceUnitId, unitFingerprint: unitFingerprint(unitTextOf(t.u)), normalizedValue: t.normalized,
        validity: code ? 'INVALID' : 'VALID', invalidReason: code,
      });
    }
  }
  // 4. Une valeur, une décision : doublons exacts retirés ; décisions VALIDES contradictoires → toutes invalides.
  const parCle = new Map<string, PreparedValueDecision[]>();
  for (const p of out) {
    if (p.validity !== 'VALID' || !p.sourceUnitId || !p.kind || !p.normalizedValue) continue;
    const k = valueKey(p.sourceUnitId, p.kind, p.normalizedValue);
    parCle.set(k, [...(parCle.get(k) ?? []), p]);
  }
  const retirees = new Set<PreparedValueDecision>();
  for (const l of parCle.values()) {
    if (l.length < 2) continue;
    if (new Set(l.map((p) => p.decision)).size > 1) for (const p of l) { p.validity = 'INVALID'; p.invalidReason = 'CONFLICTING_DECISIONS'; }
    else for (const p of l.slice(1)) retirees.add(p);
  }
  return out.filter((p) => !retirees.has(p));
}

/** Empreinte de déduplication d'une décision persistée (même décision rejouée = même ligne active). */
export function decisionFingerprint(fileId: number, p: PreparedValueDecision): string {
  return createHash('sha256').update(JSON.stringify([
    fileId, p.origin === 'REVIEW' ? 'REVIEW' : 'ANALYSIS', p.sourceUnitId, p.unitFingerprint, p.kind, p.normalizedValue, p.rawValue,
    p.decision, p.reason, p.validity, p.invalidReason, [...p.relatedFactRefs].sort(), [...p.relatedCandidateKeys].sort(),
  ])).digest('hex').slice(0, 24);
}
