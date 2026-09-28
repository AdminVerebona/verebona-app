/**
 * Registre des modèles de l'assistant — CDC §15.11, §15.12, §15.13, §25.6, §43.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LE MÉTIER NE NOMME QUE DES ALIAS
 *
 * L'alias était DÉDUIT à la trace (`fallbackUsed ? 'assistant-escalation' :
 * 'assistant-default'`) : rien ne le configurait, et rien ne disait quel
 * modèle on ATTENDAIT derrière. Désormais :
 *
 *   · les noms d'alias viennent de la configuration (§43) :
 *       VEREBONA_ASSISTANT_DEFAULT_MODEL_ALIAS     (défaut assistant-default)
 *       VEREBONA_ASSISTANT_ESCALATION_MODEL_ALIAS  (défaut assistant-escalation)
 *   · le modèle ATTENDU par alias est celui de la chaîne EFFECTIVE au moment
 *     de l'appel (configuration versionnée du BO) ; à défaut seulement,
 *       VEREBONA_ASSISTANT_MODEL_ASSISTANT_DEFAULT
 *       VEREBONA_ASSISTANT_MODEL_ASSISTANT_ESCALATION
 *     puis le référentiel des opérations (`AI_OPERATIONS`) ;
 *   · l'alias est résolu en modèle AU MOMENT DE L'APPEL, par la chaîne
 *     effective de la passerelle (configuration versionnée du BO, sinon
 *     code) : rang 0 = alias par défaut, rang 1 = alias d'escalade.
 *
 * Chaque appel trace l'alias, le modèle attendu et le modèle réellement
 * appelé (`verebona_ai_runs.expected_model_id`, migration 0204) : l'alerte
 * « modèle résolu différent du modèle attendu » (§31.3) les compare.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { AI_OPERATIONS } from '@/services/ai/registry/operations';

export type ModelAliasRole = 'default' | 'escalation';

/** Version du registre (tracée avec les contrôles de démarrage). */
export const MODEL_REGISTRY_VERSION = 'model-registry-v1.0' as const;

export interface ModelAliasEntry {
  role: ModelAliasRole;
  /** Nom fonctionnel configuré (§15.11). */
  alias: string;
  /** Rang dans la chaîne de la passerelle : 0 = principal, 1 = premier repli. */
  rank: 0 | 1;
  /** Modèle attendu derrière l'alias (configuration §43, sinon référentiel). */
  expectedModel: string | null;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v.trim() !== '' ? v.trim() : undefined;
}

/** Alias configurés (§15.11, §43), relus à chaque appel (aucun cache). */
export function configuredAliases(): Record<ModelAliasRole, string> {
  return {
    default: env('VEREBONA_ASSISTANT_DEFAULT_MODEL_ALIAS') ?? 'assistant-default',
    escalation: env('VEREBONA_ASSISTANT_ESCALATION_MODEL_ALIAS') ?? 'assistant-escalation',
  };
}

/** Modèle attendu pour un rôle et une opération. */
export function expectedModelFor(role: ModelAliasRole, operationCode = 'generate_answer'): string | null {
  const surcharge = env(role === 'default' ? 'VEREBONA_ASSISTANT_MODEL_ASSISTANT_DEFAULT' : 'VEREBONA_ASSISTANT_MODEL_ASSISTANT_ESCALATION');
  if (surcharge) return surcharge;
  const op = AI_OPERATIONS[operationCode];
  if (!op) return null;
  return role === 'default' ? op.primaryModel : (op.fallbackModels[0] ?? null);
}

/**
 * Entrée du registre pour un rang d'appel (0 = défaut, ≥ 1 = escalade).
 *
 * `chaine` : chaîne EFFECTIVE résolue au moment de l'appel (version de
 * configuration du BO, sinon code — `resolveAliases`). Le modèle attendu en
 * vient : après un changement de modèle dans le BO, l'attendu suit, et
 * l'alerte « modèle résolu ≠ attendu » (§31.3) ne signale que les écarts
 * réels (repli imprévu, configuration non appliquée). Sans chaîne résolue :
 * configuration §43, puis référentiel du code.
 */
export function aliasForRank(rank: number, operationCode = 'generate_answer', chaine?: ResolvedAliases | null): ModelAliasEntry {
  const role: ModelAliasRole = rank > 0 ? 'escalation' : 'default';
  const effectif = chaine ? (role === 'default' ? chaine.default : chaine.escalation) : null;
  return {
    role,
    alias: configuredAliases()[role],
    rank: rank > 0 ? 1 : 0,
    expectedModel: effectif ?? expectedModelFor(role, operationCode),
  };
}

/** Registre complet d'une opération (administration, contrôle de démarrage). */
export function modelRegistry(operationCode = 'generate_answer'): ModelAliasEntry[] {
  return [aliasForRank(0, operationCode), aliasForRank(1, operationCode)];
}

/** Modèles résolus pour une opération à un instant donné (chaîne effective). */
export interface ResolvedAliases {
  operationCode: string;
  default: string | null;
  escalation: string | null;
}

/**
 * Résout les alias d'une opération par la chaîne EFFECTIVE de la passerelle
 * (configuration versionnée du BO, sinon référentiel du code). Ne lève pas :
 * une configuration illisible retombe sur le code, comme la passerelle.
 */
export async function resolveAliases(
  operationCode: string,
  resolver?: (op: string) => Promise<{ primaryModel: string; fallbackModels: string[] }>,
): Promise<ResolvedAliases> {
  const resoudre = resolver ?? (async (op: string) => (await import('@/services/ai/config/config-resolver')).resolveOperationConfig(op));
  try {
    const c = await resoudre(operationCode);
    return { operationCode, default: c.primaryModel || null, escalation: c.fallbackModels[0] ?? null };
  } catch {
    const op = AI_OPERATIONS[operationCode];
    return { operationCode, default: op?.primaryModel ?? null, escalation: op?.fallbackModels[0] ?? null };
  }
}

/**
 * Statut stable / preview d'un modèle (§15.12) : un identifiant qui annonce
 * `preview`, `exp` ou `experimental` n'est pas un modèle stable.
 */
export function isPreviewModel(model: string): boolean {
  return /(preview|-exp\b|experimental)/i.test(model);
}

/**
 * Dates de fin annoncées (§15.13) saisies en configuration, au format
 * `modele=AAAA-MM-JJ,modele2=AAAA-MM-JJ`
 * (`VEREBONA_ASSISTANT_MODEL_DEPRECATIONS`). Complète la colonne
 * `ai_model_catalog.deprecation_date` (migration 0204).
 */
export function configuredDeprecations(raw = process.env.VEREBONA_ASSISTANT_MODEL_DEPRECATIONS): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of String(raw ?? '').split(',')) {
    const m = part.trim().match(/^([A-Za-z0-9._-]+)=(\d{4}-\d{2}-\d{2})$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}
