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
import { allSignificantValues, compactIdentifier, mots, plat } from '../source-units/text';
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
  // Lot 108K (ticket 91D bis, §A) : motif générique / tautologique, motif sans rapport démontrable avec la valeur et
  // son unité, rattachement à un fait sans relation cohérente avec la valeur.
  'REASON_GENERIC', 'REASON_UNRELATED', 'LINK_INCOHERENT',
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
  const dansUnite = allSignificantValues(text).filter((v) => v.kind === kind);
  if (dansUnite.length === 0) return { rejection: 'VALUE_NOT_IN_UNIT' };
  const propres = new Set(allSignificantValues(d.value).filter((v) => v.kind === kind).map((v) => v.normalized));
  if (kind === 'IDENTIFIER' && compactIdentifier(d.value).length >= 6) propres.add(compactIdentifier(d.value));
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
  /**
   * Lot 108K — contexte des faits (valeur, libellé, preuve, unités), par
   * empreinte (`factContextOf`) : COHÉRENCE des rattachements. Absent (appel
   * historique) : seul le rattachement technique est vérifié.
   */
  facts?: ReadonlyMap<string, FactContext>;
  /** Lot 108K — unités de VOISINAGE (ancrage du motif) quand `units` est restreint (réexamen) ; défaut : `units`. */
  contextUnits?: readonly SourceUnit[];
  /** Lot 108K — faits de preuve de chaque candidat retenu (clé → empreintes). */
  candidateFacts?: ReadonlyMap<string, readonly string[]>;
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
    // 3. Motif et rattachements (forme, provenance, cohérence — jamais la pertinence).
    let code0: ValueDecisionRejection | null = null;
    const motif = base.reason;
    if (motif.length < MOTIF_MIN || plat(motif) === plat(d.value)) code0 = 'REASON_MISSING';
    else if (d.decision === 'STRUCTURED' && base.relatedFactRefs.length === 0) code0 = d.relatedFactRefs.length ? 'LINK_UNKNOWN' : 'LINK_MISSING';
    else if (d.decision === 'COMPONENT_OR_CONTEXT' && base.relatedFactRefs.length === 0 && base.relatedCandidateKeys.length === 0) {
      code0 = d.relatedFactRefs.length || d.relatedCandidateKeys.length ? 'LINK_UNKNOWN' : 'LINK_MISSING';
    }
    const voisinage = new UnitNeighbourhood((ctx.contextUnits ?? ctx.units).filter((u) => UNITES_LUES.has(u.kind) && unitTextOf(u)).map(asOccurrenceUnit));
    for (const t of trouvees) {
      // Lot 108K (§A) : motif SPÉCIFIQUE à l'occurrence et rattachements COHÉRENTS avec la valeur, jugés sur CETTE unité.
      const code = code0 ?? qualifyDecision({
        decision: d.decision, reason: motif, rawValue: d.value, kind: d.kind, normalized: t.normalized,
        unit: asOccurrenceUnit(t.u), neighbourhood: voisinage,
        facts: ctx.facts ? base.relatedFactRefs.map((r) => ctx.facts!.get(r)).filter((f): f is FactContext => f !== undefined) : null,
        candidateFacts: ctx.facts && ctx.candidateFacts
          ? base.relatedCandidateKeys.flatMap((k) => ctx.candidateFacts!.get(k) ?? []).map((r) => ctx.facts!.get(r)).filter((f): f is FactContext => f !== undefined)
          : null,
        candidateLinked: base.relatedCandidateKeys.length > 0,
      });
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

// ══ Lot 108K (ticket « Correctifs de conformité du lot 91D », §A) ═══════════
//
// Une décision NOT_RETAINED / COMPONENT_OR_CONTEXT / STRUCTURED ne justifie
// une valeur que si sa qualité minimale est DÉMONTRABLE par la structure :
//   · motif SPÉCIFIQUE à l'occurrence : après retrait des valeurs, des mots
//     outils et du vocabulaire de la décision elle-même (« non pertinent »,
//     « information secondaire », « déjà traité »…), il reste au moins un mot
//     de contenu (sinon REASON_GENERIC) ET ce motif est ANCRÉ dans la source :
//     un mot de contenu partagé avec l'unité, son voisinage immédiat (même
//     page, unités proches, même tableau) ou un fait rattaché, ou une autre
//     valeur de ce voisinage / de ces faits citée (sinon REASON_UNRELATED) ;
//   · rattachement COHÉRENT : STRUCTURED → un fait rattaché porte CETTE valeur ;
//     COMPONENT_OR_CONTEXT → un fait rattaché est situé dans le voisinage de
//     l'unité, ou le motif cite sa valeur ou son libellé (sinon
//     LINK_INCOHERENT) — un simple identifiant de fait ne suffit pas.
// Le vocabulaire générique n'est PAS une liste de motifs interdits : il est
// seulement retiré avant de chercher l'ancrage (il n'ancre rien). Aucune
// règle de pertinence : le code ne dit jamais qu'une valeur est utile ou non.
// UNDETERMINED n'est jamais une justification (le contrôle ne l'acquitte pas) :
// son motif n'est contrôlé qu'en présence.

/** Mots outils (français, anglais courant) : jamais un ancrage. */
const MOTS_OUTILS = new Set([
  'les', 'des', 'une', 'aux', 'par', 'pour', 'sur', 'dans', 'avec', 'sans', 'ces', 'cet', 'cette', 'est', 'sont', 'pas', 'plus', 'que', 'qui',
  'dont', 'son', 'ses', 'leur', 'leurs', 'elle', 'ils', 'elles', 'mais', 'car', 'donc', 'tres', 'tout', 'tous', 'toute', 'toutes', 'cela',
  'ceci', 'comme', 'ici', 'fait', 'etre', 'ete', 'avoir', 'deux', 'trois', 'entre', 'vers', 'chez', 'lors', 'apres', 'avant', 'meme',
  'seulement', 'egalement', 'aussi', 'alors', 'ainsi', 'soit', 'peut', 'doit', 'the', 'and', 'for', 'not', 'with', 'this', 'that', 'from',
]);

/**
 * Vocabulaire de la DÉCISION elle-même (qualificatifs génériques, codes du
 * contrat, natures de valeur) : retiré avant l'ancrage — il ne dit rien de
 * l'occurrence. Paramètre centralisé (forme de comparaison, racines).
 */
export const GENERIC_REASON_VOCABULARY: readonly string[] = [
  'pertinent', 'pertinente', 'pertinents', 'pertinentes', 'pertinence', 'secondaire', 'secondaires', 'information', 'informations', 'info',
  'informatif', 'informative', 'donnee', 'donnees', 'valeur', 'valeurs', 'montant', 'montants', 'date', 'dates', 'identifiant', 'identifiants',
  'traite', 'traitee', 'traites', 'traitees', 'traitement', 'deja', 'retenu', 'retenue', 'retenus', 'retenues', 'retenir', 'structure',
  'structuree', 'structures', 'structurees', 'composante', 'composantes', 'contexte', 'contextuel', 'contextuelle', 'indetermine',
  'indeterminee', 'utile', 'utiles', 'inutile', 'inutiles', 'important', 'importante', 'importants', 'significatif', 'significative',
  'necessaire', 'necessaires', 'interet', 'concerne', 'concernee', 'applicable', 'aucun', 'aucune', 'autre', 'autres', 'element',
  'elements', 'document', 'documents', 'non', 'decision', 'reprise', 'repris', 'reprendre', 'ignore', 'ignoree', 'exclu', 'exclue',
  'exclusion', 'conserve', 'garde', 'ailleurs', 'plusieurs', 'fois', 'cas', 'ici', 'relevant', 'irrelevant', 'secondary', 'already', 'processed', 'value', 'useful', 'not', 'retained',
];
const GENERIQUES = new Set(GENERIC_REASON_VOCABULARY);
/** Voisinage d'une unité : même page, au plus N unités d'écart dans l'ordre de lecture (paramètre). */
export const DECISION_NEIGHBOUR_WINDOW = 3;
const RACINE = 5;

const racine = (w: string) => (w.length <= RACINE ? w : w.slice(0, RACINE));
/** Texte sans ses valeurs significatives (montants, dates, identifiants). */
const sansValeurs = (t: string) => { let x = t; for (const v of allSignificantValues(t)) x = x.split(v.raw).join(' '); return x; };
/** Mots de CONTENU d'un texte (≥ 3 lettres, sans chiffre, ni outil ni générique), en racines. */
export function contentRoots(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(mots(sansValeurs(text)).filter((w) => w.length >= 3 && !/\d/.test(w) && !MOTS_OUTILS.has(w) && !GENERIQUES.has(w)).map(racine));
}

/** Formes comparables d'une valeur (montant en centimes, date ISO, identifiant compact). Pure. */
export function valueFormsOf(v: unknown): Set<string> {
  const out = new Set<string>();
  if (v === null || v === undefined || v === '') return out;
  if (typeof v === 'number' && Number.isFinite(v)) {
    out.add(`AMOUNT:${Math.round(v * 100)}`);
    if (Number.isInteger(v)) out.add(`AMOUNT:${v}`);
    return out;
  }
  const s = String(v).trim();
  for (const x of allSignificantValues(s)) out.add(`${x.kind}:${x.normalized}`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out.add(`DATE:${s}`);
  const m = /^-?(\d+)(?:[.,](\d{1,2}))?$/.exec(s.replace(/[\s  ]/g, ''));
  if (m) {
    out.add(`AMOUNT:${Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0)}`);
    if (!m[2]) out.add(`AMOUNT:${Number(m[1])}`);
  }
  const id = compactIdentifier(s);
  if (id.length >= 6 && /\d/.test(id) && /^[A-Z0-9]+$/.test(id)) out.add(`IDENTIFIER:${id}`);
  return out;
}

/** Lot 108K — ce que le serveur sait d'un fait T1 pour juger un rattachement (aucun contenu au-delà du document). */
export interface FactContext {
  /** Formes comparables de la valeur du fait. */
  forms: ReadonlySet<string>;
  /** Libellé, clé et extrait de preuve. */
  text: string;
  /** Unités sources du fait (provenance ou extrait retrouvé). */
  unitIds: readonly string[];
}

/** Contexte des faits d'une sortie T1, par empreinte (pure). */
export function factContextOf(
  facts: ReadonlyArray<Partial<T1FactWithRef> & { sourceUnitIds?: string[] }>, units: readonly SourceUnit[],
): Map<string, FactContext> {
  const linker = new SourceUnitLinker(units);
  const out = new Map<string, FactContext>();
  for (const f of facts) {
    if (!f.t1FactRef) continue;
    const ev = (f.evidence ?? {}) as T1Evidence;
    const lies = f.sourceUnitIds?.length ? f.sourceUnitIds
      : ev.excerpt || ev.table ? linker.link({ provenance: 'TEXT_EXTRACTION', excerpt: ev.excerpt ?? null, page: ev.page ?? null, table: ev.table ?? null }) : [];
    out.set(f.t1FactRef, {
      forms: new Set([...valueFormsOf(f.normalizedValue as unknown), ...valueFormsOf(f.rawValue as unknown)]),
      text: [f.label, f.rawKey, ev.excerpt].filter((x): x is string => typeof x === 'string' && x !== '').join(' — '),
      unitIds: [...new Set(lies.map(unitOfCell))],
    });
  }
  return out;
}

/** Unité vue pour le voisinage (unités du contrôle comme couche A). */
export interface OccurrenceUnit { id: string; ordinal: number; page: number | null; parent: string | null; text: string | null }
export const asOccurrenceUnit = (u: Pick<SourceUnit, 'sourceUnitId' | 'ordinal' | 'page' | 'parentUnitId'> & { text?: string | null; label?: string | null; value?: string | null }): OccurrenceUnit => ({
  id: u.sourceUnitId, ordinal: u.ordinal, page: u.page ?? null, parent: u.parentUnitId ?? null, text: unitTextOf(u),
});

/** Voisinage des unités (même page, ordre de lecture proche, même tableau). */
export class UnitNeighbourhood {
  private readonly byId: Map<string, OccurrenceUnit>;
  constructor(private readonly units: readonly OccurrenceUnit[]) { this.byId = new Map(units.map((u) => [u.id, u])); }
  /** Unités voisines de `u` (elle comprise). */
  around(u: OccurrenceUnit, window = DECISION_NEIGHBOUR_WINDOW): OccurrenceUnit[] {
    return this.units.filter((x) => x.id === u.id || (u.parent && x.parent === u.parent) || x.id === u.parent
      || ((x.page === u.page || x.page === null || u.page === null) && Math.abs(x.ordinal - u.ordinal) <= window));
  }
  /** Deux unités sont-elles voisines ? */
  near(u: OccurrenceUnit, otherId: string): boolean {
    const o = this.byId.get(otherId);
    if (!o) return false;
    return this.around(u).some((x) => x.id === o.id);
  }
}

export interface DecisionQualityInput {
  decision: string | null;
  reason: string;
  rawValue: string;
  kind: string | null;
  normalized: string;
  unit: OccurrenceUnit;
  neighbourhood: UnitNeighbourhood;
  /** Faits rattachés ENCORE CONNUS (null : contexte non fourni, cohérence non jugée). */
  facts: readonly FactContext[] | null;
  /** Faits de preuve des candidats rattachés (null : inconnus). */
  candidateFacts: readonly FactContext[] | null;
  candidateLinked: boolean;
}

/**
 * Qualité minimale DÉMONTRABLE d'une décision sur une occurrence (pure) —
 * voir l'en-tête de section. Rend le motif de rejet, ou null.
 */
export function qualifyDecision(p: DecisionQualityInput): ValueDecisionRejection | null {
  if (p.decision === 'UNDETERMINED' || p.decision === null) return null;
  const propres = contentRoots(p.reason);
  if (propres.size === 0) return 'REASON_GENERIC';
  // Tautologie : le motif ne fait que recopier les mots de l'unité, sans rien expliquer ni citer d'autre valeur.
  const soi0 = `${p.kind}:${p.normalized}`;
  const autresValeurs = [...valueFormsOf(p.reason)].filter((x) => x !== soi0);
  const propresUnite = contentRoots(p.unit.text);
  if (autresValeurs.length === 0 && [...propres].every((r) => propresUnite.has(r))) return 'REASON_GENERIC';
  const voisins = p.neighbourhood.around(p.unit);
  const faits = [...(p.facts ?? []), ...(p.candidateFacts ?? [])];
  const ancres = new Set<string>();
  for (const t of [...voisins.map((u) => u.text), ...faits.map((f) => f.text)]) for (const r of contentRoots(t)) ancres.add(r);
  const soi = `${p.kind}:${p.normalized}`;
  const citees = new Set([...valueFormsOf(p.reason)].filter((x) => x !== soi));
  const formesVoisines = new Set<string>([...voisins.flatMap((u) => [...valueFormsOf(u.text)]), ...faits.flatMap((f) => [...f.forms])]);
  const ancre = [...propres].some((r) => ancres.has(r)) || [...citees].some((x) => formesVoisines.has(x));
  if (!ancre) return 'REASON_UNRELATED';
  if (p.facts === null) return null;
  if (p.decision === 'STRUCTURED') {
    return p.facts.some((f) => f.forms.has(soi)) ? null : 'LINK_INCOHERENT';
  }
  if (p.decision === 'COMPONENT_OR_CONTEXT') {
    const coherent = (f: FactContext) => f.unitIds.some((id) => p.neighbourhood.near(p.unit, id))
      || [...citees].some((x) => f.forms.has(x)) || [...propres].some((r) => contentRoots(f.text).has(r));
    if (p.facts.some(coherent)) return null;
    if (p.candidateFacts && p.candidateFacts.some(coherent)) return null;
    // Candidat seul, preuves inconnues : le motif ancré suffit (la barrière serveur a retenu le candidat).
    if (p.facts.length === 0 && p.candidateLinked && p.candidateFacts === null) return null;
    return 'LINK_INCOHERENT';
  }
  return null;
}
