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
import { isMasterPromptAdministrable, isPromptAdministrable, treatmentForUseCase, type Treatment } from './treatments';
import {
  DEFAULT_PROMPT_ARCHITECTURE, promptArchitectureOf, masterPromptOf,
  type PromptArchitecture, type ReasoningLevel, type TreatmentConfig,
} from './config-types';
import { currentJobContext } from '../queue/job-context';
import { hasTestCounterStore, readConfigVersionCounter } from './config-cache-version';
import {
  activeMasterPromptsTestOverride, loadActiveMasterPrompts, type ActiveMasterPrompt,
} from '../master-prompts/master-prompt-runtime';

/** Configuration réellement appliquée à un appel. */
export interface ResolvedOperationConfig {
  primaryModel: string;
  fallbackModels: string[];
  maxOutputTokens: number | null;
  reasoningPrimary: string | null;
  /**
   * Niveau de raisonnement PAR RANG (T1-UI-06, T2-UI-03, T3-UI-03, T4-UI-03) :
   * index 0 = principal, 1 = fallback 1, 2 = fallback 2. `null` = défaut du
   * modèle. Jusqu'ici saisi et versionné mais jamais transmis au fournisseur.
   */
  reasoningByRank: Array<ReasoningLevel | null>;
  /**
   * Préambule administrable, placé devant le prompt technique des ÉTAPES,
   * quelle que soit l'architecture (les opérations master ne le reçoivent
   * jamais — CDC 15 §22.3).
   */
  promptPreamble: string | null;
  /** Architecture des prompts du traitement (CDC 15 D-04). `steps` sans version. */
  promptArchitecture: PromptArchitecture;
  /**
   * Master complet porté par la version (D-03, colonne `master_prompt`),
   * en architecture `master` et s'il est renseigné ; `null` : le fichier du
   * dépôt s'applique.
   */
  masterPromptText: string | null;
  /**
   * Version de prompt maître ADMINISTRÉE depuis le BO (« Prompts maîtres »,
   * BO-IA-PROMPTS-01) dont vient `masterPromptText` ; `null` : texte de la
   * version de configuration ou fichier du dépôt.
   */
  masterPromptVersionId?: number | null;
  /** Numéro visible (v14) de cette version de prompt maître. */
  masterPromptVersionNumber?: number | null;
  /**
   * Lot 34D — configuration d'exécution EXPLICITE de cette version de prompt
   * maître (T4 : LEGACY_TEMPLATE / STRUCTURED_CONTEXT, contrats, TASK).
   * `null` : aucune (LEGACY_TEMPLATE).
   */
  masterExecution?: import('../master-prompts/structured-context').MasterExecutionConfig | null;
  /** Version dont vient cette configuration. `null` = configuration du code. */
  configVersionId: number | null;
  visibleNumber: number | null;
}

const CACHE_TTL_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 1_500;

let cache: {
  expiresAt: number;
  /**
   * Clé de version partagée lue au chargement (CFG-01). `null` : illisible,
   * seul le TTL borne alors la fraîcheur. Absente : cache posé par un test.
   */
  counter?: number | null;
  versionId: number | null;
  visibleNumber: number | null;
  byTreatment: Map<string, TreatmentConfig>;
  /**
   * Prompts maîtres ACTIFS administrés au BO (BO-IA-PROMPTS-01), par
   * traitement : priment sur le texte de la version de configuration.
   * Chargés avec elle, sous la même clé de version partagée (CFG-01).
   */
  masterPrompts?: Map<string, ActiveMasterPrompt>;
} | null = null;

/**
 * Versions épinglées par une exécution (VER-015). Une version numérotée
 * (Validée, Active, Archivée) ou À tester n'est plus modifiable (`saveEntry`
 * refuse tout statut ≠ DRAFT) : son contenu peut être gardé sans expiration.
 * Borné pour ne pas grossir indéfiniment sur une instance de longue durée.
 */
const pinned = new Map<number, Map<string, TreatmentConfig>>();
const PINNED_MAX = 16;

/** Vidé à chaque bascule d'Active, pour qu'une activation prenne effet tout de suite. */
export function invalidateConfigCache(): void {
  cache = null;
}

/**
 * Réservé aux tests : pose la version effective (et des versions épinglables)
 * sans base. `null` remet l'état initial.
 */
export function __setConfigForTests(
  effective: { versionId: number; entries: TreatmentConfig[] } | null,
  pinnable: Array<{ versionId: number; entries: TreatmentConfig[] }> = [],
): void {
  pinned.clear();
  cache = effective
    ? {
      expiresAt: Number.MAX_SAFE_INTEGER,
      versionId: effective.versionId,
      visibleNumber: null,
      byTreatment: new Map(effective.entries.map((e) => [e.treatment as string, e])),
    }
    : null;
  for (const p of pinnable) pinned.set(p.versionId, new Map(p.entries.map((e) => [e.treatment as string, e])));
}

/**
 * Identifiant de la version effective à cet instant — celle qu'un job prélevé
 * maintenant doit figer (VER-016). Ne lève jamais : `null` = configuration du code.
 */
export async function resolveEffectiveVersionId(): Promise<number | null> {
  return (await loadEffective()).versionId;
}

async function loadPinned(versionId: number): Promise<Map<string, TreatmentConfig> | null> {
  const hit = pinned.get(versionId);
  if (hit) return hit;
  try {
    const { getVersion } = await import('./config-version.repository');
    const v = await withTimeout(getVersion(versionId), LOOKUP_TIMEOUT_MS, null);
    if (!v) return null;
    const map = new Map(v.entries.map((e) => [e.treatment as string, e]));
    if (pinned.size >= PINNED_MAX) pinned.delete(pinned.keys().next().value as number);
    pinned.set(versionId, map);
    return map;
  } catch {
    return null;
  }
}

/**
 * Configuration d'un traitement sous laquelle tourne l'appel courant.
 *
 * Dans une exécution de file, c'est la version figée au démarrage (VER-015) ;
 * hors file, la version effective. `null` = configuration du code.
 */
async function entriesForCurrentExecution(): Promise<{
  versionId: number | null; visibleNumber: number | null; byTreatment: Map<string, TreatmentConfig>;
}> {
  const effective = await loadEffective();
  const ctx = currentJobContext();
  if (!ctx || ctx.configVersionId === effective.versionId) return effective;
  // Aucune version au démarrage : le code s'applique jusqu'au bout, même si
  // une version est activée pendant l'exécution.
  if (ctx.configVersionId === null) return { versionId: null, visibleNumber: null, byTreatment: new Map() };
  const map = await loadPinned(ctx.configVersionId);
  // Version épinglée illisible (base indisponible) : repli sur l'effective,
  // plutôt que sur le code — c'est la plus proche de ce qui a été figé.
  if (!map) return effective;
  return { versionId: ctx.configVersionId, visibleNumber: null, byTreatment: map };
}

/**
 * Ligne de configuration d'un traitement (déclencheurs, garde-fous) dans la
 * version effective, ou `null` sans version. Ne lève jamais.
 */
export async function resolveTreatmentConfig(treatment: Treatment): Promise<TreatmentConfig | null> {
  const effective = await loadEffective();
  return effective.byTreatment.get(treatment) ?? null;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref?.()),
  ]);
}

/**
 * Version effective, avec cache.
 *
 * CFG-01 (CDC 15) : la clé de version partagée (`config-cache-version.ts`) est
 * relue à CHAQUE résolution. Si elle a bougé depuis le chargement — promotion,
 * retour en Brouillon, validation, activation ou rollback sur N'IMPORTE
 * QUELLE instance —, la configuration est rechargée immédiatement. Le TTL de
 * 30 s reste le filet : clé illisible, ou changement fait hors application.
 */
async function loadEffective(): Promise<NonNullable<typeof cache>> {
  // Tests unitaires sans stockage de clé : aucune connexion, comportement
  // historique (cache posé par `__setConfigForTests`, sinon code).
  if (process.env.NODE_ENV === 'test' && !hasTestCounterStore()) {
    if (cache && cache.expiresAt > Date.now()) return cache;
    cache = {
      expiresAt: Date.now() + CACHE_TTL_MS, versionId: null, visibleNumber: null,
      byTreatment: new Map<string, TreatmentConfig>(),
    };
    return cache;
  }
  const precedents = cache?.masterPrompts;

  const counter = await readConfigVersionCounter();
  if (cache && cache.expiresAt > Date.now() && (counter === null || cache.counter === counter)) {
    return cache;
  }

  const vide = {
    expiresAt: Date.now() + CACHE_TTL_MS,
    counter,
    versionId: null,
    visibleNumber: null,
    byTreatment: new Map<string, TreatmentConfig>(),
  };

  try {
    const { getEffectiveVersion } = await import('./config-version.repository');
    const version = await withTimeout(getEffectiveVersion(), LOOKUP_TIMEOUT_MS, null);
    cache = version
      ? {
        expiresAt: Date.now() + CACHE_TTL_MS,
        counter,
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
  cache.masterPrompts = await loadMasterPromptsFor(precedents);
  return cache;
}

/**
 * Prompts maîtres actifs du BO (BO-IA-PROMPTS-01, AC15). Lecture en échec
 * (base lente, erreur passagère) : la DERNIÈRE lecture est conservée — jamais
 * un retour silencieux à un ancien texte. Table absente : aucune.
 */
async function loadMasterPromptsFor(precedents: Map<string, ActiveMasterPrompt> | undefined): Promise<Map<string, ActiveMasterPrompt>> {
  try {
    const { getAiEnvironment } = await import('./environment');
    const lu = await withTimeout(loadActiveMasterPrompts(getAiEnvironment()), LOOKUP_TIMEOUT_MS, null);
    return lu ?? precedents ?? new Map();
  } catch {
    return precedents ?? new Map();
  }
}

/** Prompts maîtres actifs à appliquer (cache courant, ou valeurs de test). */
async function activeMasterPrompts(): Promise<Map<string, ActiveMasterPrompt>> {
  const test = activeMasterPromptsTestOverride();
  if (test) return test;
  return (await loadEffective()).masterPrompts ?? new Map();
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
    // CDC 15 T2-43 : valeur initiale du code, remplacée par la version.
    maxOutputTokens: op.defaultMaxOutputTokens ?? null,
    reasoningPrimary: null,
    reasoningByRank: [],
    promptPreamble: null,
    // Lot 16b : `master` pour tous les traitements, même sans version.
    promptArchitecture: DEFAULT_PROMPT_ARCHITECTURE,
    masterPromptText: null,
    configVersionId: null,
    visibleNumber: null,
  };

  const effective = await entriesForCurrentExecution();

  let treatment: Treatment;
  try {
    treatment = treatmentForUseCase(op.useCaseCode);
  } catch {
    // Usage hors correspondance : le code fait foi, sans bruit.
    return duCode;
  }

  // BO-IA-PROMPTS-01 (AC15) : la version ACTIVE du prompt maître administrée
  // au BO prime sur le texte de la version de configuration — avec ou sans
  // version de configuration. T5 compris depuis le lot 32B (décision PO
  // n° 15) ; pour T5, le texte d'une version de configuration reste ignoré
  // (`promptOf`) : version active du BO, sinon fichier du dépôt.
  const actif = isMasterPromptAdministrable(treatment) ? (await activeMasterPrompts()).get(treatment) ?? null : null;
  const avecPrompt = <T extends ResolvedOperationConfig>(c: T): T => (actif && c.promptArchitecture === 'master'
    ? { ...c, masterPromptText: actif.content, masterPromptVersionId: actif.id, masterPromptVersionNumber: actif.versionNumber, masterExecution: actif.execution ?? null }
    : c);

  if (effective.versionId === null) return avecPrompt(duCode);

  const entry = effective.byTreatment.get(treatment);
  if (!entry) return avecPrompt(duCode);

  const fallbacks = [entry.fallback1, entry.fallback2].filter(
    (m): m is string => Boolean(m),
  );
  // Le niveau suit le modèle auquel il est attaché : un fallback 1 absent
  // décale le fallback 2 au rang 1 dans la chaîne, son niveau le suit.
  const reasoningFallbacks = ([
    [entry.fallback1, entry.reasoningFallback1],
    [entry.fallback2, entry.reasoningFallback2],
  ] as const).filter(([m]) => Boolean(m)).map(([, r]) => r ?? null);

  return avecPrompt({
    primaryModel: entry.primaryModel ?? duCode.primaryModel,
    // Une version qui ne déclare aucun repli en supprime : c'est une décision
    // d'administration, pas une valeur manquante. Le principal, lui, ne peut
    // pas être vide sans laisser l'opération sans modèle du tout.
    fallbackModels: entry.primaryModel ? fallbacks : duCode.fallbackModels,
    // CDC 15 T2-43 : SEULE source de vérité du plafond de sortie — plus
    // aucun plafond parallèle côté appelant (ancien
    // `VEREBONA_ASSISTANT_MAX_OUTPUT_TOKENS`).
    maxOutputTokens: entry.maxOutputTokens ?? duCode.maxOutputTokens,
    reasoningPrimary: entry.reasoningPrimary,
    // Principal du code conservé (version sans principal) : aucun niveau
    // administré ne s'applique à un modèle que l'administrateur n'a pas choisi.
    reasoningByRank: entry.primaryModel
      ? [entry.reasoningPrimary ?? null, ...reasoningFallbacks]
      : [],
    ...promptOf(entry),
    configVersionId: effective.versionId,
    visibleNumber: effective.visibleNumber,
  });
}

/**
 * Textes administrables d'une ligne (CDC 15 D-03, D-04) : le texte master
 * (toujours en architecture `master` depuis le lot 16b) ; le préambule n'est
 * plus appliqué qu'à une opération hors master non dynamique — il n'en existe
 * plus au référentiel.
 */
function promptOf(entry: TreatmentConfig): Pick<ResolvedOperationConfig, 'promptPreamble' | 'promptArchitecture' | 'masterPromptText'> {
  const promptArchitecture = promptArchitectureOf(entry);
  return {
    promptArchitecture,
    promptPreamble: preambleFor(entry.treatment, entry.prompt),
    masterPromptText: promptArchitecture === 'master' && isPromptAdministrable(entry.treatment)
      ? masterPromptOf(entry)
      : null,
  };
}


/**
 * Préambule administrable d'un traitement, ou `null`.
 *
 * T5 n'en a jamais (T5-003, écart E-02) : son comportement est entièrement dans
 * le code. Une Active antérieure à cette règle peut encore porter un texte
 * dans sa ligne T5 ; il est ignoré ici, sans attendre qu'une nouvelle version
 * soit activée.
 */
export function preambleFor(treatment: Treatment, prompt: string): string | null {
  if (!isPromptAdministrable(treatment)) return null;
  return prompt.trim() === '' ? null : prompt;
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
