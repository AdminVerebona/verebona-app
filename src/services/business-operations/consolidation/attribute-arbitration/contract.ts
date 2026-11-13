/**
 * Lot 114 (Trello #750, issue B) — contrat de l'ARBITRAGE T3 par l'IA d'une
 * contradiction d'attribut d'un événement de référence (branche
 * ATTRIBUTE_ARBITRATION du prompt maître T3, contrat
 * `t3-attribute-arbitration-v1`, bloc 38 du guide du PO). Partie PURE : zod seul.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI DÉCIDE QUOI
 *
 *   Code  la qualification 113AQ (`attribute-conflicts.ts`) écarte sans IA les
 *         rôles différents, les formats équivalents, les révisions successives
 *         et les valeurs tranchées par l'utilisateur. Il ne reste à l'arbitrage
 *         que la contradiction du MÊME attribut et du MÊME rôle, non tranchée ;
 *   T3    examine CETTE ligne (monde fermé : valeurs `V1`…, documents `D1`…,
 *         leurs extraits) et rend une issue : RESOLVED (une valeur retenue,
 *         preuve citée dans un document qui la porte), DISTINCT_FACTS (les
 *         valeurs portent sur des faits distincts : pas un conflit),
 *         UNDECIDABLE (même fait, preuves de même autorité : à l'utilisateur),
 *         LINK_ERROR (un document est étranger à l'événement) ou ABSTAIN ;
 *   Code  VALIDE strictement (schéma, références, extrait réellement présent
 *         dans les textes fournis, valeur de l'utilisateur jamais remplacée) —
 *         toute sortie invalide vaut abstention — et n'applique que les issues
 *         CERTAINES, sous la décision de l'utilisateur. Une source « plus
 *         récente » n'est jamais retenue d'office : la preuve citée décide.
 *
 * Activation prudente : appelé seulement si la version T3 EFFECTIVE porte la
 * section « BRANCHE TASK = ATTRIBUTE_ARBITRATION » ET le marqueur
 * `t3-attribute-arbitration-v1`. Sinon : aucune demande, aucun appel — la
 * contradiction réelle va directement à la carte « À traiter » (issue C).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';

export const ATTRIBUTE_ARBITRATION_CONTRACT_VERSION = 't3-attribute-arbitration-v1';
export const ATTRIBUTE_ARBITRATION_TASK = 'ATTRIBUTE_ARBITRATION';
export const ATTRIBUTE_ARBITRATION_OPERATION = 't3_attribute_arbitration';

export const ARBITRATION_OUTCOMES = ['RESOLVED', 'DISTINCT_FACTS', 'UNDECIDABLE', 'LINK_ERROR', 'ABSTAIN'] as const;
export type ArbitrationOutcome = (typeof ARBITRATION_OUTCOMES)[number];

/** Bornes du contexte transmis (aucune donnée au-delà). */
export const ARBITRATION_CONTEXT_BOUNDS = { maxValues: 4, maxDocuments: 6, maxExcerptsPerDocument: 8, maxExcerptLength: 400, maxReferences: 6 } as const;

const VALUE_REFS = ['V1', 'V2', 'V3', 'V4'] as const;
const DOC_REFS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'] as const;
type ValueRef = (typeof VALUE_REFS)[number];
type DocRef = (typeof DOC_REFS)[number];

// ── Contexte BRUT (chargé par le service ; aussi la forme des cas du corpus) ──

export interface RawArbitrationValue {
  value: string;
  /** Forme de comparaison (`normalizeConflictDate` / `normalizeConflictProvider`). */
  normalized: string;
  /** Documents qui portent cette valeur. */
  fileIds: number[];
  /** Valeur actuellement portée par l'événement de référence. */
  held: boolean;
  /** Valeur saisie ou choisie par l'utilisateur : jamais remplacée. */
  userProtected: boolean;
}

export interface RawArbitrationDocument {
  id: number;
  type: string | null;
  title: string | null;
  date: string | null;
  provider: string | null;
  references: Array<{ kind: string; value: string }>;
  excerpts: string[];
}

export interface RawArbitrationContext {
  today: string;
  /** Attribut canonique (plannedDate, startDate, realizedDate, endDate, provider). */
  field: string;
  /** Rôle sémantique comparé (même fait). */
  role: string;
  operation: { typeCode: string | null; label: string | null };
  values: RawArbitrationValue[];
  documents: RawArbitrationDocument[];
}

// ── Entrée (variables des six emplacements du master T3, aucun nouveau) ────

interface ArbitrationValueInput { ref: ValueRef; value: string; documents: DocRef[]; heldByEvent: boolean; protectedByUser: boolean }
interface ArbitrationDocumentInput {
  ref: DocRef; type: string | null; title: string | null; date: string | null; provider: string | null;
  references: Array<{ kind: string; value: string }>; excerpts: string[];
}

export interface ArbitrationInput {
  contractVersion: typeof ATTRIBUTE_ARBITRATION_CONTRACT_VERSION;
  task: typeof ATTRIBUTE_ARBITRATION_TASK;
  today: string;
  attribute: { field: string; role: string };
  operation: { type: string | null; label: string | null };
  values: ArbitrationValueInput[];
  documents: ArbitrationDocumentInput[];
  bounds: { complete: boolean; droppedValues: number; droppedDocuments: number; droppedExcerpts: number };
}

/** Correspondance des références opaques (jamais transmise au modèle). */
export interface ArbitrationScope {
  values: Partial<Record<ValueRef, { value: string; normalized: string; fileIds: number[]; userProtected: boolean; documents: DocRef[] }>>;
  documents: Partial<Record<DocRef, number>>;
  /** Textes fournis par document (contrôle des extraits cités). */
  texts: Partial<Record<DocRef, string[]>>;
  /** Formes de comparaison de TOUTES les valeurs de la ligne (même au-delà des bornes). */
  known: string[];
  /** Contexte complet (aucune valeur ni document retiré par les bornes) : condition d'un arbitrage. */
  complete: boolean;
}

const borne = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Contexte borné et références opaques (pur, ordre stable : valeurs triées, documents par identifiant). */
export function buildArbitrationInput(raw: RawArbitrationContext): { input: ArbitrationInput; scope: ArbitrationScope } {
  const B = ARBITRATION_CONTEXT_BOUNDS;
  const toutes = [...raw.values].sort((a, b) => (a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0));
  if (toutes.length < 2) throw new Error('[attribute-arbitration] au moins deux valeurs sont attendues');
  const valeurs = toutes.slice(0, B.maxValues);
  const fichiers = [...new Set(valeurs.flatMap((v) => v.fileIds))].sort((a, b) => a - b);
  const retenus = fichiers.slice(0, B.maxDocuments);
  const refDe = new Map(retenus.map((id, i) => [id, DOC_REFS[i]]));
  let extraitsRetires = 0;
  const documents: ArbitrationDocumentInput[] = retenus.map((id) => {
    const d = raw.documents.find((x) => x.id === id);
    const extraits = (d?.excerpts ?? []).filter((e) => typeof e === 'string' && e.trim()).map((e) => borne(e.trim(), B.maxExcerptLength));
    extraitsRetires += Math.max(0, extraits.length - B.maxExcerptsPerDocument);
    return {
      ref: refDe.get(id)!, type: d?.type ?? null, title: d?.title ?? null, date: d?.date ?? null, provider: d?.provider ?? null,
      references: (d?.references ?? []).slice(0, B.maxReferences), excerpts: extraits.slice(0, B.maxExcerptsPerDocument),
    };
  });
  const scope: ArbitrationScope = { values: {}, documents: {}, texts: {}, known: toutes.map((v) => v.normalized), complete: true };
  for (const d of documents) {
    scope.documents[d.ref] = retenus[DOC_REFS.indexOf(d.ref)];
    scope.texts[d.ref] = [...(d.title ? [d.title] : []), ...(d.provider ? [d.provider] : []), ...d.excerpts];
  }
  const values: ArbitrationValueInput[] = valeurs.map((v, i) => {
    const ref = VALUE_REFS[i];
    const docs = v.fileIds.map((f) => refDe.get(f)).filter((r): r is DocRef => r !== undefined).sort();
    scope.values[ref] = { value: v.value, normalized: v.normalized, fileIds: v.fileIds, userProtected: v.userProtected, documents: docs };
    return { ref, value: v.value, documents: docs, heldByEvent: v.held, protectedByUser: v.userProtected };
  });
  const droppedValues = toutes.length - valeurs.length;
  const droppedDocuments = fichiers.length - retenus.length;
  scope.complete = droppedValues === 0 && droppedDocuments === 0 && values.every((v) => v.documents.length > 0 || v.protectedByUser);
  return {
    input: {
      contractVersion: ATTRIBUTE_ARBITRATION_CONTRACT_VERSION, task: ATTRIBUTE_ARBITRATION_TASK, today: raw.today,
      attribute: { field: raw.field, role: raw.role }, operation: { type: raw.operation.typeCode, label: raw.operation.label },
      values, documents, bounds: { complete: scope.complete && extraitsRetires === 0, droppedValues, droppedDocuments, droppedExcerpts: extraitsRetires },
    },
    scope,
  };
}

/**
 * Variables RÉELLES du master T3 (les six emplacements, aucun nouveau) :
 * FIELD = contrat + attribut + événement de référence ; CURRENT_STATE = les
 * valeurs en présence ; EVIDENCES = documents et extraits ; SUBJECT_CONTEXT =
 * date, monde fermé, bornes ; CANDIDATES = issues admises ; RELATION_TYPE.
 */
export function arbitrationVariables(input: ArbitrationInput): Record<string, unknown> {
  return {
    FIELD: { contractVersion: input.contractVersion, task: input.task, attribute: input.attribute, operation: input.operation },
    CURRENT_STATE: { values: input.values },
    EVIDENCES: { documents: input.documents },
    SUBJECT_CONTEXT: { today: input.today, closedWorld: true, bounds: input.bounds },
    CANDIDATES: { outcomes: [...ARBITRATION_OUTCOMES] },
    RELATION_TYPE: ATTRIBUTE_ARBITRATION_TASK,
  };
}

/** Le texte d'un prompt porte-t-il la branche ET le marqueur ? (pure) */
export function promptCarriesAttributeArbitration(text: string | null | undefined, branches: readonly string[]): boolean {
  return typeof text === 'string' && text.includes(ATTRIBUTE_ARBITRATION_CONTRACT_VERSION) && branches.includes(ATTRIBUTE_ARBITRATION_TASK);
}

// ── Sortie (schéma validé par la passerelle, puis `validateArbitration`) ────

export const T3AttributeArbitrationOutput = z.object({
  task: z.literal(ATTRIBUTE_ARBITRATION_TASK),
  outcome: z.enum(ARBITRATION_OUTCOMES),
  /** Valeur retenue (RESOLVED) ; null sinon. */
  retainedValue: z.enum(VALUE_REFS).nullable(),
  /** Document étranger à l'événement de référence (LINK_ERROR) ; null sinon. */
  foreignDocument: z.enum(DOC_REFS).nullable(),
  confidence: z.enum(['certain', 'probable', 'ambiguous']),
  evidence: z.array(z.object({ document: z.enum(DOC_REFS), excerpt: z.string().min(1).max(300) })).max(4).default([]),
  reason: z.string().min(1).max(300),
}).superRefine((v, ctx) => {
  if ((v.outcome === 'RESOLVED') !== (v.retainedValue !== null)) {
    ctx.addIssue({ code: 'custom', path: ['retainedValue'], message: 'retainedValue est obligatoire pour RESOLVED et null sinon' });
  }
  if ((v.outcome === 'LINK_ERROR') !== (v.foreignDocument !== null)) {
    ctx.addIssue({ code: 'custom', path: ['foreignDocument'], message: 'foreignDocument est obligatoire pour LINK_ERROR et null sinon' });
  }
  // Une abstention peut ne rien citer ; toute autre issue cite au moins une preuve.
  if (v.outcome !== 'ABSTAIN' && !v.evidence.length) ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'une preuve citée est exigée (document + extrait)' });
});
export type T3AttributeArbitrationOutput = z.infer<typeof T3AttributeArbitrationOutput>;

/** Motifs de refus (validation) — stables, journalisés. */
export const ARBITRATION_ISSUES = ['SCHEMA', 'UNKNOWN_REFERENCE', 'EXCERPT_NOT_FOUND', 'RETAINED_EVIDENCE_MISSING', 'PROTECTED_VALUE', 'CONTEXT_INCOMPLETE'] as const;
export type ArbitrationIssue = (typeof ARBITRATION_ISSUES)[number];
interface ArbitrationProblem { issue: ArbitrationIssue; detail: string }

/** Normalisation pour comparer un extrait cité au texte fourni (espaces, casse, apostrophes et guillemets). */
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’‘`]/g, '\'').replace(/[«»“”]/g, '"').replace(/\s+/g, ' ').trim();

/** Effet d'une issue CERTAINE (null : aucun — la contradiction suit son cours, carte « À traiter » si elle est réelle). */
export type ArbitrationEffect =
  | { outcome: 'RESOLVED'; value: string; normalized: string; fileIds: number[]; citation: { fileId: number; excerpt: string } }
  | { outcome: 'DISTINCT_FACTS' | 'UNDECIDABLE'; citation: { fileId: number; excerpt: string } }
  | { outcome: 'LINK_ERROR'; foreignFileId: number; citation: { fileId: number; excerpt: string } };

export type ArbitrationValidation =
  | { ok: true; decision: T3AttributeArbitrationOutput; effect: ArbitrationEffect | null; ignored: 'NOT_CERTAIN' | 'ABSTAIN' | null }
  | { ok: false; problems: ArbitrationProblem[] };

/**
 * Validation STRICTE (pure) : une sortie invalide est refusée en bloc (vaut
 * abstention, jamais remplacée par une heuristique) ; seule une issue CERTAINE
 * a un effet. Une valeur de l'utilisateur n'est jamais remplacée.
 */
export function validateArbitration(output: unknown, scope: ArbitrationScope): ArbitrationValidation {
  const parsed = T3AttributeArbitrationOutput.safeParse(output);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 10).map((i) => ({ issue: 'SCHEMA' as const, detail: `${i.path.join('.') || '(racine)'} : ${i.message}`.slice(0, 200) })) };
  }
  const v = parsed.data;
  const problems: ArbitrationProblem[] = [];
  for (const e of v.evidence) {
    const textes = scope.texts[e.document];
    if (!textes) { problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `${e.document} : document hors du contexte` }); continue; }
    const cite = norm(e.excerpt);
    if (!cite || !textes.some((t) => norm(t).includes(cite))) problems.push({ issue: 'EXCERPT_NOT_FOUND', detail: `${e.document} : extrait absent des textes fournis` });
  }
  const retenue = v.retainedValue ? scope.values[v.retainedValue] : undefined;
  if (v.retainedValue) {
    if (!retenue) problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `${v.retainedValue} : valeur hors du contexte` });
    else {
      if (!v.evidence.some((e) => retenue.documents.includes(e.document))) problems.push({ issue: 'RETAINED_EVIDENCE_MISSING', detail: `aucune preuve citée dans un document qui porte ${v.retainedValue}` });
      const protegee = Object.entries(scope.values).find(([ref, x]) => x?.userProtected && ref !== v.retainedValue);
      if (protegee) problems.push({ issue: 'PROTECTED_VALUE', detail: `${protegee[0]} saisie ou choisie par l’utilisateur` });
      if (!scope.complete) problems.push({ issue: 'CONTEXT_INCOMPLETE', detail: 'valeurs ou documents au-delà des bornes : aucun arbitrage sur un contexte partiel' });
    }
  }
  if (v.foreignDocument && scope.documents[v.foreignDocument] === undefined) problems.push({ issue: 'UNKNOWN_REFERENCE', detail: `${v.foreignDocument} : document hors du contexte` });
  if (problems.length) return { ok: false, problems };
  if (v.outcome === 'ABSTAIN') return { ok: true, decision: v, effect: null, ignored: 'ABSTAIN' };
  if (v.confidence !== 'certain') return { ok: true, decision: v, effect: null, ignored: 'NOT_CERTAIN' };
  const cite = (docs?: readonly DocRef[]) => {
    const e = (docs ? v.evidence.find((x) => docs.includes(x.document)) : undefined) ?? v.evidence[0];
    return { fileId: scope.documents[e.document]!, excerpt: e.excerpt };
  };
  if (v.outcome === 'RESOLVED') {
    return { ok: true, decision: v, ignored: null, effect: { outcome: 'RESOLVED', value: retenue!.value, normalized: retenue!.normalized, fileIds: retenue!.fileIds, citation: cite(retenue!.documents) } };
  }
  if (v.outcome === 'LINK_ERROR') {
    return { ok: true, decision: v, ignored: null, effect: { outcome: 'LINK_ERROR', foreignFileId: scope.documents[v.foreignDocument!]!, citation: cite([v.foreignDocument!]) } };
  }
  return { ok: true, decision: v, ignored: null, effect: { outcome: v.outcome, citation: cite() } };
}
