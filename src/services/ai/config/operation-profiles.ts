/**
 * Profils PAR OPÉRATION ET PAR RANG — lot 85C (CDC Pilotage IA V2, phase P4 :
 * CFG-01, CFG-02, OP-03, INV-04, INV-07, R03, R35 ; décisions PO 08 et 09).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * RÉFÉRENCE PAR TRAITEMENT, ADAPTATION PAR OPÉRATION (CFG-01)
 *
 * Chaque traitement garde sa configuration de référence (modèles, niveaux de
 * raisonnement par rang, plafond de sortie). Une opération PEUT s'en écarter,
 * sans champ administrable superflu, dans la ligne versionnée existante
 * (`ai_config_entries.operation_profiles`, instantané des révisions
 * `ai_config_revisions`) — aucune table ni version parallèle :
 *   · raisonnement par rang (principal, repli 1, repli 2) ;
 *   · plafond de sortie PAR RANG (décision 08) — un repli ne copie plus
 *     aveuglément le plafond du principal ;
 *   · délai propre à l'opération (borné par le plafond déclaré du registre).
 * La température n'est JAMAIS un champ : profil technique par famille de
 * modèles (décision 09, `TEMPERATURE_PROFILE_BY_FAMILY`).
 *
 * L'héritage est explicite : valeur absente (`null`) = valeur de référence
 * du traitement ; la résolution (pure, `rankProfile`) dit d'où vient chaque
 * valeur. Les tableaux sont indexés par EMPLACEMENT administré (0 principal,
 * 1 repli 1, 2 repli 2) ; le résolveur les ramène au rang effectif dans la
 * chaîne, comme les niveaux de raisonnement du traitement.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AI_OPERATIONS, type AiOperationDefinition } from '../registry/operations';
import { TREATMENT_DEFINITIONS, isTechnicalUseCase, treatmentOfUseCase, type Treatment } from './treatments';
import { REASONING_LEVELS, type ReasoningLevel } from './config-types';
import type { OutputCapOrigin } from '../gateway/request-builder';

/** Délai minimal d'un profil (ms) : en deçà, aucun appel utile n'aboutit. */
export const PROFILE_MIN_TIMEOUT_MS = 1_000;
/** Nombre d'emplacements de la chaîne (principal + 2 replis). */
export const PROFILE_SLOTS = 3;

export interface OperationProfile {
  /** Niveau par emplacement ; `null` : niveau du traitement. */
  reasoningByRank?: Array<ReasoningLevel | null>;
  /** Plafond de sortie par emplacement ; `null` : hérité. */
  maxOutputTokensByRank?: Array<number | null>;
  /** Délai de l'opération (ms) ; `null` : plafond du registre. */
  timeoutMs?: number | null;
}

export type OperationProfiles = Record<string, OperationProfile>;

/** Opérations MODÈLE (non déterministes, actives) d'un traitement, ordre du registre. */
export function profiledOperationsOf(
  treatment: Treatment,
  operations: Readonly<Record<string, AiOperationDefinition | undefined>> = AI_OPERATIONS,
): AiOperationDefinition[] {
  const useCase = TREATMENT_DEFINITIONS[treatment].useCaseCode;
  return Object.values(operations).filter((o): o is AiOperationDefinition => Boolean(o) && o!.useCaseCode === useCase && o!.provider !== 'none' && o!.active);
}

const level = (v: unknown): ReasoningLevel | null =>
  typeof v === 'string' && (REASONING_LEVELS as readonly string[]).includes(v) ? (v as ReasoningLevel) : null;
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : null);

/** Tableau d'emplacements normalisé (3 cases, `null` en fin retirés). */
function slots<T>(raw: unknown, read: (v: unknown) => T | null): Array<T | null> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = Array.from({ length: PROFILE_SLOTS }, (_, i) => read(raw[i]));
  while (out.length && out[out.length - 1] === null) out.pop();
  return out.length ? out : undefined;
}

/**
 * Forme canonique (pure) : opérations connues du registre seulement, clés
 * triées, profils vides retirés. Rien n'est inventé pour une opération sans
 * profil.
 */
export function normalizeOperationProfiles(raw: unknown): OperationProfiles {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: OperationProfiles = {};
  for (const code of Object.keys(raw as object).sort()) {
    const op = AI_OPERATIONS[code];
    if (!op || op.provider === 'none') continue;
    const p = (raw as Record<string, unknown>)[code] as Record<string, unknown> | null;
    if (!p || typeof p !== 'object') continue;
    const reasoningByRank = slots(p.reasoningByRank, level);
    const maxOutputTokensByRank = slots(p.maxOutputTokensByRank, posInt);
    const timeoutMs = posInt(p.timeoutMs);
    const prof: OperationProfile = {
      ...(reasoningByRank ? { reasoningByRank } : {}),
      ...(maxOutputTokensByRank ? { maxOutputTokensByRank } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    if (Object.keys(prof).length) out[code] = prof;
  }
  return out;
}

export interface ProfileIssue { operationCode: string; field: 'operation' | 'reasoningByRank' | 'maxOutputTokensByRank' | 'timeoutMs'; message: string }

/**
 * Contrôles STRUCTURELS d'un profil saisi (pur) : opération du traitement,
 * niveaux de la liste fermée, entiers positifs, délai borné par le registre.
 * La compatibilité avec les MODÈLES est contrôlée par le constructeur de
 * requête unique (`config-validation.service`).
 */
export function validateOperationProfiles(treatment: Treatment, raw: unknown): ProfileIssue[] {
  if (raw == null) return [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return [{ operationCode: '*', field: 'operation', message: 'Profils par opération illisibles.' }];
  const own = new Set(profiledOperationsOf(treatment).map((o) => o.operationCode));
  const out: ProfileIssue[] = [];
  for (const [code, p] of Object.entries(raw as Record<string, unknown>)) {
    if (!own.has(code)) { out.push({ operationCode: code, field: 'operation', message: `« ${code} » n’est pas une opération modèle de ${treatment}.` }); continue; }
    const prof = (p ?? {}) as Record<string, unknown>;
    const op = AI_OPERATIONS[code];
    if (prof.reasoningByRank !== undefined) {
      const arr = prof.reasoningByRank;
      if (!Array.isArray(arr) || arr.length > PROFILE_SLOTS || arr.some((v) => v !== null && level(v) === null)) {
        out.push({ operationCode: code, field: 'reasoningByRank', message: `Niveaux de raisonnement invalides (valeurs admises : ${REASONING_LEVELS.join(', ')}).` });
      }
    }
    if (prof.maxOutputTokensByRank !== undefined) {
      const arr = prof.maxOutputTokensByRank;
      if (!Array.isArray(arr) || arr.length > PROFILE_SLOTS || arr.some((v) => v !== null && posInt(v) === null)) {
        out.push({ operationCode: code, field: 'maxOutputTokensByRank', message: 'Plafonds de sortie invalides : entiers strictement positifs attendus.' });
      }
    }
    if (prof.timeoutMs !== undefined && prof.timeoutMs !== null) {
      const t = posInt(prof.timeoutMs);
      if (t === null || t < PROFILE_MIN_TIMEOUT_MS || t > op.timeoutMs) {
        out.push({ operationCode: code, field: 'timeoutMs', message: `Délai hors bornes : entre ${PROFILE_MIN_TIMEOUT_MS} et ${op.timeoutMs} ms (plafond déclaré du registre).` });
      }
    }
  }
  return out;
}

/**
 * Profil d'une opération ramené aux RANGS de la chaîne effective : un
 * emplacement vide (repli 1 absent) décale les suivants, comme les niveaux
 * de raisonnement du traitement (`config-resolver`).
 */
export function profileForChain(p: OperationProfile | undefined, presentSlots: readonly boolean[]): OperationProfile | undefined {
  if (!p) return undefined;
  const pick = <T>(arr: Array<T | null> | undefined) => (arr ? presentSlots.map((ok, i) => (ok ? arr[i] ?? null : undefined)).filter((v) => v !== undefined) as Array<T | null> : undefined);
  return {
    ...(p.reasoningByRank ? { reasoningByRank: pick(p.reasoningByRank) } : {}),
    ...(p.maxOutputTokensByRank ? { maxOutputTokensByRank: pick(p.maxOutputTokensByRank) } : {}),
    ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}),
  };
}

/** Réglage RÉSOLU d'un rang (avant adaptation aux capacités du modèle). */
export interface RankProfile {
  reasoning: ReasoningLevel | null;
  reasoningOrigin: 'operation' | 'treatment' | 'none';
  maxOutputTokens: number | null;
  maxOutputTokensOrigin: OutputCapOrigin;
  timeoutMs: number;
  timeoutOrigin: 'operation' | 'registry';
}

/** Sous-ensemble de la configuration résolue utile au profil d'un rang. */
export interface RankConfigInput {
  reasoningByRank?: ReadonlyArray<string | null | undefined> | null;
  maxOutputTokens?: number | null;
  configVersionId?: number | null;
  /** Profil de l'opération, déjà ramené aux rangs de la chaîne. */
  operationProfile?: OperationProfile | null;
}

/**
 * Réglage d'un rang (pur) : profil de l'opération pour ce rang, sinon —
 * pour le plafond — profil de l'opération au rang principal, sinon référence
 * du traitement (ou valeur initiale du code). Le plancher de l'opération, le
 * plafond d'appelant et la limite du modèle sont appliqués ensuite par le
 * constructeur de requête.
 */
export function rankProfile(op: Pick<AiOperationDefinition, 'timeoutMs'>, cfg: RankConfigInput, rank: number): RankProfile {
  const p = cfg.operationProfile ?? undefined;
  const opLevel = level(p?.reasoningByRank?.[rank] ?? null);
  const trLevel = level(cfg.reasoningByRank?.[rank] ?? null);
  const reasoning = opLevel ?? trLevel;
  const rankCap = posInt(p?.maxOutputTokensByRank?.[rank] ?? null);
  const opCap = posInt(p?.maxOutputTokensByRank?.[0] ?? null);
  const trCap = posInt(cfg.maxOutputTokens ?? null);
  const maxOutputTokens = rankCap ?? opCap ?? trCap;
  const maxOutputTokensOrigin: OutputCapOrigin = rankCap ? (rank === 0 ? 'operation' : 'operation_rank')
    : opCap ? 'operation' : trCap ? (cfg.configVersionId != null ? 'treatment' : 'code') : 'none';
  const t = posInt(p?.timeoutMs ?? null);
  return {
    reasoning, reasoningOrigin: opLevel ? 'operation' : trLevel ? 'treatment' : 'none',
    maxOutputTokens, maxOutputTokensOrigin,
    timeoutMs: t ? Math.min(t, op.timeoutMs) : op.timeoutMs, timeoutOrigin: t ? 'operation' : 'registry',
  };
}

/**
 * Couverture des opérations MODÈLE du registre (R33, OP-01) — générée du
 * registre lui-même, jamais d'une liste recopiée :
 *   · `business` : opération d'un traitement T1–T6 → profil résolu par
 *     `rankProfile` (référence du traitement, adaptation facultative) ;
 *   · `technical` : usage technique (`AI_GOVERNANCE`, ex. `evaluate_prompt`,
 *     décision PO 03) — même constructeur de requête, hors qualification
 *     métier et hors des 14 opérations de référence ;
 *   · `uncovered` : opération modèle rattachée à rien → la recette échoue.
 */
export function operationProfileCoverage(
  operations: Readonly<Record<string, AiOperationDefinition | undefined>> = AI_OPERATIONS,
): { business: Array<{ operationCode: string; treatment: Treatment }>; technical: string[]; uncovered: string[] } {
  const out = { business: [] as Array<{ operationCode: string; treatment: Treatment }>, technical: [] as string[], uncovered: [] as string[] };
  for (const op of Object.values(operations)) {
    if (!op || op.provider === 'none' || !op.active) continue;
    if (isTechnicalUseCase(op.useCaseCode)) { out.technical.push(op.operationCode); continue; }
    let t: Treatment | null = null;
    try { t = treatmentOfUseCase(op.useCaseCode); } catch { t = null; }
    if (t && profiledOperationsOf(t, operations).some((o) => o.operationCode === op.operationCode)) out.business.push({ operationCode: op.operationCode, treatment: t });
    else out.uncovered.push(op.operationCode);
  }
  return out;
}

/** Résumé texte d'un profil (diff, journaux). */
export function renderOperationProfile(p: OperationProfile | undefined): string | null {
  if (!p) return null;
  const parts: string[] = [];
  if (p.reasoningByRank?.length) parts.push(`raisonnement ${p.reasoningByRank.map((v) => v ?? 'hérité').join(' / ')}`);
  if (p.maxOutputTokensByRank?.length) parts.push(`sortie ${p.maxOutputTokensByRank.map((v) => v ?? 'hérité').join(' / ')}`);
  if (p.timeoutMs) parts.push(`délai ${p.timeoutMs} ms`);
  return parts.length ? parts.join(' · ') : null;
}
