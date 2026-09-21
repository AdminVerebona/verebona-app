/**
 * Configuration effective d'une opération — CDC BO IA GEN-001, §2.1, §11.2.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CE QUI MANQUAIT
 *
 * Le Back-Office écrivait une configuration que rien ne lisait. Un
 * administrateur pouvait créer une version, la valider, l'activer — et le
 * comportement de l'IA ne changeait pas d'un iota, la passerelle continuant de
 * lire `registry/operations.ts`.
 *
 * Ce module fait le pont. Il est le seul endroit où la configuration versionnée
 * rencontre le code.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * UN PROMPT MAÎTRE PAR TRAITEMENT, DES PROMPTS TECHNIQUES PAR OPÉRATION
 *
 * Le BO donne UN prompt par traitement (T1-013, T3-007, T4-010 : « prompt
 * maître unique, les segmentations techniques restant dans le code »). Le
 * référentiel, lui, a plusieurs opérations par traitement — l'assistant en a
 * deux, l'une qui classe une intention, l'autre qui rédige une réponse.
 *
 * Le prompt du BO est donc un PRÉAMBULE, placé devant le prompt technique de
 * chaque opération du traitement. L'administrateur écrit le cadre commun —
 * monde fermé, ton, garde-fous, ce que le SCR-03 appelle le « socle commun » —
 * et le code garde les instructions de format propres à chaque opération.
 *
 * Cette frontière n'est pas cosmétique. Le 18/09/2026, la classification de
 * l'assistant échouait parce qu'un prompt stocké et un schéma défini dans le
 * code décrivaient deux formats différents. Laisser le contrat de sortie hors
 * de portée du BO est ce qui permet de vérifier leur accord automatiquement.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * LA CONFIGURATION NE DOIT JAMAIS FAIRE ÉCHOUER UN APPEL
 *
 * Toute erreur de lecture rend la configuration du code. Une base lente, une
 * table absente, une version incohérente : le traitement continue avec ce qu'il
 * faisait avant. Une console d'administration ne doit pas pouvoir casser le
 * produit qu'elle administre.
 *
 * La lecture est bornée et mise en cache pour la même raison qu'en télémétrie :
 * sans borne, elle attend la base sur le chemin d'appel.
 */
import { getOperation, type AiOperationDefinition } from '../registry/operations';
import { treatmentForUseCase } from './treatments';
import type { TreatmentConfig } from './config-types';

/** Configuration réellement appliquée à un appel. */
export interface ResolvedOperationConfig {
  primaryModel: string;
  fallbackModels: string[];
  maxOutputTokens: number | null;
  reasoningPrimary: string | null;
  /** Préambule administrable, à placer devant le prompt technique. */
  promptPreamble: string | null;
  /** Version dont vient cette configuration. `null` = configuration du code. */
  configVersionId: number | null;
  visibleNumber: number | null;
}

const CACHE_TTL_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 1_500;

let cache: {
  expiresAt: number;
  versionId: number | null;
  visibleNumber: number | null;
  byTreatment: Map<string, TreatmentConfig>;
} | null = null;

/** Vidé à chaque bascule d'Active, pour qu'une activation prenne effet tout de suite. */
export function invalidateConfigCache(): void {
  cache = null;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.()),
  ]);
}

async function loadEffective(): Promise<NonNullable<typeof cache>> {
  if (cache && cache.expiresAt > Date.now()) return cache;

  const vide = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    versionId: null,
    visibleNumber: null,
    byTreatment: new Map<string, TreatmentConfig>(),
  };

  if (process.env.NODE_ENV === 'test') {
    cache = vide;
    return cache;
  }

  try {
    const { getEffectiveVersion } = await import('./config-version.repository');
    const version = await withTimeout(getEffectiveVersion(), LOOKUP_TIMEOUT_MS, null);
    cache = version
      ? {
        expiresAt: Date.now() + CACHE_TTL_MS,
        versionId: version.id,
        visibleNumber: version.visibleNumber,
        byTreatment: new Map(version.entries.map((e) => [e.treatment, e])),
      }
      : vide;
  } catch {
    // Tables absentes, base indisponible, environnement illisible : on retombe
    // sur le code. Le produit continue de fonctionner comme avant le BO.
    cache = vide;
  }
  return cache;
}

/**
 * Configuration à appliquer pour une opération.
 *
 * Champ par champ : une valeur absente de la version laisse celle du code. Une
 * version dont le modèle principal n'est pas renseigné ne doit pas priver
 * l'opération du sien — le contrôle de promotion l'aurait refusée, mais une
 * version importée d'un environnement plus permissif pourrait passer.
 */
export async function resolveOperationConfig(
  operationCode: string,
): Promise<ResolvedOperationConfig> {
  const op: AiOperationDefinition = getOperation(operationCode);
  const duCode: ResolvedOperationConfig = {
    primaryModel: op.primaryModel,
    fallbackModels: [...op.fallbackModels],
    maxOutputTokens: null,
    reasoningPrimary: null,
    promptPreamble: null,
    configVersionId: null,
    visibleNumber: null,
  };

  const effective = await loadEffective();
  if (effective.versionId === null) return duCode;

  let treatment: string;
  try {
    treatment = treatmentForUseCase(op.useCaseCode);
  } catch {
    // Usage hors correspondance : le code fait foi, sans bruit.
    return duCode;
  }

  const entry = effective.byTreatment.get(treatment);
  if (!entry) return duCode;

  const fallbacks = [entry.fallback1, entry.fallback2].filter(
    (m): m is string => Boolean(m),
  );

  return {
    primaryModel: entry.primaryModel ?? duCode.primaryModel,
    // Une version qui ne déclare aucun repli en supprime : c'est une décision
    // d'administration, pas une valeur manquante. Le principal, lui, ne peut
    // pas être vide sans laisser l'opération sans modèle du tout.
    fallbackModels: entry.primaryModel ? fallbacks : duCode.fallbackModels,
    maxOutputTokens: entry.maxOutputTokens,
    reasoningPrimary: entry.reasoningPrimary,
    promptPreamble: entry.prompt.trim() === '' ? null : entry.prompt,
    configVersionId: effective.versionId,
    visibleNumber: effective.visibleNumber,
  };
}

/**
 * Assemble préambule administrable et prompt technique.
 *
 * Le préambule vient EN PREMIER : il pose le cadre, le prompt technique donne
 * le format et doit rester la dernière instruction lue. L'inverse laisserait un
 * préambule mal rédigé contredire le contrat de sortie — et c'est le contrat
 * que valide le serveur.
 */
export function composePrompt(preamble: string | null, technical: string): string {
  if (!preamble) return technical;
  return `${preamble.trim()}\n\n${technical}`;
}
