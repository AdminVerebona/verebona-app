/**
 * CONSTRUCTEUR DE REQUÊTE UNIQUE — lot 85C (CDC Pilotage IA V2, phase P4 :
 * CFG-02, CFG-03, INV-03, R02, R03, R45 ; décisions PO 08 et 09).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UNE SEULE FONCTION, TROIS USAGES
 *
 * `buildModelRequest` transforme un réglage DEMANDÉ (niveau de raisonnement,
 * plafond de sortie du rang, plancher de l'opération, plafond d'appelant)
 * en paramètres EFFECTIVEMENT transmis au modèle, à partir de SA fiche de
 * capacités (`model-capabilities.ts`). Elle est appelée à l'identique par :
 *   · la validation de configuration (BO : sauvegarde, contrôle, activation) ;
 *   · la qualification technique (épreuves des sondes) ;
 *   · l'exécution (passerelle, chaque tentative ; l'adaptateur Gemini
 *     reconstruit le même `generationConfig` par la même fonction).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REFUS AVANT APPEL, ADAPTATIONS EXPLICITES
 *
 * Combinaison CONNUE comme incompatible → refus (`MODEL_PARAMETERS_INCOMPATIBLE`),
 * avec le paramètre concerné, AVANT tout contact fournisseur :
 *   · niveau absent des niveaux documentés, ou refusé par une sonde ;
 *   · budget hors bornes documentées ;
 *   · raisonnement « étendu » demandé à un modèle qui ne raisonne pas ;
 *   · limite de sortie du modèle inférieure au plancher de l'opération (une
 *     sortie exhaustive est impossible — décision 08 : une troncature ne
 *     devient jamais une réussite) ;
 *   · entrée image exigée alors que la sonde a établi son refus.
 * Capacité INCONNUE → rien n'est inventé : le paramètre n'est pas transmis
 * (défaut du modèle) et l'adaptation est TRACÉE (`CAPABILITY_UNKNOWN`).
 * Plafond hérité supérieur à la limite du modèle → ADAPTÉ à cette limite et
 * tracé (demandé / hérité / adapté / envoyé — décision 08, CFG-02).
 *
 * Pur et déterministe : aucune base, aucun réseau, aucune lecture du nom du
 * modèle (L85C-U03).
 * ══════════════════════════════════════════════════════════════════════════
 */
import type { ReasoningLevel } from '../config/config-types';
import {
  capabilitiesOf, TEMPERATURE_PROFILE_BY_FAMILY, type ModelCapabilities,
} from '../provider/model-capabilities';

/** Paramètres de génération résolus, neutres vis-à-vis du fournisseur. */
export interface ResolvedGenerationParams {
  /** `null` : non transmise (défaut du fournisseur). */
  temperature: number | null;
  /** `null` : non transmis (défaut du fournisseur). */
  maxOutputTokens: number | null;
  /** `null` : aucun réglage de raisonnement transmis (défaut du modèle). */
  thinking: { thinkingLevel: string } | { thinkingBudget: number } | null;
}

export type AdaptationReason =
  | 'CAPABILITY_UNKNOWN'
  | 'MODEL_OUTPUT_LIMIT'
  | 'MODEL_DOES_NOT_THINK'
  | 'TEMPERATURE_REJECTED_BY_PROBE'
  | 'TEMPERATURE_OUT_OF_RANGE';

export interface Adaptation {
  parameter: 'reasoning' | 'maxOutputTokens' | 'temperature';
  reason: AdaptationReason;
  requested: unknown;
  sent: unknown;
}

/** Origine d'un plafond de sortie demandé (trace « hérité »). */
export type OutputCapOrigin = 'operation_rank' | 'operation' | 'treatment' | 'code' | 'none' | 'probe';

export interface ModelRequestInput {
  model: string;
  /** Fiche injectée (tests, validation hors ligne) ; défaut : registre en mémoire. */
  capabilities?: ModelCapabilities;
  /** Niveau DEMANDÉ pour ce rang (`null`/`standard` : défaut du modèle). */
  reasoning?: ReasoningLevel | null;
  /** Plafond DEMANDÉ pour ce rang, avant plancher et adaptation. */
  maxOutputTokens?: number | null;
  /** D'où vient ce plafond (profil d'opération par rang, opération, traitement, code). */
  maxOutputTokensOrigin?: OutputCapOrigin;
  /** Plancher de l'opération (`minOutputTokens`). */
  minOutputTokens?: number | null;
  /** Plafond imposé par l'appelant (`maxOutputTokensCap`). */
  callerCap?: number | null;
  /** L'appel transmet une image / un PDF : la modalité doit être acceptée. */
  needsImageInput?: boolean;
}

export interface RequestTrace {
  model: string;
  family: string | null;
  reasoning: { requested: ReasoningLevel | null; sent: string | null };
  maxOutputTokens: {
    requested: number | null; origin: OutputCapOrigin; operationFloor: number | null; callerCap: number | null;
    modelLimit: number | null; adapted: number | null; sent: number | null;
  };
  temperature: { profile: string | null; sent: number | null };
  adaptations: Adaptation[];
  /** Provenance des capacités utilisées (`thinking: reference`…). */
  capabilitySources: Record<string, string>;
}

export interface RequestRefusal {
  code: 'MODEL_PARAMETERS_INCOMPATIBLE';
  /** Paramètre concerné (chemin de la requête fournisseur). */
  parameter: string;
  message: string;
  requested: unknown;
}

export type ModelRequestResult =
  | { ok: true; params: ResolvedGenerationParams; trace: RequestTrace }
  | { ok: false; refusal: RequestRefusal; trace: RequestTrace };

const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : null);

/** Constructeur unique (pur). */
export function buildModelRequest(input: ModelRequestInput): ModelRequestResult {
  const cap = input.capabilities ?? capabilitiesOf(input.model);
  const adaptations: Adaptation[] = [];
  const requested = input.reasoning ?? null;
  const capabilitySources: Record<string, string> = {};
  for (const [k, s] of Object.entries(cap.sources)) if (s) capabilitySources[k] = s.source;

  const trace: RequestTrace = {
    model: input.model, family: cap.family,
    reasoning: { requested, sent: null },
    maxOutputTokens: {
      requested: posInt(input.maxOutputTokens), origin: input.maxOutputTokensOrigin ?? (posInt(input.maxOutputTokens) ? 'treatment' : 'none'),
      operationFloor: posInt(input.minOutputTokens), callerCap: posInt(input.callerCap), modelLimit: cap.outputTokenLimit,
      adapted: null, sent: null,
    },
    temperature: { profile: null, sent: null },
    adaptations,
    capabilitySources,
  };
  const refuse = (parameter: string, message: string, value: unknown): ModelRequestResult => ({
    ok: false, refusal: { code: 'MODEL_PARAMETERS_INCOMPATIBLE', parameter, message, requested: value }, trace,
  });

  // ── Modalité d'entrée ────────────────────────────────────────────────────
  if (input.needsImageInput && cap.modalities.imageInput === false) {
    return refuse('contents.inlineData', `Le modèle « ${input.model} » n’accepte pas d’entrée image/PDF (sonde de qualification).`, 'image');
  }

  // ── Raisonnement ────────────────────────────────────────────────────────
  let thinking: ResolvedGenerationParams['thinking'] = null;
  if (requested === 'minimal' || requested === 'étendu') {
    const t = cap.thinking;
    if (t.mode === 'level') {
      const v = t.map[requested];
      const path = 'generationConfig.thinkingConfig.thinkingLevel';
      if (!t.levels.includes(v) || cap.rejected.includes(`${path}=${v}`)) {
        return refuse(path, `Niveau de raisonnement « ${v} » (${requested}) non accepté par « ${input.model} ».`, v);
      }
      thinking = { thinkingLevel: v };
    } else if (t.mode === 'budget') {
      const v = t.map[requested];
      const path = 'generationConfig.thinkingConfig.thinkingBudget';
      if (v < t.min || v > t.max || cap.rejected.includes(`${path}=${v}`)) {
        return refuse(path, `Budget de raisonnement ${v} (${requested}) hors des bornes de « ${input.model} » (${t.min}–${t.max}).`, v);
      }
      thinking = { thinkingBudget: v };
    } else if (t.mode === 'none') {
      if (requested === 'étendu') {
        return refuse('generationConfig.thinkingConfig', `« ${input.model} » ne raisonne pas : le niveau « étendu » est impossible.`, requested);
      }
      // « minimal » sur un modèle qui ne raisonne pas : déjà le cas, rien à transmettre.
      adaptations.push({ parameter: 'reasoning', reason: 'MODEL_DOES_NOT_THINK', requested, sent: null });
    } else {
      adaptations.push({ parameter: 'reasoning', reason: 'CAPABILITY_UNKNOWN', requested, sent: null });
    }
  }
  trace.reasoning.sent = thinking ? ('thinkingLevel' in thinking ? thinking.thinkingLevel : `budget ${thinking.thinkingBudget}`) : null;

  // ── Plafond de sortie (décision 08) ─────────────────────────────────────
  const demande = posInt(input.maxOutputTokens);
  const plancher = posInt(input.minOutputTokens);
  const plafondAppelant = posInt(input.callerCap);
  const limite = cap.outputTokenLimit;
  if (plancher && limite !== null && limite < plancher) {
    return refuse('generationConfig.maxOutputTokens',
      `Limite de sortie de « ${input.model} » (${limite}) inférieure au plancher de l’opération (${plancher}) : sortie exhaustive impossible.`, plancher);
  }
  let max: number | null = plancher ? Math.max(demande ?? 0, plancher) : demande;
  if (plafondAppelant) max = max ? Math.min(max, plafondAppelant) : plafondAppelant;
  if (max && limite !== null && max > limite) {
    adaptations.push({ parameter: 'maxOutputTokens', reason: 'MODEL_OUTPUT_LIMIT', requested: max, sent: limite });
    max = limite;
  }
  trace.maxOutputTokens.adapted = max;
  trace.maxOutputTokens.sent = max;

  // ── Température (décision 09 : profil par famille, jamais saisie au BO) ─
  let temperature: number | null = null;
  const profil = cap.family ? TEMPERATURE_PROFILE_BY_FAMILY[cap.family] : undefined;
  const t = cap.temperature;
  const dansPlage = (v: number) => (t.min === null || v >= t.min) && (t.max === null || v <= t.max);
  if (t.accepted === false) {
    if (profil) adaptations.push({ parameter: 'temperature', reason: 'TEMPERATURE_REJECTED_BY_PROBE', requested: profil.value, sent: null });
  } else if (profil) {
    if (dansPlage(profil.value)) { temperature = profil.value; trace.temperature.profile = `famille ${cap.family}`; }
    else adaptations.push({ parameter: 'temperature', reason: 'TEMPERATURE_OUT_OF_RANGE', requested: profil.value, sent: null });
  } else if (t.accepted === true && dansPlage(0)) {
    temperature = 0;
    trace.temperature.profile = 'plage déclarée par l’API (0 privilégié)';
  } else {
    adaptations.push({ parameter: 'temperature', reason: 'CAPABILITY_UNKNOWN', requested: 0, sent: null });
  }
  trace.temperature.sent = temperature;

  return { ok: true, params: { temperature, maxOutputTokens: max, thinking }, trace };
}

/** Libellé BO du raisonnement transmis : `aucun`, `low`, `high`, `budget N`. */
export function thinkingParamLabel(t: ResolvedGenerationParams['thinking']): string {
  if (!t) return 'aucun';
  return 'thinkingLevel' in t ? t.thinkingLevel : `budget ${t.thinkingBudget}`;
}
