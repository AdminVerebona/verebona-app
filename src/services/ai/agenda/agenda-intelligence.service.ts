/**
 * Intelligence de l'agenda — USAGE IA n°4.
 *
 * Implémente la chaîne de décision du CDC §4.4.3, dans l'ordre imposé :
 *   1. règles déterministes
 *   2. interprétation des dates extraites
 *   3. comparaison aux événements existants
 *   4. règles métier
 *   5. appel IA uniquement sur cas ambigu
 *   6. création, mise à jour ou conflit
 *
 * Critère d'acceptation n°17. Le compteur `deterministic` de chaque décision
 * permet de vérifier en production qu'aucun appel n'est émis sur un cas tranché.
 *
 * LOT 54 — T4 DÉCISIONNAIRE (flux documentaire automatique). Ordre :
 *   validation technique de la date → préparation du candidat de récurrence
 *   → décision T4 (CLASSIFY_EVENT : existence, catégorie, récurrence) →
 *   déduplication → autorisation technique de la source → persistance.
 * La classification déterministe n'est plus une décision finale : elle est
 * transmise à T4 comme indice. Le code ne décide pas qu'un événement est ou
 * non une échéance : il respecte strictement `agendaDecision` et
 * `recurrenceDecision`. Le parcours manuel (`classifyAgendaEvent`) est
 * inchangé.
 */
import { classifyByRulesDetailed } from './rules/deterministic-classification';
import { prudentCategory } from './rules/prudent-category';
import {
  classifyEventMaster, decideAgendaEvent, recurrenceCandidateOf,
  type ClassifyEventContext, type T4EventDecision,
} from './master/classify-event';
import { DOCUMENT_CATALOG, EVENT_CATALOG, documentMayCreateEvent, resolveDocumentType } from '@/services/canonical/registry';
import { resolveEventSemantics } from '@/services/agenda/agenda-functional-key';
import { interpretDate, detectTemporalAmbiguity } from './rules/date-interpreter';
import { findDuplicate, titleSimilarity, containmentSimilarity } from './dedupe.service';
import {
  computeOccurrences, describeRecurrence, inferHistoricalRecurrence, type RecurrenceSpec,
} from './rules/recurrence';
import { createHash } from 'crypto';
import type {
  AgendaDecision, ExistingAgendaItem, HomeCategory, AgendaClassificationInput, AgendaClassification, T4DecisionTrace,
} from './types';
import type { AgendaCandidate } from '../source-analysis/types';
import { isExecutionCancelled } from '../queue/execution-control';

export interface AgendaIntelligenceInput {
  accountId: number;
  userId?: number;
  assetId: number | null;
  candidates: AgendaCandidate[];
  existing: ExistingAgendaItem[];
  sourceFileId?: number;
  /** Date du jour (AAAA-MM-JJ, Europe/Paris) — injectable pour les tests. */
  today?: string;
  /**
   * Révision de la preuve du champ d'origine quand T4 tranche une date
   * (décision PO D-M, lot 20) — injectable pour les tests ; défaut :
   * `reviseDateEvidenceFromT4` (toujours depuis le lot 16b-3, jamais bloquant).
   */
  reviseDate?: (p: import('../evidence/revised-date-evidence').ReviseDateInput) => Promise<unknown>;
  /**
   * Lot 54 — décision T4 CLASSIFY_EVENT d'un candidat (injectable pour les
   * tests) ; défaut : `decideAgendaEvent` (passerelle IA).
   */
  decide?: (input: AgendaClassificationInput, ctx: ClassifyEventContext) => Promise<T4EventDecision>;
  /**
   * Lot 71E (§E) — décisions T4 déjà APPLIQUÉES par un passage précédent du
   * même travail (reprise par la file), indexées par empreinte du contexte
   * soumis à T4 : réutilisées telles quelles, sans nouvel appel modèle. Un
   * contexte qui a changé (nouvelle analyse, historique différent) n'a pas la
   * même empreinte : il est redemandé.
   */
  resolvedDecisions?: Record<string, StoredT4Decision>;
}

/** Lot 71E (§E) — décision T4 conservée pour une reprise (aucun contenu documentaire, motifs tronqués). */
export type StoredT4Decision = Pick<T4EventDecision,
  'agendaDecision' | 'recurrenceDecision' | 'classification' | 'reason' | 'recurrenceReason' | 'outcome' | 'warnings' | 'contractVersion' | 'traceId'>;

/** Décision T4 à conserver pour une reprise ; jamais un échec technique (il doit être redemandé). */
export function storableT4Decision(d: T4EventDecision): StoredT4Decision | null {
  if (d.outcome === 'technical_failure') return null;
  return {
    agendaDecision: d.agendaDecision, recurrenceDecision: d.recurrenceDecision,
    classification: { ...d.classification, reason: d.classification.reason?.slice(0, 300) },
    reason: d.reason.slice(0, 300), recurrenceReason: d.recurrenceReason ? d.recurrenceReason.slice(0, 300) : null,
    outcome: d.outcome, warnings: [...d.warnings], ...(d.contractVersion ? { contractVersion: d.contractVersion } : {}),
    ...(d.traceId ? { traceId: d.traceId } : {}),
  };
}

const EVENT_TYPES: ReadonlySet<string> = new Set(EVENT_CATALOG.map((e) => e.businessType as string));

/**
 * Lot 71E (§B) — type métier APPLIQUÉ d'un candidat accepté.
 *
 *   · T4 a désigné un type du catalogue fermé (`closedWorldBusinessTypeV2`
 *     l'a déjà vérifié) : c'est la référence (persistance, occurrences, clé
 *     fonctionnelle, trace) ;
 *   · T4 n'en désigne aucun (null explicite, ou valeur hors catalogue
 *     ramenée à null) : AUCUNE valeur n'est inventée — le type du candidat
 *     (T1, registre) est conservé tel quel, et l'écart est SIGNALÉ
 *     (`T4_BUSINESS_TYPE_NULL`, provenance CANDIDATE), jamais en silence ;
 *   · type du candidat hors catalogue : ignoré (`CANDIDATE_BUSINESS_TYPE_OUT_OF_CATALOG`).
 * Pure.
 */
export function appliedBusinessType(
  candidate: { businessType?: string | null; originFieldKey?: string | null; nature?: 'HISTORICAL' | 'DEADLINE' | null },
  t4: Pick<T4EventDecision, 'agendaDecision' | 'classification' | 'outcome'>,
): {
  /** Valeur portée par la décision (`AgendaDecision.businessType`). */
  value: string | null;
  /** Valeur effectivement écrite (registre du champ d'origine à défaut de `value`). */
  applied: string | null;
  source: 'T4' | 'CANDIDATE' | 'NONE'; t4Designated: string | null; warnings: string[];
} {
  const warnings: string[] = [];
  const decided = t4.agendaDecision === 'accept' && t4.classification.businessType && EVENT_TYPES.has(t4.classification.businessType)
    ? t4.classification.businessType : null;
  if (decided) return { value: decided, applied: decided, source: 'T4', t4Designated: decided, warnings };
  let candidat = candidate.businessType ?? null;
  if (candidat && !EVENT_TYPES.has(candidat)) {
    warnings.push(`CANDIDATE_BUSINESS_TYPE_OUT_OF_CATALOG:${candidat}`);
    candidat = null;
  }
  if (t4.agendaDecision === 'accept') warnings.push('T4_BUSINESS_TYPE_NULL');
  // Valeur réellement écrite : celle du candidat, sinon le registre (champ d'origine).
  const ecrit = resolveEventSemantics({ originFieldKey: candidate.originFieldKey ?? null, businessType: candidat, nature: candidate.nature ?? null }).businessType;
  return { value: candidat, applied: ecrit, source: ecrit ? 'CANDIDATE' : 'NONE', t4Designated: null, warnings };
}

/**
 * Candidat enrichi par T1 (C, lot 14) : type documentaire de la source et
 * son autorité (DOCUMENT_CATALOG), nature et type métier de l'événement.
 * Champs lus défensivement : absents, le candidat est traité comme avant.
 */
export type T4AgendaCandidate = AgendaCandidate & {
  documentType?: string | null;
  authority?: string | null;
  mayCreateAgenda?: boolean | null;
  nature?: 'HISTORICAL' | 'DEADLINE' | null;
  businessType?: string | null;
};

/**
 * Types documentaires autorisant une création automatique d'échéance
 * (§4.4.4, CDC 15 T4-04) — DÉRIVÉ du DOCUMENT_CATALOG (`mayCreateAgenda`),
 * source unique. Contient les types du lot 10 et ceux des décisions PO D-A
 * (acte authentique, PV de contrôle technique) et D-B (constat de sinistre,
 * limité au sinistre HISTORIQUE par sa `creationScope` : voir
 * `creationAuthorization`).
 */
const AUTHORIZED_CREATION_TYPES: ReadonlySet<string> = new Set(
  DOCUMENT_CATALOG.filter((d) => d.mayCreateAgenda).flatMap((d) => [d.code, ...(d.aliases ?? [])]),
);

/**
 * Sémantique T4 d'un candidat enrichi, recopiée dans ses décisions. Champs
 * absents du candidat : non recopiés.
 */
export function t4Semantics(c: T4AgendaCandidate, fallbackSourceFileId?: number): Partial<AgendaDecision> {
  const x = c as T4AgendaCandidate & {
    target?: AgendaDecision['target']; occurrence?: string; dateSource?: AgendaDecision['dateSource'];
    sourceFileId?: number; sources?: AgendaDecision['sources'];
  };
  const out: Partial<AgendaDecision> = {};
  if (x.nature) out.nature = x.nature;
  if (x.businessType) out.businessType = x.businessType;
  if (x.target) out.target = x.target;
  if (x.occurrence) out.occurrenceIndex = x.occurrence;
  if (x.dateSource) out.dateSource = x.dateSource;
  if (x.sources?.length) out.sources = x.sources;
  if (x.documentType !== undefined) out.documentType = x.documentType;
  if (x.authority !== undefined) out.authority = x.authority as AgendaDecision['authority'];
  if (x.mayCreateAgenda !== undefined) out.mayCreateAgenda = x.mayCreateAgenda;
  if (x.recurrence) out.recurrence = x.recurrence;
  if (x.originFieldKey) out.originFieldKey = x.originFieldKey;
  const sourceFileId = x.sourceFileId ?? fallbackSourceFileId;
  if (sourceFileId !== undefined) out.sourceFileId = sourceFileId;
  return out;
}

/**
 * CDC 15 T4-04 — la source autorise-t-elle une CRÉATION automatique ?
 * `mayCreateAgenda` porté par le candidat, sinon lu au catalogue par type ;
 * type absent ou inconnu : jamais autoritaire (proposition). La portée de
 * création du type (`creationScope`, D-B : constat de sinistre → sinistre
 * HISTORIQUE seulement) s'applique dans tous les cas : toute autre échéance
 * portée par ce document est proposée.
 */
export function creationAuthorization(c: T4AgendaCandidate): {
  allowed: boolean; reasonCode: 'SOURCE_AUTHORIZED' | 'SOURCE_TYPE_NOT_AUTHORIZED' | 'SOURCE_TYPE_UNKNOWN'; documentType: string | null;
} {
  const documentType = c.documentType ?? null;
  const entry = resolveDocumentType(documentType);
  let allowed = typeof c.mayCreateAgenda === 'boolean' ? c.mayCreateAgenda : entry?.mayCreateAgenda ?? false;
  if (allowed && entry?.creationScope) allowed = documentMayCreateEvent(entry, c);
  if (allowed) return { allowed, reasonCode: 'SOURCE_AUTHORIZED', documentType };
  return {
    allowed,
    reasonCode: entry || typeof c.mayCreateAgenda === 'boolean' ? 'SOURCE_TYPE_NOT_AUTHORIZED' : 'SOURCE_TYPE_UNKNOWN',
    documentType,
  };
}

export async function processAgendaCandidates(
  input: AgendaIntelligenceInput,
): Promise<AgendaDecision[]> {
  const decisions: AgendaDecision[] = [];
  // Événements connus + ceux que ce passage va créer : chaque occurrence
  // générée est rapprochée de TOUT ce qui existera, sans doublon en masse.
  const planned: ExistingAgendaItem[] = [...input.existing];
  const today = input.today ?? todayParis();

  for (const brut of input.candidates) {
    // R5 (CDC 15 §26) : date incertaine → branche TEMPORAL_AMBIGUITY du
    // master ; sinon inchangé.
    const temporel = await resoudreAmbiguiteTemporelle(brut, input);
    if (temporel.kind === 'propose') {
      const d = temporel.decision;
      Object.assign(d, t4Semantics(brut as T4AgendaCandidate, input.sourceFileId));
      decisions.push(d);
      planned.push(asPlanned(d, planned.length));
      continue;
    }
    const candidate = temporel.candidate;
    // D-M (lot 20) : la date TRANCHÉE par T4 (branche TEMPORAL_AMBIGUITY)
    // corrige aussi la fiche — preuve révisée
    // du champ d'origine, puis T3 par les primitives canoniques (jamais
    // au-dessus d'une valeur USER/ADMIN) — toujours depuis le lot 16b-3.
    if (candidate.date !== brut.date) await reviserPreuveDate(brut, candidate.date, input);

    // ── Lot 54 : validation technique de la date — sans appel modèle ──────
    const dateTechnique = interpretDate(candidate.date);
    if (dateTechnique.qualification !== 'explicit') {
      const d = await processOne(candidate, { ...input, existing: planned, today }, null);
      Object.assign(d, t4Semantics(candidate as T4AgendaCandidate, input.sourceFileId));
      decisions.push(d);
      planned.push(asPlanned(d, planned.length));
      continue;
    }
    // ── Préparation du candidat de récurrence (le code ne décide pas) ─────
    const recurrence = prepareRecurrenceCandidate(candidate, input.assetId, planned);
    // ── Décision T4 : existence, catégorie, récurrence ─────────────────────
    const { decision: t4, fingerprint, reused } = await decideCandidate(candidate, recurrence, input);
    // Lot 71E (§B) : type métier décidé par T4 = référence de la décision finale.
    const bt = appliedBusinessType(candidate as T4AgendaCandidate, t4);
    const trace = t4Trace(t4, recurrence, { businessType: bt, fingerprint, reused });
    if (t4.agendaDecision !== 'accept') {
      // reject / abstain / échec technique : aucun Agenda, aucune proposition.
      // Lot 71E (§A) : les trois issues restent DISTINCTES jusqu'à la
      // persistance (motif) — seul un rejet explicite autorise un retrait.
      decisions.push({
        ...t4Semantics(candidate as T4AgendaCandidate, input.sourceFileId),
        action: 'ignore', title: candidate.title, date: candidate.date, category: 'information',
        confidence: candidate.confidence, deterministic: false, t4: trace,
        reasonCode: t4.outcome === 'technical_failure' ? 'T4_TECHNICAL_FAILURE'
          : t4.agendaDecision === 'reject' ? 'MODEL_REJECTED_NOT_AGENDA' : 'MODEL_ABSTAINED',
      });
      await logT4Decision(input, candidate, trace);
      continue;
    }
    await logT4Decision(input, candidate, trace);
    const base = await processOne(candidate, { ...input, existing: planned, today }, t4.classification, bt.t4Designated);
    base.t4 = trace;
    decisions.push(base);
    // Récurrence : seule une acceptation EXPLICITE de T4 produit une série
    // (reject, abstain, not_applicable → aucune occurrence prévisionnelle).
    let recurrent = recurrence && t4.recurrenceDecision === 'accept'
      ? await forecastsFor(candidate, base, input, planned, today, recurrence)
      : [];
    // T4-04 : une source non autorisée ne crée pas non plus les occurrences
    // de sa récurrence — elles sont proposées, comme l'occurrence de base.
    if (base.reasonCode === 'SOURCE_TYPE_NOT_AUTHORIZED' || base.reasonCode === 'SOURCE_TYPE_UNKNOWN') {
      recurrent = recurrent.map((d) => (d.action === 'create' ? { ...d, action: 'propose', reasonCode: base.reasonCode } : d));
    }
    if (base.action === 'create' || base.action === 'propose') {
      planned.push(asPlanned(base, planned.length));
    }
    // CDC 15 T4-07/T4-08 (lot 14) : la sémantique du candidat accompagne
    // chaque décision jusqu'à la persistance (clé fonctionnelle, liens
    // source). L'occurrence d'une récurrence porte SA date.
    // Lot 71E (§B) : le type métier APPLIQUÉ (T4, sinon candidat) remplace
    // celui du candidat — occurrences de la récurrence comprises.
    const semantique: Partial<AgendaDecision> = { ...t4Semantics(candidate as T4AgendaCandidate, input.sourceFileId), businessType: bt.value };
    if (!bt.value) delete semantique.businessType;
    Object.assign(base, semantique);
    recurrent = recurrent.map((d) => ({ ...d, ...semantique, occurrenceIndex: d.date }));
    for (const d of recurrent) {
      decisions.push(d);
      if (d.action === 'create' || d.action === 'propose') planned.push(asPlanned(d, planned.length));
    }
  }

  return decisions;
}

/** Preuve révisée d'une date tranchée par T4 (D-M) — jamais bloquant. */
async function reviserPreuveDate(brut: AgendaCandidate, chosenDate: string, input: AgendaIntelligenceInput): Promise<void> {
  const sourceFileId = (brut as AgendaCandidate & { sourceFileId?: number }).sourceFileId ?? input.sourceFileId;
  if (!brut.originFieldKey || !sourceFileId) return;
  const evidenceId = (brut as AgendaCandidate & { sources?: Array<{ role?: string; evidenceId?: number | null }> })
    .sources?.find((s) => s.role === 'SOURCE' && s.evidenceId != null)?.evidenceId ?? null;
  try {
    const revise = input.reviseDate
      ?? (await import('../evidence/revised-date-evidence')).reviseDateEvidenceFromT4;
    await revise({
      accountId: input.accountId, userId: input.userId ?? null, sourceFileId,
      fieldKey: brut.originFieldKey, extractedDate: brut.date, chosenDate, evidenceId,
    });
  } catch (e) {
    if (isExecutionCancelled(e)) throw e;
    console.error('[t4] révision de la preuve de date (non bloquante) :', (e as Error).message);
  }
}

/** Candidat de récurrence préparé par le serveur (ticket §5) : spécification, historique, série. */
export interface RecurrencePlan {
  spec: RecurrenceSpec;
  history?: string[];
  seriesKey: string;
  serie: ExistingAgendaItem[];
}

/**
 * Récurrence ENVISAGÉE pour un candidat — jamais décidée ici :
 *   · mention explicite de la source (EXPLICIT_SOURCE, portée par T1) ;
 *   · sinon historique d'au moins trois occurrences régulières de la même
 *     série (HISTORICAL_PATTERN, `inferHistoricalRecurrence`) ;
 *   · sinon aucune.
 * T4 décide ensuite (`recurrenceDecision`).
 */
export function prepareRecurrenceCandidate(
  candidate: AgendaCandidate, assetId: number | null, planned: ExistingAgendaItem[],
): RecurrencePlan | null {
  const seriesKey = seriesKeyFor(assetId, candidate);
  const serie = sameSeries(candidate, planned, seriesKey);
  let spec: RecurrenceSpec | null = candidate.recurrence ?? null;
  let history: string[] | undefined;
  if (!spec) {
    // Historique : seules les occurrences CONFIRMÉES comptent — une prévision
    // ne prouve pas une récurrence.
    const dates = [...serie.filter((e) => e.nature !== 'FORECAST').map((e) => e.date), candidate.date];
    spec = inferHistoricalRecurrence(dates);
    if (spec) history = [...new Set(dates)].sort();
  }
  return spec ? { spec, history, seriesKey, serie } : null;
}

/**
 * Lot 71E (§E) — empreinte du contexte soumis à T4 (entrée + contexte, hors
 * compte et utilisateur) : deux passages d'un même travail avec le même
 * contexte reçoivent la même empreinte. Aucun contenu documentaire n'est
 * conservé (hachage).
 */
export function t4ContextFingerprint(ci: AgendaClassificationInput, ctx: ClassifyEventContext): string {
  const { accountId: _a, userId: _u, ...reste } = ctx;
  return createHash('sha256').update(JSON.stringify({ ci, ctx: reste })).digest('hex').slice(0, 32);
}

/** Décision T4 d'un candidat automatique (contexte : candidat, récurrence, indice déterministe). */
async function decideCandidate(
  candidate: AgendaCandidate, recurrence: RecurrencePlan | null, input: AgendaIntelligenceInput,
): Promise<{ decision: T4EventDecision; fingerprint: string; reused: boolean }> {
  const ci = toClassificationInput(candidate);
  // Indice seulement (ticket §4) : la classification déterministe existante
  // n'empêche plus l'appel et ne tranche pas l'existence de l'événement.
  const regle = classifyByRulesDetailed(ci);
  const ctx: ClassifyEventContext = {
    accountId: input.accountId, userId: input.userId, sourceFileId: input.sourceFileId,
    excerpt: candidate.excerpt, date: candidate.date,
    documentType: (candidate as T4AgendaCandidate).documentType ?? null,
    recurrenceCandidate: recurrence ? recurrenceCandidateOf(recurrence.spec, recurrence.history) : null,
    ruleHint: regle ? { category: regle.category, source: regle.source, ruleCode: regle.ruleCode } : null,
  };
  const fingerprint = t4ContextFingerprint(ci, ctx);
  // Reprise (§E) : décision déjà appliquée pour ce même contexte → aucun nouvel appel.
  const deja = input.resolvedDecisions?.[fingerprint];
  if (deja && deja.outcome !== 'technical_failure') return { decision: { ...deja, warnings: [...(deja.warnings ?? [])] }, fingerprint, reused: true };
  return { decision: await (input.decide ?? decideAgendaEvent)(ci, ctx), fingerprint, reused: false };
}

/** Trace BO de la décision T4 (ticket §12) — sans contenu documentaire brut. */
export function t4Trace(
  t4: T4EventDecision, recurrence: RecurrencePlan | null,
  extra: { businessType?: ReturnType<typeof appliedBusinessType>; fingerprint?: string; reused?: boolean } = {},
): T4DecisionTrace {
  const c = recurrence ? recurrenceCandidateOf(recurrence.spec, recurrence.history) : null;
  const verdict: T4DecisionTrace['verdict'] = t4.outcome === 'technical_failure' ? 'TECHNICAL_FAILURE'
    : t4.agendaDecision === 'reject' ? 'EVENT_REJECTED'
      : t4.agendaDecision === 'abstain' ? 'ABSTAINED'
        : recurrence && t4.recurrenceDecision !== 'accept' ? 'RECURRENCE_REJECTED' : 'ACCEPTED';
  return {
    agendaDecision: t4.agendaDecision, recurrenceDecision: t4.recurrenceDecision,
    recurrenceCandidate: c ? {
      mode: c.mode, frequency: c.frequency, interval: c.interval, startDate: c.startDate, endDate: c.endDate,
      occurrenceCount: c.occurrenceCount, history: c.history,
    } : null,
    homeCategory: t4.classification.category,
    // Lot 71E (§B) : type métier APPLIQUÉ (celui de l'Agenda) et sa provenance.
    businessType: extra.businessType ? (t4.agendaDecision === 'accept' ? extra.businessType.applied : null) : t4.classification.businessType ?? null,
    ...(extra.businessType && t4.agendaDecision === 'accept' ? { businessTypeSource: extra.businessType.source } : {}),
    confidence: t4.classification.confidence, reason: t4.reason, recurrenceReason: t4.recurrenceReason,
    outcome: t4.outcome, verdict,
    warnings: [...t4.warnings, ...(extra.businessType && t4.agendaDecision === 'accept' ? extra.businessType.warnings : [])],
    errorCode: t4.error?.code ?? null, traceId: t4.traceId ?? null,
    contractVersion: t4.contractVersion ?? null,
    ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
    ...(extra.reused ? { reused: true } : {}),
  };
}

/** Journal structuré + trace sur l'exécution IA (BO › Exécutions IA). Jamais bloquant. */
async function logT4Decision(input: AgendaIntelligenceInput, candidate: AgendaCandidate, trace: T4DecisionTrace): Promise<void> {
  console.info(JSON.stringify({
    event: 't4.event_decision', accountId: input.accountId, sourceFileId: input.sourceFileId ?? null,
    originFieldKey: candidate.originFieldKey ?? null, verdict: trace.verdict, agendaDecision: trace.agendaDecision,
    recurrenceDecision: trace.recurrenceDecision, outcome: trace.outcome, errorCode: trace.errorCode ?? null,
    businessType: trace.businessType, businessTypeSource: trace.businessTypeSource ?? null, reused: trace.reused ?? false,
  }));
  // Décision réutilisée (reprise) : déjà rattachée à son exécution au passage précédent.
  if (trace.traceId && !input.decide && !trace.reused) {
    try {
      await (await import('./master/t4-decision-trace')).attachT4DecisionToTrace(trace.traceId, trace);
    } catch (e) {
      console.error('[t4] trace de décision non écrite (non bloquant) :', (e as Error).message);
    }
  }
}

function todayParis(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function asPlanned(d: AgendaDecision, i: number): ExistingAgendaItem {
  return {
    id: -(i + 1), title: d.title, date: d.date, category: d.category, status: null, manual: false,
    originFieldKey: d.originFieldKey ?? null, nature: d.occurrence?.nature, seriesKey: d.occurrence?.seriesKey ?? null,
  };
}

const normTitle = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Série : même objet (bien) + même nature d'échéance (champ d'origine, sinon intitulé). */
export function seriesKeyFor(assetId: number | null, c: { title: string; originFieldKey?: string | null }): string {
  const nature = c.originFieldKey ? `field:${c.originFieldKey}` : `title:${normTitle(c.title)}`;
  return `s_${createHash('sha256').update(`${assetId ?? 'none'}|${nature}`).digest('hex').slice(0, 20)}`;
}

/** Occurrences comparables déjà connues (même série). */
function sameSeries(c: AgendaCandidate, existing: ExistingAgendaItem[], key: string): ExistingAgendaItem[] {
  return existing.filter((e) => {
    if (e.status === 'annule') return false;
    if (e.seriesKey && e.seriesKey === key) return true;
    if (c.originFieldKey && e.originFieldKey) return c.originFieldKey === e.originFieldKey;
    const a = normTitle(e.title);
    const b = normTitle(c.title);
    return Math.max(titleSimilarity(a, b), containmentSimilarity(a, b)) >= 0.82;
  });
}

/**
 * Occurrences prévisionnelles d'une récurrence ACCEPTÉE par T4 (lot 54).
 *
 *   · mention explicite de la source (EXPLICIT_SOURCE) ;
 *   · sinon historique d'au moins trois occurrences régulières de la même
 *     série (HISTORICAL_PATTERN) ;
 *   · sinon RIEN — une seule date ne fait pas une récurrence.
 * Les dates sont calculées par le code (rules/recurrence) ; chacune passe
 * par le rapprochement T4 (exact → ignorée, probable → arbitrage, aucun →
 * création), marquée PRÉVISIONNELLE avec sa provenance.
 */
async function forecastsFor(
  candidate: AgendaCandidate,
  base: AgendaDecision,
  input: AgendaIntelligenceInput,
  planned: ExistingAgendaItem[],
  today: string,
  plan: RecurrencePlan,
): Promise<AgendaDecision[]> {
  if (base.reasonCode === 'INVALID_DATE' || base.reasonCode === 'DATE_OUT_OF_RANGE') return [];
  // Lot 54 : récurrence préparée AVANT la décision T4, acceptée par T4.
  const { spec, history, seriesKey, serie } = plan;

  // L'occurrence de base appartient à la série ; sa date reste EXPLICITE.
  base.occurrence = { nature: 'CONFIRMED', dateSource: 'EXPLICIT_DATE', seriesKey };

  const reference = history ? history[history.length - 1] : candidate.date;
  const computedAt = new Date().toISOString();
  const rule = describeRecurrence(spec);
  const out: AgendaDecision[] = [];

  // Fin explicite : aucune nouvelle occurrence ; les prévisions automatiques
  // de la série au-delà de la borne deviennent sans objet.
  const borne = spec.ended ? candidate.date : spec.endDate ?? null;
  if (borne) {
    for (const e of serie) {
      if (e.id > 0 && e.nature === 'FORECAST' && !e.manual && e.date > borne) {
        out.push({
          action: 'retire_forecast', title: e.title, date: e.date, category: e.category ?? 'information',
          confidence: candidate.confidence, reasonCode: 'RECURRENCE_ENDED', existingItemId: e.id,
          deterministic: true, sourceFileId: input.sourceFileId, originFieldKey: candidate.originFieldKey,
        });
      }
    }
  }

  const listees = Boolean(spec.dates?.length);
  // Fenêtre d'une occurrence dans la série : une occurrence déjà présente
  // dans la même période (déplacée par l'utilisateur, prévision antérieure)
  // EST cette occurrence — on ne la double pas, on ne la déplace pas.
  const fenetre = spec.frequency === 'yearly' ? 45 * spec.interval
    : spec.frequency === 'monthly' ? Math.min(10 * spec.interval, 40)
    : spec.frequency === 'weekly' ? 2 : 0;
  const jours = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  for (const date of computeOccurrences(spec, reference, today)) {
    if (date === candidate.date) continue;
    if (!listees && fenetre > 0) {
      const present = serie.find((e) => e.date !== date && jours(e.date, date) <= fenetre && e.status !== 'annule');
      if (present) {
        out.push({
          action: 'skip_duplicate', title: candidate.title, date, category: base.category, confidence: candidate.confidence,
          reasonCode: present.manual ? 'RECURRENCE_OCCURRENCE_USER_PROTECTED' : 'RECURRENCE_OCCURRENCE_IN_PERIOD',
          existingItemId: present.id > 0 ? present.id : undefined, deterministic: true,
          sourceFileId: input.sourceFileId, originFieldKey: candidate.originFieldKey,
        });
        continue;
      }
    }
    const dup = findDuplicate({ title: candidate.title, date, originFieldKey: candidate.originFieldKey }, planned);
    const occurrence: NonNullable<AgendaDecision['occurrence']> = {
      nature: listees ? 'CONFIRMED' : 'FORECAST',
      dateSource: listees ? 'EXPLICIT_DATE' : 'PREDICTED_FROM_RECURRENCE',
      seriesKey,
      recurrence: {
        mode: spec.mode, frequency: spec.frequency, interval: spec.interval,
        startDate: spec.startDate ?? null, endDate: spec.endDate ?? null, occurrenceCount: spec.occurrenceCount ?? null,
        rule, excerpt: spec.excerpt ?? null, sourceFileId: input.sourceFileId ?? null,
        referenceDate: reference, history, computedAt,
      },
    };
    const common = {
      title: candidate.title, date, category: base.category, confidence: candidate.confidence,
      sourceFileId: input.sourceFileId, originFieldKey: candidate.originFieldKey, deterministic: true, occurrence,
    };
    if (dup.kind === 'exact') {
      out.push({ ...common, action: 'skip_duplicate', reasonCode: 'RECURRENCE_OCCURRENCE_EXISTS', existingItemId: dup.item?.id });
    } else if (dup.kind === 'probable' && dup.item && dup.item.id > 0) {
      out.push({
        ...common, action: 'arbitrate_duplicate', reasonCode: 'RECURRENCE_PROBABLE_DUPLICATE', existingItemId: dup.item.id,
        duplicate: {
          similarity: dup.similarity ?? 0, dayGap: dup.dayGap ?? 0, reason: dup.reason,
          existingTitle: dup.item.title, existingDate: dup.item.date, existingManual: dup.item.manual,
        },
      });
    } else if (dup.kind === 'none') {
      out.push({
        ...common, action: 'create',
        reasonCode: spec.mode === 'EXPLICIT_SOURCE' ? 'RECURRENCE_EXPLICIT' : 'RECURRENCE_HISTORICAL',
      });
    }
  }
  return out;
}

/**
 * Ambiguïté temporelle (R5) : une date signalée incertaine par
 * `detectTemporalAmbiguity` :
 *   · mention RELATIVE (« sous 30 jours », « avant fin mars ») : aucun appel
 *     modèle — décision `propose` TEMPORAL_AMBIGUITY avec la date déduite
 *     (carte AGENDA-PROPOSAL, aucune création) ;
 *   · plusieurs candidats (jj/mm ↔ mm/jj) : branche TEMPORAL_AMBIGUITY, en
 *     cache par (compte, source, clé fonctionnelle, extrait) — une réanalyse
 *     de la même ambiguïté ne rappelle pas le modèle, sur AUCUNE instance
 *     (cache partagé en base depuis le lot 22, 24 h :
 *     `master/temporal-ambiguity-cache.ts`). Candidat certain de la liste →
 *     date remplacée ; abstention, hors liste ou échec → `propose`.
 * Date certaine : candidat inchangé, aucun appel.
 */
type ChoixTemporel = import('./master/temporal-ambiguity-cache').TemporalChoice;

/** Clé du cache : source, clé fonctionnelle (champ d'origine, cible, occurrence), extrait. */
export function cleCacheTemporel(c: AgendaCandidate, sourceFileId: number | null | undefined): string {
  const x = c as AgendaCandidate & { target?: { type: string; id: number | null }; occurrence?: string };
  const fonctionnelle = [c.originFieldKey ?? normTitle(c.title), x.target ? `${x.target.type}:${x.target.id ?? '-'}` : '-', x.occurrence ?? '-'].join('|');
  return createHash('sha256').update(`${sourceFileId ?? '-'}|${fonctionnelle}|${c.excerpt}`).digest('hex');
}

/** Réservé aux tests : vide le cache (mémoire, et lignes partagées si une base est configurée). */
export async function __resetTemporalCacheForTests(): Promise<void> {
  const { clearTemporalChoicesForTests } = await import('./master/temporal-ambiguity-cache');
  await clearTemporalChoicesForTests();
}

export async function resoudreAmbiguiteTemporelle(
  candidate: AgendaCandidate,
  input: Pick<AgendaIntelligenceInput, 'accountId' | 'userId' | 'sourceFileId'>,
  deps: {
    resolve?: typeof import('./master/temporal-ambiguity').resolveTemporalAmbiguityMaster;
  } = {},
): Promise<{ kind: 'keep'; candidate: AgendaCandidate } | { kind: 'propose'; decision: AgendaDecision }> {
  const ambig = detectTemporalAmbiguity(candidate.date, candidate.excerpt);
  if (!ambig) return { kind: 'keep', candidate };

  const proposer = (dates: string[]): { kind: 'propose'; decision: AgendaDecision } => ({
    kind: 'propose',
    decision: {
      action: 'propose', title: candidate.title, date: candidate.date, category: candidate.suggestedCategory ?? 'action',
      confidence: candidate.confidence, reasonCode: 'TEMPORAL_AMBIGUITY', deterministic: true,
      sourceFileId: input.sourceFileId, originFieldKey: candidate.originFieldKey, temporalCandidates: dates,
    },
  });
  // Mention relative : une seule date déduite — rien à faire choisir au modèle.
  if (ambig.kind === 'RELATIVE_MENTION' || ambig.dates.length < 2) return proposer(ambig.dates);

  const { resolveTemporalAmbiguityMaster } = await import('./master/temporal-ambiguity');
  const candidats = ambig.dates.map((date, i) => ({
    candidateId: i + 1, date,
    interpretation: ambig.kind === 'RELATIVE_MENTION'
      ? `date déduite de la mention relative « ${ambig.mention} »`
      : date === candidate.date ? `lecture mois/jour de « ${ambig.mention} »` : `lecture jour/mois de « ${ambig.mention} »`,
  }));
  const cache = await import('./master/temporal-ambiguity-cache');
  const cle = cache.temporalCacheKey(input.accountId, cleCacheTemporel(candidate, input.sourceFileId));
  const enCache = await cache.readTemporalChoice(cle);
  let r: ChoixTemporel;
  if (enCache) {
    r = enCache;
  } else {
    r = await (deps.resolve ?? resolveTemporalAmbiguityMaster)(
      { title: candidate.title, excerpt: candidate.excerpt.slice(0, 500), extractedDate: candidate.date, kind: ambig.kind, mention: ambig.mention },
      candidats,
      { accountId: input.accountId, userId: input.userId, sourceFileId: input.sourceFileId ?? null },
    );
    // Un échec du modèle n'est pas mis en cache : la prochaine analyse réessaie.
    if (r.warning !== 'MODEL_UNAVAILABLE') await cache.writeTemporalChoice(cle, r);
  }
  if (r.chosen && ambig.dates.includes(r.chosen.date)) return { kind: 'keep', candidate: { ...candidate, date: r.chosen.date } };
  const p = proposer(ambig.dates);
  p.decision.deterministic = false;
  return p;
}

async function processOne(
  candidate: AgendaCandidate,
  input: AgendaIntelligenceInput,
  /** Lot 54 : classification issue de la décision T4 (null : date invalide, aucun appel). */
  t4Classification: AgendaClassification | null,
  /** Lot 71E (§B, §C) : type métier DÉSIGNÉ par T4 (catalogue fermé), ou null. */
  t4BusinessType: string | null = null,
): Promise<AgendaDecision> {
  const base = {
    title: candidate.title,
    date: candidate.date,
    confidence: candidate.confidence,
    sourceFileId: input.sourceFileId,
    originFieldKey: candidate.originFieldKey,
  };

  // ── Étape 2 : interprétation de la date ────────────────────────────────
  const date = interpretDate(candidate.date);
  if (date.qualification !== 'explicit') {
    return {
      ...base, action: 'propose', category: 'information',
      reasonCode: date.qualification === 'invalid' ? 'INVALID_DATE' : 'DATE_OUT_OF_RANGE',
      deterministic: true,
    };
  }

  // ── Étape 3 : comparaison aux événements existants ─────────────────────
  const duplicate = findDuplicate(
    { title: candidate.title, date: candidate.date, originFieldKey: candidate.originFieldKey },
    input.existing,
  );

  // ══════════════════════════════════════════════════════════════════════
  // CONFIRMATION D'UNE OCCURRENCE PRÉVISIONNELLE
  //
  // Correspondance certaine avec une prévision : l'occurrence existante
  // évolue (date lue, nature CONFIRMED) — aucune seconde ligne. Une
  // prévision déplacée par l'utilisateur n'est jamais redéplacée en silence :
  // une date différente de la sienne passe par l'arbitrage.
  // ══════════════════════════════════════════════════════════════════════
  if (duplicate.kind === 'exact' && duplicate.item?.nature === 'FORECAST') {
    if (duplicate.item.manual && duplicate.item.date !== candidate.date) {
      return {
        ...base, action: 'arbitrate_duplicate', category: duplicate.item.category ?? 'information',
        reasonCode: 'FORECAST_USER_MODIFIED_DIVERGENCE', existingItemId: duplicate.item.id, deterministic: true,
        duplicate: {
          similarity: 1, dayGap: duplicate.dayGap ?? 0, reason: duplicate.reason,
          existingTitle: duplicate.item.title, existingDate: duplicate.item.date, existingManual: true,
        },
      };
    }
    return {
      ...base, action: 'confirm_forecast', category: duplicate.item.category ?? 'information',
      reasonCode: duplicate.item.date === candidate.date ? 'FORECAST_CONFIRMED_SAME_DATE' : 'FORECAST_CONFIRMED_DATE_ADJUSTED',
      existingItemId: duplicate.item.id, deterministic: true,
    };
  }

  if (duplicate.kind === 'exact') {
    // Un doublon certain n'est jamais recréé (§4.4.4).
    // Lot 71E (§C) : il peut en revanche voir sa CLASSIFICATION corrigée
    // quand T4 l'a décidée de façon fiable — la persistance n'applique la
    // correction qu'à un événement automatique intact (même identifiant,
    // aucun autre champ réécrit).
    const fiable = t4Classification && t4Classification.source === 'model'
      && t4Classification.category !== 'unknown' && t4Classification.confidence !== 'ambiguous';
    return {
      ...base, action: 'skip_duplicate',
      category: duplicate.item?.category ?? 'information',
      reasonCode: 'EXACT_DUPLICATE', existingItemId: duplicate.item?.id,
      deterministic: true,
      ...(fiable && duplicate.item && duplicate.item.id > 0 && !duplicate.item.manual
        ? { classificationCorrection: { category: t4Classification!.category as HomeCategory, businessType: t4BusinessType } } : {}),
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // PROBABLE = INCERTAIN = ARBITRAGE
  //
  // Le commentaire du dédoublonnage annonçait « jamais tranché seul », et le
  // moteur fusionnait pourtant silencieusement (`update`) un doublon probable
  // dès que l'événement existant était automatique : « Contrôle technique
  // 15/11 » devenait « Contrôle technique véhicule 17/11 » sans que personne
  // ne l'ait confirmé.
  //
  // Correspondance fiable → consolidation ; incertaine → À arbitrer ; aucune
  // → nouvelle échéance. Le caractère manuel ou automatique de l'événement
  // existant est transmis à l'arbitrage, il ne décide plus de la fusion.
  // ══════════════════════════════════════════════════════════════════════
  if (duplicate.kind === 'probable' && duplicate.item) {
    return {
      ...base, action: 'arbitrate_duplicate',
      category: duplicate.item.category ?? 'information',
      reasonCode: duplicate.item.manual ? 'PROBABLE_DUPLICATE_MANUAL_EVENT' : 'PROBABLE_DUPLICATE',
      existingItemId: duplicate.item.id,
      deterministic: true,
      duplicate: {
        similarity: duplicate.similarity ?? 0,
        dayGap: duplicate.dayGap ?? 0,
        reason: duplicate.reason,
        existingTitle: duplicate.item.title,
        existingDate: duplicate.item.date,
        existingManual: duplicate.item.manual,
      },
    };
  }

  // ── Classification : celle de la décision T4 (lot 54) ──────────────────
  const classification = t4Classification ?? { category: 'unknown', confidence: 'ambiguous', source: 'fallback' } as AgendaClassification;
  const deterministic = classification.source !== 'model' && classification.source !== 'fallback';
  const prudent = prudentCategory(classification, { date: candidate.date, today: input.today ?? todayParis() });

  // Une date explicite issue d'un document autorisé est créée automatiquement.
  // CDC 15 T4-04 : l'autorisation du TYPE documentaire (DOCUMENT_CATALOG)
  // s'applique ; sinon l'échéance est proposée.
  let authorized = candidate.confidence === 'certain';
  let reasonCode = authorized ? 'EXPLICIT_DATE_AUTHORIZED_SOURCE' : 'INSUFFICIENT_CONFIDENCE';
  if (authorized) {
    const auth = creationAuthorization(candidate as T4AgendaCandidate);
    if (!auth.allowed) {
      authorized = false;
      reasonCode = auth.reasonCode;
    }
  }
  return {
    ...base,
    action: authorized ? 'create' : 'propose',
    category: prudent.category,
    reasonCode,
    deterministic,
    classification: { ...classification, requiresQualification: prudent.requiresQualification },
  };
}

/**
 * Classification DÉTAILLÉE d'un événement — PARCOURS MANUEL (CDC 15 T4-10 ;
 * le flux documentaire automatique passe par `decideAgendaEvent` depuis le
 * lot 54) :
 *   1. règles déterministes (registre, règles métier stables T4-11, motifs) ;
 *   2. sinon, branche CLASSIFY_EVENT du master T4 (action | information |
 *      unknown, confiance) — seul moteur depuis le lot 16b-2 ;
 *   échec du modèle : repli `action`, ambigu (`classifyEventMaster`).
 * Aucun appel modèle sur un cas que les règles tranchent (critère n°17).
 */
export async function classifyAgendaEvent(
  input: AgendaClassificationInput,
  contexte: { accountId: number; userId?: number; sourceFileId?: number | null; excerpt?: string; date?: string | null },
): Promise<AgendaClassification> {
  const byRules = classifyByRulesDetailed(input);
  if (byRules !== null) {
    return { category: byRules.category, confidence: 'certain', source: byRules.source, ruleCode: byRules.ruleCode, businessType: input.businessType ?? null };
  }
  return classifyEventMaster(input, contexte);
}

/**
 * Classification d'un seul événement — point d'entrée du CHEMIN MANUEL
 * (`AgendaWriteService`) : mêmes règles et même master T4 que l'agenda
 * automatique (l'ancien `AgendaClassificationService` et le rattrapage
 * `backfill-home-category` sont supprimés au lot 16b-2).
 *
 * Renvoie une catégorie affichable : `unknown` devient la catégorie prudente
 * (`prudentCategory`, sans date : `action`).
 */
export async function classifyAgendaCategory(
  input: AgendaClassificationInput,
  contexte: { accountId: number; userId?: number; sourceFileId?: number | null; excerpt?: string; date?: string | null },
): Promise<HomeCategory> {
  const c = await classifyAgendaEvent(input, contexte);
  return prudentCategory(c, { date: contexte.date ?? null, today: todayParis() }).category;
}

function toClassificationInput(candidate: AgendaCandidate): AgendaClassificationInput {
  const c = candidate as T4AgendaCandidate;
  return {
    title: candidate.title,
    // Extrait de la source : les règles métier (T4-11) lisent l'événement réel.
    description: candidate.excerpt || null,
    originType: candidate.originFieldKey ? 'asset_field' : 'document',
    originFieldKey: candidate.originFieldKey ?? null,
    businessType: c.businessType ?? null,
    nature: c.nature ?? null,
  };
}

export { AUTHORIZED_CREATION_TYPES };
