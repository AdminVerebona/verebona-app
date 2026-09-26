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
import { classifyByRules } from './rules/deterministic-classification';
import { interpretDate } from './rules/date-interpreter';
import { findDuplicate, titleSimilarity, containmentSimilarity } from './dedupe.service';
import {
  computeOccurrences, describeRecurrence, inferHistoricalRecurrence, type RecurrenceSpec,
} from './rules/recurrence';
import { createHash } from 'crypto';
import type {
  AgendaDecision, ExistingAgendaItem, HomeCategory, AgendaClassificationInput,
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
}

/** Types de documents autorisant une création automatique d'échéance (§4.4.4). */
const AUTHORIZED_CREATION_TYPES = new Set([
  'CERTIFICAT_IMMATRICULATION', 'CARTE_GRISE', 'CONTRAT_ASSURANCE', 'AVIS_ECHEANCE',
  'CERTIFICAT_GARANTIE', 'CONTRAT_LOA', 'CONTRAT_LLD', 'DPE', 'DIAGNOSTIC',
  'RAPPORT_ENTRETIEN', 'FACTURE',
]);

export async function processAgendaCandidates(
  input: AgendaIntelligenceInput,
): Promise<AgendaDecision[]> {
  const decisions: AgendaDecision[] = [];
  // Événements connus + ceux que ce passage va créer : chaque occurrence
  // générée est rapprochée de TOUT ce qui existera, sans doublon en masse.
  const planned: ExistingAgendaItem[] = [...input.existing];
  const today = input.today ?? todayParis();

  for (const candidate of input.candidates) {
    const base = await processOne(candidate, { ...input, existing: planned });
    decisions.push(base);
    const recurrent = await forecastsFor(candidate, base, input, planned, today);
    if (base.action === 'create' || base.action === 'propose') {
      planned.push(asPlanned(base, planned.length));
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
  const category = await classify(candidate, input);
  const deterministic = classifyByRules(toClassificationInput(candidate)) !== null;

  // Une date explicite issue d'un document autorisé est créée automatiquement.
  const authorized = candidate.confidence === 'certain';
  return {
    ...base,
    action: authorized ? 'create' : 'propose',
    category,
    reasonCode: authorized ? 'EXPLICIT_DATE_AUTHORIZED_SOURCE' : 'INSUFFICIENT_CONFIDENCE',
    deterministic,
  };
}

/**
 * Étape 1 puis étape 5 : les règles d'abord, le modèle seulement si elles
 * n'ont pas tranché. En cas d'échec du modèle, repli sur `action` — mieux vaut
 * afficher une échéance dans « Prochaines dates » que la masquer, comportement
 * conservé de l'existant.
 */
async function classify(
  candidate: AgendaCandidate,
  input: AgendaIntelligenceInput,
): Promise<HomeCategory> {
  return classifyAgendaCategory(toClassificationInput(candidate), {
    accountId: input.accountId,
    userId: input.userId,
    sourceFileId: input.sourceFileId,
    excerpt: candidate.excerpt,
  });
}

/**
 * Classification d'un seul événement — point d'entrée du CHEMIN MANUEL.
 *
 * Extraite de `classify` pour que la création manuelle d'une échéance puisse
 * passer par ce moteur au lieu de l'ancien `AgendaClassificationService`. Sans
 * ce point d'entrée, `AI_AGENDA_ENGINE=enabled` laissait l'ancien classifieur
 * seul maître du chemin manuel : le drapeau ne commandait rien.
 *
 * Critère d'acceptation n°17 : aucun appel modèle n'est émis sur un cas que les
 * règles tranchent.
 */
export async function classifyAgendaCategory(
  input: AgendaClassificationInput,
  contexte: { accountId: number; userId?: number; sourceFileId?: number | null; excerpt?: string },
): Promise<HomeCategory> {
  const byRules = classifyByRules(input);
  if (byRules !== null) return byRules;

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
    return res.data.category;
  } catch (e) {
    // Interruption (garde AI_BLOCKED, jeton révoqué) : pas de repli
    // silencieux sur « action », qui ferait écrire une classification par
    // défaut ; le travail T4 est remis en file (execution-control).
    if (isExecutionCancelled(e)) throw e;
    console.warn('[agenda] classification modèle indisponible :', (e as Error).message);
    return 'action';
  }
}

function toClassificationInput(candidate: AgendaCandidate): AgendaClassificationInput {
  return {
    title: candidate.title,
    originType: candidate.originFieldKey ? 'asset_field' : 'document',
    originFieldKey: candidate.originFieldKey ?? null,
  };
}

export { AUTHORIZED_CREATION_TYPES };
