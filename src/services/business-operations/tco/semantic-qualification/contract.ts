/**
 * Lot 113AL (Trello #737, écart au CDC 82B / 111V) — contrat de l'ARBITRAGE
 * SÉMANTIQUE T3 des montants non qualifiés d'un document (branche
 * ECONOMIC_QUALIFICATION du prompt maître T3, contrat
 * `t3-economic-qualification-v1`, demande `82B-t3-decision-tco`, bloc 31 du
 * guide du PO). Partie PURE : zod seul.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * QUI DÉCIDE QUOI
 *
 *   Code  le moteur existant (`finance/economic-lines.ts`, `tco/model.ts`)
 *         qualifie d'abord avec les indices T1, les Opérations, la fiche ;
 *         il ne reste à l'arbitrage que les montants CONNUS restés sans
 *         nature (`NOT_QUALIFIED / THEME_UNKNOWN`) ou lus dans l'extract sans
 *         aucune ligne (`SOURCE_AMOUNT_NOT_EXPLOITED`) ;
 *   T3    propose, pour CHAQUE montant `M<n>` du document `D0` (monde fermé :
 *         documents `D0…Dn`, faits déjà comptés `F1…Fn`, extraits fournis),
 *         une issue : INCLUDE (rôle économique du modèle EXISTANT —
 *         `T1_FINANCIAL_ROLES` — portée, date, attribution), REPRESENTED (le
 *         montant est une autre source d'un fait déjà compté `F<n>`, ou son
 *         règlement), EXCLUDE (motif) ou ABSTAIN — avec preuves citées et
 *         confiance. T3 ne rend JAMAIS de montant : les sommes viennent des
 *         données persistées (ligne du moteur, extract) ;
 *   Code  VALIDE strictement (schéma, références, extraits réellement
 *         présents, rôle et compatibilité financière du fait représentant,
 *         preuve qui dépasse l'égalité de montant) — toute sortie invalide
 *         vaut abstention — puis n'applique que les décisions CERTAINES, en
 *         entrée du moteur existant (aucune addition directe, aucun second
 *         moteur), sous les décisions de l'utilisateur (`asset_cost_line_decisions`).
 *
 * Activation prudente : appelé seulement si la version T3 EFFECTIVE porte la
 * section « BRANCHE TASK = ECONOMIC_QUALIFICATION » ET le marqueur
 * `t3-economic-qualification-v1`. Sinon : `CONTRACT_PENDING` supervisé,
 * aucun appel ; les montants restent « Nature à confirmer » (lot 111V).
 * Aucune règle par type de document, fournisseur, mot-clé ou montant.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import { T1_AMOUNT_SCOPES, T1_FINANCIAL_ROLES } from '@/services/ai/source-analysis/master/t1-contract';

/** Version du contrat d'entrée / sortie (marqueur exact recherché dans le prompt T3 actif). */
export const ECONOMIC_QUALIFICATION_CONTRACT_VERSION = 't3-economic-qualification-v1';
/** Branche du prompt maître T3. */
export const ECONOMIC_QUALIFICATION_TASK = 'ECONOMIC_QUALIFICATION';
/** Opération du registre IA. */
export const ECONOMIC_QUALIFICATION_OPERATION = 't3_economic_qualification';
/** Demande de contrat d'origine (lot 82B, C-Q6). */
export const ECONOMIC_QUALIFICATION_REQUEST = '82B-t3-decision-tco';

/** Issues possibles d'un montant. */
export const QUALIFICATION_OUTCOMES = ['INCLUDE', 'REPRESENTED', 'EXCLUDE', 'ABSTAIN'] as const;
export type QualificationOutcome = (typeof QUALIFICATION_OUTCOMES)[number];
/** Attribution d'un montant inclus : ce bien, ou dépense commune à plusieurs biens sans ventilation prouvée. */
export const QUALIFICATION_ALLOCATIONS = ['THIS_ASSET', 'SHARED_NOT_ALLOCATED'] as const;
/** Motifs d'exclusion admis (motifs EXISTANTS du moteur, jamais une nouvelle classification). */
export const QUALIFICATION_EXCLUSIONS = ['NOT_AN_EXPENSE', 'NOT_OWNERSHIP_COST', 'OTHER_ASSET'] as const;
export type QualificationExclusion = (typeof QUALIFICATION_EXCLUSIONS)[number];
/** Rôles qu'un montant REPRÉSENTÉ par un fait déjà compté peut porter. */
const REPRESENTABLE_ROLES = ['REALIZED_COST', 'FORECAST_COST', 'REDUCTION', 'REFUND', 'PAYMENT'] as const;
/** Portées « partie d'un total » (acompte, solde, échéance). */
const PART_SCOPES = new Set(['DEPOSIT', 'BALANCE', 'INSTALLMENT']);

/** Bornes du contexte transmis (aucune donnée au-delà). */
export const QUALIFICATION_CONTEXT_BOUNDS = {
  maxAmounts: 12, maxDocuments: 8, maxExcerptsTarget: 14, maxExcerptsRelated: 4, maxExcerptLength: 400,
  maxFacts: 20, maxCountedFacts: 40, maxReferences: 6, maxLinesPerDocument: 8, maxPeriods: 6, maxOperations: 6, maxPrior: 4,
} as const;

// ── Contexte BRUT (chargé par le service ; aussi la forme des cas du corpus) ──

/** Montant du document cible à arbitrer (somme persistée : ligne du moteur ou extract T1). */
export interface RawQualificationAmount {
  fileId: number;
  amountMinor: number;
  currency: string;
  /** LINE : ligne NOT_QUALIFIED du moteur ; EXTRACT : montant lu dans l'extract sans aucune ligne. */
  origin: 'LINE' | 'EXTRACT';
  /** Identifiant de la ligne du moteur (null : EXTRACT). */
  lineId: string | null;
  /** Passage de l'extract qui porte le montant (si repéré). */
  quote: string | null;
}

export interface RawQualificationDocument {
  id: number;
  type: string | null;
  title: string | null;
  date: string | null;
  provider: string | null;
  references: Array<{ kind: string; value: string }>;
  excerpts: string[];
  /** Faits T1 persistés (clé, libellé, valeur, extrait). */
  facts?: Array<{ key: string; label: string | null; value: string | null; quote: string | null }>;
  /** Périodes métier persistées (nature, bornes). */
  periods?: Array<{ kind: string; start: string | null; end: string | null }>;
  /** Champs corrigés par l'utilisateur sur le document (noms seulement). */
  userCorrectedFields?: string[];
  /** T1 : document commun à plusieurs biens. */
  multiAsset?: boolean;
  /** Nombre de biens auxquels le document est rattaché. */
  linkedAssetCount?: number;
  /** Lignes économiques actuelles du document (statut et motif du moteur). */
  lines?: Array<{ kind: string | null; amountMinor: number; currency: string; status: string; reason: string | null }>;
  /** Relation au document cible (`TARGET`, `SAME_OPERATION`, `SAME_REFERENCE`, `SAME_ASSET`). */
  relation?: string;
}

/** Fait économique DÉJÀ compté (ligne retenue du moteur) — cible possible d'une représentation. */
export interface RawCountedFact {
  /** Clé stable de décision de la ligne (`tcoLineKeys(...).primary`). */
  key: string;
  lineId: string;
  source: 'ASSET_DATA' | 'EQUIPMENT_DATA' | 'OPERATION' | 'DOCUMENT';
  label: string;
  kind: string | null;
  amountMinor: number;
  currency: string;
  date: string | null;
  fileId: number | null;
  operationId: number | null;
}

export interface RawQualificationContext {
  today: string;
  asset: { id: number; category: string | null };
  targetFileId: number;
  amounts: RawQualificationAmount[];
  /** Document cible d'abord, puis documents liés (Opération commune, référence commune, même bien). */
  documents: RawQualificationDocument[];
  countedFacts: RawCountedFact[];
  operations?: Array<{ label: string; typeCode: string | null; fileIds: number[] }>;
  /** Examens antérieurs de ce document (issue résumée), jamais les décisions de l'utilisateur (qui priment et excluent l'examen). */
  priorReviews?: Array<{ at: string; status: string; summary: string }>;
}

// ── Entrée (variables des six emplacements du master T3, aucun nouveau) ────

type Ref = string;

interface InputAmount { ref: Ref; document: 'D0'; amount: string; currency: string; origin: 'LINE' | 'EXTRACT'; quote: string | null }
interface InputDocument {
  ref: Ref; relation: string; type: string | null; title: string | null; date: string | null; provider: string | null;
  references: Array<{ kind: string; value: string }>; excerpts: string[];
  facts: Array<{ key: string; label: string | null; value: string | null; quote: string | null }>;
  periods: Array<{ kind: string; start: string | null; end: string | null }>;
  userCorrectedFields: string[]; sharedByAssets: boolean;
  economicLines: Array<{ nature: string | null; amount: string; currency: string; status: string; reason: string | null }>;
}
interface InputFact { ref: Ref; source: string; label: string; nature: string | null; amount: string; currency: string; date: string | null; document: Ref | null }

export interface QualificationInput {
  contractVersion: typeof ECONOMIC_QUALIFICATION_CONTRACT_VERSION;
  task: typeof ECONOMIC_QUALIFICATION_TASK;
  today: string;
  asset: { category: string | null };
  amounts: InputAmount[];
  documents: InputDocument[];
  countedFacts: InputFact[];
  operations: Array<{ label: string; type: string | null; documents: Ref[] }>;
  priorReviews: Array<{ at: string; status: string; summary: string }>;
  bounds: { complete: boolean; dropped: number };
}

/** Correspondance des références opaques (jamais transmise au modèle). */
export interface QualificationScope {
  targetFileId: number;
  assetId: number;
  amounts: Record<Ref, RawQualificationAmount>;
  facts: Record<Ref, RawCountedFact & { document: Ref | null }>;
  documents: Record<Ref, number>;
  /** Textes fournis par document (contrôle des extraits cités). */
  texts: Record<Ref, string[]>;
  /** Le document cible est commun à plusieurs biens (ventilation à prouver). */
  sharedTarget: boolean;
}

const borne = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
/** Montant lisible transmis au modèle (jamais recalculé par lui). */
export const amountText = (minor: number): string => (minor / 100).toFixed(2);

/** Contexte borné et références opaques (pur, ordre stable). */
export function buildQualificationInput(raw: RawQualificationContext): { input: QualificationInput; scope: QualificationScope } {
  const B = QUALIFICATION_CONTEXT_BOUNDS;
  let dropped = 0;
  const cible = raw.documents.find((d) => d.id === raw.targetFileId);
  if (!cible) throw new Error('[economic-qualification] document cible absent du contexte');
  const autres = raw.documents.filter((d) => d.id !== raw.targetFileId);
  dropped += Math.max(0, autres.length - B.maxDocuments);
  const docs = [cible, ...autres.slice(0, B.maxDocuments)];
  const docRef = new Map<number, Ref>(docs.map((d, i) => [d.id, `D${i}`]));
  const texts: Record<Ref, string[]> = {};
  const documents: InputDocument[] = docs.map((d, i) => {
    const ref = `D${i}`;
    const max = i === 0 ? B.maxExcerptsTarget : B.maxExcerptsRelated;
    const extraits = (d.excerpts ?? []).filter((e) => typeof e === 'string' && e.trim()).map((e) => borne(e.replace(/\s+/g, ' ').trim(), B.maxExcerptLength));
    dropped += Math.max(0, extraits.length - max);
    const facts = (d.facts ?? []).slice(0, i === 0 ? B.maxFacts : 6).map((f) => ({
      key: f.key, label: f.label, value: f.value ? borne(f.value, 200) : null, quote: f.quote ? borne(f.quote.replace(/\s+/g, ' ').trim(), B.maxExcerptLength) : null,
    }));
    const kept = extraits.slice(0, max);
    texts[ref] = [...(d.title ? [d.title] : []), ...kept, ...facts.flatMap((f) => [f.quote, f.value, f.label].filter((x): x is string => !!x))];
    return {
      ref, relation: i === 0 ? 'TARGET' : (d.relation ?? 'SAME_ASSET'), type: d.type, title: d.title, date: d.date, provider: d.provider,
      references: (d.references ?? []).slice(0, B.maxReferences), excerpts: kept, facts,
      periods: (d.periods ?? []).slice(0, B.maxPeriods), userCorrectedFields: [...new Set(d.userCorrectedFields ?? [])].sort(),
      sharedByAssets: d.multiAsset === true || (d.linkedAssetCount ?? 0) > 1,
      economicLines: (d.lines ?? []).slice(0, B.maxLinesPerDocument).map((l) => ({ nature: l.kind, amount: amountText(l.amountMinor), currency: l.currency, status: l.status, reason: l.reason })),
    };
  });
  const montants = raw.amounts.filter((a) => a.fileId === raw.targetFileId && Number.isSafeInteger(a.amountMinor) && a.amountMinor > 0);
  dropped += Math.max(0, montants.length - B.maxAmounts);
  const amounts: Record<Ref, RawQualificationAmount> = {};
  const inputAmounts: InputAmount[] = montants.slice(0, B.maxAmounts).map((a, i) => {
    const ref = `M${i + 1}`;
    amounts[ref] = a;
    if (a.quote) texts.D0 = [...texts.D0, borne(a.quote.replace(/\s+/g, ' ').trim(), B.maxExcerptLength)];
    return { ref, document: 'D0', amount: amountText(a.amountMinor), currency: String(a.currency || 'EUR').toUpperCase(), origin: a.origin, quote: a.quote ? borne(a.quote.replace(/\s+/g, ' ').trim(), B.maxExcerptLength) : null };
  });
  dropped += Math.max(0, raw.countedFacts.length - B.maxCountedFacts);
  const facts: QualificationScope['facts'] = {};
  const countedFacts: InputFact[] = raw.countedFacts.slice(0, B.maxCountedFacts).map((f, i) => {
    const ref = `F${i + 1}`;
    const document = f.fileId != null ? docRef.get(f.fileId) ?? null : null;
    facts[ref] = { ...f, document };
    return { ref, source: f.source, label: borne(f.label, 160), nature: f.kind, amount: amountText(f.amountMinor), currency: String(f.currency || 'EUR').toUpperCase(), date: f.date, document };
  });
  const operations = (raw.operations ?? []).slice(0, B.maxOperations).map((o) => ({
    label: borne(o.label, 160), type: o.typeCode, documents: o.fileIds.map((x) => docRef.get(x)).filter((x): x is Ref => !!x),
  }));
  return {
    input: {
      contractVersion: ECONOMIC_QUALIFICATION_CONTRACT_VERSION, task: ECONOMIC_QUALIFICATION_TASK, today: raw.today,
      asset: { category: raw.asset.category }, amounts: inputAmounts, documents, countedFacts, operations,
      priorReviews: (raw.priorReviews ?? []).slice(0, B.maxPrior).map((p) => ({ at: p.at, status: p.status, summary: borne(p.summary, 200) })),
      bounds: { complete: dropped === 0, dropped },
    },
    scope: {
      targetFileId: raw.targetFileId, assetId: raw.asset.id, amounts, facts,
      documents: Object.fromEntries(docs.map((d, i) => [`D${i}`, d.id])), texts,
      sharedTarget: documents[0].sharedByAssets,
    },
  };
}

/**
 * Variables RÉELLES du master T3 (les six emplacements, aucun nouveau) :
 * FIELD = contrat, bien, rôles et portées admis ; CURRENT_STATE = montants à
 * arbitrer et faits déjà comptés ; EVIDENCES = documents, extraits, faits T1,
 * périodes, lignes actuelles ; SUBJECT_CONTEXT = date, monde fermé, bornes,
 * Opérations, examens antérieurs ; CANDIDATES = issues, attributions et
 * motifs admis ; RELATION_TYPE.
 */
export function qualificationVariables(input: QualificationInput): Record<string, unknown> {
  return {
    FIELD: { contractVersion: input.contractVersion, task: input.task, asset: input.asset, roles: [...T1_FINANCIAL_ROLES], scopes: [...T1_AMOUNT_SCOPES] },
    CURRENT_STATE: { amounts: input.amounts, countedFacts: input.countedFacts },
    EVIDENCES: { documents: input.documents },
    SUBJECT_CONTEXT: { today: input.today, closedWorld: true, target: 'D0', bounds: input.bounds, operations: input.operations, priorReviews: input.priorReviews },
    CANDIDATES: { outcomes: [...QUALIFICATION_OUTCOMES], allocations: [...QUALIFICATION_ALLOCATIONS], exclusions: [...QUALIFICATION_EXCLUSIONS] },
    RELATION_TYPE: ECONOMIC_QUALIFICATION_TASK,
  };
}

/** Le texte d'un prompt porte-t-il la branche ET le marqueur ? (pure) */
export function promptCarriesEconomicQualification(text: string | null | undefined, branches: readonly string[]): boolean {
  return typeof text === 'string' && text.includes(ECONOMIC_QUALIFICATION_CONTRACT_VERSION) && branches.includes(ECONOMIC_QUALIFICATION_TASK);
}

// ── Sortie (schéma validé par la passerelle, puis `validateQualification`) ──

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const T3EconomicDecision = z.object({
  amount: z.string().regex(/^M\d{1,2}$/),
  outcome: z.enum(QUALIFICATION_OUTCOMES),
  role: z.enum(T1_FINANCIAL_ROLES).nullable().default(null),
  scope: z.enum(T1_AMOUNT_SCOPES).nullable().default(null),
  economicDate: isoDate.nullable().default(null),
  periodStart: isoDate.nullable().default(null),
  periodEnd: isoDate.nullable().default(null),
  allocation: z.enum(QUALIFICATION_ALLOCATIONS).nullable().default(null),
  representedBy: z.string().regex(/^F\d{1,2}$/).nullable().default(null),
  exclusion: z.enum(QUALIFICATION_EXCLUSIONS).nullable().default(null),
  confidence: z.enum(['certain', 'probable', 'ambiguous']),
  evidence: z.array(z.object({ document: z.string().regex(/^D\d{1,2}$/), excerpt: z.string().min(1).max(300) })).max(4).default([]),
  reason: z.string().min(1).max(300),
}).superRefine((v, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (v.outcome === 'INCLUDE') {
    if (!v.role) issue('role', 'role est obligatoire pour INCLUDE');
    if (!v.allocation) issue('allocation', 'allocation est obligatoire pour INCLUDE');
    if (v.representedBy) issue('representedBy', 'representedBy est réservé à REPRESENTED');
    if (v.exclusion) issue('exclusion', 'exclusion est réservé à EXCLUDE');
  } else if (v.outcome === 'REPRESENTED') {
    if (!v.representedBy) issue('representedBy', 'representedBy est obligatoire pour REPRESENTED');
    if (!v.role) issue('role', 'role est obligatoire pour REPRESENTED');
    if (v.exclusion) issue('exclusion', 'exclusion est réservé à EXCLUDE');
  } else if (v.outcome === 'EXCLUDE') {
    if (!v.exclusion) issue('exclusion', 'exclusion est obligatoire pour EXCLUDE');
    if (v.representedBy) issue('representedBy', 'representedBy est réservé à REPRESENTED');
  } else if (v.representedBy || v.exclusion) issue('outcome', 'ABSTAIN ne porte ni representedBy ni exclusion');
  // Une abstention peut ne rien citer ; toute autre issue cite au moins une preuve.
  if (v.outcome !== 'ABSTAIN' && !v.evidence.length) issue('evidence', 'une preuve citée est exigée (document + extrait)');
});

export const T3EconomicQualificationOutput = z.object({
  task: z.literal(ECONOMIC_QUALIFICATION_TASK),
  decisions: z.array(T3EconomicDecision).min(1).max(QUALIFICATION_CONTEXT_BOUNDS.maxAmounts),
});
export type T3EconomicQualificationOutput = z.infer<typeof T3EconomicQualificationOutput>;
type Decision = T3EconomicQualificationOutput['decisions'][number];

/** Motifs de refus (validation) — stables, journalisés. */
export const QUALIFICATION_ISSUES = [
  'SCHEMA', 'UNKNOWN_AMOUNT', 'DUPLICATE_AMOUNT', 'UNKNOWN_DOCUMENT', 'UNKNOWN_FACT', 'EXCERPT_NOT_FOUND', 'TARGET_EVIDENCE_MISSING',
  'ROLE_INCOMPATIBLE', 'AMOUNT_INCOMPATIBLE', 'CURRENCY_INCOMPATIBLE', 'SAME_AMOUNT_ONLY', 'PERIOD_INVALID',
] as const;
export type QualificationIssue = (typeof QUALIFICATION_ISSUES)[number];
interface QualificationProblem { issue: QualificationIssue; amount: string | null; detail: string }

/** Normalisation pour comparer un extrait cité au texte fourni (espaces, casse, apostrophes et guillemets). */
const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[’‘`]/g, '\'').replace(/[«»“”]/g, '"').replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Effet VALIDÉ d'un montant (persisté, relu par le moteur à chaque calcul).
 * `applied` : décision CERTAINE et non abstention — seules celles-ci changent le calcul.
 */
export interface QualificationEffect {
  amountRef: string;
  fileId: number;
  lineId: string | null;
  amountMinor: number;
  currency: string;
  origin: 'LINE' | 'EXTRACT';
  outcome: QualificationOutcome;
  applied: boolean;
  role: string | null;
  scope: string | null;
  economicDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  /** THIS_ASSET / NOT_ALLOCATED (commun sans ventilation prouvée, ou document de plusieurs biens). */
  allocation: 'THIS_ASSET' | 'NOT_ALLOCATED' | null;
  representedBy: { key: string; lineId: string; label: string; source: string; fileId: number | null } | null;
  exclusion: QualificationExclusion | null;
  confidence: 'certain' | 'probable' | 'ambiguous';
  reason: string;
  evidence: Array<{ fileId: number; excerpt: string }>;
  /** Note serveur (ex. « ventilation entre biens non prouvée »). */
  serverNote?: string | null;
}

export type QualificationValidation =
  | { ok: true; output: T3EconomicQualificationOutput; effects: QualificationEffect[] }
  | { ok: false; problems: QualificationProblem[] };

/**
 * Validation STRICTE (pure) : une sortie invalide est refusée EN BLOC (vaut
 * abstention de tous ses montants, jamais remplacée par une heuristique) ;
 * seules les décisions CERTAINES qui ne sont pas des abstentions ont un effet.
 * Un montant sans décision reste en abstention (rien n'est inventé).
 */
export function validateQualification(output: unknown, scope: QualificationScope): QualificationValidation {
  const parsed = T3EconomicQualificationOutput.safeParse(output);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 10).map((i) => ({ issue: 'SCHEMA' as const, amount: null, detail: `${i.path.join('.') || '(racine)'} : ${i.message}`.slice(0, 200) })) };
  }
  const v = parsed.data;
  const problems: QualificationProblem[] = [];
  const add = (issue: QualificationIssue, amount: string | null, detail: string) => problems.push({ issue, amount, detail: detail.slice(0, 200) });
  const vus = new Set<string>();
  for (const d of v.decisions) {
    const a = scope.amounts[d.amount];
    if (!a) { add('UNKNOWN_AMOUNT', d.amount, 'montant absent du contexte'); continue; }
    if (vus.has(d.amount)) add('DUPLICATE_AMOUNT', d.amount, 'deux décisions pour le même montant');
    vus.add(d.amount);
    for (const e of d.evidence) {
      const textes = scope.texts[e.document];
      if (!textes) { add('UNKNOWN_DOCUMENT', d.amount, `${e.document} absent du contexte`); continue; }
      const cite = norm(e.excerpt);
      if (!cite || !textes.some((t) => norm(t).includes(cite))) add('EXCERPT_NOT_FOUND', d.amount, `${e.document} : extrait absent des textes fournis`);
    }
    if (d.periodStart && d.periodEnd && d.periodStart > d.periodEnd) add('PERIOD_INVALID', d.amount, 'début de période après la fin');
    if (d.outcome === 'ABSTAIN') continue;
    // Toute décision porte sur le document D0 : au moins une preuve de D0.
    if (!d.evidence.some((e) => e.document === 'D0')) add('TARGET_EVIDENCE_MISSING', d.amount, 'aucune preuve citée dans D0');
    if (d.outcome === 'REPRESENTED') checkRepresentation(d, a, scope, add);
  }
  if (problems.length) return { ok: false, problems };
  const parRef = new Map(v.decisions.map((d) => [d.amount, d]));
  const effects = Object.entries(scope.amounts).map(([ref, a]) => effectOf(ref, a, parRef.get(ref) ?? null, scope));
  return { ok: true, output: v, effects };
}

/** Compatibilité financière d'une représentation (rôle, devise, montant, preuve au-delà de l'égalité de montant). */
function checkRepresentation(d: Decision, a: RawQualificationAmount, scope: QualificationScope, add: (i: QualificationIssue, a: string | null, s: string) => void): void {
  const f = d.representedBy ? scope.facts[d.representedBy] : undefined;
  if (!f) { add('UNKNOWN_FACT', d.amount, `${d.representedBy ?? '(aucun)'} absent des faits comptés`); return; }
  const role = String(d.role);
  if (!(REPRESENTABLE_ROLES as readonly string[]).includes(role)) { add('ROLE_INCOMPATIBLE', d.amount, `${role} ne peut pas être représenté par un fait compté`); return; }
  if (String(a.currency || 'EUR').toUpperCase() !== String(f.currency || 'EUR').toUpperCase()) { add('CURRENCY_INCOMPATIBLE', d.amount, 'devise différente du fait représentant'); return; }
  // Nature du fait : un règlement ou une part d'un coût se rattache à un coût ; un avoir / remboursement à la même nature.
  const coutFait = f.kind === 'REALIZED_COST' || f.kind === 'FORECAST_COST';
  if ((role === 'PAYMENT' || role === 'REALIZED_COST' || role === 'FORECAST_COST') && !coutFait) { add('ROLE_INCOMPATIBLE', d.amount, `fait de nature ${f.kind ?? 'inconnue'}`); return; }
  if ((role === 'REDUCTION' || role === 'REFUND') && f.kind !== role) { add('ROLE_INCOMPATIBLE', d.amount, `fait de nature ${f.kind ?? 'inconnue'}`); return; }
  const partie = d.scope != null && PART_SCOPES.has(d.scope);
  if (a.amountMinor > f.amountMinor) { add('AMOUNT_INCOMPATIBLE', d.amount, 'montant supérieur au fait représentant'); return; }
  if (a.amountMinor < f.amountMinor && role !== 'PAYMENT' && !partie) { add('AMOUNT_INCOMPATIBLE', d.amount, 'montant inférieur sans portée de part (acompte, solde, échéance)'); return; }
  // L'égalité de montant ne suffit JAMAIS : une preuve du lien dépasse le seul montant.
  const preuvesD0 = new Set(d.evidence.filter((e) => e.document === 'D0').map((e) => norm(e.excerpt)));
  const preuveFait = f.document ? d.evidence.some((e) => e.document === f.document && f.document !== 'D0') : false;
  if (!preuveFait && preuvesD0.size < 2) add('SAME_AMOUNT_ONLY', d.amount, 'lien au fait compté sans preuve distincte du montant (citer le document du fait ou deux passages de D0)');
}

function effectOf(ref: string, a: RawQualificationAmount, d: Decision | null, scope: QualificationScope): QualificationEffect {
  const base: QualificationEffect = {
    amountRef: ref, fileId: a.fileId, lineId: a.lineId, amountMinor: a.amountMinor, currency: String(a.currency || 'EUR').toUpperCase(), origin: a.origin,
    outcome: 'ABSTAIN', applied: false, role: null, scope: null, economicDate: null, periodStart: null, periodEnd: null, allocation: null,
    representedBy: null, exclusion: null, confidence: 'ambiguous', reason: 'Aucune décision rendue pour ce montant.', evidence: [], serverNote: null,
  };
  if (!d) return base;
  const evidence = d.evidence.map((e) => ({ fileId: scope.documents[e.document], excerpt: e.excerpt }));
  const f = d.representedBy ? scope.facts[d.representedBy] : undefined;
  // Document commun à plusieurs biens : une inclusion « ce bien » n'est jamais une ventilation prouvée (aucune allocation arbitraire).
  const partage = d.outcome === 'INCLUDE' && (d.allocation === 'SHARED_NOT_ALLOCATED' || scope.sharedTarget);
  return {
    ...base, outcome: d.outcome, applied: d.outcome !== 'ABSTAIN' && d.confidence === 'certain',
    role: d.role, scope: d.scope, economicDate: d.economicDate, periodStart: d.periodStart, periodEnd: d.periodEnd,
    allocation: d.outcome === 'INCLUDE' ? (partage ? 'NOT_ALLOCATED' : 'THIS_ASSET') : null,
    representedBy: f ? { key: f.key, lineId: f.lineId, label: f.label, source: f.source, fileId: f.fileId } : null,
    exclusion: d.exclusion, confidence: d.confidence, reason: d.reason, evidence,
    serverNote: partage && d.allocation !== 'SHARED_NOT_ALLOCATED' ? 'Document commun à plusieurs biens : ventilation non prouvée.' : null,
  };
}
