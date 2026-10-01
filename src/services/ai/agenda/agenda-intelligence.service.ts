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
 */
import { z } from 'zod';
import { AiGateway } from '../gateway/ai-gateway';
import { classifyByRulesInMode, resolveClassificationMode, type ClassificationMode } from './rules/rules-engine';
import { prudentCategory } from './rules/prudent-category';
import { classifyEventMaster } from './master/classify-event';
import { getPromptArchitecture } from '../config/config-resolver';
import { t4EffectsMode, type RolloutMode } from '@/services/canonical/rollout';
import { DOCUMENT_CATALOG, resolveDocumentType } from '@/services/canonical/registry';
import { interpretDate, detectTemporalAmbiguity } from './rules/date-interpreter';
import { findDuplicate, titleSimilarity, containmentSimilarity } from './dedupe.service';
import {
  computeOccurrences, describeRecurrence, inferHistoricalRecurrence, type RecurrenceSpec,
} from './rules/recurrence';
import { createHash } from 'crypto';
import type {
  AgendaDecision, ExistingAgendaItem, HomeCategory, AgendaClassificationInput, AgendaClassification,
} from './types';
import type { AgendaCandidate } from '../source-analysis/types';
import { isExecutionCancelled } from '../queue/execution-control';

const ClassifyEventOutput = z.object({
  category: z.enum(['action', 'information']),
  reason: z.string().max(300),
});

export interface AgendaIntelligenceInput {
  accountId: number;
  userId?: number;
  assetId: number | null;
  candidates: AgendaCandidate[];
  existing: ExistingAgendaItem[];
  sourceFileId?: number;
  /** Date du jour (AAAA-MM-JJ, Europe/Paris) — injectable pour les tests. */
  today?: string;
  /** Mode de `AI_T4_EFFECTS` (lu dans l'environnement si absent) — injectable. */
  t4Effects?: RolloutMode;
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
 * source unique. Contient les types du lot 10 et les extensions du catalogue
 * (acte authentique, PV de contrôle technique — question ouverte du registre).
 */
const AUTHORIZED_CREATION_TYPES: ReadonlySet<string> = new Set(
  DOCUMENT_CATALOG.filter((d) => d.mayCreateAgenda).flatMap((d) => [d.code, ...(d.aliases ?? [])]),
);

/**
 * Sémantique T4 d'un candidat enrichi, recopiée dans ses décisions (sous
 * AI_T4_EFFECTS=enabled). Champs absents du candidat : non recopiés.
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
 * type absent ou inconnu : jamais autoritaire (proposition).
 */
export function creationAuthorization(c: T4AgendaCandidate): {
  allowed: boolean; reasonCode: 'SOURCE_AUTHORIZED' | 'SOURCE_TYPE_NOT_AUTHORIZED' | 'SOURCE_TYPE_UNKNOWN'; documentType: string | null;
} {
  const documentType = c.documentType ?? null;
  const entry = resolveDocumentType(documentType);
  const allowed = typeof c.mayCreateAgenda === 'boolean' ? c.mayCreateAgenda : entry?.mayCreateAgenda ?? false;
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

  const t4Effects = input.t4Effects ?? t4EffectsMode();
  for (const brut of input.candidates) {
    // R5 (CDC 15 §26) : date incertaine → branche TEMPORAL_AMBIGUITY du
    // master (T4 master + enabled seulement) ; sinon inchangé.
    const temporel = await resoudreAmbiguiteTemporelle(brut, input, t4Effects);
    if (temporel.kind === 'propose') {
      const d = temporel.decision;
      if (t4Effects === 'enabled') Object.assign(d, t4Semantics(brut as T4AgendaCandidate, input.sourceFileId));
      decisions.push(d);
      planned.push(asPlanned(d, planned.length));
      continue;
    }
    const candidate = temporel.candidate;
    const base = await processOne(candidate, { ...input, existing: planned, today, t4Effects });
    decisions.push(base);
    let recurrent = await forecastsFor(candidate, base, input, planned, today);
    // T4-04 : une source non autorisée ne crée pas non plus les occurrences
    // de sa récurrence — elles sont proposées, comme l'occurrence de base.
    if (base.reasonCode === 'SOURCE_TYPE_NOT_AUTHORIZED' || base.reasonCode === 'SOURCE_TYPE_UNKNOWN') {
      recurrent = recurrent.map((d) => (d.action === 'create' ? { ...d, action: 'propose', reasonCode: base.reasonCode } : d));
    }
    if (base.action === 'create' || base.action === 'propose') {
      planned.push(asPlanned(base, planned.length));
    }
    // CDC 15 T4-07/T4-08 (lot 14) : sous enabled, la sémantique du candidat
    // accompagne chaque décision jusqu'à la persistance (clé fonctionnelle,
    // liens source). L'occurrence d'une récurrence porte SA date.
    if (t4Effects === 'enabled') {
      Object.assign(base, t4Semantics(candidate as T4AgendaCandidate, input.sourceFileId));
      recurrent = recurrent.map((d) => ({ ...d, ...t4Semantics(candidate as T4AgendaCandidate, input.sourceFileId), occurrenceIndex: d.date }));
    }
    for (const d of recurrent) {
      decisions.push(d);
      if (d.action === 'create' || d.action === 'propose') planned.push(asPlanned(d, planned.length));
    }
  }

  return decisions;
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
 * Occurrences prévisionnelles justifiées par une récurrence DÉMONTRÉE.
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
): Promise<AgendaDecision[]> {
  if (base.reasonCode === 'INVALID_DATE' || base.reasonCode === 'DATE_OUT_OF_RANGE') return [];
  const seriesKey = seriesKeyFor(input.assetId, candidate);
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
  if (!spec) return [];

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
 * Ambiguïté temporelle (R5) : sous T4 `master` ET `AI_T4_EFFECTS=enabled`,
 * une date signalée incertaine par `detectTemporalAmbiguity` :
 *   · mention RELATIVE (« sous 30 jours », « avant fin mars ») : aucun appel
 *     modèle — décision `propose` TEMPORAL_AMBIGUITY avec la date déduite
 *     (carte AGENDA-PROPOSAL, aucune création) ;
 *   · plusieurs candidats (jj/mm ↔ mm/jj) : branche TEMPORAL_AMBIGUITY, en
 *     cache par (source, clé fonctionnelle, extrait) — une réanalyse de la
 *     même ambiguïté ne rappelle pas le modèle. Candidat certain de la liste →
 *     date remplacée ; abstention, hors liste ou échec → `propose`.
 * Hors de ce mode : candidat inchangé, aucun appel.
 */
type ChoixTemporel = { chosen: { candidateId: number; date: string; interpretation: string } | null; warning: string | null };
const CACHE_TEMPOREL = new Map<string, { at: number; r: ChoixTemporel }>();
const CACHE_TEMPOREL_TTL_MS = 24 * 3600_000;
const CACHE_TEMPOREL_MAX = 500;

/** Clé du cache : source, clé fonctionnelle (champ d'origine, cible, occurrence), extrait. */
export function cleCacheTemporel(c: AgendaCandidate, sourceFileId: number | null | undefined): string {
  const x = c as AgendaCandidate & { target?: { type: string; id: number | null }; occurrence?: string };
  const fonctionnelle = [c.originFieldKey ?? normTitle(c.title), x.target ? `${x.target.type}:${x.target.id ?? '-'}` : '-', x.occurrence ?? '-'].join('|');
  return createHash('sha256').update(`${sourceFileId ?? '-'}|${fonctionnelle}|${c.excerpt}`).digest('hex');
}

/** Réservé aux tests. */
export function __resetTemporalCacheForTests(): void { CACHE_TEMPOREL.clear(); }

export async function resoudreAmbiguiteTemporelle(
  candidate: AgendaCandidate,
  input: Pick<AgendaIntelligenceInput, 'accountId' | 'userId' | 'sourceFileId'>,
  t4Effects: RolloutMode,
  deps: {
    architecture?: () => Promise<string>;
    resolve?: typeof import('./master/temporal-ambiguity').resolveTemporalAmbiguityMaster;
  } = {},
): Promise<{ kind: 'keep'; candidate: AgendaCandidate } | { kind: 'propose'; decision: AgendaDecision }> {
  if (t4Effects !== 'enabled') return { kind: 'keep', candidate };
  const ambig = detectTemporalAmbiguity(candidate.date, candidate.excerpt);
  if (!ambig) return { kind: 'keep', candidate };
  const architecture = await (deps.architecture ?? (() => getPromptArchitecture('T4')))();
  if (architecture !== 'master') return { kind: 'keep', candidate };

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
  const cle = cleCacheTemporel(candidate, input.sourceFileId);
  const enCache = CACHE_TEMPOREL.get(cle);
  let r: ChoixTemporel;
  if (enCache && Date.now() - enCache.at < CACHE_TEMPOREL_TTL_MS) {
    r = enCache.r;
  } else {
    r = await (deps.resolve ?? resolveTemporalAmbiguityMaster)(
      { title: candidate.title, excerpt: candidate.excerpt.slice(0, 500), extractedDate: candidate.date, kind: ambig.kind, mention: ambig.mention },
      candidats,
      { accountId: input.accountId, userId: input.userId, sourceFileId: input.sourceFileId ?? null },
    );
    // Un échec du modèle n'est pas mis en cache : la prochaine analyse réessaie.
    if (r.warning !== 'MODEL_UNAVAILABLE') {
      if (CACHE_TEMPOREL.size >= CACHE_TEMPOREL_MAX) CACHE_TEMPOREL.delete(CACHE_TEMPOREL.keys().next().value as string);
      CACHE_TEMPOREL.set(cle, { at: Date.now(), r });
    }
  }
  if (r.chosen && ambig.dates.includes(r.chosen.date)) return { kind: 'keep', candidate: { ...candidate, date: r.chosen.date } };
  const p = proposer(ambig.dates);
  p.decision.deterministic = false;
  return p;
}

async function processOne(
  candidate: AgendaCandidate,
  input: AgendaIntelligenceInput,
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
    return {
      ...base, action: 'skip_duplicate',
      category: duplicate.item?.category ?? 'information',
      reasonCode: 'EXACT_DUPLICATE', existingItemId: duplicate.item?.id,
      deterministic: true,
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

  // ── Étapes 1, 4 et 5 : classification, règles métier, appel ciblé ──────
  const classification = await classify(candidate, input);
  const deterministic = classification.source !== 'model' && classification.source !== 'fallback';
  const prudent = prudentCategory(classification, { date: candidate.date, today: input.today ?? todayParis() });

  // Une date explicite issue d'un document autorisé est créée automatiquement.
  // CDC 15 T4-04 : l'autorisation du TYPE documentaire (DOCUMENT_CATALOG)
  // s'applique sous AI_T4_EFFECTS=enabled ; en shadow, le refus est
  // seulement journalisé ; en legacy, rien ne change.
  let authorized = candidate.confidence === 'certain';
  let reasonCode = authorized ? 'EXPLICIT_DATE_AUTHORIZED_SOURCE' : 'INSUFFICIENT_CONFIDENCE';
  const mode = input.t4Effects ?? t4EffectsMode();
  if (authorized && mode !== 'legacy') {
    const auth = creationAuthorization(candidate as T4AgendaCandidate);
    if (!auth.allowed) {
      if (mode === 'enabled') {
        authorized = false;
        reasonCode = auth.reasonCode;
      } else {
        console.info(`[agenda][shadow] T4-04 : création refusée sous enabled (${auth.reasonCode}, type ${auth.documentType ?? 'absent'}) — « ${candidate.title} » ${candidate.date}`);
      }
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
 * Étape 1 puis étape 5 : les règles d'abord, le modèle seulement si elles
 * n'ont pas tranché.
 */
async function classify(
  candidate: AgendaCandidate,
  input: AgendaIntelligenceInput,
): Promise<AgendaClassification> {
  return classifyAgendaEvent(toClassificationInput(candidate), {
    accountId: input.accountId,
    userId: input.userId,
    sourceFileId: input.sourceFileId,
    excerpt: candidate.excerpt,
    date: candidate.date,
    ...(input.t4Effects ? { mode: await resolveClassificationMode({ t4Effects: input.t4Effects }) } : {}),
  });
}

/**
 * Classification DÉTAILLÉE d'un événement (CDC 15 T4-10) :
 *   1. règles déterministes (registre, règles métier, motifs) ;
 *   2. sinon, architecture T4 `master` : branche CLASSIFY_EVENT du master
 *      (action | information | unknown, confiance) ;
 *   3. sinon, `classify_event` historique, strictement inchangé ;
 *   échec du modèle : repli `action` (comportement historique), ambigu.
 * Aucun appel modèle sur un cas que les règles tranchent (critère n°17).
 */
export async function classifyAgendaEvent(
  input: AgendaClassificationInput,
  contexte: {
    accountId: number; userId?: number; sourceFileId?: number | null; excerpt?: string; date?: string | null;
    /** Mode de classification (injectable) ; à défaut, commutateur + configuration. */
    mode?: ClassificationMode;
  },
): Promise<AgendaClassification> {
  // Arbitrage lead (lot 14) : règles v2 sous AI_T4_EFFECTS=enabled ou T4
  // master ; historique exact sinon (divergences journalisées en shadow).
  const architecture = await getPromptArchitecture('T4');
  const mode = contexte.mode ?? await resolveClassificationMode({ architecture });
  const byRules = classifyByRulesInMode(input, mode);
  if (byRules !== null) {
    return { category: byRules.category, confidence: 'certain', source: byRules.source, ruleCode: byRules.ruleCode, businessType: input.businessType ?? null };
  }

  if (architecture === 'master') {
    return classifyEventMaster(input, contexte);
  }

  try {
    const res = await AiGateway.execute({
      useCaseCode: 'AGENDA_INTELLIGENCE',
      operationCode: 'classify_event',
      accountId: contexte.accountId,
      userId: contexte.userId,
      sourceIds: contexte.sourceFileId ? [contexte.sourceFileId] : undefined,
      promptVariables: {
        TITLE: input.title,
        EXCERPT: (contexte.excerpt ?? input.description ?? '').slice(0, 500),
      },
      outputSchema: ClassifyEventOutput,
    });
    return { category: res.data.category, confidence: 'probable', source: 'model', reason: res.data.reason };
  } catch (e) {
    // Interruption (garde AI_BLOCKED, jeton révoqué) : pas de repli
    // silencieux sur « action », qui ferait écrire une classification par
    // défaut ; le travail T4 est remis en file (execution-control).
    if (isExecutionCancelled(e)) throw e;
    console.warn('[agenda] classification modèle indisponible :', (e as Error).message);
    return { category: 'action', confidence: 'ambiguous', source: 'fallback', reason: 'modèle indisponible' };
  }
}

/**
 * Classification d'un seul événement — point d'entrée du CHEMIN MANUEL.
 *
 * Extraite de `classify` pour que la création manuelle d'une échéance puisse
 * passer par ce moteur au lieu de l'ancien `AgendaClassificationService`. Sans
 * ce point d'entrée, `AI_AGENDA_ENGINE=enabled` laissait l'ancien classifieur
 * seul maître du chemin manuel : le drapeau ne commandait rien.
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
