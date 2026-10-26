/**
 * Plan de requêtes d'une configuration — lot 85C (CDC Pilotage IA V2 P4 :
 * CFG-03, R03, R33, R35).
 *
 * Pour une ligne de configuration (traitement) et chacune de ses opérations
 * modèle, construit la requête de CHAQUE rang de la chaîne exactement comme
 * l'exécution : même résolution des réglages (`rankProfile` — profil
 * d'opération, sinon référence du traitement) et même constructeur
 * (`buildModelRequest`, d'après les capacités du modèle). Sert :
 *   · à la validation de configuration (refus connus → bloquants ;
 *     adaptations → signalées) ;
 *   · à l'affichage des profils effectifs au BO ;
 *   · aux tests d'identité validation / exécution (L85C-E04).
 * Pur (capacités injectables).
 */
import type { AiOperationDefinition } from '../registry/operations';
import type { TreatmentConfig } from './config-types';
import { profileForChain, profiledOperationsOf, rankProfile, normalizeOperationProfiles, type RankProfile } from './operation-profiles';
import { buildModelRequest, type ModelRequestResult } from '../gateway/request-builder';
import type { ModelCapabilities } from '../provider/model-capabilities';

interface RankPlan {
  operationCode: string;
  rank: number;
  /** Emplacement administré (`primaryModel`, `fallback1`, `fallback2`). */
  slot: 'primaryModel' | 'fallback1' | 'fallback2';
  model: string;
  profile: RankProfile;
  result: ModelRequestResult;
}

/** Chaîne effective d'une ligne : emplacements renseignés, dans l'ordre. */
function chainOf(entry: Pick<TreatmentConfig, 'primaryModel' | 'fallback1' | 'fallback2'>): Array<{ slot: RankPlan['slot']; model: string }> {
  return ([['primaryModel', entry.primaryModel], ['fallback1', entry.fallback1], ['fallback2', entry.fallback2]] as const)
    .filter(([, m]) => Boolean(m))
    .map(([slot, m]) => ({ slot, model: m as string }));
}

/** Requêtes de tous les rangs d'UNE opération pour une ligne de configuration. */
export function operationRequestPlan(
  entry: TreatmentConfig,
  op: AiOperationDefinition,
  opts: { capabilities?: (model: string) => ModelCapabilities; callerCap?: number | null } = {},
): RankPlan[] {
  if (!entry.primaryModel) return [];
  const chaine = chainOf(entry);
  const reasoningByRank = [entry.reasoningPrimary ?? null, ...([[entry.fallback1, entry.reasoningFallback1], [entry.fallback2, entry.reasoningFallback2]] as const)
    .filter(([m]) => Boolean(m)).map(([, r]) => r ?? null)];
  const operationProfile = profileForChain(normalizeOperationProfiles(entry.operationProfiles)[op.operationCode], [true, Boolean(entry.fallback1), Boolean(entry.fallback2)]) ?? null;
  const cfg = {
    reasoningByRank, operationProfile, configVersionId: 1,
    maxOutputTokens: entry.maxOutputTokens ?? op.defaultMaxOutputTokens ?? null,
  };
  return chaine.map(({ slot, model }, rank) => {
    const profile = rankProfile(op, cfg, rank);
    const result = buildModelRequest({
      model, ...(opts.capabilities ? { capabilities: opts.capabilities(model) } : {}),
      reasoning: profile.reasoning, maxOutputTokens: profile.maxOutputTokens, maxOutputTokensOrigin: profile.maxOutputTokensOrigin,
      minOutputTokens: op.minOutputTokens ?? null, callerCap: opts.callerCap ?? null,
      needsImageInput: (op.requiredCapabilities ?? []).includes('multimodal'),
    });
    return { operationCode: op.operationCode, rank, slot, model, profile, result };
  });
}

/** Plan complet d'une ligne : toutes les opérations modèle du traitement. */
export function treatmentRequestPlan(
  entry: TreatmentConfig,
  opts: { capabilities?: (model: string) => ModelCapabilities } = {},
): RankPlan[] {
  return profiledOperationsOf(entry.treatment).flatMap((op) => operationRequestPlan(entry, op, opts));
}
