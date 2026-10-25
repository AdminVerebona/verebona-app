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
import { isMasterPromptAdministrable, treatmentOfUseCase, type Treatment } from './treatments';
import {
  DEFAULT_PROMPT_ARCHITECTURE, promptArchitectureOf, masterPromptOf,
  type PromptArchitecture, type ReasoningLevel, type TreatmentConfig,
} from './config-types';
import { currentJobContext } from '../queue/job-context';
import { normalizeOperationProfiles, profileForChain, profileForSlotOrder, type OperationProfile } from './operation-profiles';
import { applyRoutingOverlay, type RoutingOverlay } from './routing-overlay';
import {
  currentSyncConfigSnapshot, registerExecutionSnapshotCapture, type EffectiveConfigState, type ExecutionConfigSnapshot,
} from './execution-snapshot';
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
  /**
   * Lot 54 : révision de cette version effectivement appliquée (la version
   * active reste modifiable). `null` : configuration du code, ou version
   * sans révision (schéma antérieur à 0376).
   */
  configRevisionId?: number | null;
  configRevisionNumber?: number | null;
  /**
   * Lot 85C (CDC Pilotage IA V2 P4, CFG-01, OP-03) : profil de CETTE
   * opération (raisonnement, plafond de sortie par rang, délai), ramené aux
   * rangs de la chaîne effective. Absent : la référence du traitement vaut
   * pour tous les rangs (héritage explicite, `rankProfile`).
   */
  operationProfile?: OperationProfile | null;
  /**
   * Lot 86B (P6, ACT-03, OPT-03) : surcouche de routage appliquée à la chaîne
   * configurée de la version ACTIVE — modèles retirés par une exclusion
   * manuelle, modèle promu en tête. Absent : chaîne configurée telle quelle.
   */
  routing?: { excludedModels: string[]; exclusionIgnored: boolean; promotedModel: string | null; promotionId: number | null };
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
  /** Lot 54 : révision appliquée (dernier état enregistré de l'active). */
  revisionId?: number | null;
  revisionNumber?: number | null;
  byTreatment: Map<string, TreatmentConfig>;
  /**
   * Prompts maîtres ACTIFS administrés au BO (BO-IA-PROMPTS-01), par
   * traitement : priment sur le texte de la version de configuration.
   * Chargés avec elle, sous la même clé de version partagée (CFG-01).
   */
  masterPrompts?: Map<string, ActiveMasterPrompt>;
  /**
   * Lot 86B : surcouche de routage (exclusions, promotions) de l'environnement,
   * chargée avec la configuration sous la même clé partagée (chaque geste
   * l'incrémente). Absente : aucune.
   */
  overlay?: RoutingOverlay;
} | null = null;

/**
 * RÉVISIONS épinglées par une exécution (VER-015, lot 54). Une version est
 * désormais modifiable, une révision jamais (déclencheur 0376) : seul son
 * contenu peut être gardé sans expiration. Clé : identifiant de révision.
 * Borné pour ne pas grossir indéfiniment sur une instance de longue durée.
 */
interface PinnedConfig {
  versionId: number;
  visibleNumber: number | null;
  revisionId: number | null;
  revisionNumber: number | null;
  byTreatment: Map<string, TreatmentConfig>;
  /** Prompts maîtres figés dans la révision (texte et exécution connus). */
  masterPrompts: Map<string, ActiveMasterPrompt>;
}
const pinned = new Map<number, PinnedConfig>();
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
  effective: { versionId: number; entries: TreatmentConfig[]; overlay?: RoutingOverlay } | null,
  pinnable: Array<{ versionId: number; entries: TreatmentConfig[] }> = [],
): void {
  pinned.clear();
  pinnedVersions.clear();
  cache = effective
    ? {
      expiresAt: Number.MAX_SAFE_INTEGER,
      versionId: effective.versionId,
      visibleNumber: null,
      byTreatment: new Map(effective.entries.map((e) => [e.treatment as string, e])),
      ...(effective.overlay ? { overlay: effective.overlay } : {}),
    }
    : null;
  for (const p of pinnable) {
    pinnedVersions.set(p.versionId, {
      versionId: p.versionId, visibleNumber: null, revisionId: null, revisionNumber: null,
      byTreatment: new Map(p.entries.map((e) => [e.treatment as string, e])), masterPrompts: new Map(),
    });
  }
}

/**
 * Version et révision effectives à cet instant — celles qu'un job prélevé
 * maintenant doit figer (VER-016, lot 54). Ne lève jamais : `null` =
 * configuration du code.
 */
export async function resolveEffectivePin(): Promise<{ versionId: number | null; revisionId: number | null }> {
  const e = await loadEffective();
  return { versionId: e.versionId, revisionId: e.revisionId ?? null };
}

/**
 * Lot 87A (P7, RUN-04) — instantané de la configuration EFFECTIVE à cet
 * instant (version, révision, lignes, prompts maîtres, surcouche de routage).
 * Ne lève jamais.
 */
export async function captureExecutionSnapshot(scope: 'job' | 'sync', treatment: Treatment | null = null): Promise<ExecutionConfigSnapshot> {
  const effective = await loadEffective().catch(() => ({ versionId: null, visibleNumber: null, byTreatment: new Map<string, TreatmentConfig>() } as EffectiveConfigState));
  return { scope, treatment, takenAt: new Date().toISOString(), effective };
}

// Lot 87A : relevé utilisé par `runWithConfigSnapshot` (exécutions synchrones).
registerExecutionSnapshotCapture(captureExecutionSnapshot);

/**
 * Lot 87A — surcouche de routage EN VIGUEUR (exclusions, promotions), ou
 * `null`. Lue par la politique de secours : une exclusion prise pendant une
 * exécution retire le modèle des secours encore à essayer. Ne lève jamais.
 */
export async function currentRoutingOverlay(): Promise<RoutingOverlay | null> {
  try {
    return (await loadEffective()).overlay ?? null;
  } catch {
    return null;
  }
}

/** Compatibilité : identifiant de la version effective seul. */
export async function resolveEffectiveVersionId(): Promise<number | null> {
  return (await loadEffective()).versionId;
}

/** Prompts maîtres figés dans une révision dont l'exécution est connue. */
function pinnedMasterPrompts(refs: import('./config-snapshot').ConfigSnapshot['masterPrompts']): Map<string, ActiveMasterPrompt> {
  const out = new Map<string, ActiveMasterPrompt>();
  for (const [t, r] of Object.entries(refs)) {
    // Configuration d'exécution inconnue de l'instantané (reprise) : le prompt
    // actif s'applique, jamais un mode d'exécution deviné.
    if (!r || r.execution === undefined) continue;
    out.set(t, { id: r.versionId, treatment: t as Treatment, versionNumber: r.versionNumber, content: r.content, execution: r.execution });
  }
  return out;
}

async function loadPinnedRevision(revisionId: number): Promise<PinnedConfig | null> {
  const hit = pinned.get(revisionId);
  if (hit) return hit;
  try {
    const { getRevisionConfiguration } = await import('./config-version.repository');
    const v = await withTimeout(getRevisionConfiguration(revisionId), LOOKUP_TIMEOUT_MS, null);
    if (!v) return null;
    const p: PinnedConfig = {
      versionId: v.versionId, visibleNumber: v.visibleNumber, revisionId: v.revisionId, revisionNumber: v.revisionNumber,
      byTreatment: new Map(v.entries.map((e) => [e.treatment as string, e])),
      masterPrompts: pinnedMasterPrompts(v.masterPrompts),
    };
    if (pinned.size >= PINNED_MAX) pinned.delete(pinned.keys().next().value as number);
    pinned.set(revisionId, p);
    return p;
  } catch {
    return null;
  }
}

/** Versions épinglées par les tests (`__setConfigForTests`) ; jamais en cache réel. */
const pinnedVersions = new Map<number, PinnedConfig>();

/**
 * Épinglage par VERSION seule (contexte antérieur au lot 54, sans révision) :
 * dernier état enregistré de cette version, relu (une version est modifiable,
 * son contenu n'est donc jamais gardé sans expiration).
 */
async function loadPinnedVersion(versionId: number): Promise<PinnedConfig | null> {
  const t = pinnedVersions.get(versionId);
  if (t) return t;
  try {
    const { getVersion } = await import('./config-version.repository');
    const v = await withTimeout(getVersion(versionId), LOOKUP_TIMEOUT_MS, null);
    if (!v) return null;
    return {
      versionId: v.id, visibleNumber: v.visibleNumber, revisionId: v.currentRevisionId, revisionNumber: v.currentRevisionNumber,
      byTreatment: new Map(v.entries.map((e) => [e.treatment as string, e])), masterPrompts: new Map(),
    };
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
  versionId: number | null; visibleNumber: number | null; revisionId?: number | null; revisionNumber?: number | null;
  byTreatment: Map<string, TreatmentConfig>;
  /** Prompts maîtres figés de la révision épinglée (sinon : les actifs). */
  pinnedMasterPrompts?: Map<string, ActiveMasterPrompt>;
  /** Lot 86B : surcouche de routage (configuration active seulement). */
  overlay?: RoutingOverlay;
}> {
  const ctx = currentJobContext();
  // Lot 87A (P7, RUN-04) : instantané relevé au DÉMARRAGE de l'exécution —
  // lignes, prompts maîtres ET surcouche de routage figés (une promotion ou
  // une activation prise en cours ne touche que les exécutions suivantes).
  const figee = ctx ? frozenFor(ctx) : currentSyncConfigSnapshot()?.effective ?? null;
  if (figee) return { ...figee, pinnedMasterPrompts: figee.masterPrompts };
  const effective = await loadEffective();
  if (!ctx) return effective;
  // Lot 54 : la révision figée au démarrage fait foi (la version active
  // reste modifiable pendant l'exécution).
  if (ctx.configRevisionId != null) {
    if (ctx.configRevisionId === effective.revisionId) return effective;
    const p = await loadPinnedRevision(ctx.configRevisionId);
    // Révision illisible (base indisponible) : repli sur l'effective,
    // plutôt que sur le code — c'est la plus proche de ce qui a été figé.
    if (!p) return effective;
    return { ...p, pinnedMasterPrompts: p.masterPrompts };
  }
  if (ctx.configVersionId === effective.versionId) return effective;
  // Aucune version au démarrage : le code s'applique jusqu'au bout, même si
  // une version est activée pendant l'exécution.
  if (ctx.configVersionId === null) return { versionId: null, visibleNumber: null, byTreatment: new Map() };
  const p = await loadPinnedVersion(ctx.configVersionId);
  if (!p) return effective;
  return p;
}

/**
 * Instantané du travail de file applicable (pur) : seulement s'il porte la
 * révision (ou, sans révision, la version) épinglée par ce contexte — un
 * contexte épinglé sur une AUTRE révision (qualification d'une candidate)
 * garde sa révision, sans surcouche.
 */
function frozenFor(ctx: NonNullable<ReturnType<typeof currentJobContext>>): EffectiveConfigState | null {
  const s = ctx.configSnapshot?.effective;
  if (!s) return null;
  if (ctx.configRevisionId != null) return (s.revisionId ?? null) === ctx.configRevisionId ? s : null;
  return s.versionId === ctx.configVersionId ? s : null;
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
  const surcouchePrecedente = cache?.overlay;

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

  // Lot 86B : l'objet est COMPLÉTÉ (prompts maîtres, surcouche) avant d'être
  // publié dans le cache — un chargement concurrent (contrôle de l'assistant
  // après un changement) ne peut plus rendre un objet incomplet.
  let next: NonNullable<typeof cache>;
  try {
    // Lot 54 : version active ET sa révision courante, lues en une requête.
    const { getRuntimeConfiguration } = await import('./config-version.repository');
    const version = await withTimeout(getRuntimeConfiguration(), LOOKUP_TIMEOUT_MS, null);
    next = version
      ? {
        expiresAt: Date.now() + CACHE_TTL_MS,
        counter,
        versionId: version.versionId,
        visibleNumber: version.visibleNumber,
        revisionId: version.revisionId,
        revisionNumber: version.revisionNumber,
        byTreatment: new Map(version.entries.map((e) => [e.treatment, e])),
      }
      : vide;
  } catch {
    // Tables absentes, base indisponible, environnement illisible : on retombe
    // sur le code. Le produit continue de fonctionner comme avant le BO.
    next = vide;
  }
  next.masterPrompts = await loadMasterPromptsFor(precedents);
  if (next.versionId !== null) next.overlay = await loadOverlayFor(surcouchePrecedente);
  cache = next;
  return next;
}

/**
 * Lot 86B — surcouche de routage (exclusions, promotions). Lecture en échec :
 * la DERNIÈRE lecture est conservée (jamais une exclusion levée en silence
 * par une base lente) ; tables absentes : aucune.
 */
async function loadOverlayFor(precedente: RoutingOverlay | undefined): Promise<RoutingOverlay | undefined> {
  try {
    const { loadRoutingOverlay } = await import('./routing-state.service');
    const lu = await withTimeout(loadRoutingOverlay(), LOOKUP_TIMEOUT_MS, null);
    return lu ?? precedente;
  } catch {
    return precedente;
  }
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
 * Lot 54E — texte master EFFECTIF d'un traitement administrable : version
 * active du BO, sinon texte de la version de configuration ; `null` : le
 * fichier du dépôt s'applique. Sert à savoir si une fonction liée à un
 * emplacement FACULTATIF (ex. {{BUSINESS_CANDIDATES}}) est disponible avant
 * de dépenser un appel modèle. Ne lève jamais.
 */
/**
 * Lot 59 (#419) — texte EFFECTIF et sa provenance : version active du BO
 * (`v<numéro>`), version de configuration (`config`), sinon le fichier du
 * dépôt (`file`, texte `null`). Ne lève jamais.
 */
export async function effectiveMasterPromptInfo(treatment: Treatment): Promise<{ text: string | null; version: string }> {
  try {
    const actif = (await activeMasterPrompts()).get(treatment);
    if (actif?.content) return { text: actif.content, version: actif.versionNumber != null ? `v${actif.versionNumber}` : 'bo' };
    const conf = masterPromptOf(await resolveTreatmentConfig(treatment));
    return conf ? { text: conf, version: 'config' } : { text: null, version: 'file' };
  } catch {
    return { text: null, version: 'file' };
  }
}

export async function effectiveMasterPromptText(treatment: Treatment): Promise<string | null> {
  try {
    const actif = (await activeMasterPrompts()).get(treatment);
    if (actif?.content) return actif.content;
    return masterPromptOf(await resolveTreatmentConfig(treatment));
  } catch {
    return null;
  }
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

  let treatment: Treatment | null;
  try {
    treatment = treatmentOfUseCase(op.useCaseCode);
  } catch {
    treatment = null;
  }
  // Usage technique (`AI_GOVERNANCE`, lot 49 : indépendant des traitements)
  // ou hors correspondance : le référentiel du code fait foi, sans bruit —
  // aucune ligne de configuration, aucun prompt maître ne s'y applique.
  if (treatment === null) return duCode;

  // BO-IA-PROMPTS-01 (AC15) : la version ACTIVE du prompt maître administrée
  // au BO prime sur le texte de la version de configuration — avec ou sans
  // version de configuration.
  // Lot 54 : exécution épinglée sur une révision antérieure — ses prompts
  // maîtres figés priment (configuration cohérente jusqu'au bout).
  const figes = effective.pinnedMasterPrompts?.get(treatment) ?? null;
  const actif = isMasterPromptAdministrable(treatment) ? figes ?? (await activeMasterPrompts()).get(treatment) ?? null : null;
  const avecPrompt = <T extends ResolvedOperationConfig>(c: T): T => (actif && c.promptArchitecture === 'master'
    ? { ...c, masterPromptText: actif.content, masterPromptVersionId: actif.id, masterPromptVersionNumber: actif.versionNumber, masterExecution: actif.execution ?? null }
    : c);

  if (effective.versionId === null) return avecPrompt(duCode);

  const entry = effective.byTreatment.get(treatment);
  if (!entry) return avecPrompt(duCode);

  // Lot 86B : surcouche de routage (configuration ACTIVE seulement — une
  // exécution épinglée sur une autre révision garde sa chaîne figée).
  const routed = entry.primaryModel && effective.overlay ? routedChain(entry, operationCode, treatment, effective.overlay) : null;
  if (routed) {
    return avecPrompt({
      primaryModel: routed.chain[0].model,
      fallbackModels: routed.chain.slice(1).map((c) => c.model),
      maxOutputTokens: entry.maxOutputTokens ?? duCode.maxOutputTokens,
      reasoningPrimary: routed.chain[0].extra ?? null,
      reasoningByRank: routed.chain.map((c) => c.extra ?? null),
      ...promptOf(entry),
      ...(() => {
        const prof = profileForSlotOrder(normalizeOperationProfiles(entry.operationProfiles)[operationCode], routed.chain.map((c) => c.slot));
        return prof ? { operationProfile: prof } : {};
      })(),
      configVersionId: effective.versionId,
      visibleNumber: effective.visibleNumber,
      configRevisionId: effective.revisionId ?? null,
      configRevisionNumber: effective.revisionNumber ?? null,
      routing: { excludedModels: routed.excluded, exclusionIgnored: routed.exclusionIgnored, promotedModel: routed.promotedModel, promotionId: routed.promotionId },
    });
  }

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
    // Lot 85C : profil de l'opération, emplacements ramenés aux rangs de la
    // chaîne (même décalage que les niveaux de raisonnement). Principal du
    // code conservé : aucun profil administré ne s'applique.
    ...(entry.primaryModel ? operationProfileOf(entry, operationCode) : {}),
    configVersionId: effective.versionId,
    visibleNumber: effective.visibleNumber,
    configRevisionId: effective.revisionId ?? null,
    configRevisionNumber: effective.revisionNumber ?? null,
  });
}

/**
 * Lot 86B — chaîne de la ligne après surcouche (exclusions, promotion), ou
 * `null` si la surcouche ne change rien (chemin historique inchangé).
 */
function routedChain(entry: TreatmentConfig, operationCode: string, treatment: Treatment, overlay: RoutingOverlay) {
  const chaine = ([[entry.primaryModel, entry.reasoningPrimary], [entry.fallback1, entry.reasoningFallback1], [entry.fallback2, entry.reasoningFallback2]] as const)
    .map(([model, reasoning], slot) => ({ model: model ?? '', slot, extra: (reasoning ?? null) as ReasoningLevel | null }))
    .filter((c) => c.model !== '');
  const r = applyRoutingOverlay(chaine, treatment, operationCode, overlay);
  const inchangee = r.chain.length === chaine.length && r.chain.every((c, i) => c.slot === chaine[i].slot);
  if (inchangee && !r.exclusionIgnored) return null;
  return r;
}

function operationProfileOf(entry: TreatmentConfig, operationCode: string): Pick<ResolvedOperationConfig, 'operationProfile'> {
  const p = normalizeOperationProfiles(entry.operationProfiles)[operationCode];
  const chaine = profileForChain(p, [true, Boolean(entry.fallback1), Boolean(entry.fallback2)]);
  return chaine ? { operationProfile: chaine } : {};
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
    masterPromptText: promptArchitecture === 'master' ? masterPromptOf(entry) : null,
  };
}


/**
 * Préambule administrable d'un traitement, ou `null`. Lot 49 : seuls les
 * traitements opérationnels ont une ligne de configuration (une ligne T5
 * historique n'est jamais lue — `config-version.repository`).
 */
export function preambleFor(_treatment: Treatment, prompt: string): string | null {
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
