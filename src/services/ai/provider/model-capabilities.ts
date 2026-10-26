/**
 * Capacités des modèles — lot 85C (CDC Pilotage IA V2, phase P4 : CAT-02,
 * CAT-03, CFG-02, CFG-03, INV-03 ; décisions PO 02, 08, 09).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SOURCE UNIQUE DES CAPACITÉS (CAT-03)
 *
 * Paramètres acceptés, niveaux de raisonnement, défauts, limites de sortie et
 * d'entrée, modalités : une seule fiche par modèle, chaque champ portant sa
 * SOURCE et sa DATE de vérification. Trois origines, fusionnées ici et nulle
 * part ailleurs :
 *   1. `api`       — métadonnées de `GET /v1beta/models` (catalogue existant
 *                    `ai_model_catalog`, alimenté par `ai-catalog-sync`) :
 *                    limites d'entrée/sortie, `thinking`, `temperature`,
 *                    `maxTemperature`, méthodes, `baseModelId` ;
 *   2. `reference` — RÉFÉRENCES DOCUMENTÉES ci-dessous, versionnées dans le
 *                    code (guide officiel « Gemini thinking » [G2]) : mode et
 *                    niveaux de raisonnement, correspondance des niveaux
 *                    administrés, famille (profil de température, décision 09) ;
 *   3. `probe`     — sondes de qualification (`model-qualification.service`) :
 *                    entrée image acceptée, schéma JSON accepté, paramètres
 *                    explicitement REFUSÉS par le modèle (incident 4694, R45).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * AUCUNE DÉDUCTION PAR LE NOM DU MODÈLE
 *
 * Une référence documentée est retrouvée par IDENTIFIANT EXACT (ou par le
 * `baseModelId` rendu par Google) — jamais par motif, préfixe ou famille
 * devinée. Un modèle sans référence et dont l'API ne dit rien a des
 * capacités INCONNUES : rien n'est inventé (CAT-02 « une capacité inconnue
 * n'est pas implicitement favorable », CAT-03 « une nouvelle interface non
 * gérée reste en attente d'adaptation »). Le test L85C-U03 échoue si un nom
 * de modèle est interprété.
 *
 * Module PUR, à l'exception du petit registre en mémoire (`capabilitiesOf`),
 * alimenté par `model-capabilities.repository.ts` (lecture bornée, cache).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createHash } from 'node:crypto';

/** Version des références documentées : la changer modifie les fiches → requalification marquée au passage suivant. */
export const CAPABILITY_REFERENCES_VERSION = 'capabilities-ref-2026-10-23' as const;

/** Date de consultation des références officielles [G2] reprises ci-dessous. */
const REF_VERIFIED_AT = '2026-10-21';
const REF_SOURCE = 'Google AI for Developers — « Gemini thinking » [G2], consulté le 21/10/2026 ; valeurs en service depuis le lot 52B';

type CapabilitySource = 'api' | 'reference' | 'probe';

export interface FieldSource {
  source: CapabilitySource;
  /** AAAA-MM-JJ ou ISO : date de la vérification qui fonde la valeur. */
  verifiedAt: string | null;
  /** Référence lisible (document, sonde, méthode d'API). */
  ref?: string | null;
}

/** Niveaux administrés (BO) qui se projettent sur un réglage du modèle. */
type AdministeredReasoning = 'minimal' | 'étendu';

/** Raisonnement d'un modèle. */
export type ThinkingCapability =
  /** Niveau nommé (`thinkingConfig.thinkingLevel`). */
  | { mode: 'level'; levels: readonly string[]; map: Readonly<Record<AdministeredReasoning, string>> }
  /** Budget en jetons (`thinkingConfig.thinkingBudget`). */
  | { mode: 'budget'; min: number; max: number; map: Readonly<Record<AdministeredReasoning, number>> }
  /** Le modèle ne raisonne pas : aucun réglage n'est accepté. */
  | { mode: 'none' }
  /** Interface inconnue (raisonnement annoncé, réglage non documenté) : aucun réglage n'est inventé. */
  | { mode: 'unknown' };

export interface TemperatureCapability {
  /** `null` : inconnu. */
  accepted: boolean | null;
  min: number | null;
  max: number | null;
  /** Défaut du fournisseur (API). */
  providerDefault: number | null;
}

export interface ModelCapabilities {
  model: string;
  /** Famille DOCUMENTÉE (référence), jamais déduite du nom ; `null` : inconnue. */
  family: string | null;
  thinking: ThinkingCapability;
  temperature: TemperatureCapability;
  /** Limite de sortie du modèle (jetons) ; `null` : inconnue. */
  outputTokenLimit: number | null;
  inputTokenLimit: number | null;
  /** Modalités établies par les sondes (`null` : non établies). */
  modalities: { imageInput: boolean | null; structuredOutput: boolean | null };
  /** Paramètres refusés constatés (sonde) : `chemin=valeur`. */
  rejected: readonly string[];
  /** Provenance de chaque champ. */
  sources: Partial<Record<CapabilityField, FieldSource>>;
}

export type CapabilityField = 'family' | 'thinking' | 'temperature' | 'outputTokenLimit' | 'inputTokenLimit' | 'imageInput' | 'structuredOutput' | 'rejected';

/** Référence documentée d'un modèle (identifiant EXACT). */
interface ModelReference {
  model: string;
  family: string;
  thinking: ThinkingCapability;
  /** Température acceptée et bornes documentées. */
  temperature?: { min: number; max: number };
  outputTokenLimit?: number;
  inputTokenLimit?: number;
  source: string;
  verifiedAt: string;
}

const LEVEL_LOW_HIGH: ThinkingCapability = { mode: 'level', levels: ['low', 'high'], map: { minimal: 'low', 'étendu': 'high' } };
const BUDGET_FLASH: ThinkingCapability = { mode: 'budget', min: 0, max: 24_576, map: { minimal: 0, 'étendu': 24_576 } };
const BUDGET_PRO: ThinkingCapability = { mode: 'budget', min: 128, max: 32_768, map: { minimal: 128, 'étendu': 32_768 } };
const TEMP_0_2 = { min: 0, max: 2 } as const;

/**
 * Références documentées, par identifiant EXACT. Reprennent à l'identique les
 * réglages réellement transmis depuis le lot 52B (aucun changement de
 * comportement des modèles en service) ; à revoir avec l'équipe IA sur la
 * page [G2] en vigueur — tout changement ici est une évolution de code,
 * détectée au passage suivant du catalogue et marquant la requalification.
 */
const MODEL_REFERENCES: readonly ModelReference[] = [
  { model: 'gemini-3.6-flash', family: 'gemini-3', thinking: LEVEL_LOW_HIGH, temperature: TEMP_0_2, source: REF_SOURCE, verifiedAt: REF_VERIFIED_AT },
  { model: 'gemini-3.5-flash', family: 'gemini-3', thinking: LEVEL_LOW_HIGH, temperature: TEMP_0_2, source: REF_SOURCE, verifiedAt: REF_VERIFIED_AT },
  { model: 'gemini-3.5-flash-lite', family: 'gemini-3', thinking: LEVEL_LOW_HIGH, temperature: TEMP_0_2, source: REF_SOURCE, verifiedAt: REF_VERIFIED_AT },
  { model: 'gemini-3.1-flash-lite', family: 'gemini-3', thinking: LEVEL_LOW_HIGH, temperature: TEMP_0_2, source: REF_SOURCE, verifiedAt: REF_VERIFIED_AT },
  { model: 'gemini-3-flash-preview', family: 'gemini-3', thinking: LEVEL_LOW_HIGH, temperature: TEMP_0_2, source: REF_SOURCE, verifiedAt: REF_VERIFIED_AT },
  { model: 'gemini-3.1-pro-preview', family: 'gemini-3', thinking: LEVEL_LOW_HIGH, temperature: TEMP_0_2, source: REF_SOURCE, verifiedAt: REF_VERIFIED_AT },
  { model: 'gemini-2.5-pro', family: 'gemini-2.5', thinking: BUDGET_PRO, temperature: TEMP_0_2, outputTokenLimit: 65_536, inputTokenLimit: 1_048_576, source: REF_SOURCE, verifiedAt: REF_VERIFIED_AT },
  { model: 'gemini-2.5-flash', family: 'gemini-2.5', thinking: BUDGET_FLASH, temperature: TEMP_0_2, outputTokenLimit: 65_536, inputTokenLimit: 1_048_576, source: REF_SOURCE, verifiedAt: REF_VERIFIED_AT },
  { model: 'gemini-2.5-flash-lite', family: 'gemini-2.5', thinking: BUDGET_FLASH, temperature: TEMP_0_2, outputTokenLimit: 65_536, inputTokenLimit: 1_048_576, source: REF_SOURCE, verifiedAt: REF_VERIFIED_AT },
];

const REF_BY_MODEL = new Map(MODEL_REFERENCES.map((r) => [r.model, r]));

/**
 * Profil de TEMPÉRATURE par famille (décision PO 09) — jamais saisi au BO.
 * `0` privilégié lorsqu'il est pris en charge : c'est la valeur transmise à
 * tous les modèles depuis GEN-011, conservée telle quelle (aucune activation
 * d'une autre valeur sans qualification préalable — P5). Une famille absente
 * d'ici reçoit `0` seulement si l'API déclare une plage qui le contient ;
 * sinon rien n'est transmis (défaut du fournisseur, adaptation tracée).
 */
export const TEMPERATURE_PROFILE_BY_FAMILY: Readonly<Record<string, { value: number; note: string }>> = {
  'gemini-2.5': { value: 0, note: 'GEN-011 — reproductibilité de l’extraction' },
  'gemini-3': { value: 0, note: 'GEN-011 — valeur en service ; toute autre valeur passe par la qualification (décision 09)' },
};

/** Données BRUTES connues d'un modèle hors références (catalogue + sondes), telles que stockées. */
export interface StoredCapabilityInputs {
  model: string;
  /** Métadonnées de l'API Models (`ai_model_catalog`). */
  api?: {
    inputTokenLimit?: number | null;
    outputTokenLimit?: number | null;
    supportsThinking?: boolean | null;
    temperature?: number | null;
    maxTemperature?: number | null;
    baseModelId?: string | null;
    checkedAt?: string | null;
  } | null;
  /** Constats des sondes (qualification). */
  probe?: {
    imageInput?: boolean | null;
    structuredOutput?: boolean | null;
    /** Paramètres refusés (`generationConfig.thinkingConfig.thinkingLevel=low`). */
    rejected?: readonly string[];
    checkedAt?: string | null;
  } | null;
}

/** Référence documentée par identifiant EXACT, puis par `baseModelId` rendu par l'API (jamais par motif). */
function referenceFor(model: string, baseModelId?: string | null): ModelReference | null {
  return REF_BY_MODEL.get(model) ?? (baseModelId ? REF_BY_MODEL.get(baseModelId) ?? null : null);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Fiche de capacités EFFECTIVE (pure, déterministe). Priorités :
 *   · limites : API (relevé vivant), sinon référence ;
 *   · raisonnement : l'API qui déclare `thinking: false` fait foi (aucun
 *     réglage) ; sinon référence ; sinon `unknown` si l'API l'annonce sans
 *     réglage documenté, `unknown` aussi en l'absence de toute information ;
 *   · température : plage de l'API, sinon référence, sinon inconnue ; un
 *     refus constaté par sonde la rend non acceptée ;
 *   · modalités : sondes seules.
 */
export function effectiveCapabilities(model: string, stored?: StoredCapabilityInputs | null): ModelCapabilities {
  const api = stored?.api ?? null;
  const probe = stored?.probe ?? null;
  const ref = referenceFor(model, api?.baseModelId ?? null);
  const sources: ModelCapabilities['sources'] = {};
  const apiSrc: FieldSource = { source: 'api', verifiedAt: api?.checkedAt ?? null, ref: 'GET /v1beta/models' };
  const refSrc: FieldSource | null = ref ? { source: 'reference', verifiedAt: ref.verifiedAt, ref: ref.source } : null;
  const probeSrc: FieldSource = { source: 'probe', verifiedAt: probe?.checkedAt ?? null, ref: 'qualification technique' };

  let family: string | null = null;
  if (ref) { family = ref.family; sources.family = refSrc!; }

  let thinking: ThinkingCapability = { mode: 'unknown' };
  if (api?.supportsThinking === false) { thinking = { mode: 'none' }; sources.thinking = apiSrc; }
  else if (ref) { thinking = ref.thinking; sources.thinking = refSrc!; }
  else if (api?.supportsThinking === true) { thinking = { mode: 'unknown' }; sources.thinking = apiSrc; }

  const rejected = [...new Set(probe?.rejected ?? [])].sort();
  if (rejected.length) sources.rejected = probeSrc;

  let temperature: TemperatureCapability = { accepted: null, min: null, max: null, providerDefault: null };
  const maxT = num(api?.maxTemperature);
  if (maxT !== null) {
    temperature = { accepted: true, min: 0, max: maxT, providerDefault: num(api?.temperature) };
    sources.temperature = apiSrc;
  } else if (ref?.temperature) {
    temperature = { accepted: true, min: ref.temperature.min, max: ref.temperature.max, providerDefault: num(api?.temperature) };
    sources.temperature = refSrc!;
  }
  if (rejected.some((r) => r.split('=')[0] === 'generationConfig.temperature')) {
    temperature = { ...temperature, accepted: false };
    sources.temperature = probeSrc;
  }

  let outputTokenLimit = num(api?.outputTokenLimit);
  if (outputTokenLimit !== null) sources.outputTokenLimit = apiSrc;
  else if (ref?.outputTokenLimit) { outputTokenLimit = ref.outputTokenLimit; sources.outputTokenLimit = refSrc!; }
  let inputTokenLimit = num(api?.inputTokenLimit);
  if (inputTokenLimit !== null) sources.inputTokenLimit = apiSrc;
  else if (ref?.inputTokenLimit) { inputTokenLimit = ref.inputTokenLimit; sources.inputTokenLimit = refSrc!; }

  const imageInput = typeof probe?.imageInput === 'boolean' ? probe.imageInput : null;
  const structuredOutput = typeof probe?.structuredOutput === 'boolean' ? probe.structuredOutput : null;
  if (imageInput !== null) sources.imageInput = probeSrc;
  if (structuredOutput !== null) sources.structuredOutput = probeSrc;

  return { model, family, thinking, temperature, outputTokenLimit, inputTokenLimit, modalities: { imageInput, structuredOutput }, rejected, sources };
}

/** JSON canonique (clés triées). */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/**
 * Partie COMPARABLE d'une fiche : valeurs et nature de leur source, SANS les
 * dates de vérification (une synchronisation qui relit la même chose ne
 * change rien — R46).
 */
function comparableCapabilities(c: ModelCapabilities): Record<string, unknown> {
  const sources: Record<string, string> = {};
  for (const [k, s] of Object.entries(c.sources)) if (s) sources[k] = s.source;
  return {
    family: c.family, thinking: c.thinking, temperature: c.temperature, outputTokenLimit: c.outputTokenLimit,
    inputTokenLimit: c.inputTokenLimit, modalities: c.modalities, rejected: c.rejected, sources,
  };
}

/** Empreinte d'une fiche (comparaison d'un passage à l'autre). */
export function capabilitiesSha256(c: ModelCapabilities): string {
  return createHash('sha256').update(canonical(comparableCapabilities(c)), 'utf8').digest('hex');
}

interface CapabilityChange { field: string; before: unknown; after: unknown }

/** Champs modifiés entre deux fiches (pure). */
export function diffCapabilities(before: ModelCapabilities | Record<string, unknown> | null, after: ModelCapabilities): CapabilityChange[] {
  const a = before ? ('sources' in before && 'thinking' in before && 'modalities' in before ? comparableCapabilities(before as ModelCapabilities) : before as Record<string, unknown>) : {};
  const b = comparableCapabilities(after);
  const out: CapabilityChange[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (canonical(a[k]) !== canonical(b[k])) out.push({ field: k, before: a[k] ?? null, after: b[k] ?? null });
  }
  return out;
}

/** Libellé court du raisonnement (BO). */
export function thinkingLabel(t: ThinkingCapability): string {
  switch (t.mode) {
    case 'level': return `niveaux ${t.levels.join(' / ')} (minimal → ${t.map.minimal}, étendu → ${t.map['étendu']})`;
    case 'budget': return `budget ${t.min}–${t.max} jetons (minimal → ${t.map.minimal}, étendu → ${t.map['étendu']})`;
    case 'none': return 'aucun raisonnement réglable';
    default: return 'inconnu (aucun réglage transmis)';
  }
}

// ── Registre en mémoire (lecture synchrone sur le chemin d'appel) ───────────

let storedInputs: ReadonlyMap<string, StoredCapabilityInputs> = new Map();

/** Remplace les données stockées (chargeur `model-capabilities.repository`, tests). */
export function setStoredCapabilityInputs(m: ReadonlyMap<string, StoredCapabilityInputs>): void {
  storedInputs = m;
}

/** Données stockées d'un modèle (ou `null`). */
export function storedCapabilityInputsOf(model: string): StoredCapabilityInputs | null {
  return storedInputs.get(model) ?? null;
}

/**
 * Fiche effective d'un modèle, à partir des références du code et des
 * dernières données chargées (catalogue, sondes). Synchrone : utilisée par
 * le constructeur de requête unique (validation, qualification, exécution).
 */
export function capabilitiesOf(model: string): ModelCapabilities {
  return effectiveCapabilities(model, storedInputs.get(model) ?? null);
}

/** Modèles connus du registre (références + données chargées), triés. */
export function knownCapabilityModels(): string[] {
  return [...new Set([...MODEL_REFERENCES.map((r) => r.model), ...storedInputs.keys()])].sort();
}
