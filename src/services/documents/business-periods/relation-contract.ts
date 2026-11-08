/**
 * Lot 113AD (Trello #725, §2 B — D11 de #724, R13 / R14) — contrat du
 * RÉEXAMEN T3 par l'IA d'une divergence de périodes que les documents ne
 * déclarent pas (branche PERIOD_RELATION du prompt maître T3, contrat
 * `t3-period-relation-v1`, bloc 29 du guide du PO). Partie PURE : zod seul.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI DÉCIDE QUOI
 *
 *   Code  la résolution (`resolution.ts`) explique sans IA la succession, le
 *         même fait, les natures différentes, l'avenant ou le rectificatif
 *         DÉCLARÉ par T1 et la décision de l'utilisateur. Il ne reste au
 *         réexamen que la divergence qu'aucune de ces preuves n'explique
 *         (CONTRADICTION / UNQUALIFIED) ;
 *   T3    classe CETTE paire (monde fermé : deux périodes `P1`, `P2`, deux
 *         documents `D1`, `D2`, leurs extraits) : SUCCESSION, SAME_FACT,
 *         AMENDMENT, RECTIFICATION, DIFFERENT_NATURES, CONTRADICTION ou
 *         ABSTAIN, avec la preuve citée (document + extrait recopié) et sa
 *         confiance ;
 *   Code  VALIDE strictement (schéma, références, extrait réellement présent
 *         dans les textes fournis, période corrigée par l'utilisateur jamais
 *         remplacée) — toute sortie invalide vaut abstention — et n'applique
 *         que les classements CERTAINS, sous la décision de l'utilisateur.
 *
 * Activation prudente : appelé seulement si la version T3 EFFECTIVE porte la
 * section « BRANCHE TASK = PERIOD_RELATION » ET le marqueur
 * `t3-period-relation-v1`. Sinon : aucune demande, aucun appel, rien ne
 * change (question PERIOD-CONFLICT ou signalement, comme au lot 113AA).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';

/** Version du contrat d'entrée / sortie (marqueur exact recherché dans le prompt T3 actif). */
export const PERIOD_RELATION_CONTRACT_VERSION = 't3-period-relation-v1';
/** Branche du prompt maître T3. */
export const PERIOD_RELATION_TASK = 'PERIOD_RELATION';
/** Opération du registre IA. */
export const PERIOD_RELATION_OPERATION = 't3_period_relation';

/** Classements possibles d'une paire (sortie T3). */
export const PERIOD_RELATIONS = ['SUCCESSION', 'SAME_FACT', 'AMENDMENT', 'RECTIFICATION', 'DIFFERENT_NATURES', 'CONTRADICTION', 'ABSTAIN'] as const;
export type PeriodRelationClass = (typeof PERIOD_RELATIONS)[number];
/** Classements qui EXPLIQUENT la divergence (aucune question) ; les autres gardent le comportement 113AA. */
export const EXPLAINING_RELATIONS = ['SUCCESSION', 'SAME_FACT', 'DIFFERENT_NATURES', 'AMENDMENT', 'RECTIFICATION'] as const;
export type ExplainingRelation = (typeof EXPLAINING_RELATIONS)[number];

/** Bornes du contexte transmis (aucune donnée au-delà). */
export const RELATION_CONTEXT_BOUNDS = { maxExcerptsPerDocument: 8, maxExcerptLength: 400, maxReferences: 6 } as const;

// ── Contexte BRUT (chargé par le service ; aussi la forme des cas du corpus) ──

export interface RawRelationPeriod {
  periodId: number;
  fileId: number;
  start: string | null;
  end: string | null;
  openEnded?: boolean;
  /** Passage du document qui porte la période (évidence T1 persistée). */
  quote: string | null;
  userCorrected: boolean;
}

export interface RawRelationDocument {
  id: number;
  type: string | null;
  title: string | null;
  date: string | null;
  provider: string | null;
  references: Array<{ kind: string; value: string }>;
  excerpts: string[];
}

export interface RawRelationContext {
  today: string;
  periodKind: string;
  operation: { typeCode: string | null; label: string | null; provider: string | null };
  /** Exactement deux périodes, de deux documents différents. */
  periods: RawRelationPeriod[];
  documents: RawRelationDocument[];
}

// ── Entrée (variables des six emplacements du master T3, aucun nouveau) ────

type PeriodRef = 'P1' | 'P2';
type DocRef = 'D1' | 'D2';

interface RelationPeriodInput {
  ref: PeriodRef;
  document: DocRef;
  start: string | null;
  end: string | null;
  openEnded: boolean;
  quote: string | null;
  /** Période corrigée par l'utilisateur : jamais remplacée. */
  correctedByUser: boolean;
}

interface RelationDocumentInput {
  ref: DocRef;
  type: string | null;
  title: string | null;
  date: string | null;
  provider: string | null;
  references: Array<{ kind: string; value: string }>;
  excerpts: string[];
}

export interface RelationInput {
  contractVersion: typeof PERIOD_RELATION_CONTRACT_VERSION;
  task: typeof PERIOD_RELATION_TASK;
  today: string;
  periodKind: string;
  operation: { type: string | null; label: string | null; provider: string | null };
  periods: RelationPeriodInput[];
  documents: RelationDocumentInput[];
  bounds: { complete: boolean; droppedExcerpts: number };
}

/** Correspondance des références opaques (jamais transmise au modèle). */
export interface RelationScope {
  periods: Record<PeriodRef, { periodId: number; fileId: number; userCorrected: boolean }>;
  documents: Record<DocRef, number>;
  /** Textes fournis par document (contrôle des extraits cités). */
  texts: Record<DocRef, string[]>;
}

const borne = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Contexte borné et références opaques (pur, ordre stable : document d'identifiant le plus petit = P1 / D1). */
export function buildRelationInput(raw: RawRelationContext): { input: RelationInput; scope: RelationScope } {
  if (raw.periods.length !== 2 || raw.periods[0].fileId === raw.periods[1].fileId) throw new Error('[period-relation] une paire de périodes de deux documents est attendue');
  const [p1, p2] = [...raw.periods].sort((a, b) => a.fileId - b.fileId || a.periodId - b.periodId);
  const B = RELATION_CONTEXT_BOUNDS;
  let retires = 0;
  const doc = (fileId: number, ref: DocRef): RelationDocumentInput => {
    const d = raw.documents.find((x) => x.id === fileId);
    const extraits = (d?.excerpts ?? []).filter((e) => typeof e === 'string' && e.trim()).map((e) => borne(e.trim(), B.maxExcerptLength));
    retires += Math.max(0, extraits.length - B.maxExcerptsPerDocument);
    return {
      ref, type: d?.type ?? null, title: d?.title ?? null, date: d?.date ?? null, provider: d?.provider ?? null,
      references: (d?.references ?? []).slice(0, B.maxReferences), excerpts: extraits.slice(0, B.maxExcerptsPerDocument),
    };
  };
  const documents = [doc(p1.fileId, 'D1'), doc(p2.fileId, 'D2')];
  const period = (p: RawRelationPeriod, ref: PeriodRef, document: DocRef): RelationPeriodInput => ({
    ref, document, start: p.start, end: p.end, openEnded: p.openEnded === true,
    quote: p.quote ? borne(p.quote.trim(), B.maxExcerptLength) : null, correctedByUser: p.userCorrected,
  });
  const periods = [period(p1, 'P1', 'D1'), period(p2, 'P2', 'D2')];
  const texts = (r: DocRef, p: RelationPeriodInput) => {
    const d = documents.find((x) => x.ref === r)!;
    return [...(p.quote ? [p.quote] : []), ...(d.title ? [d.title] : []), ...d.excerpts];
  };
  return {
    input: {
      contractVersion: PERIOD_RELATION_CONTRACT_VERSION, task: PERIOD_RELATION_TASK, today: raw.today, periodKind: raw.periodKind,
      operation: { type: raw.operation.typeCode, label: raw.operation.label, provider: raw.operation.provider },
      periods, documents, bounds: { complete: retires === 0, droppedExcerpts: retires },
    },
    scope: {
      periods: { P1: { periodId: p1.periodId, fileId: p1.fileId, userCorrected: p1.userCorrected }, P2: { periodId: p2.periodId, fileId: p2.fileId, userCorrected: p2.userCorrected } },
      documents: { D1: p1.fileId, D2: p2.fileId },
      texts: { D1: texts('D1', periods[0]), D2: texts('D2', periods[1]) },
    },
  };
}

/**
 * Variables RÉELLES du master T3 (les six emplacements, aucun nouveau) :
 * FIELD = contrat + nature + événement de référence ; CURRENT_STATE = les deux
 * périodes ; EVIDENCES = documents et extraits ; SUBJECT_CONTEXT = date, monde
 * fermé, bornes ; CANDIDATES = classements admis ; RELATION_TYPE.
 */
export function relationVariables(input: RelationInput): Record<string, unknown> {
  return {
    FIELD: { contractVersion: input.contractVersion, task: input.task, periodKind: input.periodKind, operation: input.operation },
    CURRENT_STATE: { periods: input.periods },
    EVIDENCES: { documents: input.documents },
    SUBJECT_CONTEXT: { today: input.today, closedWorld: true, bounds: input.bounds },
    CANDIDATES: { relations: [...PERIOD_RELATIONS] },
    RELATION_TYPE: PERIOD_RELATION_TASK,
  };
}

/** Le texte d'un prompt porte-t-il la branche ET le marqueur ? (pure) */
export function promptCarriesPeriodRelation(text: string | null | undefined, branches: readonly string[]): boolean {
  return typeof text === 'string' && text.includes(PERIOD_RELATION_CONTRACT_VERSION) && branches.includes(PERIOD_RELATION_TASK);
}

// ── Sortie (schéma validé par la passerelle, puis `validateRelation`) ───────

const REPLACING = ['AMENDMENT', 'RECTIFICATION'] as const;

export const T3PeriodRelationOutput = z.object({
  task: z.literal(PERIOD_RELATION_TASK),
  relation: z.enum(PERIOD_RELATIONS),
  /** Période du document qui actualise / remplace l'autre (AMENDMENT, RECTIFICATION) ; null sinon. */
  replacingPeriod: z.enum(['P1', 'P2']).nullable(),
  confidence: z.enum(['certain', 'probable', 'ambiguous']),
  evidence: z.array(z.object({ document: z.enum(['D1', 'D2']), excerpt: z.string().min(1).max(300) })).max(4).default([]),
  reason: z.string().min(1).max(300),
}).superRefine((v, ctx) => {
  const remplace = (REPLACING as readonly string[]).includes(v.relation);
  if (remplace !== (v.replacingPeriod !== null)) {
    ctx.addIssue({ code: 'custom', path: ['replacingPeriod'], message: 'replacingPeriod est obligatoire pour AMENDMENT / RECTIFICATION et null sinon' });
  }
  // Une abstention peut ne rien citer ; tout autre classement cite au moins une preuve.
  if (v.relation !== 'ABSTAIN' && !v.evidence.length) ctx.addIssue({ code: 'custom', path: ['evidence'], message: 'une preuve citée est exigée (document + extrait)' });
});
export type T3PeriodRelationOutput = z.infer<typeof T3PeriodRelationOutput>;

/** Motifs de refus (validation) — stables, journalisés. */
export const RELATION_ISSUES = ['SCHEMA', 'EXCERPT_NOT_FOUND', 'REPLACING_EVIDENCE_MISSING', 'PROTECTED_PERIOD'] as const;
export type RelationIssue = (typeof RELATION_ISSUES)[number];
interface RelationProblem { issue: RelationIssue; detail: string }

/** Normalisation pour comparer un extrait cité au texte fourni (espaces, casse, apostrophes et guillemets). */
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’‘`]/g, '\'').replace(/[«»“”]/g, '"').replace(/\s+/g, ' ').trim();

/** Effet d'un classement (null : comportement 113AA — question si qualifiés, sinon signalement). */
export interface RelationEffect {
  relation: ExplainingRelation;
  /** Document qui actualise / remplace (AMENDMENT, RECTIFICATION) ; null sinon. */
  replacingFileId: number | null;
  /** Preuve citée retenue (document qui la porte, extrait). */
  citation: { fileId: number; excerpt: string };
}

export type RelationValidation =
  | { ok: true; decision: T3PeriodRelationOutput; effect: RelationEffect | null; ignored: 'NOT_CERTAIN' | 'NOT_EXPLAINING' | null }
  | { ok: false; problems: RelationProblem[] };

/**
 * Validation STRICTE (pure) : une sortie invalide est refusée en bloc (vaut
 * abstention, jamais remplacée par une heuristique) ; seule une décision
 * CERTAINE qui explique la divergence a un effet.
 */
export function validateRelation(output: unknown, scope: RelationScope): RelationValidation {
  const parsed = T3PeriodRelationOutput.safeParse(output);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 10).map((i) => ({ issue: 'SCHEMA' as const, detail: `${i.path.join('.') || '(racine)'} : ${i.message}`.slice(0, 200) })) };
  }
  const v = parsed.data;
  const problems: RelationProblem[] = [];
  for (const e of v.evidence) {
    const cite = norm(e.excerpt);
    if (!cite || !scope.texts[e.document].some((t) => norm(t).includes(cite))) problems.push({ issue: 'EXCERPT_NOT_FOUND', detail: `${e.document} : extrait absent des textes fournis` });
  }
  if (v.replacingPeriod) {
    const remplacant = v.replacingPeriod;
    const remplacee = remplacant === 'P1' ? 'P2' : 'P1';
    const docRemplacant: DocRef = remplacant === 'P1' ? 'D1' : 'D2';
    if (!v.evidence.some((e) => e.document === docRemplacant)) problems.push({ issue: 'REPLACING_EVIDENCE_MISSING', detail: `aucune preuve citée dans ${docRemplacant}` });
    if (scope.periods[remplacee].userCorrected) problems.push({ issue: 'PROTECTED_PERIOD', detail: `${remplacee} corrigée par l’utilisateur` });
  }
  if (problems.length) return { ok: false, problems };
  if (!(EXPLAINING_RELATIONS as readonly string[]).includes(v.relation)) return { ok: true, decision: v, effect: null, ignored: 'NOT_EXPLAINING' };
  if (v.confidence !== 'certain') return { ok: true, decision: v, effect: null, ignored: 'NOT_CERTAIN' };
  const docRef: DocRef = v.replacingPeriod === 'P2' ? 'D2' : v.replacingPeriod === 'P1' ? 'D1' : v.evidence[0].document;
  const citation = v.evidence.find((e) => e.document === docRef) ?? v.evidence[0];
  return {
    ok: true, decision: v, ignored: null,
    effect: {
      relation: v.relation as ExplainingRelation,
      replacingFileId: v.replacingPeriod ? scope.periods[v.replacingPeriod].fileId : null,
      citation: { fileId: scope.documents[citation.document], excerpt: citation.excerpt },
    },
  };
}
